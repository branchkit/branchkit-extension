import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The escape order, driven through the REAL key path.
 *
 * escape-cascade.test.ts asserts the cascade's internal order with every
 * collaborator mocked and `runEscapeCascade` called directly. That is a fine
 * unit test and it is not what this file is for. It cannot see the four ways
 * the key and the voice had actually diverged, because all four lived in the
 * seams BETWEEN the cascade and its callers:
 *
 *   - the committed-find Escape was peeled in content.ts's listener, ahead of
 *     the cascade that claims to declare the order;
 *   - the cascade's find layer asked a different predicate than caret's did,
 *     so voice could not dismiss a committed find at all;
 *   - a `w`-entered video layer was in neither list;
 *   - the listener's find gate tested element presence, so an unfocused bar
 *     swallowed every key including Escape itself.
 *
 * So: real `preemptsPageKeys` (the listener's guards), real `KeyHandler`
 * singleton, real cascade, real find module — a genuine KeyboardEvent
 * dispatched at the document, in the capture phase content.ts uses.
 *
 * WHAT THIS DOES NOT COVER, precisely:
 *   - content.ts's listener is not imported (it boots the whole content script:
 *     chrome.*, observers, a page session). The harness below re-states the two
 *     calls that bracket the escape path — `preemptsPageKeys` then
 *     `keyHandler.handleKeyDown` — in the listener's order. If someone reorders
 *     those two IN content.ts, this file stays green and is wrong. That is the
 *     one gap left, and it is the reason the guards were extracted to a module
 *     at all: the third input to the order is now a named function rather than
 *     fifteen inline lines, so the drift surface is one call site instead of a
 *     block of code no test could reach.
 *   - the three listener steps BETWEEN those two calls (focus-input Tab cycler,
 *     the Ctrl+Alt+A snapshot chord, scroll-key held tracking) are omitted.
 *     None reads Escape or a mode layer; the snapshot chord requires Ctrl+Alt.
 *   - `selection-commands` and `range-disambiguation` are mocked: they reach
 *     `chrome.*` at module scope. The cascade's calls INTO them are asserted,
 *     their internals are not (caret's own staged unwind is caret.test.ts's).
 */

let pickPending = false;
const pickCancelled: string[] = [];
vi.mock('./range-disambiguation', () => ({
  isRangePickPending: () => pickPending,
  cancelRangePick: (r: string) => { pickCancelled.push(r); pickPending = false; },
}));

let caretActive = false;
const caretEscapes: string[] = [];
vi.mock('./selection-commands', () => ({
  caret: {
    isActive: () => caretActive,
    escape: () => { caretEscapes.push('escape'); caretActive = false; },
  },
}));

import { keyHandler } from '../core/singletons';
import { preemptsPageKeys } from './key-preamble';
import { runEscapeCascade, type EscapeLayer } from './escape-cascade';
import {
  findImmediate, openFindMode, closeFindMode,
  isFindActive, isFindBarOpen, isFindBarFocused,
} from '../scan/find';

// jsdom's hand-built KeyboardEvent carries no `code`; the registry matches on it.
function codeFor(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return key; // Escape / Enter are read off e.key
}

/** content.ts's document keydown listener, escape-relevant slice, same order. */
function listener(e: KeyboardEvent): void {
  if (preemptsPageKeys(e)) return;
  keyHandler.handleKeyDown(e);
}

let peeled: EscapeLayer = '';

function press(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent('keydown', {
    key, code: codeFor(key), bubbles: true, cancelable: true, ...init,
  });
  // Dispatched at a page node so it must travel the capture path to reach the
  // document listener — the same trip a real keystroke makes.
  (document.activeElement ?? document.body).dispatchEvent(e);
  return e;
}

function reset(): void {
  closeFindMode();
  keyHandler.exitHintMode();
  keyHandler.exitVideoMode();
  keyHandler.exitCaretMode();
  pickPending = false;
  caretActive = false;
  pickCancelled.length = 0;
  caretEscapes.length = 0;
  peeled = '';
  document.body.innerHTML = '';
}

