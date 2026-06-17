/**
 * BranchKit Browser — native browser keyboard shortcuts, for the keymap editor.
 *
 * No web/extension API enumerates the browser's built-in shortcuts, so this is
 * a small curated table. It lets the editor tell the user what native command a
 * chord would override, so they bind with eyes open. Two axes:
 *   - OS  → which base modifier the browser uses: Cmd (mac) vs Ctrl (win/linux).
 *           The same bundle runs on both, so this is detected at runtime.
 *   - Browser → Chrome vs Firefox, for the few shortcuts that differ. Known per
 *           build (separate bundles) but detected here too.
 * Only the stable, common Ctrl/Cmd(+Shift)+letter commands — the chords users
 * actually bind onto. Combos with Alt, and multi-key sequences, are not claimed
 * (rare and platform-messy — better to say nothing than guess wrong).
 */

import { parseCombo } from './activate/key-combo';

export type OS = 'mac' | 'other';
export type Browser = 'chrome' | 'firefox';

interface NativeShortcut {
  code: string; // event.code
  shift?: boolean; // requires Shift in addition to the primary modifier
  label: string;
  only?: Browser; // restrict to one browser; omitted = both
}

// "primary modifier" = Cmd on mac, Ctrl on win/linux. Entries are
// primary [+ Shift] + code. Sourced from the stable Chrome/Firefox defaults.
const NATIVE_SHORTCUTS: readonly NativeShortcut[] = [
  { code: 'KeyF', label: 'Find in page' },
  { code: 'KeyS', label: 'Save page' },
  { code: 'KeyP', label: 'Print' },
  { code: 'KeyT', label: 'New tab' },
  { code: 'KeyW', label: 'Close tab' },
  { code: 'KeyN', label: 'New window' },
  { code: 'KeyR', label: 'Reload' },
  { code: 'KeyD', label: 'Bookmark this page' },
  { code: 'KeyL', label: 'Focus address bar' },
  { code: 'KeyT', shift: true, label: 'Reopen closed tab' },
  { code: 'KeyJ', label: 'Downloads', only: 'chrome' },
  { code: 'KeyN', shift: true, label: 'New incognito window', only: 'chrome' },
  { code: 'KeyK', label: 'Search bar', only: 'firefox' },
  { code: 'KeyP', shift: true, label: 'New private window', only: 'firefox' },
];

/**
 * The native browser command a binding would override, or null if none known.
 * Takes os/browser explicitly so it's pure and testable; the editor passes the
 * detected values.
 */
export function nativeOverride(keys: string, os: OS, browser: Browser): string | null {
  if (keys.includes(' ')) return null; // sequences aren't native shortcuts
  const c = parseCombo(keys);
  if (!c || c.alt) return null; // alt-combos not modeled
  const primary = os === 'mac' ? c.meta : c.ctrl;
  const otherBase = os === 'mac' ? c.ctrl : c.meta;
  if (!primary || otherBase) return null; // must use exactly the OS primary modifier
  for (const s of NATIVE_SHORTCUTS) {
    if (s.code !== c.code) continue;
    if (Boolean(s.shift) !== c.shift) continue;
    if (s.only && s.only !== browser) continue;
    return s.label;
  }
  return null;
}

export function detectOS(): OS {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const uaData = (nav as (Navigator & { userAgentData?: { platform?: string } }) | undefined)?.userAgentData;
  const platform = (uaData?.platform ?? nav?.platform ?? '').toLowerCase();
  return platform.includes('mac') ? 'mac' : 'other';
}

export function detectBrowser(): Browser {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /firefox/i.test(ua) ? 'firefox' : 'chrome';
}
