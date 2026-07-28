/**
 * BranchKit Browser — selection-commands feature-module unit tests.
 *
 * Pins the parseSelectionCommand table (voice → structured SelectionCommand),
 * the SELECTION_ACTIONS gate set, and the Phase-1 registration contract:
 * nothing registers at import time; registerSelectionCommands() installs the
 * handlers on the shared dispatcher and they drive their collaborators.
 *
 * Run: npm test
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { modes } from '../core/modes';

type SelectionCommands = typeof import('./selection-commands');
type Handler = (params: Record<string, string>) => void;

const registered = new Map<string, Handler>();
const dispatcher = {
  register: vi.fn((action: string, fn: Handler) => { registered.set(action, fn); }),
  dispatch: (action: string, params: Record<string, string> = {}) => registered.get(action)?.(params),
};
const keyHandler = {
  armMarkSet: vi.fn(), armMarkJump: vi.fn(),
  setMarkCallback: vi.fn(), setCaretKeyHandler: vi.fn(),
  // The caret LIFETIME rides the stack inside these (as the real KeyHandler
  // does since Wave 3 C3c) — the fakes uphold that half of the contract so
  // the stack-edge test below observes the production wiring shape.
  enterCaretMode: vi.fn(() => { modes.push('caret'); }),
  exitCaretMode: vi.fn(() => { modes.pop('caret'); }),
};
const caretInstance = {
  enterFromFind: vi.fn(() => false), enterFromNormal: vi.fn(), enter: vi.fn(),
  extendToPhrase: vi.fn(), extendToRange: vi.fn(), handleKey: vi.fn(), isActive: vi.fn(() => false),
  extendToCurrentMatch: vi.fn(),
};
const findPageLink = vi.fn();
const flashToast = vi.fn();
const copyText = vi.fn(async () => true);
const findAllRanges = vi.fn((): Range[] => []);
const openPhraseBox = vi.fn();
const clearFindPaint = vi.fn();
// find's commit multicast. CAPTURED rather than stubbed away: this module
// registers the caret's extend-to-match at its own module scope now (it was a
// content.ts composition until 2026-07-27), and holding what it registered is
// the only way a test can tell a real registration from none.
let committedListener: (() => void) | null = null;
const onFindCommitted = vi.fn((fn: () => void) => {
  committedListener = fn;
  return () => { committedListener = null; };
});
const startRangePick = vi.fn();
const cancelRangePick = vi.fn();

// The options the module hands the CaretController — `onModeChange` is the
// caret→plugin mirror, and driving it is the only way to observe the post.
let caretOpts: { onModeChange: (mode: string | null) => void } | null = null;

async function loadModule(): Promise<SelectionCommands> {
  vi.resetModules();
  vi.doMock('../core/singletons', () => ({ dispatcher, keyHandler }));
  vi.doMock('./caret', () => ({
    CaretController: vi.fn(function CaretController(opts: typeof caretOpts) {
      caretOpts = opts;
      return caretInstance;
    }),
  }));
  vi.doMock('../render/toast', () => ({ flashToast }));
  vi.doMock('../pagination', () => ({ findPageLink }));
  vi.doMock('../url-nav', () => ({ urlUp: vi.fn(() => null), urlRoot: vi.fn(() => null) }));
  vi.doMock('../clipboard', () => ({ copyText }));
  vi.doMock('../scan/find', () => ({ findAllRanges, openPhraseBox, clearFindPaint, onFindCommitted }));
  vi.doMock('./range-disambiguation', () => ({ startRangePick, cancelRangePick }));
  return await import('./selection-commands');
}

beforeEach(() => {
  vi.clearAllMocks();
  registered.clear();
  caretOpts = null;
  committedListener = null;
  vi.stubGlobal('chrome', { runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../core/singletons');
  vi.doUnmock('./caret');
  vi.doUnmock('../render/toast');
  vi.doUnmock('../pagination');
  vi.doUnmock('../url-nav');
  vi.doUnmock('../clipboard');
  vi.doUnmock('../scan/find');
  vi.doUnmock('./range-disambiguation');
});

describe('parseSelectionCommand', () => {
  it('maps the discrete ops', async () => {
    const m = await loadModule();
    expect(m.parseSelectionCommand('select_flip')).toEqual({ op: 'flip' });
    expect(m.parseSelectionCommand('select_copy')).toEqual({ op: 'copy' });
    expect(m.parseSelectionCommand('select_exit')).toEqual({ op: 'exit' });
    expect(m.parseSelectionCommand('select_whole', { granularity: 'sentence' }))
      .toEqual({ op: 'select', granularity: 'sentence' });
    expect(m.parseSelectionCommand('select_shrink')).toEqual({ op: 'shrink', granularity: 'word' });
  });

  it('maps extend_* ids to their granularity with direction and count', async () => {
    const m = await loadModule();
    expect(m.parseSelectionCommand('extend_sentence', { direction: 'backward', count: '3' }))
      .toEqual({ op: 'extend', granularity: 'sentence', direction: 'backward', count: 3 });
    expect(m.parseSelectionCommand('extend_edge'))
      .toEqual({ op: 'extend', granularity: 'lineboundary', direction: 'forward', count: 1 });
  });

  it('SELECTION_ACTIONS covers every extend id plus the discrete ops', async () => {
    const m = await loadModule();
    for (const a of ['extend_word', 'extend_sentence', 'extend_line', 'extend_paragraph',
      'extend_edge', 'select_shrink', 'select_whole', 'select_flip', 'select_copy', 'select_exit']) {
      expect(m.SELECTION_ACTIONS.has(a)).toBe(true);
    }
    expect(m.SELECTION_ACTIONS.has('scroll_down')).toBe(false);
  });
});

describe('registration contract (Phase 1)', () => {
  it('registers nothing at import time', async () => {
    await loadModule();
    expect(dispatcher.register).not.toHaveBeenCalled();
    expect(keyHandler.setMarkCallback).not.toHaveBeenCalled();
  });

  // ...but it DOES subscribe to find's commit, and that is deliberate: the
  // caret's extend-to-match is not a command, it is a reaction to one. It moved
  // here from a content.ts composition (2026-07-27) because this module owns
  // the caret instance, and it lands at module scope like the mode probe beside
  // it. Nothing else observes the registration, so without this the whole
  // find-and-select behaviour stays untested — as it was the entire time it
  // lived in content.ts, which has no test file.
  it('subscribes to find commits at import, and extends only when caret is live', async () => {
    await loadModule();
    expect(committedListener).toBeTypeOf('function');

    caretInstance.isActive.mockReturnValue(false);
    committedListener!();
    expect(caretInstance.extendToCurrentMatch).not.toHaveBeenCalled();

    // The guard is the point: "/ query Enter" is a find-and-select ONLY inside
    // a caret/visual session; outside one it must stay an ordinary find.
    caretInstance.isActive.mockReturnValue(true);
    committedListener!();
    expect(caretInstance.extendToCurrentMatch).toHaveBeenCalledTimes(1);
  });

  it('registerSelectionCommands installs the handlers once', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    for (const a of ['mark_set', 'mark_jump', 'caret_mode', 'visual_line_mode', 'select_to',
      'go_next', 'go_previous', 'copy_url', 'go_up', 'go_root']) {
      expect(registered.has(a)).toBe(true);
    }
    expect(keyHandler.setMarkCallback).toHaveBeenCalledTimes(1);
    expect(keyHandler.setCaretKeyHandler).toHaveBeenCalledTimes(1);
  });

  it('caret_mode prefers promoting a find match before dropping to caret', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    caretInstance.enterFromFind.mockReturnValueOnce(true);
    dispatcher.dispatch('caret_mode');
    expect(caretInstance.enterFromNormal).not.toHaveBeenCalled();
    dispatcher.dispatch('caret_mode');
    expect(caretInstance.enterFromNormal).toHaveBeenCalledTimes(1);
  });

  it('select_to: single top-frame match acts immediately', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    const r = {} as Range;
    findAllRanges.mockReturnValueOnce([r]);
    dispatcher.dispatch('select_to', { query: 'hello world' });
    expect(findAllRanges).toHaveBeenCalledWith('hello world');
    expect(caretInstance.extendToRange).toHaveBeenCalledWith(r);
    expect(startRangePick).not.toHaveBeenCalled();
    expect(openPhraseBox).not.toHaveBeenCalled();
    // The selection replaces the match marking handed over by the box.
    expect(clearFindPaint).toHaveBeenCalled();
  });

  // With several candidates the marking STAYS: the chips point at the painted
  // matches, and clearing at commit left them pointing at unmarked text. The
  // pick's teardown owns the paint from here.
  it('select_to: a multi-match pick keeps the match paint for the chips', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    findAllRanges.mockReturnValueOnce([{} as Range, {} as Range]);
    dispatcher.dispatch('select_to', { query: 'dup' });
    expect(startRangePick).toHaveBeenCalledTimes(1);
    expect(clearFindPaint).not.toHaveBeenCalled();
  });

  // The phrase box replaced the dictated-argument cue card: dispatched without
  // a query, the command COLLECTS one rather than dropping. This is the voice
  // ("highlight") and keybind (gs) entry — both arrive with no phrase in hand.
  it('select_to: no query opens the phrase box instead of dropping', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    dispatcher.dispatch('select_to', {});
    expect(openPhraseBox).toHaveBeenCalledWith(expect.objectContaining({
      placeholder: 'Highlight phrase...', onPhrase: expect.any(Function),
    }));
    expect(findAllRanges).not.toHaveBeenCalled();
    expect(caretInstance.extendToRange).not.toHaveBeenCalled();
  });

  it('select_to: mode=extend opens the box in extend mode', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    dispatcher.dispatch('select_to', { mode: 'extend' });
    expect(openPhraseBox).toHaveBeenCalledWith(expect.objectContaining({
      placeholder: 'Extend selection to...', onPhrase: expect.any(Function),
    }));
  });

  it('select_to: a blank query is still no query — it opens the box', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    dispatcher.dispatch('select_to', { query: '   ' });
    expect(openPhraseBox).toHaveBeenCalledWith(expect.objectContaining({
      placeholder: 'Highlight phrase...', onPhrase: expect.any(Function),
    }));
    expect(findAllRanges).not.toHaveBeenCalled();
  });

  it('select_to: multiple matches start a range pick instead of selecting', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    const ranges = [{} as Range, {} as Range];
    findAllRanges.mockReturnValueOnce(ranges);
    dispatcher.dispatch('select_to', { query: 'dup' });
    expect(caretInstance.extendToRange).not.toHaveBeenCalled();
    expect(startRangePick).toHaveBeenCalledTimes(1);
    expect(startRangePick.mock.calls[0][0]).toBe(ranges);
    // The pick's callback extends to the chosen range.
    (startRangePick.mock.calls[0][1] as (r: Range) => void)(ranges[1]);
    expect(caretInstance.extendToRange).toHaveBeenCalledWith(ranges[1]);
  });

  it('select_to: no matches toasts and cancels any pending pick', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    findAllRanges.mockReturnValueOnce([]);
    dispatcher.dispatch('select_to', { query: 'absent' });
    expect(flashToast).toHaveBeenCalledWith('Phrase not found');
    expect(cancelRangePick).toHaveBeenCalled();
    expect(startRangePick).not.toHaveBeenCalled();
    // Nothing to hand the paint to — it must not outlive the question.
    expect(clearFindPaint).toHaveBeenCalled();
  });

  // The caret tag gates every voice selection command, and a SUBFRAME caret
  // session is a DESIGNED path (resolveSelectTo routes subframe matches
  // through the chip pick). The per-frame CARET_ACTIVE post this test used to
  // pin is gone (Wave 3 C4a): the frame's contribution is its STACK EDGE, and
  // the subframe half of the invariant — any frame's stack asserts the tag —
  // is pinned where the derivation lives, background/mode-mirror.test.ts.
  it('a subframe caret edge speaks through the stack, never a direct plugin post', async () => {
    vi.stubGlobal('top', {}); // window !== window.top: this frame is a subframe
    const m = await loadModule();
    m.registerSelectionCommands();
    const send = (globalThis as unknown as { chrome: { runtime: { sendMessage: ReturnType<typeof vi.fn> } } })
      .chrome.runtime.sendMessage;
    modes.reset();

    // What leaves the frame is the STACK EDGE and nothing else. This read
    // `not.toHaveBeenCalled()` until the mirror transport was defaulted in
    // core/modes.ts, which passed only because no unit test wired the sink —
    // it could not tell "posted nothing" from "had no transport". The edge now
    // really posts, so the invariant is stated directly instead of inferred.
    const postedTypes = () => send.mock.calls.map(([m]) => (m as { type: string }).type);

    caretOpts!.onModeChange('caret');
    expect(modes.has('caret')).toBe(true);   // the edge the SW derives from
    expect(postedTypes()).toEqual(['MODE_STACK']);

    caretOpts!.onModeChange(null);
    expect(modes.has('caret')).toBe(false);
    expect(postedTypes()).toEqual(['MODE_STACK', 'MODE_STACK']);
    // The caret TAG is derived from the stack in the SW
    // (background/mode-mirror.ts). A frame asserting it directly is the
    // regression this test exists to catch.
    expect(postedTypes()).not.toContain('CARET_ACTIVE');
  });

  it('go_next follows the page link when found, toasts when absent', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    findPageLink.mockReturnValueOnce(null);
    dispatcher.dispatch('go_next');
    expect(flashToast).toHaveBeenCalledWith('No next page');
  });

  // The caret's active edge drives the mode stack through
  // enterCaretMode/exitCaretMode in the same onModeChange that drives the
  // mirror, so the three cannot drift.
  it('the mode stack rides the caret active edge', async () => {
    await loadModule();
    modes.reset();

    caretOpts!.onModeChange('caret');
    expect(modes.has('caret')).toBe(true);
    // caret↔visual is one lifetime — no re-push, no nest.
    caretOpts!.onModeChange('visual');
    expect(modes.depth()).toBe(1);

    caretOpts!.onModeChange(null);
    expect(modes.has('caret')).toBe(false);
  });
});
