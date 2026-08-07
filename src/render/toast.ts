/**
 * BranchKit Browser — ephemeral toast.
 *
 * A brief, self-dismissing confirmation (e.g. "Copied URL") so actions with no
 * visible page effect still feel responsive. Shadow-DOM isolated, top frame
 * only, same visual family as the mode chip.
 *
 * Toasts mount into the shared bottom-right overlay stack (render/overlay-stack)
 * rather than floating on their own, so they can't overlap the mode chip / find
 * bar and can stack with each other: the newest lands nearest the corner and
 * pushes older ones up, each leaving on its own timer. Capped so a burst of
 * confirmations can't build a tower.
 */

import { mountInStack, reapStackIfEmpty } from './overlay-stack';

const HOST_ATTR = 'data-branchkit-toast';
const MAX_VISIBLE = 3;

// Position and z-index belong to the overlay stack now; this styles only the
// toast's own look and its fade.
const STYLE = `
:host { all: initial; }
.toast {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; font-weight: 600;
  color: #c9d1d9; background: #1c2128;
  border: 1px solid #3d444d; border-radius: 6px;
  padding: 6px 12px; box-shadow: 0 4px 14px rgba(1, 4, 9, 0.5);
  opacity: 0; transition: opacity 120ms ease;
}
.toast.show { opacity: 1; }
`;

interface ActiveToast {
  host: HTMLElement;
  timer: ReturnType<typeof setTimeout> | null;
}

// Oldest first; newest pushed onto the end (and, being latest in DOM order,
// rendered nearest the corner).
let active: ActiveToast[] = [];

function dismiss(t: ActiveToast): void {
  if (t.timer) clearTimeout(t.timer);
  t.host.remove();
  active = active.filter((x) => x !== t);
  reapStackIfEmpty();
}

/** Flash a short message for `ms` (default 1400). Top frame only. Stacks with
 * any toasts already up; a burst beyond MAX_VISIBLE evicts the oldest early. */
export function flashToast(text: string, ms = 1400): void {
  if (typeof document === 'undefined' || window !== window.top) return;

  while (active.length >= MAX_VISIBLE) dismiss(active[0]);

  const el = document.createElement('div');
  el.setAttribute(HOST_ATTR, '');
  el.setAttribute('data-branchkit-hint', ''); // page observers skip our nodes
  const shadow = el.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = text;
  shadow.append(style, toast);
  mountInStack(el, 'toast');

  const entry: ActiveToast = { host: el, timer: null };
  active.push(entry);

  requestAnimationFrame(() => toast.classList.add('show'));
  entry.timer = setTimeout(() => dismiss(entry), ms);
}

/** Test-only reset. */
export function _resetToastForTesting(): void {
  for (const t of active) {
    if (t.timer) clearTimeout(t.timer);
    t.host.remove();
  }
  active = [];
  reapStackIfEmpty();
}
