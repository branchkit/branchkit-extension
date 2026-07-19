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
// Minimum spacing between the two out-of-band strikes that confirm a release
// (see strikeOut). Matches the old sweep's ~100ms cadence intent; guards
// against two near-instant derivations (e.g. per-scan-batch reconciles)
// defeating the temporal hysteresis.
const EXIT_STRIKE_MIN_MS = 50;

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
  /**
   * An IO entry crossed the band edge (either direction). The tracker no
   * longer writes any wrapper state from entries — this is the wake-up
   * signal (DESIGN_OBSERVED_STATE_READ_TIME phase 3): the engine's
   * band-convergence pass derives membership from fresh rects and applies
   * claims/releases. Coalesced by the caller (passSoon single-flight).
   */
  onBandActivity: () => void;
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
  // Two-strike release ledger (temporal hysteresis, drill round 6): a
  // wrapper first seen out-of-band records a strike timestamp; only a second
  // out-of-band sighting >= EXIT_STRIKE_MIN_MS later releases. Guards the
  // destructive direction against a virtualizer transiently parking a
  // recycling shell at odd coordinates. WeakMap: entries GC with the wrapper.
  private exitStrikeAt: WeakMap<ElementWrapper, number> = new WeakMap();
  private flushScheduled = false;
  // Promise chain that serializes every doFlush. Without this, a flush
  // started by scheduleFlush's timer can be in mid-await on
  // CLAIM_LABELS while flushNow's `await this.flush()` starts a second
  // flush concurrently. The second sees an empty queue and returns
  // immediately, so flushNow resolves before the first claim finishes —
  // showBadges would then render badges before all wrappers have
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
   * Two-strike out-of-band ledger (temporal hysteresis for the destructive
   * direction — drill round 6, inherited from the deleted sweepBand). The
   * band-convergence pass calls `strikeOut` for a codeworded wrapper it
   * derived out-of-band: the first sighting records a timestamp; a second
   * sighting at least EXIT_STRIKE_MIN_MS later confirms the exit and the
   * caller releases. An in-band sighting clears the strike.
   */
  strikeOut(w: ElementWrapper, now: number): boolean {
    const first = this.exitStrikeAt.get(w);
    if (first === undefined) {
      this.exitStrikeAt.set(w, now);
      return false;
    }
    if (now - first < EXIT_STRIKE_MIN_MS) return false;
    this.exitStrikeAt.delete(w);
    return true;
  }

  clearExitStrike(w: ElementWrapper): void {
    this.exitStrikeAt.delete(w);
  }

  /**
   * Queue codeword claims for wrappers the caller just derived in-band by
   * fresh geometry (the engine's band-convergence pass — the single
   * store-claim path; DESIGN_OBSERVED_STATE_READ_TIME phase 3). The flush's
   * fresh-rect guard re-checks band membership at grant time, so a wrapper
   * that left between queue and flush returns its label to the pool.
   */
  queueClaims(wrappers: ElementWrapper[]): void {
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
   * entries (or the convergence pass queue more wrappers) by the time
   * it returns; we loop so showBadges sees a quiescent tracker.
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
    // Wake-up signal only (DESIGN_OBSERVED_STATE_READ_TIME phase 3): entries
    // write NO wrapper state and queue NO claims/releases — a dropped,
    // coalesced, or limbo-discarded entry costs one pass of latency, never a
    // standing lie. The engine's band-convergence pass derives membership
    // from fresh rects.
    const __t0 = performance.now();
    let activity = false;
    for (const entry of entries) {
      const wrapper = this.store.findWrapperFor(entry.target);
      if (!wrapper) continue;
      // Limbo wrappers hold their state by design (decision 3 of
      // DESIGN_WRAPPER_IDENTITY_STABILITY): preserve the pre-disconnect
      // lastRect snapshot for the rebind position-tiebreaker.
      if (wrapper.disconnectedAt !== null) continue;
      // Snapshot the latest rect for the limbo position-tiebreaker — a
      // free, current rect on every observation. entry.boundingClientRect
      // IS a DOMRectReadOnly at runtime; cast is safe.
      wrapper.lastRect = entry.boundingClientRect as DOMRect;
      activity = true;
    }
    if (activity) this.events.onBandActivity();
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

        // Wrapper may have left the band (or the DOM) between queue and
        // flush — re-derive from a fresh rect at grant time (the queue is
        // churn-bounded, so this is a handful of gBCRs per flush). If we
        // still got a label for it, queue the release so the pool doesn't
        // leak.
        let inBandNow = false;
        try {
          inBandNow = wrapper.element.isConnected && geometryInBand(
            wrapper.element.getBoundingClientRect(),
            window.innerWidth, window.innerHeight, VIEWPORT_MARGIN_PX,
          );
        } catch { /* detached mid-flush */ }
        if (!inBandNow) {
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
