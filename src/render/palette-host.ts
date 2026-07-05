/**
 * BranchKit Browser — command palette host (content-script side).
 *
 * Injects/removes the extension-served palette iframe (palette.html) over the
 * page. The iframe — not an in-page shadow DOM like the find bar — is the
 * isolation boundary: palette keystrokes reveal tab titles and command names,
 * and the host page must not be able to observe them (the Vomnibar rationale;
 * see notes/DESIGN_TAB_NAVIGATION.md, Layer 2). Everything interactive lives
 * in palette-page.ts inside the frame; this module only owns the element,
 * focus save/restore, and the close signal from the background.
 *
 * Top-frame only — content.ts's toggle handler relays subframe invocations up
 * through the background (PALETTE_OPEN → PALETTE_COMMAND at frame 0).
 */

const HOST_ATTR = 'data-branchkit-palette';
// One below max signed int — same tier as the help and debug overlays.
const Z_INDEX = 2_147_483_646;

let frame: HTMLIFrameElement | null = null;
let prevFocus: HTMLElement | null = null;

export function isPaletteOpen(): boolean {
  return frame !== null;
}

export function openPalette(): void {
  if (frame) return;
  prevFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const f = document.createElement('iframe');
  f.setAttribute(HOST_ATTR, '');
  // Tag as BranchKit's own UI so the page MutationObserver skips it (isOwnMutation).
  f.setAttribute('data-branchkit-hint', '');
  f.setAttribute('allowtransparency', 'true');
  f.src = chrome.runtime.getURL('palette.html');
  f.style.cssText =
    `position: fixed; inset: 0; width: 100vw; height: 100vh; border: 0; ` +
    `margin: 0; padding: 0; z-index: ${Z_INDEX}; background: transparent; ` +
    `color-scheme: normal; display: block;`;
  // Focus the frame once loaded so its query input receives keystrokes
  // immediately (the page inside focuses the input on init).
  f.addEventListener('load', () => {
    try { f.contentWindow?.focus(); } catch { f.focus(); }
  });
  document.documentElement.appendChild(f);
  frame = f;
}

export function closePalette(): void {
  if (!frame) return;
  frame.remove();
  frame = null;
  // Give focus back to wherever the user was typing/reading. A dispatch that
  // moves focus itself (focus_input, tab switch) runs after this and wins.
  if (prevFocus?.isConnected) {
    try { prevFocus.focus(); } catch { /* element became unfocusable */ }
  } else {
    window.focus();
  }
  prevFocus = null;
}

export function togglePalette(): void {
  if (frame) closePalette();
  else openPalette();
}
