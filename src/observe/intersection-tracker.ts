/**
 * BranchKit Browser — IntersectionObserver gates label claim/release.
 *
 * The load-bearing piece of Sprint B: only viewport-near elements claim
 * codewords from the per-tab pool. Off-screen elements release theirs.
 * Without this gate, a 5000-link page (Twitter timeline, infinite-scroll
 * search results) exhausts the 676-codeword pool on first paint.
 *
 * Design: notes/DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md section 4.
 *
 * Lifecycle per wrapper:
 *   1. MutationObserver discovers a wrapper → tracker.observe(element).
 *   2. IO fires "intersecting" within margin → wrapper queued for claim.
 *   3. Flush sends one CLAIM_LABELS for the whole queue, distributes
 *      returned labels back across wrappers (in queue order).
 *   4. IO fires "not intersecting" past margin → wrapper queued for release;
 *      its codeword is cleared locally and pushed onto the release queue.
 *   5. Flush sends one RELEASE_LABELS for the whole queue.
 *
 * Claim and release are batched within a 50ms debounce so a viewport
 * full of elements settling at once produces O(1) RPCs to the pool, not
 * O(N).
 */

import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { wantsCodeword } from '../lifecycle/desired-state';
import { labelReservoir } from '../labels/label-reservoir';
import { geometryInBand } from '../layout-cache';

// Wide rootMargin to match Rango's lazy-construction model: catch elements
// while they're still ~5 viewport-line-rows away, so the per-badge work
// (codeword claim, HintBadge construction, observer refinement) happens
// during the "approach" window instead of at the moment of visibility.
// Same total CPU as the old 200 px margin — just shifted earlier so the
// user doesn't perceive it as "paint lag" lining up with their scroll.
// Was 200 px; Rango uses 1000 px (`addWrappersIntersectionObserver` in
// ElementWrapper.ts) and feels noticeably smoother on long scrolls.
//
// VIEWPORT_MARGIN_PX is the single source of truth for the band width:
// every geometry check that backstops this IO's `isInViewport` flag
// (reconcileTeardown, computeReconcilePlan) must use the same margin, or
// the backstop disagrees with IO ground truth for the ring between the
// two values (the 200-vs-1000 drift bug, 2026-06-11).
export const VIEWPORT_MARGIN_PX = 1000;
const VIEWPORT_MARGIN = `${VIEWPORT_MARGIN_PX}px`;

export interface TrackerEvents {
  /**
   * Called after a flush that changed any wrapper's codeword.
   * `claimed` are wrappers that just got a fresh codeword via this flush.
   * `released` are codewords released back to the pool this flush
   * (viewport-leave). The delta-sync path on content.ts uses these
   * lists to drive per-wrapper Put / per-codeword Delete on the plugin
   * side without re-walking the whole store.
   */
  onCodewordsChanged: (claimed: ElementWrapper[], released: string[]) => void;
}

export class IntersectionTracker {
  private io: IntersectionObserver;
  private store: WrapperStore;
  private events: TrackerEvents;
  // Wrappers waiting to claim. Set so a wrapper can't queue twice if IO
  // fires "intersecting" repeatedly before flush.
  private pendingClaim: Set<ElementWrapper> = new Set();
  // Codewords waiting to release. Strings, not wrappers — the wrapper may
  // already have been GC'd by the time we flush.
  private pendingRelease: string[] = [];
  private flushScheduled = false;
  // Promise chain that serializes every doFlush. Without this, a flush
  // started by scheduleFlush's timer can be in mid-await on
  // CLAIM_LABELS while flushNow's `await this.flush()` starts a second
  // flush concurrently. The second sees an empty queue and returns
  // immediately, so flushNow resolves before the first claim finishes —
  // showHints would then render badges before all wrappers have
  // codewords. Chaining ensures every doFlush waits for the prior one.
  private flushChain: Promise<void> = Promise.resolve();

  constructor(store: WrapperStore, events: TrackerEvents) {
    this.store = store;
    this.events = events;
    this.io = new IntersectionObserver(this.handleEntries, {
      root: null,
      rootMargin: VIEWPORT_MARGIN,
      threshold: 0,
    });
  }

  observe(element: Element): void {
    this.io.observe(element);
  }

  /**
   * Stop observing an element and drop any pending claim for it. Caller
   * is responsible for releasing the wrapper's currently-held codeword
   * (e.g. via removeWrapperByElement → ElementWrapper.releaseLabel).
   *
   * The pendingClaim cleanup is load-bearing: without it, a wrapper that
   * leaves the store between queue and flush would still receive a
   * codeword from CLAIM_LABELS — and since no wrapper holds a reference,
   * the codeword leaks until tab close.
   */
  unobserve(element: Element): void {
    this.io.unobserve(element);
    const wrapper = this.store.findWrapperFor(element);
    if (wrapper) this.pendingClaim.delete(wrapper);
  }

