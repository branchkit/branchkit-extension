/**
 * BranchKit Browser — Badge appearance settings persistence.
 *
 * One source of truth for the `chrome.storage.sync.badgeSettings` key.
 * Controls badge font sizing (scale + clamps) and Rango-style ratio
 * nudges per font-size bucket. Content script reads these into module
 * state at startup and re-reads on storage.onChanged.
 */

export interface BadgeSettings {
  /** Target font-size × scale → badge font-size, before clamping. */
  scale: number;
  fontMin: number;
  fontMax: number;
  /** Ratio nudges (0 = badge fully outside target, 1 = badge inside at
   *  target.top-left). Three buckets: <15px / <20px / ≥20px target font. */
  nudgeXSmall: number;
  nudgeYSmall: number;
  nudgeXMed: number;
  nudgeYMed: number;
  nudgeXLarge: number;
  nudgeYLarge: number;
}

export const DEFAULT_BADGE_SETTINGS: BadgeSettings = {
  scale: 0.8,
  // Clamp is a wide guard rail, not the effective size control — the old
  // [10,12] window swallowed the scale entirely on typical 13-16px text.
  fontMin: 8,
  fontMax: 18,
  nudgeXSmall: 0.3,
  nudgeYSmall: 0.2,
  nudgeXMed: 0.4,
  nudgeYMed: 0.3,
  nudgeXLarge: 0.6,
  nudgeYLarge: 0.5,
};

const STORAGE_KEY = 'badgeSettings';

export async function loadBadgeSettings(): Promise<BadgeSettings> {
  const result = await chrome.storage.sync.get(STORAGE_KEY);
  const stored = result[STORAGE_KEY] as Partial<BadgeSettings> | undefined;
  return { ...DEFAULT_BADGE_SETTINGS, ...stored };
}

export function saveBadgeSettings(settings: BadgeSettings): void {
  chrome.storage.sync.set({ [STORAGE_KEY]: settings });
}

export function resetBadgeSettings(): void {
  chrome.storage.sync.remove(STORAGE_KEY);
}

export function onBadgeSettingsChanged(cb: (settings: BadgeSettings) => void): () => void {
  const listener = (changes: Record<string, chrome.storage.StorageChange>): void => {
    if (!changes[STORAGE_KEY]) return;
    const next = changes[STORAGE_KEY].newValue as Partial<BadgeSettings> | undefined;
    cb({ ...DEFAULT_BADGE_SETTINGS, ...next });
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
