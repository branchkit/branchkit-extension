/**
 * Palette host lifetime — the overlay iframe's open/close, and (Wave 3 C2)
 * the mode stack riding it: push on open, pop on close, one lifetime however
 * many toggles arrive. The relay/bootstrap machinery is exercised in the
 * palette's own harness; what's pinned here is the lifecycle seam.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../plugin/resolve', () => ({ reportDispatchResult: () => {} }));

vi.stubGlobal('chrome', {
  runtime: {
    // A parseable origin for the relay's FRAME_ORIGIN; about:blank for the
    // frame src so happy-dom doesn't try (and loudly fail) to fetch it.
    getURL: (p: string) => (p ? 'about:blank' : 'chrome-extension://abcdefg/'),
    sendMessage: vi.fn(() => Promise.resolve()),
  },
});

let host: typeof import('./palette-host');
let modes: typeof import('../core/modes')['modes'];

beforeEach(async () => {
  host = await import('./palette-host');
  modes = (await import('../core/modes')).modes;
  host.closePalette();
  modes.reset();
  document.body.innerHTML = '';
});

describe('palette open/close and the mode stack (Wave 3 C2)', () => {
  it('open pushes the mode and mounts the frame; close pops and unmounts', () => {
    host.openPalette();
    expect(host.isPaletteOpen()).toBe(true);
    expect(modes.has('palette')).toBe(true);

    host.closePalette();
    expect(host.isPaletteOpen()).toBe(false);
    expect(modes.has('palette')).toBe(false);
  });

  it('open is idempotent while open — one frame, one stack entry', () => {
    host.openPalette();
    host.openPalette('tabs');
    expect(document.querySelectorAll('[data-branchkit-palette]')).toHaveLength(1);
    expect(modes.depth()).toBe(1);
  });

  it('close without open is a no-op', () => {
    host.closePalette();
    expect(modes.depth()).toBe(0);
  });

  it('toggle drives the same lifetime', () => {
    host.togglePalette();
    expect(modes.has('palette')).toBe(true);
    host.togglePalette();
    expect(modes.has('palette')).toBe(false);
  });
});

describe('paletteHostMessageHandlers', () => {
  it('PALETTE_CLOSE closes the overlay and ANSWERS — the background awaits it', () => {
    host.openPalette('all');
    const answer = host.paletteHostMessageHandlers.PALETTE_CLOSE({ type: 'PALETTE_CLOSE' }, {} as never);
    // Returning undefined here would close the channel with no response, and
    // the background's `await sendMessage` would resolve to undefined before
    // the overlay was gone — it dispatches into the page on that resolution.
    expect(answer).toBe(true);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('PALETTE_COMMAND forwards action and params to the dispatcher', async () => {
    const { dispatcher } = await import('../core/singletons');
    const spy = vi.spyOn(dispatcher, 'dispatch').mockImplementation(() => {});
    host.paletteHostMessageHandlers.PALETTE_COMMAND(
      { type: 'PALETTE_COMMAND', action: 'scroll_down', params: { amount: '3' } }, {} as never,
    );
    expect(spy).toHaveBeenCalledWith('scroll_down', { amount: '3' });

    // A command with no params must still dispatch — an `?? {}` that became a
    // guard would silently drop every parameterless palette pick.
    host.paletteHostMessageHandlers.PALETTE_COMMAND(
      { type: 'PALETTE_COMMAND', action: 'toggle_help' }, {} as never,
    );
    expect(spy).toHaveBeenLastCalledWith('toggle_help', {});
    spy.mockRestore();
  });
});