  /**
   * Drop every observation. Used when the store is bulk-replaced —
   * caller should `observeAll()` afterwards once new wrappers are in.
   */
  disconnectAll(): void {
    this.io.disconnect();
    this.pendingClaim.clear();
  }

  observeAll(): void {
    for (const w of this.store.all) {
      this.io.observe(w.element);
    }
  }

  /**
   * Re-queue every viewport-visible wrapper for claim. The claim step of the
   * level-triggered reconciler — called only by `reconcile()` in content.ts,
   * not as an independent backstop. Walks the existing store rather than
   * waiting for IO entries that won't fire until the user scrolls (e.g. after
   * the pool is regenerated on an alphabet change, or a post-nav mutation storm
   * drops the initial IO callbacks).
   */
  refreshViewportClaims(): void {
    for (const w of this.store.all) {
      // Delta against desired state: wants a codeword but doesn't hold one.
      if (wantsCodeword(w) && !w.scanned.codeword) {
        this.pendingClaim.add(w);
      }
    }
    if (this.pendingClaim.size > 0) this.scheduleFlush();
  }

  /**
   * Mid-scroll band flag sweep — BOTH directions of the settle plan's
   * lifecycle repair, run by geometry while the user is actively scrolling
   * (notes/DESIGN_FLING_WAVE.md Part 1c + drill round 2). On a virtualized
   * grid most rows are inserted OUTSIDE the band and cross its edge
   * mid-fling; the IO's delivery of those crossings starves on saturated
   * frames (attached_to_band p90 581ms, round 1), so this reads geometry
   * directly. One gBCR per live wrapper, no interleaved writes — a single
   * reflow per sweep; the caller throttles (10Hz) and runs reconcile() when
   * anything changed (claims + build flow through the normal convergence
   * entry — no new claim path).
   *
   * The release direction is load-bearing for the POOL, not just flag
   * hygiene: entries-only drained the local reservoir mid-fling (claims
   * fast, releases waiting on starved IO/settle — band_to_claimed p90
   * 13 → 377ms, round 2) and left the leading edge letterless until
   * settle. `labelReservoir.release` is local-synchronous, so an exit in
   * this sweep funds a claim in the same sweep's reconcile. This is NOT
   * the retired off-screen hide sweep (paint-the-band seam 3): that one
   * hid badges while LEAVING them band-flagged, so the plan re-showed
   * them — a flap. This flips the flag first; plan and IO agree with the
   * result.
   */
  sweepBand(vw: number, vh: number): { repaired: number; released: number } {
    const __t0 = performance.now();
    let repaired = 0;
    let released = 0;
    for (const w of this.store.all) {
      if (w.disconnectedAt !== null) continue;
      if (!w.element.isConnected) continue;
      const r = w.element.getBoundingClientRect();
      // Boxless skip (the reconcile plan's zero-rect guard): display:none
      // elements report all-zeros, which would false-positive at the origin.
      if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) continue;
      const inBand = geometryInBand(r, vw, vh, VIEWPORT_MARGIN_PX);
      if (inBand && !w.isInViewport) {
        w.lastRect = r; // free fresh rect — keeps the limbo tiebreaker current
        w.isInViewport = true;
        w.tInBand ??= performance.now();
        repaired++;
      } else if (!inBand && w.isInViewport) {
        w.lastRect = r;
        w.isInViewport = false;
        // Same path as the IO exit branch: cancels any pending claim,
        // stashes preferredCodeword for sticky reclaim, drops the badge to
        // dormant. ≥1000px off-screen, so the hide is imperceptible.
        this.queueRelease(w);
        released++;
      }
    }
    const rec = (globalThis as { __branchkitRecordCpu?: (label: string, ms: number) => void }).__branchkitRecordCpu;
    if (rec) rec('intersection:sweepBand', performance.now() - __t0);
    return { repaired, released };
  }

  /**
   * Queue codeword claims for wrappers a caller just proved in-band by
   * geometry, without waiting for the IO to deliver its band-entry callback
   * (mid-fling that delivery ran ~305ms p50 — the dominant paint-latency
   * stage; notes/DESIGN_FLING_WAVE.md Part 1). The caller owns the band
   * check and the optimistic `isInViewport` write — the tracker only ever
   * learns band state from IO entries or callers that just read geometry.
   * Idempotent with the IO path: its claim branch skips wrappers that
   * already hold a codeword, and a wrong optimistic flag is corrected by
   * the IO's initial callback (a genuine out-of-band wrapper gets the
   * normal release, sticky reclaim keeps the letter).
   */
  primeClaims(wrappers: ElementWrapper[]): void {
    let queued = false;
    for (const w of wrappers) {
      if (w.scanned.codeword) continue;
      this.pendingClaim.add(w);
      queued = true;
    }
    if (queued) this.scheduleFlush();
  }

  /**
   * Force pending work to flush. Awaitable. Drains until both queues are
   * stable — a doFlush awaiting CLAIM_LABELS may have IO fire more
   * entries (or refreshViewportClaims push more wrappers) by the time
   * it returns; we loop so showHints sees a quiescent tracker.
   */
  async flushNow(): Promise<void> {
    // Drop any pending microtask flush — we're going to drive flushes directly.
    // The microtask might still fire and call enqueueFlush again, but
    // enqueueFlush is idempotent (no-op when both queues are empty).
    this.flushScheduled = false;
    do {
      await this.enqueueFlush();
    } while (this.pendingClaim.size > 0 || this.pendingRelease.length > 0);
  }

  private handleEntries = (entries: IntersectionObserverEntry[]): void => {
    // Sync cost is the whole loop + scheduleFlush. Reported via the
    // global recorder content.ts wires up (see __branchkitRecordCpu).
    // No-op when the recorder isn't present (tests, early boot).
    const __t0 = performance.now();
    for (const entry of entries) {
      const wrapper = this.store.findWrapperFor(entry.target);
      if (!wrapper) continue;
      // Limbo wrappers hold their codeword by design (decision 3 of
      // DESIGN_WRAPPER_IDENTITY_STABILITY). A disconnected element
      // typically fires `isIntersecting: false` from the IO — letting
      // that release the codeword would defeat the whole limbo
      // mechanism. Skip until the wrapper rebinds or finalizes; the
      // pre-disconnect lastRect snapshot is preserved.
      if (wrapper.disconnectedAt !== null) continue;
      // Snapshot the latest rect for the limbo position-tiebreaker.
      // IO entries give us a free, current rect on every observation —
      // without this hook, `lastRect` would almost always be null at
      // disconnect time (the layout cache is cleared after each show/
      // reposition, so the MO-driven `dropDisconnectedWrappers` path
      // would observe an empty cache). entry.boundingClientRect IS a
      // DOMRectReadOnly at runtime; cast is safe.
      wrapper.lastRect = entry.boundingClientRect as DOMRect;
      wrapper.isInViewport = entry.isIntersecting;

      if (entry.isIntersecting) {
        // Paint-latency stage stamp (first band entry only).
        wrapper.tInBand ??= performance.now();
        // Want a codeword if we don't already have one.
        if (!wrapper.scanned.codeword) {
          this.pendingClaim.add(wrapper);
        }
      } else {
        this.queueRelease(wrapper);
      }
    }
    this.scheduleFlush();
    const rec = (globalThis as { __branchkitRecordCpu?: (label: string, ms: number) => void }).__branchkitRecordCpu;
    if (rec) rec('intersection:handleEntries', performance.now() - __t0);
  };

  /**
   * Release a wrapper's codeword + hint and queue the label for return to
   * the pool. Shared by the IO exit branch and the level-triggered
   * tear-down backstop (`reconcileTeardown` in content.ts). Cancels any
   * pending claim, since the wrapper is leaving the band. Schedules a flush
   * so the released label re-enters the pool; safe to call repeatedly
   * (scheduleFlush is idempotent).
   */
  queueRelease(wrapper: ElementWrapper): void {
    // Cancel any pending claim — the wrapper went off-screen before we got
    // around to claiming for it.
    this.pendingClaim.delete(wrapper);
    if (wrapper.scanned.codeword) {
      this.pendingRelease.push(wrapper.scanned.codeword);
      // Remember the codeword so a scroll-back re-claim can re-grant the same
      // letter (sticky reclaim — kills flicker). See claimLabels pass 1.
      wrapper.preferredCodeword = wrapper.scanned.codeword;
      wrapper.scanned.codeword = '';
      wrapper.label = null;
      // The codeword is being released — the plugin will receive a Delete
      // and the grammar entry goes away. Next reclaim is a fresh codeword
      // that has to be re-acknowledged by the plugin before it's voice-
      // matchable, so reset to pending. show() will add bk-pending again.
      wrapper.grammarReady = false;
      // Keep the badge object alive across visibility cycles (notes/
      // DESIGN_HINT_REUSE.md): drop visibility + label content, but leave
      // the shadow DOM, observers, anchorParent, and color computation
      // intact for the likely scroll-back. The next viewport entry takes
      // the fast path in `badgeNewlyCodeworded` (`setLabel` + `show`
      // instead of `new HintBadge`). Final teardown still happens via
      // `ElementWrapper.destroy()` when the wrapper itself is dropped.
      if (wrapper.hint) {
        wrapper.hint.hide();
        wrapper.hint.clearLabel();
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    // queueMicrotask runs at the end of the current task — after the IO
    // callback finishes its synchronous entry loop, so all entries from
    // one callback still coalesce into one flush. The setTimeout(16ms)
    // it replaced was dead time for the common case (single IO callback)
    // because no new entries arrive between callback end and timer fire.
    // The rare "two adjacent IO callbacks within a frame" case is still
    // covered: the second callback's adds land in pendingClaim while the
    // first flush's CLAIM_LABELS IPC is in-flight; flushChain's
    // serialization picks them up on the next pass.
    queueMicrotask(() => {
      this.flushScheduled = false;
      this.enqueueFlush();
    });
  }

  /**
   * Append a doFlush to the serialization chain. Returns the promise
   * that resolves when this flush completes. Errors don't break the
   * chain — both branches schedule the next doFlush.
   */
  private enqueueFlush(): Promise<void> {
    this.flushChain = this.flushChain.then(() => this.doFlush(), () => this.doFlush());
    return this.flushChain;
  }

  private async doFlush(): Promise<void> {
    let dirty = false;
    const releasedCodewords: string[] = [];
    const newlyClaimed: ElementWrapper[] = [];

    // Releases first so a codeword freed in this same flush is back in the
    // pool's free list before the immediately-following claim runs its
    // sticky-reclaim pass. Without this ordering, a wrapper re-entering
    // the viewport in the same coalesced flush that another wrapper
    // released its old codeword couldn't re-grant it. This is what keeps
    // codeword identity stable across "leaves viewport, returns".
    if (this.pendingRelease.length > 0) {
      const labels = this.pendingRelease;
      this.pendingRelease = [];
      releasedCodewords.push(...labels);
      dirty = true;
      // Local + async SW notify. Returns codewords to the reservoir front
      // (so the immediately-following claim's sticky-reclaim can pick them
      // up) and fire-and-forgets the SW release.
      labelReservoir.release(labels);
    }

    if (this.pendingClaim.size > 0) {
      const queued = [...this.pendingClaim];
      this.pendingClaim.clear();

      // Claim in discovery order — no viewport-distance re-deal. Every
      // codeword is a two-word pair of equal speaking cost, so there's no
      // "give closer elements the cheaper codeword" to optimize; the old
      // rank-and-pair sort was pure overhead (and forced a layout per
      // wrapper). The pool's square-fill order (label-pool.ts:buildPool)
      // keeps the live prefix×suffix grid balanced for the two-stage voice
      // grammar regardless of which wrappers claim front-of-pool.
      const wrappers = queued;
      // Sticky reclaim: ask the reservoir to re-grant each wrapper's
      // previously-held codeword (if still in the local pool) so scroll-back
      // keeps the same letter.
      const preferred = wrappers.map(w => w.preferredCodeword ?? '');

      // Synchronous local claim — no IPC. The reservoir refills async when
      // it drops below threshold. If the pool is exhausted (no codewords
      // available locally yet), some slots come back as '' and those
      // wrappers stay unhinted until the next refill arrives; the level-
      // triggered reconcile will re-queue them on the next claim cycle.
      const labels = labelReservoir.claim(wrappers.length, preferred);

      for (let i = 0; i < wrappers.length; i++) {
        const wrapper = wrappers[i];
        const label = i < labels.length ? labels[i] : '';

        // Wrapper may have left the viewport between queue and flush. If
        // we still got a label for it, queue the release so the pool
        // doesn't leak.
        if (!wrapper.isInViewport) {
          if (label) this.pendingRelease.push(label);
          continue;
        }

        if (label) {
          wrapper.scanned.codeword = label;
          wrapper.tClaimed ??= performance.now();
          newlyClaimed.push(wrapper);
          dirty = true;
        }
        // No label → pool exhausted; wrapper stays unhinted. Will retry
        // on the next intersection event after a release frees a slot.
      }
    }

    if (dirty) this.events.onCodewordsChanged(newlyClaimed, releasedCodewords);

    // We may have queued more work during the await — typically extra
    // releases for late-leaving wrappers. Flush again.
    if (this.pendingClaim.size > 0 || this.pendingRelease.length > 0) {
      this.scheduleFlush();
    }
  }
}
