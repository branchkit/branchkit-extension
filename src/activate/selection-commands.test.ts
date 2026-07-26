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
  enterCaretMode: vi.fn(), exitCaretMode: vi.fn(),
};
const caretInstance = {
  enterFromFind: vi.fn(() => false), enterFromNormal: vi.fn(), enter: vi.fn(),
  extendToPhrase: vi.fn(), extendToRange: vi.fn(), handleKey: vi.fn(), isActive: vi.fn(() => false),
};
const findPageLink = vi.fn();
const flashToast = vi.fn();
const copyText = vi.fn(async () => true);
const findAllRanges = vi.fn((): Range[] => []);
const openFindMode = vi.fn();
const clearFindPaint = vi.fn();
const startRangePick = vi.fn();
const cancelRangePick = vi.fn();

async function loadModule(): Promise<SelectionCommands> {
  vi.resetModules();
  vi.doMock('../core/singletons', () => ({ dispatcher, keyHandler }));
  vi.doMock('./caret', () => ({
    CaretController: vi.fn(function CaretController() { return caretInstance; }),
  }));
  vi.doMock('../render/toast', () => ({ flashToast }));
  vi.doMock('../pagination', () => ({ findPageLink }));
  vi.doMock('../url-nav', () => ({ urlUp: vi.fn(() => null), urlRoot: vi.fn(() => null) }));
  vi.doMock('../clipboard', () => ({ copyText }));
  vi.doMock('../scan/find', () => ({ findAllRanges, openFindMode, clearFindPaint }));
  vi.doMock('./range-disambiguation', () => ({ startRangePick, cancelRangePick }));
  return await import('./selection-commands');
}

beforeEach(() => {
  vi.clearAllMocks();
  registered.clear();
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
    expect(openFindMode).not.toHaveBeenCalled();
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
    expect(openFindMode).toHaveBeenCalledWith('highlight');
    expect(findAllRanges).not.toHaveBeenCalled();
    expect(caretInstance.extendToRange).not.toHaveBeenCalled();
  });

  it('select_to: mode=extend opens the box in extend mode', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    dispatcher.dispatch('select_to', { mode: 'extend' });
    expect(openFindMode).toHaveBeenCalledWith('extend');
  });

  it('select_to: a blank query is still no query — it opens the box', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    dispatcher.dispatch('select_to', { query: '   ' });
    expect(openFindMode).toHaveBeenCalledWith('highlight');
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

  it('go_next follows the page link when found, toasts when absent', async () => {
    const m = await loadModule();
    m.registerSelectionCommands();
    findPageLink.mockReturnValueOnce(null);
    dispatcher.dispatch('go_next');
    expect(flashToast).toHaveBeenCalledWith('No next page');
  });
});
