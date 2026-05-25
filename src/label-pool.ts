/**
 * BranchKit Browser — Per-tab label pool.
 *
 * Frames in the same tab share a pool of codewords so that two frames
 * never independently pick the same label. Voice routing uses the
 * `assigned` map to find which frame owns a codeword.
 *
 * Design: notes/DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md section 2.
 */

import { LabelStack } from './types';

// Pool composition: 26×26 pairs = 676 codewords.
//
// All hints are uniform two-word pairs — no singles. This eliminates
// prefix ambiguity by construction: every first word is always a prefix,
// every hint always requires a second word. Same approach as Rango.
// Continuous Vosk recognition makes pairs flow as one utterance (~200ms),
// so the one-word advantage of singles is negligible.

/**
 * Build the codeword pool from a 26-word alphabet. All pairs, ordered by
 * prefix then suffix. Returns null if the alphabet isn't usable.
 */
export function buildPool(alphabet: string[]): string[] | null {
  if (!Array.isArray(alphabet) || alphabet.length !== 26) return null;
  if (alphabet.some(w => typeof w !== 'string' || w.length === 0)) return null;

  const pool: string[] = [];
  for (let p = 0; p < 26; p++) {
    for (let s = 0; s < 26; s++) pool.push(`${alphabet[p]} ${alphabet[s]}`);
  }
  return pool;
}

const storageKey = (tabId: number) => `labelStack:${tabId}`;

// In-memory mirror of each tab's assigned map. Avoids chrome.storage.session
// IPC (~1-5ms) on the hot path — getFrameForLabel is called on every voice
// action. Mutators (claim/release/clear/regenerate) keep this in sync.
const assignedCache = new Map<number, Record<string, number>>();

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
  assignedCache.set(tabId, {});
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
    assignedCache.set(tabId, { ...stack.assigned });
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
    assignedCache.set(tabId, { ...stack.assigned });
  });
}

/**
 * Look up which frame owns a codeword. Used to route voice/keyboard
 * actions to the correct frame.
 */
export async function getFrameForLabel(tabId: number, label: string): Promise<number | null> {
  const cached = assignedCache.get(tabId);
  if (cached) return cached[label] ?? null;
  const stack = await loadStack(tabId);
  if (stack) assignedCache.set(tabId, { ...stack.assigned });
  return stack?.assigned[label] ?? null;
}

/**
 * Release every label held by a specific frame. Should be called when a
 * frame is detached without the whole tab going away (e.g. iframe
 * removed from the DOM). Currently NOT wired — Chrome's only signal for
 * this without `webNavigation` permission is unreliable. Frames that
 * detach mid-page leak their codewords until the tab closes; in practice
 * this is rare and bounded by the 676-label pool capacity. Wiring this
 * up is a Sprint B task once the manifest gains `webNavigation` access
 * for IntersectionObserver gating.
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
    assignedCache.set(tabId, { ...stack.assigned });
  });
}

/**
 * Clear a tab's stack. Called on tab close or top-level navigation.
 */
export async function clearStack(tabId: number): Promise<void> {
  return withTabLock(tabId, async () => {
    assignedCache.delete(tabId);
    await chrome.storage.session.remove(storageKey(tabId));
  });
}

/**
 * Clear every per-tab label stack from chrome.storage.session. Called
 * on SW startup (onInstalled / onStartup) to release labels that
 * were assigned to content-script frames whose Ports never fired
 * onDisconnect (typical for SW idle-termination cycles and extension
 * reload). Without this, the per-tab pool can stay near-exhausted
 * indefinitely — claims return empty arrays, scans produce zero-
 * codeword batches, and badges never paint.
 *
 * Label stability across SW restart is sacrificed by this clear, but
 * the alternative (silent pool exhaustion) is worse UX. Content
 * scripts on already-open tabs re-claim from the freshly-empty pool
 * on their next scan, getting head-of-pool codewords just like a
 * cold-start.
 */
export async function clearAllStacks(): Promise<void> {
  assignedCache.clear();
  const all = await chrome.storage.session.get();
  const stackKeys = Object.keys(all).filter(k => k.startsWith('labelStack:'));
  if (stackKeys.length > 0) {
    await chrome.storage.session.remove(stackKeys);
  }
}

/**
 * Strict order-preserving equality on two alphabet arrays. Used by
 * `storeAlphabet` to short-circuit redundant pool churn — voice
 * re-pushes the alphabet on a hot path, and a `regenerateAllStacks` call
 * for a no-op change creates a race window between the pool wipe and
 * the `chrome.storage.onChanged` listener (which Chrome suppresses when
 * the stored value didn't actually change), letting new wrappers claim
 * codewords that existing wrappers still hold locally.
 */
export function alphabetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Regenerate every active stack with a new alphabet. Called when the voice
 * plugin pushes an updated alphabet — old codewords are invalid. All
 * frames will re-claim labels on their next scan.
 *
 * Each tab's reset goes through its own withTabLock so an in-flight
 * claim or release can't race the regeneration and overwrite the new
 * pool with stale state. Tabs regenerate in parallel, but each tab's
 * regenerate-then-anyone-else order is preserved.
 */
export async function regenerateAllStacks(): Promise<void> {
  const alphabet = await getAlphabet();
  if (!alphabet) return;
  const newPool = buildPool(alphabet);
  if (!newPool) return;

  const all = await chrome.storage.session.get();
  const tabIds = Object.keys(all)
    .filter(k => k.startsWith('labelStack:'))
    .map(k => Number.parseInt(k.slice('labelStack:'.length), 10))
    .filter(n => Number.isFinite(n));

  await Promise.all(tabIds.map(tabId =>
    withTabLock(tabId, async () => {
      assignedCache.set(tabId, {});
      await chrome.storage.session.set({
        [storageKey(tabId)]: { free: [...newPool], assigned: {} },
      });
    })
  ));
}
