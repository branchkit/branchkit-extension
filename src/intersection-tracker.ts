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

import { ElementWrapper, WrapperStore, wrapperToCandidate } from './element-wrapper';
import { HintCandidate, getFocusPoint, rankByDistance } from './allocator';

const VIEWPORT_MARGIN = '200px';
const FLUSH_DEBOUNCE_MS = 50;

export interface TrackerEvents {
  /** Called after a flush that may have changed any wrapper's codeword. */
  onCodewordsChanged: () => void;
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
   * Re-queue every viewport-visible wrapper for claim. Used after the
   * pool is regenerated (e.g. alphabet changed) so the tracker walks
   * the existing store rather than waiting for IO entries that won't
   * fire until the user scrolls.
   */
  refreshViewportClaims(): void {
    for (const w of this.store.all) {
      if (w.isInViewport && !w.scanned.codeword) {
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
    for (const entry of entries) {
      const wrapper = this.store.findWrapperFor(entry.target);
      if (!wrapper) continue;
      wrapper.isInViewport = entry.isIntersecting;

      if (entry.isIntersecting) {
        // Want a codeword if we don't already have one.
        if (!wrapper.scanned.codeword) {
          this.pendingClaim.add(wrapper);
        }
      } else {
        // Cancel any pending claim — the wrapper went off-screen before
        // we got around to claiming for it.
        this.pendingClaim.delete(wrapper);
        if (wrapper.scanned.codeword) {
          this.pendingRelease.push(wrapper.scanned.codeword);
          wrapper.scanned.codeword = '';
          wrapper.label = null;
          // The badge can't follow a wrapper that's lost its codeword —
          // its label would resolve to "?". Tear it down; the next
          // showHints will re-mount if the user scrolls back.
          if (wrapper.hint) {
            wrapper.hint.remove();
            wrapper.hint = null;
          }
        }
      }
    }
    this.scheduleFlush();
  };

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

    // Releases first so reclaimed labels are at the front of the pool's
    // free list when the immediately-following claim fires. This is what
    // keeps codeword identity stable across "leaves viewport, returns"
    // for the same element.
    if (this.pendingRelease.length > 0) {
      const labels = this.pendingRelease;
      this.pendingRelease = [];
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

      // Rank-aware allocation: closer-to-focus wrappers get the cheap
      // (front-of-pool, single-word) codewords. The pool already orders
      // singles before pairs (see label-pool.ts:buildPool); pairing
      // pool order with rank order delivers the design's "cheap hints
      // for visible elements" promise without a multi-metric chooser.
      // (Sprint C path 1; DESIGN_BROWSER_HINT_ALLOCATOR.md section 2.)
      //
      // getBoundingClientRect forces layout, so candidates are
      // materialized once and reused for every comparison rather than
      // recomputed inside the comparator.
      const focus = getFocusPoint();
      const cmp = rankByDistance(focus);
      type Pair = { wrapper: ElementWrapper; candidate: HintCandidate };
      const pairs: Pair[] = queued.map(w => ({
        wrapper: w,
        candidate: wrapperToCandidate(w),
      }));
      pairs.sort((a, b) => cmp(a.candidate, b.candidate));
      const wrappers = pairs.map(p => p.wrapper);

      let labels: string[] = [];
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'CLAIM_LABELS',
          count: wrappers.length,
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
          dirty = true;
        }
        // No label → pool exhausted; wrapper stays unhinted. Will retry
        // on the next intersection event after a release frees a slot.
      }
    }

    if (dirty) this.events.onCodewordsChanged();

    // We may have queued more work during the await — typically extra
    // releases for late-leaving wrappers. Flush again.
    if (this.pendingClaim.size > 0 || this.pendingRelease.length > 0) {
      this.scheduleFlush();
    }
  }
}
