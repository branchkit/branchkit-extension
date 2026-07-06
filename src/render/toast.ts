/**
 * BranchKit Browser — ephemeral toast.
 *
 * A brief, self-dismissing confirmation (e.g. "Copied URL") so actions with no
 * visible page effect still feel responsive. Shadow-DOM isolated, top frame
 * only, same visual family as the mode chip.
 */

const HOST_ATTR = 'data-branchkit-toast';
const Z_INDEX = 2_147_483_645;

let host: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const STYLE = `
:host { all: initial; }
.toast {
  position: fixed; bottom: 48px; left: 50%; transform: translateX(-50%);
  z-index: ${Z_INDEX};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px; font-weight: 600;
  color: #c9d1d9; background: #1c2128;
  border: 1px solid #3d444d; border-radius: 6px;
  padding: 6px 12px; box-shadow: 0 4px 14px rgba(1, 4, 9, 0.5);
  opacity: 0; transition: opacity 120ms ease;
}
.toast.show { opacity: 1; }
`;

/** Flash a short message for `ms` (default 1400). Top frame only. */
export function flashToast(text: string, ms = 1400): void {
  if (typeof document === 'undefined' || window !== window.top) return;
  if (timer) { clearTimeout(timer); timer = null; }
  if (host) { host.remove(); host = null; }

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
  document.documentElement.appendChild(el);
  host = el;

  requestAnimationFrame(() => toast.classList.add('show'));
  timer = setTimeout(() => {
    host?.remove();
    host = null;
    timer = null;
  }, ms);
}

/** Test-only reset. */
export function _resetToastForTesting(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  host?.remove();
  host = null;
}