beforeEach(() => {
  document.addEventListener('keydown', listener, true);
  // The production wiring (content.ts), plus a recorder so a test can name the
  // layer the KEY peeled — the cascade's return value is otherwise swallowed by
  // the boolean `handleKeyDown` needs.
  keyHandler.setEscapeHook(() => { peeled = runEscapeCascade('key_escape'); return peeled; });
  reset();
});

afterEach(() => {
  document.removeEventListener('keydown', listener, true);
  reset();
});

/** A committed find: highlights + read-only pill, bar closed. */
function committedFind(): void {
  document.body.innerHTML = '<p>a needle in a needle stack</p>';
  findImmediate('needle');
}

// --- the parity table ----------------------------------------------------

// Each row is a page state, the layer it should peel, and why it is here. Both
// inputs run the row; the assertion is that they agree. Every row marked
// (regression) is a state where they measurably did not.
const SCENARIOS: Array<{ name: string; setup: () => void; expected: EscapeLayer }> = [
  {
    name: 'nothing open',
    setup: () => {},
    expected: '',
  },
  {
    name: 'hint mode',
    setup: () => keyHandler.enterHintMode(),
    expected: 'hint_mode',
  },
  {
    name: 'a range pick outranks everything',
    setup: () => { pickPending = true; keyHandler.enterHintMode(); },
    expected: 'range_pick',
  },
  {
    name: 'a caret selection',
    setup: () => { caretActive = true; },
    expected: 'selection',
  },
  {
    // (regression) The cascade asked isFindBarOpen() — false once Enter commits
    // — so the spoken "over" peeled NOTHING here: highlights, pill and badges
    // all survived with no spoken way out.
    name: 'a committed find (regression: voice could not dismiss it)',
    setup: committedFind,
    expected: 'find',
  },
  {
    // (regression) THE headline divergence. handleFindNavKey ran in the
    // listener's preamble, ahead of the cascade, and took Escape — so the key
    // closed the FIND while the voice exited HINT MODE. Two inputs, opposite
    // results, in the one place that promises one order.
    name: 'a committed find UNDER hint mode (regression: opposite results)',
    setup: () => { committedFind(); keyHandler.enterHintMode(); },
    expected: 'hint_mode',
  },
  {
    // (regression) `w` enters a sticky keyboard layer that the cascade did not
    // know about. The KEY always escaped it — the layer's own handler treats
    // Escape as 'exit' — so this was a VOICE-only dead end: "over" reached the
    // extension (no exclusive tag is held, so the plugin does not suppress it)
    // and found no video layer to unwind. The key's exit is now the cascade's
    // too, which is the point: one declaration, not a layer with a private one.
    name: 'video mode entered by `w` (regression: voice had no way out)',
    setup: () => keyHandler.enterVideoMode(),
    expected: 'video',
  },
];

describe('the Escape key and the spoken escape peel the same layer', () => {
  for (const s of SCENARIOS) {
    it(`${s.name} → ${s.expected || 'nothing'}`, () => {
      reset();
      s.setup();
      press('Escape');
      const byKey = peeled;

      reset();
      s.setup();
      const byVoice = runEscapeCascade('voice_escape');

      expect(byKey).toBe(s.expected);
      expect(byVoice).toBe(s.expected);
      expect(byKey).toBe(byVoice);
    });
  }

  it('consumes the key only when a layer was actually peeled', () => {
    // Nothing open: Escape must reach the page (an autofocus-trapping site
    // relies on it), so the listener must not preventDefault.
    const untouched = press('Escape');
    expect(untouched.defaultPrevented).toBe(false);

    reset();
    keyHandler.enterHintMode();
    const consumed = press('Escape');
    expect(consumed.defaultPrevented).toBe(true);
  });

  it('names the input to the layer that consumed it', () => {
    pickPending = true;
    press('Escape');
    expect(pickCancelled).toEqual(['key_escape']);

    reset();
    pickPending = true;
    runEscapeCascade('voice_escape');
    expect(pickCancelled).toEqual(['voice_escape']);
  });
});

