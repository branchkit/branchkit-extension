import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { KeyHandler } from './keyboard';
import { ActionDispatcher, CommandRegistry } from '../dispatcher';

// Derive a plausible `event.code` from a `key` char, so synthetic events carry
// the layout-independent code the registry now matches on. Real browsers always
// set `code`; jsdom KeyboardEvent does not for hand-built keys.
function codeFor(key: string): string {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  const map: Record<string, string> = { '/': 'Slash', ' ': 'Space', '.': 'Period', ',': 'Comma' };
  return map[key] ?? key; // Escape / Enter / Backspace are read off e.key anyway
}

function makeKey(key: string, extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key,
    code: codeFor(key),
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...extra,
  } as unknown as KeyboardEvent;
}

let registry: CommandRegistry;
let dispatcher: ActionDispatcher;
let handler: KeyHandler;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let dispatchSpy: any;

beforeEach(() => {
  modes.reset(); // the stack is a singleton; each test starts from Normal
  registry = new CommandRegistry();
  dispatcher = new ActionDispatcher();
  dispatchSpy = vi.fn();
  (dispatcher as any).dispatch = dispatchSpy;
  handler = new KeyHandler(registry, dispatcher);
  // Escape is no longer handled inside KeyHandler: it delegates to the shared
  // escape cascade so the key and the spoken "escape"/"over" unwind through one
  // declared order (activate/escape-cascade.ts). Production installs the real
  // cascade; here we install the slice of it that touches this unit — the hint
  // layers — which is what these cases exercise.
  handler.setEscapeHook(() => handler.escapeHintLayer() ?? '');
});

// The keyboard is Normal by default (notes/DESIGN_KEYBOARD_MODES.md). Hints
// stay always-VISIBLE for voice, but letters only filter them in the explicit
// hint mode entered by `f`. Everywhere else the alphabet is Normal-mode
// keybinds.

describe('hint mode entry/exit', () => {
  it('enterHintMode sets mode to hint and fires the mode callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterHintMode();
    expect(handler.getMode()).toBe('hint');
    expect(modeCb).toHaveBeenCalledWith('hint');
  });

  it('exitHintMode resets to normal and fires the mode callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterHintMode();
    handler.exitHintMode();
    expect(handler.getMode()).toBe('normal');
    expect(modeCb).toHaveBeenLastCalledWith('normal');
  });

  it('exitHintMode from normal does not re-fire the callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.exitHintMode();
    expect(modeCb).not.toHaveBeenCalled();
  });
});

describe('hint mode — codeword filtering', () => {
  it('letter keys in hint mode append to filter and fire callback', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    handler.handleKeyDown(makeKey('a'));
    expect(cb).toHaveBeenCalledWith('a');

    handler.handleKeyDown(makeKey('B'));
    expect(cb).toHaveBeenCalledWith('ab');
  });

  it('backspace in codeword mode removes last char', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('b'));
    handler.handleKeyDown(makeKey('Backspace'));
    expect(cb).toHaveBeenLastCalledWith('a');
  });

  it('enter is not special in hint mode — hints complete by typing, not Enter', () => {
    handler.enterHintMode();
    const result = handler.handleKeyDown(makeKey('Enter'));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('/ dispatches find_open (find-in-page), not a hint filter', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    const result = handler.handleKeyDown(makeKey('/'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('find_open');
    expect(cb).not.toHaveBeenCalled();
  });

  it('escape exits hint mode (no prefix) and fires the escape callback', () => {
    // The badges do NOT hide from the KeyHandler — that's a content-side
    // visibility decision (always-visible keeps them; manual dismisses). We
    // just exit the mode and notify.
    const escapeCb = vi.fn();
    handler.setHintEscapeCallback(escapeCb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('Escape'));
    expect(handler.getMode()).toBe('normal');
    expect(escapeCb).toHaveBeenCalled();
    // Exiting the mode dispatches nothing — badge visibility is content-side.
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('escape with a typed prefix cancels just the prefix and stays in hint mode', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('x'));

    const result = handler.handleKeyDown(makeKey('Escape'));
    expect(result).toBe(true);
    expect(cb).toHaveBeenLastCalledWith(''); // prefix cleared
    expect(handler.getMode()).toBe('hint'); // did NOT exit

    // A second Escape (no prefix in progress) exits to normal.
    handler.handleKeyDown(makeKey('Escape'));
    expect(handler.getMode()).toBe('normal');
  });

  it('intercepts inside an editable field (hint mode wins over insert)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();

    const result = handler.handleKeyDown(makeKey('a'));
    expect(result).toBe(true);
    expect(cb).toHaveBeenCalledWith('a');
    input.remove();
  });
});

