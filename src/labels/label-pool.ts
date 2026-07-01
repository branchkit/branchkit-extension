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
import { LETTERS_26 } from './words';

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

// In-memory mirror of each tab's full LabelStack. Avoids chrome.storage.session
// reads + writes on every claim/release (each was ~5-15ms, the dominant chunk
// of badge-paint latency during scroll). storage.session is still the durable
// store — we write through asynchronously so an SW restart restores state.
const stackCache = new Map<number, LabelStack>();

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
  const cached = stackCache.get(tabId);
  if (cached) return cached;
  const key = storageKey(tabId);
  const result = await chrome.storage.session.get(key);
  const stack = (result[key] as LabelStack | undefined) ?? null;
  if (stack) stackCache.set(tabId, stack);
  return stack;
}

async function saveStack(tabId: number, stack: LabelStack): Promise<void> {
  // Update the in-memory cache synchronously — that's what subsequent
  // claims/releases will read. Persist to storage.session asynchronously
  // (fire-and-forget) so an SW restart can rebuild the cache. We do NOT
  // await the storage write because doing so was the dominant per-claim
  // cost on the hot path, with no functional consequence: the worst case
  // of a missed write is one tab's stack reset to free-pool on SW restart,
  // which is bounded by the level-triggered reconciler's re-claim.
  stackCache.set(tabId, stack);
  chrome.storage.session.set({ [storageKey(tabId)]: stack }).catch(() => {
    /* SW context invalidated during shutdown — write was best-effort */
  });
}

// The pool builds its tokens from the fixed, extension-owned 26-letter
// alphabet — not BranchKit's codeword alphabet. Letters are the cross-frame
// identity, available with BranchKit absent, and stable across alphabet
// changes (so connecting voice never churns hint identities). Async to keep
// the call sites unchanged.
async function getAlphabet(): Promise<string[] | null> {
  return LETTERS_26;
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

  const stack: LabelStack = { free: pool, reserved: {}, assigned: {} };
  await saveStack(tabId, stack);
  assignedCache.set(tabId, {});
  return stack;
}

/** Defensive: pre-PR-6 stacks loaded from chrome.storage.session have no
 * `reserved` field. Initialise it lazily on first access so the migration
 * is a no-op for users with persisted state. */
function ensureReservedField(stack: LabelStack): void {
  if (!stack.reserved) stack.reserved = {};
}

/**
 * Reserve `count` labels from a tab's pool for a specific frame. The result is
 * index-aligned to the request: `result[i]` is the codeword for slot i, or ''
 * when the pool ran out before reaching it. Returns [] if the pool isn't ready.
 *
 * Reserved codewords are NOT routable yet — the frame's reservoir holds them
 * but no wrapper has committed. Voice activations for reserved-only codewords
 * fall through to the broadcast-to-all-frames fallback. A subsequent
 * CONFIRM_LABELS message promotes the entries from `reserved` to `assigned`,
 * at which point routing locks to the confirming frame.
 *
 * `preferred[i]` is the codeword slot i held before it left the viewport.
 * Pass 1 re-grants any preferred codeword still in the free list OR already
 * reserved to this frame (the latter handles the sticky-reclaim-across-
 * reservoir-refills case). Pass 2 fills the remaining slots front-of-pool in
 * request order, preserving the pool's balanced square-fill ordering so the
 * live prefix×suffix grid stays balanced for the two-stage voice grammar.
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
    ensureReservedField(stack);

    const result: string[] = new Array(count).fill('');
    const granted = new Set<string>();
    const freeSet = new Set(stack.free);

    // Pass 1 — sticky reclaim. Includes codewords this frame already has
    // reserved (a reservoir-internal cycle) so a wrapper that came back
    // into viewport before a reservoir refill flushed gets the same letter.
    const needsFresh: number[] = [];
    for (let i = 0; i < count; i++) {
      const pref = preferred[i];
      const stillReservedToThisFrame = pref && stack.reserved[pref] === frameId;
      if (pref && (freeSet.has(pref) || stillReservedToThisFrame) && !granted.has(pref)) {
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
      for (const label of granted) stack.reserved[label] = frameId;
      stack.free = stack.free.filter(l => !granted.has(l));
      await saveStack(tabId, stack);
      // assignedCache still mirrors `stack.assigned` only — reserved
      // entries aren't routable until confirmed.
    }
    return result;
  });
}

/**
 * Confirm that wrappers in `frameId` now hold `labels` — an ARBITRATED
 * exchange (review bug #5 / epoch-handshake Phase 4), not a silent promote.
 * Called by the extension's reservoir after `claim()` actually hands
 * codewords to wrappers (vs. just refilling the local cache). Per label:
 *
 *   - `reserved[label] === frameId` → promote to assigned (the normal path).
 *   - `assigned[label] === frameId` → already ours; idempotent no-op.
 *   - in `free` → ACQUIRE directly (free → assigned[frameId]). This is the
 *     released-then-locally-reclaimed case: the frame released the codeword
 *     (RELEASE moved it to free) and then its reservoir re-granted it from
 *     the local cache. Pre-fix this was a silent no-op, so the pool kept the
 *     codeword free and could hand it to ANOTHER frame while this frame's
 *     wrapper still held it — the cross-frame duplicate the pool exists to
 *     prevent.
 *   - reserved/assigned to a DIFFERENT frame, or unknown to the pool (stale
 *     alphabet string) → REJECTED. The other frame won the race; the caller
 *     must drop the codeword locally and re-claim fresh.
 */