describe('video is a layer the cascade owns', () => {
  it('peels video and leaves the keyboard usable', () => {
    keyHandler.enterVideoMode();
    expect(keyHandler.getMode()).toBe('video');
    press('Escape');
    expect(keyHandler.getMode()).toBe('normal');
  });

  it('the cascade peels it BEFORE the layer\'s own Escape handler sees it', () => {
    // The layer has always had a private exit (resolveVideoModeKey maps Escape
    // to 'exit'), which is why the key never looked broken while voice was
    // stuck. A private exit that happens to agree is still a second
    // declaration — the next edit to either is where they part. Production
    // installs this handler; the cascade must reach the layer first.
    const videoKey = vi.fn().mockReturnValue(true);
    keyHandler.setVideoKeyHandler(videoKey);
    keyHandler.enterVideoMode();

    press('Escape');

    expect(peeled).toBe('video');
    expect(videoKey).not.toHaveBeenCalled();
    expect(keyHandler.getMode()).toBe('normal');

    // ...and the layer still owns its own non-Escape keys.
    keyHandler.enterVideoMode();
    press('k');
    expect(videoKey).toHaveBeenCalledTimes(1);
  });

  it('sits above find: a search committed before `w` survives the video exit', () => {
    // The one stacking that is genuinely reachable by keyboard — commit a
    // search, then press `w`. Escaping must peel the layer entered LAST.
    committedFind();
    keyHandler.enterVideoMode();

    press('Escape');
    expect(peeled).toBe('video');
    expect(isFindActive()).toBe(true); // the search underneath is untouched

    press('Escape');
    expect(peeled).toBe('find');
    expect(isFindActive()).toBe(false);
  });
});

describe('the find bar owns the keyboard only while it HAS the keyboard', () => {
  it('while focused, the bar takes every key and the cascade stays out', () => {
    document.body.innerHTML = '<p>needle</p>';
    openFindMode();
    expect(isFindBarFocused()).toBe(true);

    // The bar's own keydown handler owns Escape here (it closes the box); the
    // page listener must decline the key rather than run the cascade on it.
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    expect(preemptsPageKeys(e)).toBe(true);

    // ...and letters must reach the input rather than filter codewords.
    const f = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true });
    expect(preemptsPageKeys(f)).toBe(true);
  });

  it('losing focus closes the box rather than parking in a key-eating state', () => {
    // (regression) The gate tested element PRESENCE, so clicking the page with
    // the bar open killed hint mode, find navigation, the focus-input cycler,
    // the snapshot chord and Escape itself — with no visible cause and no key
    // that could recover it.
    document.body.innerHTML = '<p>needle</p><input id="other">';
    openFindMode();
    expect(isFindBarOpen()).toBe(true);

    document.querySelector<HTMLInputElement>('#other')!.focus();

    expect(isFindBarOpen()).toBe(false);
    expect(isFindActive()).toBe(false);
    // Keys flow again.
    const f = new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', bubbles: true, cancelable: true });
    expect(preemptsPageKeys(f)).toBe(false);
  });

  it('a bar that never took focus does not eat keys', () => {
    // Belt to the blur-close's braces: `openFindMode` focuses the input, but a
    // focus() in a background tab or a non-focused frame never lands, and there
    // is no blur to rescue it. The gate is FOCUS, so presence alone is inert.
    document.body.innerHTML = '<p>needle</p>';
    openFindMode();
    expect(isFindBarFocused()).toBe(true);

    // Detach the activeElement without a focus move (the shape a cross-frame
    // focus loss leaves behind).
    (document.activeElement as HTMLElement).blur();
    expect(isFindBarFocused()).toBe(false);
  });
});

describe('n / N stay in the preamble, Escape does not', () => {
  it('the committed find still navigates with n', () => {
    committedFind();
    const n = new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true, cancelable: true });
    expect(preemptsPageKeys(n)).toBe(true); // consumed as find navigation
  });

  it('Escape on a committed find is NOT taken by the preamble', () => {
    committedFind();
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    // It belongs to the cascade now, which is the whole point of item 4.
    expect(preemptsPageKeys(e)).toBe(false);
  });

  it('caret mode keeps n / N for its own extend-to-match', () => {
    committedFind();
    keyHandler.enterCaretMode('caret');
    const n = new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', bubbles: true, cancelable: true });
    expect(preemptsPageKeys(n)).toBe(false); // falls through to the caret handler
  });
});
