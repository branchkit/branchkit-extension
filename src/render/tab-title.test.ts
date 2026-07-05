import { describe, it, expect, beforeEach } from 'vitest';
import { setTabMarker, reapplyTabMarker, _resetTabTitleForTesting } from './tab-title';

describe('tab title decorator', () => {
  beforeEach(() => {
    document.title = 'GitHub';
    _resetTabTitleForTesting();
  });

  it('prepends the marker letters', () => {
    setTabMarker('a');
    expect(document.title).toBe('a| GitHub');
  });

  it('does not double-decorate on re-apply (strip-before-apply)', () => {
    setTabMarker('a');
    reapplyTabMarker();
    reapplyTabMarker();
    expect(document.title).toBe('a| GitHub');
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
    expect(document.title).toBe('a| GitHub — Issues');
  });

  it('adopts an incremental page edit without re-stripping', () => {
    setTabMarker('a'); // "a| GitHub"
    document.title = '▶︎ a| GitHub'; // page prepended to our decorated title
    reapplyTabMarker();
    expect(document.title).toBe('▶︎ a| GitHub'); // left as-is, not re-stripped
  });

  it('clears the decoration when marker set to null', () => {
    setTabMarker('a');
    setTabMarker(null);
    expect(document.title).toBe('GitHub');
  });

  it('updates the letters when reassigned', () => {
    setTabMarker('a');
    setTabMarker('qr');
    expect(document.title).toBe('qr| GitHub');
  });

  it('leaves an empty title undecorated (PDF/pre-load)', () => {
    document.title = '';
    _resetTabTitleForTesting();
    setTabMarker('a');
    expect(document.title).toBe('');
  });
});
