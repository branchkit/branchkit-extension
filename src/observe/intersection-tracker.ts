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

const VIEWPORT_MARGIN = '200px';
const FLUSH_DEBOUNCE_MS = 50;

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
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
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
   * Force pending work to flush. Awaitable. Drains until both queues are
   * stable — a doFlush awaiting CLAIM_LABELS may have IO fire more
   * entries (or refreshViewportClaims push more wrappers) by the time
   * it returns; we loop so showHints sees a quiescent tracker.
   */
  async flushNow(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
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
      // The badge can't follow a wrapper that's lost its codeword — its
      // label would resolve to "?". Tear it down; the next showHints will
      // re-mount if the user scrolls back.
      if (wrapper.hint) {
        wrapper.hint.remove();
        wrapper.hint = null;
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.enqueueFlush();
    }, FLUSH_DEBOUNCE_MS);
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
    // sticky-reclaim pass (claimLabels pass 1). Without this ordering, a
    // wrapper re-entering the viewport in the same coalesced flush that
    // another wrapper released its old codeword couldn't re-grant it. This is
    // what keeps codeword identity stable across "leaves viewport, returns".
    if (this.pendingRelease.length > 0) {
      const labels = this.pendingRelease;
      this.pendingRelease = [];
      releasedCodewords.push(...labels);
      dirty = true;
      try {
        await chrome.runtime.sendMessage({ type: 'RELEASE_LABELS', labels });
      } catch {
        /* extension context may be invalidated */
      }
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
      // Sticky reclaim: ask the pool to re-grant each wrapper's previously-held
      // codeword (if still free) so scroll-back keeps the same letter.
      const preferred = wrappers.map(w => w.preferredCodeword);

      let labels: string[] = [];
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CLAIM_LABELS',
          count: wrappers.length,
          preferred,
        });
        labels = Array.isArray(response?.labels) ? response.labels : [];
      } catch {
        labels = [];
      }

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
