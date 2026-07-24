/**
 * BranchKit Browser — per-tab session upkeep (service-worker side).
 *
 * The June section-4 target that hadn't landed: purgeTab (label stack +
 * codeword memory on tab close), the SPA-rescan coalescer, the dead-tab
 * label-stack sweep, and the tab-switch breadcrumb. The chrome.* listeners
 * that drive these stay in background.ts (wiring); this module owns the
 * policy + per-tab maps. Lifted per notes/DESIGN_RESTRUCTURE_ROUND3.md.
 */

import { Message } from '../types';
import { clearStack, sweepDeadStacks } from '../labels/label-pool';
import { clearCodewordMemory } from '../labels/codeword-memory';
import { forwardDebugLog } from '../plugin/plugin-api';

// Clear a tab's label pool when the tab is closed (the sole call site is
// `chrome.tabs.onRemoved`). NOT called on navigation, and deliberately so:
// cross-document nav reclaims per-frame via the liveness Port's onDisconnect,
// and same-document (SPA) nav keeps the content script alive — it releases its
// own codewords through limbo→finalize, so a purge here would race that local
// ownership and corrupt the grammar. See notes/DESIGN_EXTENSION_RESTRUCTURE.md
// section 5 step 3 (dropped 2026-05-30).
export function purgeTab(tabId: number): void {
  clearStack(tabId).catch(() => {});
  // Codeword memory is meant to survive frame teardown (the point of Regime B),
  // but not the tab's whole lifetime — drop it on tab close.
  clearCodewordMemory(tabId).catch(() => {});
}

export async function logTabSwitch(reason: string, oldTabId: number | null, newTabId: number | null): Promise<void> {
  const lookup = async (id: number | null): Promise<{ id: number | null; url: string; title: string }> => {
    if (id == null) return { id: null, url: '', title: '' };
    try {
      const t = await chrome.tabs.get(id);
      return { id, url: t.url ?? '', title: t.title ?? '' };
    } catch {
      return { id, url: '<gone>', title: '' };
    }
  };
  const [from, to] = await Promise.all([lookup(oldTabId), lookup(newTabId)]);
  forwardDebugLog('tab_switch', { reason, from, to });
}

// --- SPA-rescan coalescing ---

const SPA_RESCAN_DEBOUNCE_MS = 150;
const spaRescanTimers = new Map<number, ReturnType<typeof setTimeout>>();
const spaLastRescanDispatch = new Map<number, { url: string; at: number }>();
const SPA_RESCAN_DEDUP_MS = 2000;

// Coalesce bursts of same-document URL changes (SPAs often fire several
// pushState/replaceState calls settling on one route) into a single
// bounded rescan per tab. The 150ms debounce alone doesn't catch SPAs that
// re-announce the SAME route wider apart (YouTube Shorts pushes /shorts/<id>
// then canonicalizes it 200ms–1s later — each advance dispatched 2–4 full
// rescan cycles, landing exactly while the new video primes its buffers), so
// an identical-URL dispatch within SPA_RESCAN_DEDUP_MS is suppressed — the
// CS already rescanned this route; residual DOM churn is the generic
// mutation path's job. Suppressions are breadcrumbed, never silent.
export function scheduleSpaRescan(tabId: number, url: string): void {
  const last = spaLastRescanDispatch.get(tabId);
  if (last && last.url === url && Date.now() - last.at < SPA_RESCAN_DEDUP_MS) {
    forwardDebugLog('pipeline.bg_rescan_deduped', { tab_id: tabId, source: 'spa_nav' });
    return;
  }
  const existing = spaRescanTimers.get(tabId);
  if (existing) clearTimeout(existing);
  spaRescanTimers.set(tabId, setTimeout(() => {
    spaRescanTimers.delete(tabId);
    spaLastRescanDispatch.set(tabId, { url, at: Date.now() });
    forwardDebugLog('pipeline.bg_rescan_dispatched', { tab_id: tabId, source: 'spa_nav' });
    chrome.tabs.sendMessage(tabId, {
      type: 'BRANCHKIT_ACTION',
      payload: { action: 'rescan', params: { from_cache: 'true', reason: 'spa_nav' } },
    } as Message).catch(() => {});
  }, SPA_RESCAN_DEBOUNCE_MS));
}

// Tab closed: cancel any pending rescan and forget its dedup entry.
export function cancelSpaRescan(tabId: number): void {
  const pending = spaRescanTimers.get(tabId);
  if (pending) {
    clearTimeout(pending);
    spaRescanTimers.delete(tabId);
  }
  spaLastRescanDispatch.delete(tabId);
}

// --- Dead-tab label-stack sweep (long-session audit finding 6) ---

// tabs.onRemoved and the liveness Port's onDisconnect both miss when this
// background is asleep at the moment a tab dies. Chrome heals on the next SW
// recycle (init → clearAllStacks), but the persistent Firefox background can
// run for days — missed reclaims accumulate until the pool exhausts, claims
// return empty, and badges silently stop painting ("restart fixes it").
// Level-triggered reclaim: every 15 min, purge tracked stacks whose tab no
// longer exists (mirrors purgeTab: stack + codeword memory). setInterval,
// not chrome.alarms, on purpose — the leak only matters while THIS
// background instance stays alive; a fresh instance heals in init.
const DEAD_TAB_SWEEP_MS = 15 * 60_000;

async function sweepDeadTabState(): Promise<void> {
  try {
    const swept = await sweepDeadStacks(async () => {
      const tabs = await chrome.tabs.query({});
      const alive = new Set<number>();
      for (const t of tabs) if (typeof t.id === 'number') alive.add(t.id);
      return alive;
    });
    for (const tabId of swept) clearCodewordMemory(tabId).catch(() => {});
    if (swept.length > 0) {
      console.info('[BranchKit] dead-tab sweep reclaimed label stacks for tabs:', swept.join(','));
    }
  } catch {
    // tabs API unavailable (shutdown) — next tick or next init covers it.
  }
}

// Called once from background.ts.
export function startDeadTabSweep(): void {
  setInterval(sweepDeadTabState, DEAD_TAB_SWEEP_MS);
}
