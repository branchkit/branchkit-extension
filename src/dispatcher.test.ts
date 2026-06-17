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

    expect(r.match('j')).toEqual({ result: 'exact', entry: { keys: 'j', action: 'scroll_down' } });
    expect(r.match('H').entry?.action).toBe('previous_tab');
    expect(r.match('L').entry?.action).toBe('next_tab');
    // 'gg' is a two-key sequence: 'g' is a partial prefix.
    expect(r.match('g')).toEqual({ result: 'partial' });
    expect(r.match('gg').entry?.action).toBe('scroll_top');
    // 'cs' likewise.
    expect(r.match('c')).toEqual({ result: 'partial' });
    expect(r.match('cs').entry?.action).toBe('cycle_scroll_target');
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
