/**
 * Tab recency (MRU) stack — Layer 0 of notes/DESIGN_TAB_NAVIGATION.md.
 *
 * `stack[0]` is the most recently activated tab id. Backs the `last_active`
 * tab verb ("swap tab" / Shift+6) now; the fuzzy switcher's MRU default
 * ranking (Layer 2) reads the same stack later. Persisted in
 * chrome.storage.session so it survives MV3 service-worker restarts (tab ids
 * don't survive a browser restart, so neither should the stack).
 *
 * Pure stack ops are separated from the storage glue for unit testing,
 * mirroring tab-nav.ts.
 */

const MRU_KEY = 'tabMru';
const MRU_CAP = 50;

/** New stack with `tabId` on top, deduped, trimmed to `cap`. */
export function pushMru(stack: readonly number[], tabId: number, cap = MRU_CAP): number[] {
  const next = [tabId, ...stack.filter((id) => id !== tabId)];
  return next.length > cap ? next.slice(0, cap) : next;
}

/**
 * Candidate ids for "the tab before the current one", most recent first.
 * Excludes `currentTabId`; the caller walks the list skipping ids whose tab
 * no longer exists (closed tabs are not pruned from the stack).
 */
export function previousCandidates(
  stack: readonly number[],
  currentTabId: number | null,
): number[] {
  return stack.filter((id) => id !== currentTabId);
}

export async function loadMru(): Promise<number[]> {
  const got = await chrome.storage.session.get(MRU_KEY);
  const v = got[MRU_KEY];
  return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
}

/**
 * Record a tab activation. Read-modify-write without a lock: onActivated
 * bursts can lose a push, which only costs recency precision — acceptable
 * for a heuristic stack.
 */
export async function recordTabActivated(tabId: number): Promise<void> {
  const stack = await loadMru();
  await chrome.storage.session.set({ [MRU_KEY]: pushMru(stack, tabId) });
}
