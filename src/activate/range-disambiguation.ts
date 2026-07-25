/**
 * Range-match disambiguation for the dictated-argument selection verbs
 * ("highlight <phrase>", "select to <phrase>") — when a phrase matches more
 * than one place, paint a codeword chip at each match and let the user pick
 * by voice, instead of silently taking the first match.
 * Design: notes/DESIGN_TEXT_TARGETING.md ("Range-match disambiguation").
 *
 * Deliberately OUTSIDE the hints store (mode-chip precedent): the store feeds
 * occlusion, sweep, snapshot, and prefix-filter machinery that must not see a
 * non-element type. This module is an imperative per-frame singleton — one
 * pending pick at a time, chips positioned ONCE in document coordinates (no
 * reconciler, no observers; the window is seconds long and bounded by a
 * timeout), codewords claimed from the real deck via the reservoir (SW pool
 * arbitrates cross-frame uniqueness) and published through label-sync so the
 * shadow accounting stays truthful.
 */

import { labelReservoir } from '../labels/label-reservoir';
import { publishRecords, retireRecords } from '../labels/label-sync';
import { flashToast } from '../render/toast';
import { bkLog } from '../debug/bk-log';
import { reportDispatchResult } from '../plugin/resolve';
import type { ScannedElement } from '../types';

/** Most matches we'll badge — beyond this the phrase is too generic to pick
 * by eye anyway; the toast tells the user to say more words. */
export const MAX_RANGE_BADGES = 9;

/** Auto-cancel window. Mirrors the platform arm-window philosophy: a stale
 * pending pick must not swallow a codeword spoken minutes later. */
const PICK_WINDOW_MS = 12_000;

/** One chip's mutable visuals: the positioned host (dim target) and its
 * first letter's span (mid-pair matched-char highlight). */
interface ChipUi {
  host: HTMLElement;
  firstLetter: HTMLElement | null;
}

interface PendingPick {
  byCodeword: Map<string, Range>;
  chipUi: Map<string, ChipUi>;
  timeout: number;
  onPick: (range: Range) => void;
  /** Regular badges were visible at pick start — restore them on teardown. */
  restoreBadges: boolean;
}

let pending: PendingPick | null = null;

/**
 * Pick-window badge hooks, injected by content.ts (badge visibility lives in
 * the content monolith — injection avoids the import cycle). While chips are
 * up they OWN the codewords, so the regular badges hide for the window and
 * the screen shows exactly what's speakable (user decision 2026-07-25);
 * restored on teardown only if they were visible at start. Purely visual —
 * grammar publication is untouched, per-frame like the pick itself.
 */
interface PickWindowHooks {
  /** Hide regular badges; returns whether they were visible (for restore). */
  hideBadges: () => boolean;
  showBadges: () => void;
}
let pickWindowHooks: PickWindowHooks | null = null;
export function setPickWindowHooks(h: PickWindowHooks): void {
  pickWindowHooks = h;
}

/** True when a pick is live (optionally: for this specific codeword). */
export function isRangePickPending(codeword?: string): boolean {
  if (!pending) return false;
  return codeword === undefined || pending.byCodeword.has(codeword);
}

/**
 * Consume a spoken codeword if it belongs to the pending pick. Returns true
 * when consumed (the caller must NOT fall through to element activation).
 */
export function resolveRangePick(codeword: string): boolean {
  if (!pending) return false;
  const range = pending.byCodeword.get(codeword);
  if (!range) return false;
  const onPick = pending.onPick;
  teardown('picked');
  onPick(range);
  return true;
}

/** Cancel any pending pick (new arm replaces old, timeout, explicit). */
export function cancelRangePick(reason: string): void {
  if (pending) teardown(reason);
}

/**
 * Pick-window codeword guard: while chips are up they OWN the codewords — a
 * stray badge codeword must not click a link out from under the question the
 * chips are asking. Returns true when the codeword was swallowed (the caller
 * stops); flashes guidance and reports the refusal. The pick stays live —
 * "escape" or the timeout ends it, then the badges and their codewords come
 * back.
 */
export function refusePickWindowCodeword(action: string, codeword: string): boolean {
  if (!pending || pending.byCodeword.has(codeword)) return false;
  flashToast('Pick a highlighted match — or say "escape"');
  reportDispatchResult({
    action, codeword, resolution: 'range_pick', elem_tag: '',
    taken: 'skipped', ok: false,
    frame: `${location.origin}${location.pathname}`.slice(0, 200),
    detail: 'pick pending — codeword is not a chip', fp: '',
  });
  return true;
}

/**
 * Mid-pair progress on the chips — the same feedback the badge hints give:
 * after the first word of a pair, chips that can't complete dim and the
 * matched first letter lights up on the rest. `letter` is the SW-translated
 * prefix letter; '' resets (pair cancelled). Returns true iff a pick is
 * live, so the caller (content's progress handler) routes progress HERE
 * instead of the store hints — without this, speaking a chip's first word
 * re-showed the very badges the pick window just hid.
 */
