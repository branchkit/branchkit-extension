/**
 * BranchKit Browser — palette default landing-spot persistence.
 *
 * One source of truth for the `chrome.storage.sync.paletteOpenDefault` key:
 * where a BARE palette pick (no spoken modifier, plain Enter) lands a
 * navigate row. The modifiers ("blank"/"stash"/"here" + badge, Shift+Enter)
 * are absolute and unaffected — this configures only which of them the
 * unmodified pick means. One rule, chosen by the user rather than by us.
 *
 * Read at dispatch time (one storage.sync.get per palette pick — no cached
 * copy, no onChanged listener to keep honest).
 */

export type PaletteOpenDefault = 'blank' | 'here' | 'stash';

export const DEFAULT_PALETTE_OPEN: PaletteOpenDefault = 'blank';

const STORAGE_KEY = 'paletteOpenDefault';

function valid(v: unknown): v is PaletteOpenDefault {
  return v === 'blank' || v === 'here' || v === 'stash';
}

export async function loadPaletteOpenDefault(): Promise<PaletteOpenDefault> {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEY);
    const stored = result[STORAGE_KEY];
    return valid(stored) ? stored : DEFAULT_PALETTE_OPEN;
  } catch {
    return DEFAULT_PALETTE_OPEN;
  }
}

export function savePaletteOpenDefault(v: PaletteOpenDefault): void {
  if (v === DEFAULT_PALETTE_OPEN) {
    chrome.storage.sync.remove(STORAGE_KEY);
  } else {
    chrome.storage.sync.set({ [STORAGE_KEY]: v });
  }
}
