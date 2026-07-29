/**
 * BranchKit Browser — keyboard activation tests.
 *
 * `activateWrapper` had no executable coverage of any kind until 2026-07-28:
 * it was a `content.ts` local, the entry points have no tests by design, and
 * the messages harness drives the VOICE element verbs, which section 6g.7
 * measured share no code with these. Replacing its whole body with `return`
 * left tsc, every lint, 2,278 tests and every harness green.
 *
 * A realinput scenario now drives the two branches with a DOM observable (plain
 * activation follows the link, `gf` focuses without following). These are the
 * four it cannot reach cheaply — yank and copytext end in the clipboard, hover
 * in a synthetic event, caret in a selection — plus the shape questions no
 * end-to-end run answers well: that each verb acts and RETURNS rather than
 * falling through to the activation below it, that the armed verb is consumed
 * exactly once, and that the handoff branches on the visibility mode.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Mod = typeof import('./keyboard-activation');

const keyHandler = { takeHintAction: vi.fn<() => string | null>(() => null) };
const copyText = vi.fn(async (_t: string) => true);
const flashToast = vi.fn((_m: string) => {});
const activateElement = vi.fn((_el: HTMLElement, _o?: { newTab?: boolean }) => {});
const dispatchHover = vi.fn((_el: HTMLElement) => {});
const caret = { enterAt: vi.fn((_el: HTMLElement) => {}) };
const noteActivated = vi.fn((_el: HTMLElement) => {});
const clearHintFilter = vi.fn(() => {});
const hideBadges = vi.fn(() => {});
const scheduleHintRefresh = vi.fn(() => {});
const shouldAutoShowBadges = vi.fn(() => true);

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.doMock('../core/singletons', () => ({ keyHandler }));
  vi.doMock('./clipboard', () => ({ copyText }));
  vi.doMock('../render/toast', () => ({ flashToast }));
  vi.doMock('./event-sequence', () => ({ activateElement, dispatchHover }));
  vi.doMock('./selection-commands', () => ({ caret }));
  vi.doMock('../scan/references', () => ({ noteActivated }));
  vi.doMock('../render/badge-visibility', () => ({
    clearHintFilter, hideBadges, shouldAutoShowBadges, scheduleHintRefresh,
  }));
  return import('./keyboard-activation');
}

/** A wrapper over a real element, with the badge's flash observable. */
function wrap(html: string, category = 'link') {
  document.body.innerHTML = html;
  const element = document.body.firstElementChild as HTMLElement;
  const flash = vi.fn();
  return { element, category, hint: { flash } } as never as
    Parameters<Mod['activateWrapper']>[0] & { hint: { flash: typeof flash } };
}

beforeEach(() => {
  vi.clearAllMocks();
  keyHandler.takeHintAction.mockReturnValue(null);
  shouldAutoShowBadges.mockReturnValue(true);
});
afterEach(() => {
  for (const m of ['../core/singletons', './clipboard', '../render/toast', './event-sequence',
    './selection-commands', '../scan/references', '../render/badge-visibility']) vi.doUnmock(m);
});

describe('activateWrapper — the armed verbs act and do NOT follow', () => {
  it('yank copies the enclosing link’s href', async () => {
    const { activateWrapper } = await load();
    keyHandler.takeHintAction.mockReturnValue('yank');
    const w = wrap('<a href="https://example.test/x"><span>inner</span></a>');
    activateWrapper(w);
    expect(copyText).toHaveBeenCalledWith('https://example.test/x');
    // The half that matters: yank must RETURN. Falling through would ALSO
    // navigate, which no clipboard assertion can see.
    expect(activateElement).not.toHaveBeenCalled();
    expect(noteActivated).not.toHaveBeenCalled();
  });

  it('yank over a non-link copies nothing and says so', async () => {
    const { activateWrapper } = await load();
    keyHandler.takeHintAction.mockReturnValue('yank');
    activateWrapper(wrap('<button>press</button>'));
    expect(copyText).not.toHaveBeenCalled();
    expect(flashToast).toHaveBeenCalledWith('Not a link');
  });

  it('copytext copies the visible text, trimmed — not the href', async () => {
    const { activateWrapper } = await load();
    keyHandler.takeHintAction.mockReturnValue('copytext');
    activateWrapper(wrap('<a href="https://example.test/x">  spaced out  </a>'));
    expect(copyText).toHaveBeenCalledWith('spaced out');
    expect(activateElement).not.toHaveBeenCalled();
  });

  it('focus focuses and does not activate', async () => {
    const { activateWrapper } = await load();
    keyHandler.takeHintAction.mockReturnValue('focus');
    const w = wrap('<a href="#x">link</a>');
    const focus = vi.spyOn(w.element as unknown as HTMLElement, 'focus');
    activateWrapper(w);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(activateElement).not.toHaveBeenCalled();
  });

  it('hover dispatches a hover and does not activate', async () => {
    const { activateWrapper } = await load();
    keyHandler.takeHintAction.mockReturnValue('hover');
    const w = wrap('<a href="#x">link</a>');
    activateWrapper(w);
    expect(dispatchHover).toHaveBeenCalledWith(w.element);
    expect(activateElement).not.toHaveBeenCalled();
  });

  it('caret enters at the element, AFTER the visibility handoff', async () => {
    const { activateWrapper } = await load();
    keyHandler.takeHintAction.mockReturnValue('caret');
    const order: string[] = [];
    clearHintFilter.mockImplementation(() => { order.push('handoff'); });
    caret.enterAt.mockImplementation(() => { order.push('enterAt'); });
    const w = wrap('<a href="#x">link</a>');
    activateWrapper(w);
    expect(caret.enterAt).toHaveBeenCalledWith(w.element);
    expect(activateElement).not.toHaveBeenCalled();
    // Order is the assertion, not an accident: the handoff clears the hint
    // filter and exits hint mode, so running it after `enterAt` would tear down
    // the mode the caret just pushed.
    expect(order).toEqual(['handoff', 'enterAt']);
  });

  it('every armed verb flashes its own badge', async () => {
    const { activateWrapper } = await load();
    for (const verb of ['yank', 'copytext', 'focus', 'hover', 'caret']) {
      keyHandler.takeHintAction.mockReturnValue(verb);
      const w = wrap('<a href="https://example.test/x">link</a>');
      activateWrapper(w);
      expect(w.hint.flash, verb).toHaveBeenCalledTimes(1);
    }
  });
});