export function filterRangePickChips(letter: string): boolean {
  if (!pending) return false;
  for (const [cw, ui] of pending.chipUi) {
    const matches = letter !== '' && cw.replace(/\s/g, '').charAt(0) === letter;
    ui.host.style.opacity = letter === '' || matches ? '1' : '0.25';
    // White at rest; the matched first letter goes gold (user pref) — the
    // inverse of the old gold-at-rest scheme.
    if (ui.firstLetter) ui.firstLetter.style.color = matches ? '#ffd60a' : '';
  }
  return true;
}

/**
 * Start a disambiguation pick over the given ranges: claim codewords, paint a
 * chip at each range, publish the codewords for matching, and wait for
 * resolveRangePick / timeout. Ranges beyond MAX_RANGE_BADGES are dropped with
 * a visible toast (no silent truncation).
 */
export function startRangePick(ranges: Range[], onPick: (range: Range) => void): void {
  cancelRangePick('replaced');

  const overflow = ranges.length - MAX_RANGE_BADGES;
  const picked = ranges.slice(0, MAX_RANGE_BADGES);
  const codewords = labelReservoir.claim(picked.length).filter(cw => cw !== '');
  if (codewords.length === 0) {
    // Pool dry or alphabet not loaded — fall back to today's behavior.
    bkLog('BK_RANGE_PICK_NO_LABELS', { ranges: picked.length });
    onPick(picked[0]);
    return;
  }

  const byCodeword = new Map<string, Range>();
  const chipUi = new Map<string, ChipUi>();
  const records: ScannedElement[] = [];
  for (let i = 0; i < picked.length && i < codewords.length; i++) {
    byCodeword.set(codewords[i], picked[i]);
    chipUi.set(codewords[i], paintChip(picked[i], codewords[i]));
    records.push({
      label: codewords[i],
      id: 0, // not in the element registry — codeword is the only address
      category: 'view',
      type: 'range_disambiguation',
      adapter: null,
      codeword: codewords[i],
      in_strict_viewport: true, // matchability gate — these must be eligible
    });
  }

  const timeout = window.setTimeout(() => teardown('timeout'), PICK_WINDOW_MS);
  const restoreBadges = pickWindowHooks?.hideBadges() ?? false;
  pending = { byCodeword, chipUi, timeout, onPick, restoreBadges };

  void publishRecords(records).then((admitted) => {
    // Rejected codewords (pool race, plugin refusal) can never be spoken —
    // drop their chips so a painted badge always implies a working pick.
    if (!pending || pending.byCodeword !== byCodeword) return;
    for (const [cw] of byCodeword) {
      if (!admitted.has(cw)) {
        chipUi.get(cw)?.host.remove();
        chipUi.delete(cw);
        byCodeword.delete(cw);
      }
    }
    if (byCodeword.size === 0) teardown('nothing_admitted');
  });

  bkLog('BK_RANGE_PICK_START', { matches: ranges.length, badged: byCodeword.size });
  if (overflow > 0) {
    flashToast(`${ranges.length} matches — showing first ${MAX_RANGE_BADGES}, say more words to narrow`);
  }
}

function teardown(reason: string): void {
  if (!pending) return;
  const { byCodeword, chipUi, timeout, restoreBadges } = pending;
  pending = null;
  window.clearTimeout(timeout);
  for (const ui of chipUi.values()) ui.host.remove();
  if (restoreBadges) pickWindowHooks?.showBadges();
  const codewords = [...byCodeword.keys()];
  retireRecords(codewords);
  labelReservoir.release(codewords);
  bkLog('BK_RANGE_PICK_END', { reason, released: codewords.length });
}

/**
 * One codeword chip anchored at a range, positioned once in document
 * coordinates. Static by design: a pick lives seconds, so no reconciler or
 * observers — scrolling works because the chip is absolute in the flow.
 * Styling mirrors the hint badges' look (dark chip, light text) but is
 * self-contained so hints.ts stays untouched.
 */
function paintChip(range: Range, codeword: string): ChipUi {
  const rect = range.getBoundingClientRect();
  const host = document.createElement('div');
  host.setAttribute('data-branchkit-hint', ''); // page observers + our scanners skip our nodes
  host.style.cssText =
    'position:absolute;z-index:2147483646;pointer-events:none;' +
    `left:${rect.left + window.scrollX}px;top:${rect.top + window.scrollY - 18}px`;
  const shadow = host.attachShadow({ mode: 'closed' });
  const chip = document.createElement('span');
  chip.style.cssText =
    'display:inline-block;background:rgba(20,20,24,0.92);color:#ffffff;' +
    'font:600 11px/1.5 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;' +
    'padding:0 5px;border-radius:4px;border:0.5px solid rgba(255,255,255,0.25);' +
    'box-shadow:0 1px 4px rgba(0,0,0,0.4);white-space:nowrap';
  // Per-character spans so mid-pair progress can light the matched first
  // letter, mirroring the badge hints' matched-char treatment.
  let firstLetter: HTMLElement | null = null;
  for (const ch of codeword) {
    const s = document.createElement('span');
    s.textContent = ch;
    chip.appendChild(s);
    if (!firstLetter && ch.trim() !== '') firstLetter = s;
  }
  shadow.appendChild(chip);
  (document.body || document.documentElement).appendChild(host);
  return { host, firstLetter };
}
