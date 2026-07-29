import { describe, it, expect, vi } from 'vitest';
import { ActionDispatcher, CommandRegistry } from './dispatcher';
import { DEFAULT_KEYMAP } from './keymap/command-catalog';

describe('CommandRegistry.replaceAll', () => {
  it('replaces the binding set wholesale', () => {
    const r = new CommandRegistry();
    r.add({ keys: 'x', action: 'old' });
    r.replaceAll([{ keys: 'y', action: 'new' }]);

    expect(r.match('x')).toEqual({ result: 'none' });
    expect(r.match('y')).toEqual({ result: 'exact', entry: { keys: 'y', action: 'new' } });
  });

  it('copies entries (later mutation of the source does not leak in)', () => {
    const r = new CommandRegistry();
    const src = [{ keys: 'a', action: 'act', params: { n: '1' } }];
    r.replaceAll(src);
    src[0].action = 'mutated';
    src[0].params!.n = '9';

    const m = r.match('a');
    expect(m.entry?.action).toBe('act');
    expect(m.entry?.params).toEqual({ n: '1' });
  });

  it('builds a working registry from DEFAULT_KEYMAP', () => {
    const r = new CommandRegistry();
    r.replaceAll(DEFAULT_KEYMAP.map((e) => ({ keys: e.keys, action: e.command, params: e.params })));

    expect(r.match('KeyJ').entry?.action).toBe('scroll_down'); // bare j (Vimium)
    // Shift+H = history back; bare H = scroll-left (distinct tokens).
    expect(r.match('shift+KeyH').entry?.action).toBe('history_back');
    expect(r.match('KeyH').entry?.action).toBe('scroll_left');
    // 'gt' is a two-token sequence: one KeyG is a partial prefix (gg/gt/gi/…).
    expect(r.match('KeyG KeyT').entry?.action).toBe('next_tab');
    expect(r.match('KeyG')).toEqual({ result: 'partial' });
    // 'cs' is a two-token sequence: one KeyC is a partial prefix.
    expect(r.match('KeyC')).toEqual({ result: 'partial' });
    expect(r.match('KeyC KeyS').entry?.action).toBe('cycle_scroll_target');
  });

  it('matches on token boundaries — a combo prefix is not a sequence prefix', () => {
    const r = new CommandRegistry();
    r.replaceAll([{ keys: 'KeyG KeyG', action: 'gg' }, { keys: 'shift+KeyG', action: 'sg' }]);
    // "KeyG" is a partial of "KeyG KeyG" but NOT of "shift+KeyG".
    expect(r.match('KeyG')).toEqual({ result: 'partial' });
    // A modifier combo is a single token, never a prefix of a bare-key sequence.
    expect(r.match('shift+KeyG')).toEqual({ result: 'exact', entry: { keys: 'shift+KeyG', action: 'sg' } });
  });
});

describe('ActionDispatcher', () => {
  it('routes to the registered handler with params', () => {
    const d = new ActionDispatcher();
    const h = vi.fn();
    d.register('go', h);
    d.dispatch('go', { dir: 'down' });
    expect(h).toHaveBeenCalledWith({ dir: 'down' });
  });

  it('warns and no-ops on an unknown action', () => {
    const d = new ActionDispatcher();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    d.dispatch('missing');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

// --- Registration contract (entry-point topology phase 3b follow-up) --------
//
// `register` became a duplicate-THROW rather than a silent `Map.set` when the
// 44 command bindings left content.ts for eleven feature modules. While they
// all sat in one contiguous block a collision was visible on sight; dispersed,
// a silent overwrite resolves by whichever registrar the entry point calls
// last — a property nobody edits deliberately.
describe('ActionDispatcher registration', () => {
  it('throws when a second module claims an action already bound', () => {
    const d = new ActionDispatcher();
    d.register('scroll_down', () => {});
    expect(() => d.register('scroll_down', () => {}))
      .toThrow(/duplicate handler for action 'scroll_down'/);
  });

  it('keeps the FIRST handler when a duplicate is refused', () => {
    const d = new ActionDispatcher();
    const calls: string[] = [];
    d.register('find_next', () => { calls.push('first'); });
    try { d.register('find_next', () => { calls.push('second'); }); } catch { /* expected */ }
    d.dispatch('find_next');
    // Last-write-wins was the old behaviour and is the bug being closed: the
    // shadowed command was dead with every lint, tsc and test green.
    expect(calls).toEqual(['first']);
  });

  it('re-registering the IDENTICAL function is a no-op, so composing twice is safe', () => {
    const d = new ActionDispatcher();
    const handler = () => {};
    d.register('same', handler);
    expect(() => d.register('same', handler)).not.toThrow();
    expect(d.registeredActions()).toEqual(['same']);
  });

  it('does not confuse two actions that merely share one handler', () => {
    const d = new ActionDispatcher();
    const shared = () => {};
    d.register('a_one', shared);
    expect(() => d.register('a_two', shared)).not.toThrow();
    expect(d.registeredActions()).toEqual(['a_one', 'a_two']);
  });

  it('reports every bound id, sorted', () => {
    const d = new ActionDispatcher();
    d.register('zoom_in', () => {});
    d.register('find_open', () => {});
    expect(d.registeredActions()).toEqual(['find_open', 'zoom_in']);
  });

  it('the registrars are NOT idempotent, which is what the test reset is for', () => {
    const d = new ActionDispatcher();
    // A registrar builds a fresh closure per call, so identity never matches.
    const registrar = () => { d.register('scroll_up', () => {}); };
    registrar();
    expect(() => registrar()).toThrow(/duplicate handler/);
    d._resetForTesting();
    expect(d.registeredActions()).toEqual([]);
    expect(() => registrar()).not.toThrow();
  });
});