describe('activateWrapper — the plain path', () => {
  it('notes the element and activates it', async () => {
    const { activateWrapper } = await load();
    const w = wrap('<a href="#x">link</a>');
    activateWrapper(w);
    expect(noteActivated).toHaveBeenCalledWith(w.element);
    expect(activateElement).toHaveBeenCalledWith(w.element, { newTab: false });
  });

  it("'newtab' is the ONLY armed value that reaches the activation", async () => {
    const { activateWrapper } = await load();
    keyHandler.takeHintAction.mockReturnValue('newtab');
    const w = wrap('<a href="#x">link</a>');
    activateWrapper(w);
    expect(activateElement).toHaveBeenCalledWith(w.element, { newTab: true });
  });

  it('an input is focused rather than clicked', async () => {
    const { activateWrapper } = await load();
    const w = wrap('<input type="text">', 'input');
    const focus = vi.spyOn(w.element as unknown as HTMLElement, 'focus');
    activateWrapper(w);
    expect(focus).toHaveBeenCalledTimes(1);
    expect(activateElement).not.toHaveBeenCalled();
    // Still noted: "resolve reference" has to be able to name the field the
    // user last landed in, not just the last thing they clicked.
    expect(noteActivated).toHaveBeenCalledWith(w.element);
  });

  it('consumes the armed verb exactly once per activation', async () => {
    const { activateWrapper } = await load();
    activateWrapper(wrap('<a href="#x">link</a>'));
    // Reading it twice would let a second read see null and take a different
    // branch than the first; not reading it at all leaks the verb to the next
    // activation, which is the bug the comment in the source is about.
    expect(keyHandler.takeHintAction).toHaveBeenCalledTimes(1);
  });
});

describe('the visibility handoff', () => {
  it('in always mode: clears the filter and schedules a refresh, never hides', async () => {
    const { activateWrapper } = await load();
    shouldAutoShowBadges.mockReturnValue(true);
    activateWrapper(wrap('<a href="#x">link</a>'));
    expect(clearHintFilter).toHaveBeenCalledTimes(1);
    expect(scheduleHintRefresh).toHaveBeenCalledTimes(1);
    expect(hideBadges).not.toHaveBeenCalled();
  });

  it('in manual mode: hides, and does not schedule a refresh onto hidden badges', async () => {
    const { activateWrapper } = await load();
    shouldAutoShowBadges.mockReturnValue(false);
    activateWrapper(wrap('<a href="#x">link</a>'));
    expect(hideBadges).toHaveBeenCalledTimes(1);
    expect(scheduleHintRefresh).not.toHaveBeenCalled();
    expect(clearHintFilter).not.toHaveBeenCalled();
  });

  it('runs for the armed verbs too, not only the plain path', async () => {
    const { activateWrapper } = await load();
    for (const verb of ['yank', 'copytext', 'focus', 'hover', 'caret']) {
      vi.clearAllMocks();
      shouldAutoShowBadges.mockReturnValue(true);
      keyHandler.takeHintAction.mockReturnValue(verb);
      activateWrapper(wrap('<a href="https://example.test/x">link</a>'));
      expect(scheduleHintRefresh, verb).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the module itself', () => {
  it('does nothing at import time', async () => {
    await load();
    for (const m of [activateElement, dispatchHover, noteActivated, clearHintFilter,
      hideBadges, scheduleHintRefresh, copyText, flashToast]) {
      expect(m).not.toHaveBeenCalled();
    }
    expect(keyHandler.takeHintAction).not.toHaveBeenCalled();
  });
});