describe('new-tab casing (capital mid-codeword)', () => {
  it('arms new-tab when a capital is typed mid-codeword', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a')); // start codeword (lowercase)
    expect(handler.isNewTabArmed()).toBe(false);
    handler.handleKeyDown(makeKey('A', { shiftKey: true })); // capital, mid-codeword
    expect(handler.isNewTabArmed()).toBe(true);
  });

  it('does not arm for an all-lowercase codeword', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('b'));
    expect(handler.isNewTabArmed()).toBe(false);
  });

  it('disarms on exitHintMode (after a pick)', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    expect(handler.isNewTabArmed()).toBe(true);
    handler.exitHintMode();
    expect(handler.isNewTabArmed()).toBe(false);
  });

  it('disarms when the prefix is cleared with Escape', () => {
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    expect(handler.isNewTabArmed()).toBe(true);
    handler.handleKeyDown(makeKey('Escape')); // clears the prefix
    expect(handler.isNewTabArmed()).toBe(false);
  });
});

// The pending hint action lived in content.ts as a bare `let`, so the
// verb → activate → consume → reset arc had no test anywhere. These are its
// first. The verb COMMANDS still register in content.ts; what moved here is
// the state they arm, next to the newTabArmed it interacts with.
describe('the pending hint action', () => {
  it('is a plain activate until a verb arms one', () => {
    expect(handler.takeHintAction()).toBe('activate');
  });

  it('holds the armed verb until something consumes it', () => {
    handler.armHintAction('yank');
    expect(handler.takeHintAction()).toBe('yank');
  });

  // The one-shot rule. A verb that survived its activation would silently
  // apply to the NEXT badge the user picked — a `yf` that keeps yanking.
  it('disarms on consumption, so a verb never reaches a second pick', () => {
    handler.armHintAction('hover');
    expect(handler.takeHintAction()).toBe('hover');
    expect(handler.takeHintAction()).toBe('activate');
  });

  it('disarms without acting when the verb is abandoned', () => {
    handler.armHintAction('copytext');
    handler.resetHintAction();
    expect(handler.takeHintAction()).toBe('activate');
  });

  it('takes the last verb armed when the user changes their mind', () => {
    handler.armHintAction('yank');
    handler.armHintAction('focus');
    expect(handler.takeHintAction()).toBe('focus');
  });

  describe('the capital-letter new-tab promotion', () => {
    it('promotes a plain activate to newtab when a capital armed new-tab', () => {
      handler.enterHintMode();
      handler.handleKeyDown(makeKey('a'));
      handler.handleKeyDown(makeKey('A', { shiftKey: true }));
      expect(handler.isNewTabArmed()).toBe(true);

      handler.promoteNewTabIfArmed();
      expect(handler.takeHintAction()).toBe('newtab');
    });

    // An explicit verb keeps precedence: `yf` then a capital still yanks. The
    // capital is the affordance for "open this", and the user already said
    // what to do instead of opening it.
    it('leaves an explicit verb alone', () => {
      handler.enterHintMode();
      handler.armHintAction('yank');
      handler.handleKeyDown(makeKey('a'));
      handler.handleKeyDown(makeKey('A', { shiftKey: true }));
      expect(handler.isNewTabArmed()).toBe(true);

      handler.promoteNewTabIfArmed();
      expect(handler.takeHintAction()).toBe('yank');
    });

    it('is a no-op when no capital was typed', () => {
      handler.enterHintMode();
      handler.handleKeyDown(makeKey('a'));
      handler.promoteNewTabIfArmed();
      expect(handler.takeHintAction()).toBe('activate');
    });
  });
});

