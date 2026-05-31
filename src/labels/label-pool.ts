/**
 * BranchKit Browser — Per-tab label pool.
 *
 * Frames in the same tab share a pool of codewords so that two frames
 * never independently pick the same label. Voice routing uses the
 * `assigned` map to find which frame owns a codeword.
 *
 * Design: notes/DESIGN_BROWSER_FRAMES_AND_OBSERVERS.md section 2.
 */

import { LabelStack } from '../types';

// Pool composition: 26×26 pairs = 676 codewords.
//
// All hints are uniform two-word pairs — no singles. This eliminates
// prefix ambiguity by construction: every first word is always a prefix,
// every hint always requires a second word. Same approach as Rango.
// Continuous Vosk recognition makes pairs flow as one utterance (~200ms),
// so the one-word advantage of singles is negligible.
//
// Ordering is BALANCED (square-fill): pairs are enumerated by expanding
// L-shaped shells where shell d holds every pair with max(prefix,suffix)==d.
// The first N codewords therefore always use ceil(sqrt(N)) DISTINCT prefixes
// AND ceil(sqrt(N)) DISTINCT suffixes — a balanced grid. Both spoken stages
// stay meaningful at every hint count: the prefix narrows the set and the
// suffix selects within it.
//
// This matters because both stages are real disambiguation steps. The plugin
// derives `browser_hints_prefix` *only* from prefixes present in claimed
// codewords (buildPrefixListData), and the per-prefix suffix collection only
// from suffixes claimed under that prefix. Codewords are claimed front-of-pool
// and released on viewport-leave, so the live set is roughly the in-viewport
// hints. A naive prefix-major order collapses the prefix stage on sparse pages
// (every hint is `a <suffix>`, only "a" is a usable prefix); suffix-major
// collapses the suffix stage (every hint is `<prefix> a`, the second word is
// always the same). Square-fill avoids both — with 16 visible hints you get a
// 4×4 grid of distinct prefixes × distinct suffixes.

/**
 * Build the codeword pool from a 26-word alphabet. All 676 pairs, ordered
 * by expanding square shells so the first N claims form a balanced
 * prefix×suffix grid. Returns null if the alphabet isn't usable.
 */
export function buildPool(alphabet: string[]): string[] | null {
  if (!Array.isArray(alphabet) || alphabet.length !== 26) return null;
  if (alphabet.some(w => typeof w !== 'string' || w.length === 0)) return null;

  const pool: string[] = [];
  // Shell d (max coord == d) contributes 2d+1 pairs; summed over d=0..25
  // this is 26² = 676. Within a shell: first the new suffix d across all
  // prefixes 0..d (the row), then the new prefix d across suffixes d-1..0
  // (the column), so each shell introduces exactly one new prefix and one
  // new suffix.
  for (let d = 0; d < 26; d++) {
    for (let p = 0; p <= d; p++) pool.push(`${alphabet[p]} ${alphabet[d]}`);
    for (let s = d - 1; s >= 0; s--) pool.push(`${alphabet[d]} ${alphabet[s]}`);
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
 * Claim `count` labels from a tab's pool for a specific frame. The result is
 * index-aligned to the request: `result[i]` is the codeword for slot i, or ''
 * when the pool ran out before reaching it. Returns [] if the pool isn't ready.
 *
 * `preferred[i]` is the codeword slot i held before it left the viewport.
 * Pass 1 re-grants any preferred codeword still in the free list, so an
 * element that scrolls out and back keeps the same letter (sticky reclaim —
 * kills scroll flicker). Pass 2 fills the remaining slots front-of-pool in
 * request order, preserving the balanced-grid ordering (and the closer-first
 * priority the IntersectionTracker encodes via rank-sorted request order).
 */
export async function claimLabels(
  tabId: number,
  frameId: number,
  count: number,
  preferred: string[] = [],
): Promise<string[]> {
  return withTabLock(tabId, async () => {
    const stack = await getOrCreateStack(tabId);
    if (!stack) return [];

    const result: string[] = new Array(count).fill('');
    const granted = new Set<string>();
    const freeSet = new Set(stack.free);

    // Pass 1 — sticky reclaim.
    const needsFresh: number[] = [];
    for (let i = 0; i < count; i++) {
      const pref = preferred[i];
      if (pref && freeSet.has(pref) && !granted.has(pref)) {
        granted.add(pref);
        result[i] = pref;
      } else {
        needsFresh.push(i);
      }
    }

    // Pass 2 — fresh, front-of-pool in request order.
    if (needsFresh.length > 0) {
      let k = 0;
      for (const label of stack.free) {
        if (k >= needsFresh.length) break;
        if (granted.has(label)) continue;
        granted.add(label);
        result[needsFresh[k]] = label;
        k++;
      }
    }

    if (granted.size > 0) {
      for (const label of granted) stack.assigned[label] = frameId;
      stack.free = stack.free.filter(l => !granted.has(l));
      await saveStack(tabId, stack);
      assignedCache.set(tabId, { ...stack.assigned });
    }
    return result;
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
 * Release every label held by a specific frame. Called when a frame is
 * detached without the whole tab going away (e.g. iframe removed from the
 * DOM). Wired to the per-frame liveness Port's `onDisconnect` in
 * `background.ts` — when a frame's content script tears down, its Port
 * disconnects and we reclaim its codewords here. The one residual gap is
 * the service-worker-idle window: if the SW is terminated when the frame
 * dies, `onDisconnect` may not fire until the SW next wakes, so the
 * reclaim is delayed (bounded by the 676-label pool capacity, not lost).
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
 * Clear a tab's stack. Called on tab close only (via `purgeTab`). Not used
 * for navigation — see the `purgeTab` comment in `background.ts` for why a
 * nav-time clear would corrupt the grammar.
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
