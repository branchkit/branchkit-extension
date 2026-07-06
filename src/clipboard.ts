/**
 * Copy text to the clipboard from a content script. Tries the async Clipboard
 * API (works under a keydown user gesture without a manifest permission), then
 * falls back to a hidden-textarea `execCommand('copy')`. Best-effort for
 * voice-triggered copies (no gesture): returns false if both paths fail.
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