export async function confirmLabels(
  tabId: number,
  frameId: number,
  labels: string[],
): Promise<{ rejected: string[] }> {
  return withTabLock(tabId, async () => {
    const stack = await loadStack(tabId);
    // Pool not ready: nothing to arbitrate — treat as accepted (the frame's
    // codewords stay locally held; routing falls back to broadcast until a
    // later confirm lands on a live pool). Rejecting here would nuke every
    // wrapper on a transient stack miss.
    if (!stack) return { rejected: [] };
    ensureReservedField(stack);

    const rejected: string[] = [];
    let changed = false;
    for (const label of labels) {
      if (stack.reserved[label] === frameId) {
        delete stack.reserved[label];
        stack.assigned[label] = frameId;
        changed = true;
      } else if (stack.assigned[label] === frameId) {
        // already ours — idempotent re-confirm
      } else if (label in stack.reserved || label in stack.assigned) {
        rejected.push(label); // another frame owns it
      } else {
        const idx = stack.free.indexOf(label);
        if (idx !== -1) {
          stack.free.splice(idx, 1);
          stack.assigned[label] = frameId;
          changed = true;
        } else {
          rejected.push(label); // unknown to the pool (stale alphabet etc.)
        }
      }
    }
    if (changed) {
      await saveStack(tabId, stack);
      assignedCache.set(tabId, { ...stack.assigned });
    }
    return { rejected };
  });
}

/**
 * Release labels back to the pool — frame-scoped. Only labels the calling
 * frame actually owns (assigned or reserved to `frameId`) are freed; the
 * rest are silently ignored, so release stays idempotent for the owner.
 *
 * The owner check is load-bearing (review 2026-06-29, owner-blind release):
 * a frame can hold a STALE local copy of a codeword another frame won in
 * confirm arbitration — its wrapper released in the release-vs-confirm
 * window, or its reservoir kept the string after a rejection. An unscoped
 * release from that frame would free the winner's live assignment: the
 * winner's badge keeps painting but stops routing, and the pool can re-issue
 * the codeword to a third frame — the cross-frame duplicate the pool exists
 * to prevent. Same arbitration rule `confirmLabels` applies to `reserved`.
 *
 * Returned labels are unshifted en bloc (preserving their original order)
 * so an immediate re-claim of the same count yields the same labels —
 * important for hint stability across rescans.
 */
export async function releaseLabels(tabId: number, frameId: number, labels: string[]): Promise<void> {
  return withTabLock(tabId, async () => {
    const stack = await loadStack(tabId);
    if (!stack) return;
    ensureReservedField(stack);

    const toReturn: string[] = [];
    for (const label of labels) {
      // A label is in exactly one of assigned / reserved / free at a time;
      // check both owned states so release works pre- and post-confirm.
      if (stack.assigned[label] === frameId) {
        delete stack.assigned[label];
        toReturn.push(label);
      } else if (stack.reserved[label] === frameId) {
        delete stack.reserved[label];
        toReturn.push(label);
      }
    }
    if (toReturn.length === 0) return;
    stack.free.unshift(...toReturn);
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
    ensureReservedField(stack);

    const toRelease: string[] = [];
    for (const [label, owner] of Object.entries(stack.assigned)) {
      if (owner === frameId) toRelease.push(label);
    }
    for (const label of toRelease) {
      delete stack.assigned[label];
    }
    // Reservoir-held labels for the dying frame must also come back — they
    // were pre-allocated to this frame's reservoir, no wrapper ever
    // confirmed, and now there's no frame left to confirm them.
    for (const [label, owner] of Object.entries(stack.reserved)) {
      if (owner === frameId) toRelease.push(label);
    }
    for (const label of toRelease) {
      delete stack.reserved[label];
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
    stackCache.delete(tabId);
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
  stackCache.clear();
  const all = await chrome.storage.session.get();
  const stackKeys = Object.keys(all).filter(k => k.startsWith('labelStack:'));
  if (stackKeys.length > 0) {
    await chrome.storage.session.remove(stackKeys);
  }
}

/**
 * Strict order-preserving equality on two alphabet arrays. Used by
 * `storeAlphabet` to short-circuit a redundant alphabet write: voice re-pushes
 * the alphabet on a hot path (almost all identical), and each distinct write
 * wakes every content script into a needless grammar re-push + re-render.
 */
export function alphabetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