describe('codeword filter — match predicate (no blank-on-nonmatch)', () => {
  it('no-ops a first letter no codeword starts with (hints stay put)', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.setMatchPredicate((p) => p.startsWith('a')); // only "a…" codewords exist

    const result = handler.handleKeyDown(makeKey('k')); // no "k…" codeword
    expect(result).toBe(true); // consumed (doesn't fall through to the page)
    expect(cb).not.toHaveBeenCalled(); // filter NOT applied → nothing hidden
  });

  it('REPORTS the refusal, and reports nothing when the key is accepted', () => {
    // The keyboard says "that was refused" and stops there; what a refusal
    // looks like belongs to content, through the same seam mode changes use.
    // Reaching for the mode chip directly gave it two writers (2026-07-27).
    const refused = vi.fn();
    handler.setRefusedKeyCallback(refused);
    handler.setFilterCallback(vi.fn());
    handler.enterHintMode();
    handler.setMatchPredicate((p) => p.startsWith('a'));

    handler.handleKeyDown(makeKey('k'));
    expect(refused).toHaveBeenCalledTimes(1);

    handler.handleKeyDown(makeKey('a'));
    expect(refused).toHaveBeenCalledTimes(1); // accepted — still one
  });

  it('accepts a matching first letter and filters', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.setMatchPredicate((p) => p.startsWith('a'));

    handler.handleKeyDown(makeKey('a'));
    expect(cb).toHaveBeenCalledWith('a');
  });

  it('does not extend the prefix into a non-matching codeword', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    handler.enterHintMode();
    handler.setMatchPredicate((p) => p === 'a' || p === 'ai');

    handler.handleKeyDown(makeKey('a'));
    expect(cb).toHaveBeenLastCalledWith('a');
    handler.handleKeyDown(makeKey('z')); // "az" matches nothing → no-op
    expect(cb).toHaveBeenLastCalledWith('a');
    handler.handleKeyDown(makeKey('i')); // "ai" matches
    expect(cb).toHaveBeenLastCalledWith('ai');
  });
});

describe('normal mode — bare letters are keybinds, even with hints painted', () => {
  it('a bare letter fires its keybind instead of filtering hints', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    const cb = vi.fn();
    handler.setFilterCallback(cb);

    const result = handler.handleKeyDown(makeKey('j'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_down', {});
    expect(cb).not.toHaveBeenCalled(); // NOT a hint filter
    expect(handler.getMode()).toBe('normal');
  });

  it('an unbound bare letter falls through (reaches the page / other extensions)', () => {
    const cb = vi.fn();
    handler.setFilterCallback(cb);
    const result = handler.handleKeyDown(makeKey('z')); // nothing bound
    expect(result).toBe(false);
    expect(cb).not.toHaveBeenCalled();
  });

  it('yields to editable fields (Normal-mode keybinds do not hijack a search box)', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = handler.handleKeyDown(makeKey('j'));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    input.remove();
  });

  it('Escape in an editable field blurs it (back to Normal, Vimium behavior)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    const result = handler.handleKeyDown(makeKey('Escape'));
    expect(result).toBe(true); // consumed, not passed to the page
    expect(document.activeElement).not.toBe(input); // blurred → Normal mode
    input.remove();
  });
});

