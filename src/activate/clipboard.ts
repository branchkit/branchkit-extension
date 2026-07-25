/**
 * Copy text to the clipboard from a content script. Tries the async Clipboard
 * API, then falls back to a hidden-textarea `execCommand('copy')`. The
 * `clipboardWrite` manifest permission makes both paths work WITHOUT a user
 * gesture — required for voice-triggered copies ("copy that", "copy url"),
 * which arrive over SSE with no transient activation: Firefox gates gestureless
 * `writeText` on it, Chrome gates gestureless `execCommand('copy')` on it.
 * Returns false if both paths fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    ta.setAttribute('data-branchkit-hint', ''); // page observers skip our nodes
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
