import { describe, it, expect, beforeEach } from 'vitest';
import { setTabMarker, reapplyTabMarker, _resetTabTitleForTesting, tabTitleMessageHandlers } from './tab-title';

describe('tab title decorator', () => {
  beforeEach(() => {
    document.title = 'GitHub';
    _resetTabTitleForTesting();
  });

  it('prepends the marker letters', () => {
    setTabMarker('a');
    expect(document.title).toBe('[a] GitHub');
  });

  it('does not double-decorate on re-apply (strip-before-apply)', () => {
    setTabMarker('a');
    reapplyTabMarker();
    reapplyTabMarker();
    expect(document.title).toBe('[a] GitHub');
  });

  it('ignores our own write echoing back (echo guard)', () => {
    setTabMarker('a');
    const decorated = document.title;
    reapplyTabMarker(); // simulate onUpdated firing for our own write
    expect(document.title).toBe(decorated);
  });

  it('re-decorates after the page changes its title', () => {
    setTabMarker('a');
    document.title = 'GitHub — Issues'; // page rewrote it (marker gone)
    reapplyTabMarker();
    expect(document.title).toBe('[a] GitHub — Issues');
  });

  it('adopts an incremental page edit without re-stripping', () => {
    setTabMarker('a'); // "[a] GitHub"
    document.title = '▶︎ [a] GitHub'; // page prepended to our decorated title
    reapplyTabMarker();
    expect(document.title).toBe('▶︎ [a] GitHub'); // left as-is, not re-stripped
  });

  it('clears the decoration when marker set to null', () => {
    setTabMarker('a');
    setTabMarker(null);
    expect(document.title).toBe('GitHub');
  });

  it('updates the letters when reassigned', () => {
    setTabMarker('a');
    setTabMarker('qr');
    expect(document.title).toBe('[qr] GitHub');
  });

  it('leaves an empty title undecorated (PDF/pre-load)', () => {
    document.title = '';
    _resetTabTitleForTesting();
    setTabMarker('a');
    expect(document.title).toBe('');
  });
});

describe('tabTitleMessageHandlers', () => {
  const subframe = () =>
    Object.defineProperty(window, 'top', { configurable: true, get: () => ({} as Window) });
  const topframe = () =>
    Object.defineProperty(window, 'top', { configurable: true, get: () => window });

  beforeEach(() => {
    topframe();
    document.title = 'GitHub';
    _resetTabTitleForTesting();
  });

  it('sets the marker in the top frame', () => {
    tabTitleMessageHandlers.TAB_MARKER({ type: 'TAB_MARKER', letters: 'qr' }, {} as never);
    expect(document.title).toBe('[qr] GitHub');
  });

  it('does nothing in a subframe — the marker decorates the TAB title', () => {
    subframe();
    tabTitleMessageHandlers.TAB_MARKER({ type: 'TAB_MARKER', letters: 'qr' }, {} as never);
    expect(document.title).toBe('GitHub');
  });

  it('reapplies a marker the page overwrote, top frame only', () => {
    tabTitleMessageHandlers.TAB_MARKER({ type: 'TAB_MARKER', letters: 'qr' }, {} as never);
    document.title = 'GitHub — Pull requests';
    tabTitleMessageHandlers.TAB_MARKER_REAPPLY({ type: 'TAB_MARKER_REAPPLY' }, {} as never);
    expect(document.title).toBe('[qr] GitHub — Pull requests');

    document.title = 'GitHub — Issues';
    subframe();
    tabTitleMessageHandlers.TAB_MARKER_REAPPLY({ type: 'TAB_MARKER_REAPPLY' }, {} as never);
    expect(document.title).toBe('GitHub — Issues');
  });

  it('clears the marker on a null letters payload', () => {
    tabTitleMessageHandlers.TAB_MARKER({ type: 'TAB_MARKER', letters: 'qr' }, {} as never);
    tabTitleMessageHandlers.TAB_MARKER({ type: 'TAB_MARKER', letters: null }, {} as never);
    expect(document.title).toBe('GitHub');
  });
});
