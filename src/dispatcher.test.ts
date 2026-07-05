import { describe, it, expect, vi } from 'vitest';
import { ActionDispatcher, CommandRegistry } from './dispatcher';
import { DEFAULT_KEYMAP } from './command-catalog';

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
