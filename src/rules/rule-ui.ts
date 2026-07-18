/**
 * BranchKit Browser — Shared UI helpers for the popup + options page.
 *
 * Per-kind glyphs, matcher → display-string conversion, and the
 * codeword-resolve message round-trip. The DOM rendering itself stays
 * per-surface (popup builds via createElement, options uses HTML
 * templates) but the data and messaging shapes live here so the two
 * UIs can't drift.
 */

import type { Matcher, RuleEntry } from './domain-rules';
import type { ResolveHintResponse } from '../types';

export const KIND_META: Record<RuleEntry['kind'], { glyph: string; label: string }> = {
  exclude: { glyph: '–', label: 'Exclude' },
  include: { glyph: '+', label: 'Include' },
  reveal:  { glyph: '◉', label: 'Reveal'  },
  nudge:   { glyph: '✥', label: 'Nudge'   },
};

/** "(+12, -8)" — display suffix for a nudge entry's pixel offset. */
export function nudgeSummary(entry: RuleEntry): string {
  if (!entry.nudge) return '';
  const fmt = (v: number) => (v >= 0 ? `+${v}` : `${v}`);
  return `(${fmt(entry.nudge.dx)}, ${fmt(entry.nudge.dy)})`;
}

/**
 * One-line display string for a matcher. `text` matchers carry a
 * (case-insensitive) suffix unless explicitly case-sensitive.
 */
export function matcherSummary(matcher: Matcher): string {
  switch (matcher.type) {
    case 'css':   return matcher.selector;
    case 'text': {
      const ci = matcher.caseSensitive ? '' : ' (case-insensitive)';
      return matcher.mode === 'contains'
        ? `text contains "${matcher.value}"${ci}`
        : `text="${matcher.value}"${ci}`;
    }
    case 'class': return `.${matcher.name}`;
  }
}

/**
 * Send a RESOLVE_HINT_FROM_TAB and return the response. Errors arriving
 * via chrome.runtime are flattened into `{ ok: false, reason }` so the
 * caller has one shape to render.
 */
export async function resolveCodewordFromTab(
  tabId: number,
  codeword: string,
): Promise<ResolveHintResponse> {
  try {
    return await chrome.runtime.sendMessage({
      type: 'RESOLVE_HINT_FROM_TAB',
      tabId,
      codeword,
    });
  } catch (err) {
    return { ok: false, reason: String((err as Error)?.message ?? err) };
  }
}

/**
 * Render the "Matched <tag> 'name'" line into `feedback`. Pass
 * `includeSelector: true` to append ` → <code>selector</code>` for
 * surfaces where the matcher input isn't right next to the feedback
 * (the options page resolve panel).
 */
export function renderResolvePreview(
  feedback: HTMLElement,
  response: Extract<ResolveHintResponse, { ok: true }>,
  options: { includeSelector?: boolean } = {},
): void {
  feedback.classList.remove('error');
  feedback.replaceChildren();
  feedback.append('Matched ');
  const tag = document.createElement('code');
  tag.textContent = `<${response.tagName}>`;
  feedback.appendChild(tag);
  if (response.accessibleName) feedback.append(` "${response.accessibleName}"`);
  if (options.includeSelector) {
    feedback.append(' → ');
    const sel = document.createElement('code');
    sel.textContent = response.selector;
    feedback.appendChild(sel);
  }
}

export function setFeedbackError(el: HTMLElement, message: string): void {
  el.classList.add('error');
  el.textContent = message;
}

export function clearFeedback(el: HTMLElement): void {
  el.classList.remove('error');
  el.textContent = '';
}
