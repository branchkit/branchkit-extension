/**
 * BranchKit Browser — Per-tab label pool.
 *
 * Frames in the same tab share a pool of codewords so that two frames
 * never independently pick the same label. Voice routing uses the
 * `assigned` map to find which frame owns a codeword.
 *
 * Design: notes/DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md §2.
 */

import { LabelStack } from './types';

// Pool composition: 17 singles + 9 prefixes × 26 pairs = 251 codewords.
// Matches DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md §2 ("26 singles + 9 prefix×26").
// Sprint C will replace this fixed split with the dynamic allocator from
// DESIGN_BROWSER_HINT_ALLOCATOR.md.
const SINGLES_COUNT = 17;
const PREFIXES_COUNT = 9;

/**
 * Build the codeword pool from a 26-word alphabet. Pool is ordered so the
 * cheapest hints (singles) sit at the front; splice from the start to claim
 * cheap labels first.
 *
 * Returns null if the alphabet isn't usable.
 */
export function buildPool(alphabet: string[]): string[] | null {
  if (!Array.isArray(alphabet) || alphabet.length !== 26) return null;
  if (alphabet.some(w => typeof w !== 'string' || w.length === 0)) return null;

  const pool: string[] = [];
  for (let i = 0; i < SINGLES_COUNT; i++) pool.push(alphabet[i]);
  for (let p = 0; p < PREFIXES_COUNT; p++) {
    const prefix = alphabet[SINGLES_COUNT + p];
    for (let s = 0; s < 26; s++) pool.push(`${prefix} ${alphabet[s]}`);
  }
  return pool;
}

const storageKey = (tabId: number) => `labelStack:${tabId}`;

// Per-tab promise chain that serializes all mutations on that tab.
// Two frames calling CLAIM_LABELS at the same time can't both splice the
// same labels because their work runs sequentially in this chain.
const tabLocks = new Map<number, Promise<unknown>>();

export function withTabLock<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
  const prev = tabLocks.get(tabId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  tabLocks.set(tabId, next);
  next.finally(() => {
    if (tabLocks.get(tabId) === next) tabLocks.delete(tabId);
  });
  return next;
}

async function loadStack(tabId: number): Promise<LabelStack | null> {
  const key = storageKey(tabId);
  const result = await chrome.storage.session.get(key);
  return (result[key] as LabelStack | undefined) ?? null;
}

async function saveStack(tabId: number, stack: LabelStack): Promise<void> {
  await chrome.storage.session.set({ [storageKey(tabId)]: stack });
}

async function getAlphabet(): Promise<string[] | null> {
  const result = await chrome.storage.local.get('alphabet');
  const a = result.alphabet;
  return Array.isArray(a) && a.length === 26 ? a : null;
}

/**
 * Get a tab's stack, creating it lazily on first access. Returns null if
 * the alphabet isn't loaded yet — callers treat that as "no labels
 * available right now"; content.ts already gates hint rendering on
 * alphabet presence.
 */
async function getOrCreateStack(tabId: number): Promise<LabelStack | null> {
  const existing = await loadStack(tabId);
  if (existing) return existing;

  const alphabet = await getAlphabet();
  if (!alphabet) return null;

  const pool = buildPool(alphabet);
  if (!pool) return null;

  const stack: LabelStack = { free: pool, assigned: {} };
  await saveStack(tabId, stack);
  return stack;
}

/**
 * Claim up to `count` labels from a tab's pool for a specific frame.
 * Returns fewer than `count` if the pool is partially exhausted, or empty
 * if the pool isn't ready.
 */
export async function claimLabels(tabId: number, frameId: number, count: number): Promise<string[]> {
  return withTabLock(tabId, async () => {
    const stack = await getOrCreateStack(tabId);
    if (!stack) return [];

    const take = Math.min(count, stack.free.length);
    const claimed = stack.free.splice(0, take);
    for (const label of claimed) stack.assigned[label] = frameId;

    await saveStack(tabId, stack);
    return claimed;
  });
}

/**
 * Release labels back to the pool. Labels not in `assigned` are silently
 * ignored — release is idempotent. Returned labels are unshifted en bloc
 * (preserving their original order) so an immediate re-claim of the same
 * count yields the same labels — important for hint stability across
 * rescans.
 */
export async function releaseLabels(tabId: number, labels: string[]): Promise<void> {
  return withTabLock(tabId, async () => {
    const stack = await loadStack(tabId);
    if (!stack) return;

    const toReturn: string[] = [];
    for (const label of labels) {
      if (label in stack.assigned) {
        delete stack.assigned[label];
        toReturn.push(label);
      }
    }
    if (toReturn.length > 0) {
      stack.free.unshift(...toReturn);
    }
    await saveStack(tabId, stack);
  });
}

/**
 * Look up which frame owns a codeword. Used to route voice/keyboard
 * actions to the correct frame.
 */
export async function getFrameForLabel(tabId: number, label: string): Promise<number | null> {
  const stack = await loadStack(tabId);
  return stack?.assigned[label] ?? null;
}

/**
 * Release every label held by a specific frame. Called when a frame is
 * removed (navigation, iframe destruction).
 */
export async function releaseFrame(tabId: number, frameId: number): Promise<void> {
  return withTabLock(tabId, async () => {
    const stack = await loadStack(tabId);
    if (!stack) return;

    const toRelease: string[] = [];
    for (const [label, owner] of Object.entries(stack.assigned)) {
      if (owner === frameId) toRelease.push(label);
    }
    for (const label of toRelease) {
      delete stack.assigned[label];
    }
    if (toRelease.length > 0) {
      stack.free.unshift(...toRelease);
    }
    await saveStack(tabId, stack);
  });
}

/**
 * Clear a tab's stack. Called on tab close or top-level navigation.
 */
export async function clearStack(tabId: number): Promise<void> {
  return withTabLock(tabId, async () => {
    await chrome.storage.session.remove(storageKey(tabId));
  });
}

/**
 * Regenerate every active stack with a new alphabet. Called when the voice
 * plugin pushes an updated alphabet — old codewords are invalid. All
 * frames will re-claim labels on their next scan.
 */
export async function regenerateAllStacks(): Promise<void> {
  const alphabet = await getAlphabet();
  if (!alphabet) return;
  const newPool = buildPool(alphabet);
  if (!newPool) return;

  const all = await chrome.storage.session.get();
  const updates: Record<string, LabelStack> = {};
  for (const key of Object.keys(all)) {
    if (key.startsWith('labelStack:')) {
      updates[key] = { free: [...newPool], assigned: {} };
    }
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.session.set(updates);
  }
}