describe('normal mode — command sequences', () => {
  it('exact match dispatches action', () => {
    registry.add({ keys: 'KeyF', action: 'hint_mode' });
    const result = handler.handleKeyDown(makeKey('f'));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('hint_mode', {});
  });

  it('partial match waits for more keys', () => {
    registry.add({ keys: 'KeyG KeyG', action: 'scroll_top' });
    const result = handler.handleKeyDown(makeKey('g'));
    expect(result).toBe(true);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('multi-key sequence dispatches on completion', () => {
    registry.add({ keys: 'KeyG KeyG', action: 'scroll_top' });
    handler.handleKeyDown(makeKey('g'));
    handler.handleKeyDown(makeKey('g'));
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_top', {});
  });

  it('no match resets sequence', () => {
    registry.add({ keys: 'KeyF', action: 'hint_mode' });
    const result = handler.handleKeyDown(makeKey('x'));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('an unbound modifier combo passes through (native shortcut / other extension)', () => {
    registry.add({ keys: 'KeyC', action: 'some_action' }); // bare c, not Meta+C
    const result = handler.handleKeyDown(makeKey('c', { metaKey: true }));
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });
});

describe('normal mode — modifier-combo commands', () => {
  it('a bound modifier combo dispatches', () => {
    registry.add({ keys: 'ctrl+shift+KeyK', action: 'next_tab' });
    const result = handler.handleKeyDown(makeKey('k', { ctrlKey: true, shiftKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('next_tab', {});
  });

  it('a bound Shift+letter dispatches its command', () => {
    registry.add({ keys: 'shift+KeyG', action: 'scroll_bottom' });
    const result = handler.handleKeyDown(makeKey('G', { shiftKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_bottom', {});
  });

  it('a bound modifier combo fires even inside an editable field', () => {
    // Required for the palette / hide chords (Ctrl+K, Ctrl+S): they must fire
    // (and suppress the native shortcut) while focused in a search box.
    registry.add({ keys: 'ctrl+KeyK', action: 'do_thing' });
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = handler.handleKeyDown(makeKey('k', { ctrlKey: true }));
    expect(result).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('do_thing', {});
    input.remove();
  });

  it('an unbound modifier combo in a field falls through (native shortcut)', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const result = handler.handleKeyDown(makeKey('a', { ctrlKey: true })); // Ctrl+A select-all
    expect(result).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('pass-through (explicit insert) mode', () => {
  it('enterInsertMode reports insert and passes all keys to the page', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterInsertMode();
    expect(handler.getMode()).toBe('insert');
    expect(modeCb).toHaveBeenLastCalledWith('insert');
    // A bare letter that would normally be a keybind now reaches the page.
    expect(handler.handleKeyDown(makeKey('f'))).toBe(false);
    // Even a chord reaches the page in pass-through.
    expect(handler.handleKeyDown(makeKey('s', { ctrlKey: true }))).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('Escape leaves pass-through and returns to normal', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterInsertMode();
    const result = handler.handleKeyDown(makeKey('Escape'));
    expect(result).toBe(true); // intercepted to exit, not passed to page
    expect(handler.getMode()).toBe('normal');
    expect(modeCb).toHaveBeenLastCalledWith('normal');
  });

  it('toggleInsertMode flips in and out', () => {
    handler.toggleInsertMode();
    expect(handler.getMode()).toBe('insert');
    handler.toggleInsertMode();
    expect(handler.getMode()).toBe('normal');
  });
});

describe('passNextKey', () => {
  it('hands exactly the next keystroke to the page, then resumes', () => {
    handler.armPassNextKey();
    // The next key passes through unhandled…
    expect(handler.handleKeyDown(makeKey('f'))).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
    // …and the one after that is handled normally again (a bound keybind would
    // dispatch; with an empty registry it just falls through, but we're back in
    // normal mode either way).
    expect(handler.getMode()).toBe('normal');
  });
});

describe('per-site exclusion', () => {
  it('excluded reports insert and passes every key to the page', () => {
    handler.setExcluded(true);
    expect(handler.isExcluded()).toBe(true);
    expect(handler.getMode()).toBe('insert');
    expect(handler.handleKeyDown(makeKey('f'))).toBe(false);
    // Escape is NOT special on an excluded site — it reaches the page too.
    expect(handler.handleKeyDown(makeKey('Escape'))).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('clearing exclusion restores normal keybind handling', () => {
    handler.setExcluded(true);
    handler.setExcluded(false);
    expect(handler.isExcluded()).toBe(false);
    expect(handler.getMode()).toBe('normal');
  });
});

describe('granular per-site passkeys', () => {
  it('passes a listed key to the page even when it is bound', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    handler.setPassKeys(['j']);
    // The passkey wins: reaches the page, and the bind does NOT fire.
    expect(handler.handleKeyDown(makeKey('j'))).toBe(false);
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('leaves unlisted binds working', () => {
    registry.add({ keys: 'KeyF', action: 'hint_mode' });
    handler.setPassKeys(['j', 'k']); // f not listed
    expect(handler.handleKeyDown(makeKey('f'))).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('hint_mode', {});
  });

  it('matches event.key exactly (symbols pass through)', () => {
    handler.setPassKeys(['#']);
    expect(handler.handleKeyDown(makeKey('#', { shiftKey: true }))).toBe(false);
  });

  it('does not apply in hint mode (letters still filter hints)', () => {
    handler.setPassKeys(['a']);
    handler.setFilterCallback(vi.fn());
    handler.enterHintMode();
    expect(handler.handleKeyDown(makeKey('a'))).toBe(true); // consumed as codeword
  });

  it('clears when set to empty — the bind fires again', () => {
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    handler.setPassKeys(['j']);
    handler.setPassKeys([]);
    expect(handler.handleKeyDown(makeKey('j'))).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('scroll_down', {});
  });
});

describe('mark capture (Vimium m / `)', () => {
  it('armMarkSet captures the next letter as a local mark and fires onMark', () => {
    const onMark = vi.fn();
    handler.setMarkCallback(onMark);
    handler.armMarkSet();
    expect(handler.getMode()).toBe('mark-set');
    const consumed = handler.handleKeyDown(makeKey('q'));
    expect(consumed).toBe(true);
    expect(onMark).toHaveBeenCalledWith('set', 'q', false);
    // Arm is a one-shot: back to normal, the next key is a keybind again.
    expect(handler.getMode()).toBe('normal');
  });

  it('Shift+letter marks it global', () => {
    const onMark = vi.fn();
    handler.setMarkCallback(onMark);
    handler.armMarkJump();
    handler.handleKeyDown(makeKey('A', { shiftKey: true }));
    expect(onMark).toHaveBeenCalledWith('jump', 'A', true);
  });

  it('the ` / \' registers stay local even with Shift', () => {
    const onMark = vi.fn();
    handler.setMarkCallback(onMark);
    handler.armMarkJump();
    handler.handleKeyDown(makeKey('`', { shiftKey: true }));
    expect(onMark).toHaveBeenCalledWith('jump', '`', false);
  });

  it('a bare modifier keydown does not abandon the arm — the letter after it lands', () => {
    const onMark = vi.fn();
    handler.setMarkCallback(onMark);
    handler.armMarkSet();
    expect(handler.handleKeyDown(makeKey('Shift', { shiftKey: true }))).toBe(true);
    expect(handler.getMode()).toBe('mark-set'); // still armed
    handler.handleKeyDown(makeKey('B', { shiftKey: true }));
    expect(onMark).toHaveBeenCalledWith('set', 'B', true);
  });

  it('Escape cancels the arm without firing onMark', () => {
    const onMark = vi.fn();
    handler.setMarkCallback(onMark);
    handler.armMarkSet();
    expect(handler.handleKeyDown(makeKey('Escape'))).toBe(true);
    expect(onMark).not.toHaveBeenCalled();
    expect(handler.getMode()).toBe('normal');
  });

  it('a non-printable key (arrow) abandons the arm', () => {
    const onMark = vi.fn();
    handler.setMarkCallback(onMark);
    handler.armMarkJump();
    expect(handler.handleKeyDown(makeKey('ArrowDown'))).toBe(false);
    expect(onMark).not.toHaveBeenCalled();
    expect(handler.getMode()).toBe('normal');
  });

  it('mark capture pre-empts hint filtering', () => {
    handler.setFilterCallback(vi.fn());
    const onMark = vi.fn();
    handler.setMarkCallback(onMark);
    handler.enterHintMode();
    handler.armMarkSet();
    handler.handleKeyDown(makeKey('z'));
    expect(onMark).toHaveBeenCalledWith('set', 'z', false);
  });
});

describe('caret / visual mode routing', () => {
  it('enterCaretMode routes bare keys to the injected caret handler', () => {
    const caretKey = vi.fn().mockReturnValue(true);
    handler.setCaretKeyHandler(caretKey);
    // A Normal-mode bind that must NOT fire while caret owns the keyboard.
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });

    handler.enterCaretMode('caret');
    expect(handler.getMode()).toBe('caret');

    const consumed = handler.handleKeyDown(makeKey('j'));
    expect(consumed).toBe(true);
    expect(caretKey).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled(); // scroll_down suppressed
  });

  it('reports the visual sub-mode and fires the mode callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterCaretMode('visual');
    expect(handler.getMode()).toBe('visual');
    expect(modeCb).toHaveBeenCalledWith('visual');
  });

  it('exitCaretMode returns to normal and fires the callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.setCaretKeyHandler(vi.fn().mockReturnValue(true));
    handler.enterCaretMode('caret');
    handler.exitCaretMode();
    expect(handler.getMode()).toBe('normal');
    expect(modeCb).toHaveBeenLastCalledWith('normal');
  });

  it('real-modifier chords still reach the registry (Ctrl+C copies)', () => {
    handler.setCaretKeyHandler(vi.fn().mockReturnValue(true));
    handler.enterCaretMode('visual');
    // Ctrl+C is unbound → handleNormalKey returns false → browser copies.
    expect(handler.handleKeyDown(makeKey('c', { ctrlKey: true }))).toBe(false);
  });

  it('caret capture overrides an editable-field focus (modal capture)', () => {
    const caretKey = vi.fn().mockReturnValue(true);
    handler.setCaretKeyHandler(caretKey);
    handler.enterCaretMode('caret');
    // Even if a field were focused, caret owns the key (isModalCapture()).
    handler.handleKeyDown(makeKey('l'));
    expect(caretKey).toHaveBeenCalled();
  });
});

describe('video mode routing', () => {
  it('enterVideoMode routes bare keys to the injected video handler', () => {
    const videoKey = vi.fn().mockReturnValue(true);
    handler.setVideoKeyHandler(videoKey);
    // Normal-mode binds that must NOT fire while the layer owns the keyboard
    // — j/k are exactly the collision the layer exists to resolve.
    registry.add({ keys: 'KeyJ', action: 'scroll_down' });
    registry.add({ keys: 'KeyK', action: 'scroll_up' });

    handler.enterVideoMode();
    expect(handler.getMode()).toBe('video');

    expect(handler.handleKeyDown(makeKey('k'))).toBe(true);
    expect(videoKey).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).not.toHaveBeenCalled(); // scroll_up suppressed
  });

  it('exitVideoMode returns to normal and fires the mode callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.setVideoKeyHandler(vi.fn().mockReturnValue(true));
    handler.enterVideoMode();
    expect(modeCb).toHaveBeenLastCalledWith('video');
    handler.exitVideoMode();
    expect(handler.getMode()).toBe('normal');
    expect(modeCb).toHaveBeenLastCalledWith('normal');
  });

  it('real-modifier chords still reach the registry from the layer', () => {
    handler.setVideoKeyHandler(vi.fn().mockReturnValue(true));
    handler.enterVideoMode();
    // Ctrl+K is a palette-tier chord — must fire even inside the layer.
    registry.add({ keys: 'ctrl+KeyK', action: 'toggle_palette' });
    expect(handler.handleKeyDown(makeKey('k', { ctrlKey: true }))).toBe(true);
    expect(dispatchSpy).toHaveBeenCalledWith('toggle_palette', {});
  });
});

// getMode() resolves ONE mode through a precedence chain, which is the right
// answer for the chip and the wrong one for "is this layer up". The modes are
// not mutually exclusive, so the ranked read reports a live layer as absent —
// and two callers acted on that: the escape cascade (which must peel a layer
// that is live whether or not it ranks top) and the pick window's entry-state
// snapshot (which restored to normal instead of hint for exactly this reason).
describe('unranked mode reads', () => {
  it('isHintMode is true whenever the hint layer is up, outranked or not', () => {
    handler.enterHintMode();
    expect(handler.isHintMode()).toBe(true);
    expect(handler.getMode()).toBe('hint');

    // Caret outranks hint in getMode(); the hint layer is still up and still
    // holding its codewords.
    handler.enterCaretMode('caret');
    expect(handler.getMode()).toBe('caret');
    expect(handler.isHintMode()).toBe(true);

    handler.exitHintMode();
    expect(handler.isHintMode()).toBe(false);
  });

  it('isVideoMode is true whenever the video layer is up, outranked or not', () => {
    handler.enterVideoMode();
    expect(handler.isVideoMode()).toBe(true);
    expect(handler.getMode()).toBe('video');

    // Caret outranks video too — and a video layer the cascade could not see
    // is the state where being stuck is worst, because bare keys are gone.
    handler.enterCaretMode('visual');
    expect(handler.getMode()).toBe('visual');
    expect(handler.isVideoMode()).toBe(true);

    handler.exitVideoMode();
    expect(handler.isVideoMode()).toBe(false);
  });
});

// --- Wave 3 C2: the mode stack rides the keyboard's mode lifetimes ---------
//
// The KeyHandler's flags stay the readers' truth through C2; the stack is the
// writer-side spine, pushed/popped inside the SAME enter/exit implementations
// so the two cannot drift. peelTop becomes the escape decider at C3 — the
// inner-transient case is proven here against real keyboard state.

import { modes } from '../core/modes';
import { clearInnerTransientProbes, setInnerTransientProbe } from '../core/mode-stack';

describe('the mode stack rides the keyboard lifetimes (Wave 3 C2)', () => {
  beforeEach(() => modes.reset());
  afterEach(() => clearInnerTransientProbes());

  it('hint mode pushes on enter and pops on exit, one lifetime', () => {
    handler.enterHintMode();
    expect(modes.has('hint')).toBe(true);
    handler.enterHintMode(); // re-entry joins, never nests
    expect(modes.depth()).toBe(1);
    handler.exitHintMode();
    expect(modes.has('hint')).toBe(false);
    handler.exitHintMode(); // exit when never entered is a no-op
    expect(modes.depth()).toBe(0);
  });

  it('video mode pushes on enter and pops on exit', () => {
    handler.enterVideoMode();
    expect(modes.has('video')).toBe(true);
    handler.exitVideoMode();
    expect(modes.has('video')).toBe(false);
  });

  it('the typed prefix is hint\'s inner transient: peelTop clears it without popping', () => {
    setInnerTransientProbe('hint', () => handler.peelHintPrefix());
    handler.setMatchPredicate(() => true);
    handler.enterHintMode();
    handler.handleKeyDown(makeKey('a'));

    // First escape: the letters go, the mode stays — nothing pops.
    expect(modes.peelTop('test')).toEqual({ peeled: 'inner', name: 'hint_prefix', reason: 'test' });
    expect(handler.getMode()).toBe('hint');
    expect(modes.has('hint')).toBe(true);

    // Second escape: the mode itself. C2 boundary, on purpose: peelTop pops
    // the ENTRY but does not yet drive the flag — the exit effects wire in at
    // C3, when the cascade's decider flips here.
    expect(modes.peelTop('test')).toEqual({ peeled: 'mode', id: 'hint', reason: 'test' });
    expect(modes.has('hint')).toBe(false);
  });

  it('peelHintPrefix answers null with no prefix (the probe reads as no-transient)', () => {
    handler.enterHintMode();
    expect(handler.peelHintPrefix()).toBe(null);
    handler.exitHintMode();
    expect(handler.peelHintPrefix()).toBe(null);
  });
});

describe('the chip hears cascade-order exits (video Escape regression, 2026-07-26)', () => {
  // The cascade pops the stack FIRST and then runs the mode's exit as a
  // finisher, whose own pop no-ops. A notification gated behind that pop
  // never fired: keys returned to normal (routing derives from the stack)
  // while the chip kept saying "video" — indistinguishable, from the user's
  // seat, from being stuck in the mode. Notifications now ride getMode()'s
  // EDGE, so any caller order reaches the chip.
  beforeEach(() => modes.reset());

  it('video: pop-then-finisher still notifies normal', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterVideoMode();
    expect(modeCb).toHaveBeenLastCalledWith('video');

    expect(modes.peelTop('key_escape')).toMatchObject({ peeled: 'mode', id: 'video' });
    handler.exitVideoMode(); // the cascade's finisher — stack already popped
    expect(modeCb).toHaveBeenLastCalledWith('normal');
    expect(handler.getMode()).toBe('normal');
  });

  it('hint: pop-then-finisher still notifies normal', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.enterHintMode();
    expect(modeCb).toHaveBeenLastCalledWith('hint');

    expect(modes.peelTop('key_escape')).toMatchObject({ peeled: 'mode', id: 'hint' });
    handler.escapeHintMode();
    expect(modeCb).toHaveBeenLastCalledWith('normal');
  });

  it('defensive exits stay quiet: no edge, no callback', () => {
    const modeCb = vi.fn();
    handler.setModeChangeCallback(modeCb);
    handler.exitHintMode();
    handler.exitVideoMode();
    handler.exitCaretMode();
    expect(modeCb).not.toHaveBeenCalled();
  });
});
