/**
 * BranchKit Browser — shared bottom-right overlay stack.
 *
 * The mode chip, find bar, committed find pill, and copy toast all want the
 * bottom-right corner. Historically each appended itself to the page
 * independently and coordinated only by a z-index handshake — which stops them
 * fighting over depth but does nothing about *position*, so two of them in the
 * corner at once render on top of each other.
 *
 * This is the one place they mount instead. A single fixed, bottom-anchored
 * flex column: CSS flow lays the members out end-to-end, so overlap is
 * structurally impossible — no pixel-offset math, no per-surface z tiers.
 *
 * Anchored at the bottom, so the container grows UPWARD and the corner edge
 * stays pinned: persistent members (mode chip, find bar) never move when a
 * transient toast comes or goes. Members order corner-outward via CSS `order`
 * (see StackSlot). Within the toast lane, the newest appended lands nearest the
 * corner and pushes older ones up — "newest at the active edge, older rise".
 *
 * The container is a LIGHT-DOM `<div>`, not a shadow host: the find bar already
 * lives in light DOM by choice, and its count element, the reload orphan sweep,
 * and its test surface all reach it via `document.querySelector`. A shadow
 * boundary here would break those for no gain. Members that want style
 * isolation (mode chip, toast) keep their own shadow roots — reparenting them
 * doesn't touch that. Top frame only. See notes/DESIGN_HUD_STACKING.md.
 */

const HOST_ATTR = 'data-branchkit-overlay-stack';
// One tier for the whole corner family, just below the help/palette modal tier
// (2147483646) so a full-viewport modal correctly covers the corner. This drops
// the find bar from max — accepted; see the design note's z-index section.
const Z_INDEX = 2_147_483_645;

/**
 * Where a member sits in the column, corner-outward. Rendered as the CSS `order`
 * property, so lower = higher up the column (further from the corner), higher =
 * nearer the corner. The find bar takes focus and holds the cursor, so it sits
 * at the corner; the mode chip is a quieter status above it; transient toasts
 * churn at the top.
 */
export type StackSlot = 'toast' | 'mode' | 'find';

const SLOT_ORDER: Record<StackSlot, number> = {
  toast: 10, // top — transient lane
  mode: 20, // middle — persistent status
  find: 30, // corner — focused input
};

let host: HTMLElement | null = null;

/** The stack container, creating it lazily on first use. Top frame only —
 * returns null off the top frame or before a document exists. */
function ensureStack(): HTMLElement | null {
  if (typeof document === 'undefined' || window !== window.top) return null;
  if (host?.isConnected) return host;

  const el = document.createElement('div');
  el.setAttribute(HOST_ATTR, '');
  // Tag as BranchKit's own UI so the page MutationObserver — and our own
  // scanner (closest('[data-branchkit-hint]')) — skips it and everything in it.
  el.setAttribute('data-branchkit-hint', '');
  // Layout only; each member styles its own look. The container is a transparent
  // scaffold sized to its content in the corner — pointer-events off so its
  // (invisible) box can't eat clicks, re-enabled per member.
  el.style.cssText = `
    position: fixed; bottom: 12px; right: 12px; z-index: ${Z_INDEX};
    display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
    pointer-events: none;
  `;
  document.body.appendChild(el);
  host = el;
  return el;
}

/**
 * Mount a member into the shared stack at the given slot. The child keeps its
 * own identity (shadow host, data attrs, event listeners) — this only reparents
 * it and assigns its column position and pointer-events. Idempotent: re-mounting
 * a child already in the stack just re-asserts its slot.
 */
export function mountInStack(child: HTMLElement, slot: StackSlot): void {
  const stack = ensureStack();
  if (!stack) return;
  child.style.order = String(SLOT_ORDER[slot]);
  child.style.pointerEvents = 'auto';
  stack.appendChild(child);
}

/**
 * When the last member leaves, tear the host down so we don't leave an empty
 * fixed-position scaffold on the page. Callers remove their own child, then
 * call this.
 */
export function reapStackIfEmpty(): void {
  if (host && host.childElementCount === 0) {
    host.remove();
    host = null;
  }
}

/**
 * Remove any orphaned stack hosts left on the page by a previous script instance
 * (an extension reload mid-session leaves the old script's corner UI painting
 * with nobody owning it). Called from the boot orphan sweep, before this script
 * mounts anything, so it only ever reaches orphans.
 */
export function purgeOrphanedOverlayStacks(): void {
  for (const el of document.querySelectorAll(`[${HOST_ATTR}]`)) el.remove();
  host = null;
}

/** Test-only: the stack container, or null if not mounted. */
export function _stackForTesting(): HTMLElement | null {
  return host;
}

/** Test-only reset. */
export function _resetOverlayStackForTesting(): void {
  host?.remove();
  host = null;
}
