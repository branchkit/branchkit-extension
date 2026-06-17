import { describe, it, expect, afterEach } from 'vitest';
import { nativeOverride, detectOS, detectBrowser } from './browser-shortcuts';

describe('nativeOverride — OS axis', () => {
  it('Ctrl+S overrides Save page on win/linux', () => {
    expect(nativeOverride('ctrl+KeyS', 'other', 'chrome')).toBe('Save page');
  });

  it('Ctrl+S is free on mac (browser uses Cmd, not Ctrl)', () => {
    expect(nativeOverride('ctrl+KeyS', 'mac', 'chrome')).toBeNull();
  });

  it('Cmd+S overrides Save page on mac', () => {
    expect(nativeOverride('meta+KeyS', 'mac', 'chrome')).toBe('Save page');
  });

  it('Cmd+F overrides Find on mac', () => {
    expect(nativeOverride('meta+KeyF', 'mac', 'firefox')).toBe('Find in page');
  });

  it('the win/linux primary (Meta/Super) is not a browser modifier', () => {
    expect(nativeOverride('meta+KeyS', 'other', 'chrome')).toBeNull();
  });
});

describe('nativeOverride — browser axis', () => {
  it('Ctrl+J is Downloads in Chrome only', () => {
    expect(nativeOverride('ctrl+KeyJ', 'other', 'chrome')).toBe('Downloads');
    expect(nativeOverride('ctrl+KeyJ', 'other', 'firefox')).toBeNull();
  });

  it('Ctrl+K is the Search bar in Firefox only', () => {
    expect(nativeOverride('ctrl+KeyK', 'other', 'firefox')).toBe('Search bar');
    expect(nativeOverride('ctrl+KeyK', 'other', 'chrome')).toBeNull();
  });

  it('private vs incognito window differs by browser', () => {
    expect(nativeOverride('ctrl+shift+KeyN', 'other', 'chrome')).toBe('New incognito window');
    expect(nativeOverride('ctrl+shift+KeyP', 'other', 'firefox')).toBe('New private window');
    expect(nativeOverride('ctrl+shift+KeyN', 'other', 'firefox')).toBeNull();
  });
});

describe('nativeOverride — shift disambiguation', () => {
  it('Ctrl+T is New tab, Ctrl+Shift+T is Reopen closed tab', () => {
    expect(nativeOverride('ctrl+KeyT', 'other', 'chrome')).toBe('New tab');
    expect(nativeOverride('ctrl+shift+KeyT', 'other', 'chrome')).toBe('Reopen closed tab');
  });
});

describe('nativeOverride — non-claims', () => {
  it('bare keys and Shift+letter are never browser shortcuts', () => {
    expect(nativeOverride('shift+KeyH', 'other', 'chrome')).toBeNull();
    expect(nativeOverride('KeyS', 'other', 'chrome')).toBeNull();
  });

  it('multi-key sequences are not claimed', () => {
    expect(nativeOverride('KeyG KeyG', 'other', 'chrome')).toBeNull();
  });

  it('alt-combos are not modeled (no claim)', () => {
    expect(nativeOverride('ctrl+alt+KeyT', 'other', 'chrome')).toBeNull();
  });

  it('an unknown primary chord returns null', () => {
    expect(nativeOverride('ctrl+KeyG', 'other', 'chrome')).toBeNull();
  });
});

describe('detection', () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  });
  function stubNavigator(nav: object): void {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  }

  it('detectOS reads mac from userAgentData.platform', () => {
    stubNavigator({ userAgentData: { platform: 'macOS' }, userAgent: '', platform: '' });
    expect(detectOS()).toBe('mac');
  });

  it('detectOS falls back to navigator.platform', () => {
    stubNavigator({ userAgent: '', platform: 'MacIntel' });
    expect(detectOS()).toBe('mac');
  });

  it('detectOS returns other for Windows', () => {
    stubNavigator({ userAgent: '', platform: 'Win32' });
    expect(detectOS()).toBe('other');
  });

  it('detectBrowser distinguishes Firefox from Chrome', () => {
    stubNavigator({ userAgent: 'Mozilla/5.0 ... Firefox/121.0' });
    expect(detectBrowser()).toBe('firefox');
    stubNavigator({ userAgent: 'Mozilla/5.0 ... Chrome/120.0 Safari/537' });
    expect(detectBrowser()).toBe('chrome');
  });
});
