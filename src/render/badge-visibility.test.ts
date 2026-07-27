/**
 * Badge-visibility module tests (Wave 4 tail, notes/PLAN_MODE_HOLDER_IMPL.md).
 *
 * The primitive under test is the one that, hand-rolled, shipped a field bug
 * twice in one arc: the screen borrow (snapshot-then-hide, conditional
 * idempotent give-back) and the compound showing-read behind it. Real
 * singletons (store, pageSession, keyHandler) with fake badges — no module
 * mocks, per the arc's synthetic-participants rule.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { store } from '../core/store';
import { pageSession } from '../lifecycle/page-session';
import { keyHandler } from '../core/singletons';
import {
  initBadgeVisibility, anyBadgesShowing, hideBadges, toggleHints,
  setBadgesVisible, borrowBadgeScreen, _resetBadgeVisibilityForTesting,
} from './badge-visibility';

function fakeHint(visible: boolean) {
  return {
    isVisible: visible,
    hide: vi.fn(function (this: { isVisible: boolean }) { this.isVisible = false; }),
    hideLeader: vi.fn(),
    show: vi.fn(function (this: { isVisible: boolean }) { this.isVisible = true; }),
    setFiltered: vi.fn(),
    remove: vi.fn(), // store teardown (wrapper.destroy) calls this
  };
}

function seedWrapper(visibleHint: boolean): ElementWrapper {
  const scanned: ScannedElement = { label: 'x', id: 1, category: 'button', type: 'button', adapter: null, codeword: 'arch' };
  const w = new ElementWrapper(document.createElement('div'), scanned);
  w.hint = fakeHint(visibleHint) as unknown as ElementWrapper['hint'];
  store.addWrapper(w);
  return w;
}

let scans: number;
let hintActionResets: number;

beforeEach(() => {
  scans = 0;
  hintActionResets = 0;
  initBadgeVisibility({
    doScan: () => { scans++; },
    resetHintAction: () => { hintActionResets++; },
  });
  // showBadges' fast path still awaits a frame + a tracker flush; neither
  // exists before pageSession.start(), so provide inert stand-ins.
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
    setTimeout(() => cb(0), 0)) as unknown as typeof requestAnimationFrame;
  (pageSession as unknown as { tracker: { flushNow(): Promise<void> } }).tracker =
    { flushNow: async () => {} };
  pageSession.badgesVisible = false;
});

afterEach(() => {
  for (const w of [...store.all]) store.removeWrapperByElement(w.element);
  pageSession.badgesVisible = false;
  keyHandler.exitHintMode();
  _resetBadgeVisibilityForTesting();
});

const settle = () => new Promise((r) => setTimeout(r, 5));

describe('the compound showing-read', () => {
  it('is true on the flag alone', () => {
    pageSession.badgesVisible = true;
    expect(anyBadgesShowing()).toBe(true);
  });

  it('is true on an actually-visible badge even when the flag desynced to hidden', () => {
    // The double-badge / "won't hide" report: flag says hidden, a badge is
    // painted. Every transition must act on what the user sees.
    seedWrapper(true);
    expect(pageSession.badgesVisible).toBe(false);
    expect(anyBadgesShowing()).toBe(true);
  });

  it('is false when the flag is down and no badge is visible', () => {
    seedWrapper(false);
    expect(anyBadgesShowing()).toBe(false);
  });
});

describe('use before init', () => {
  it('fails loud, not silently no-op', () => {
    _resetBadgeVisibilityForTesting();
    expect(() => hideBadges()).toThrow(/initBadgeVisibility/);
  });
});

describe('hideBadges', () => {
  it('clears the filter state, exits hint mode, drops the flag, hides every badge', () => {
    const w = seedWrapper(true);
    pageSession.badgesVisible = true;
    keyHandler.enterHintMode();

    hideBadges();

    expect(hintActionResets).toBe(1);
    expect(keyHandler.isHintMode()).toBe(false);
    expect(pageSession.badgesVisible).toBe(false);
    expect(w.hint!.hide).toHaveBeenCalled();
    expect(w.hint!.setFiltered).toHaveBeenCalledWith(false);
  });
});

describe('setBadgesVisible / toggleHints', () => {
  it('showing from hidden scans and raises the flag', async () => {
    expect(setBadgesVisible(true)).toBe(true);
    expect(scans).toBe(1);
    await settle();
    expect(pageSession.badgesVisible).toBe(true);
  });

  it('is a no-op when already at the requested state', () => {
    pageSession.badgesVisible = true;
    expect(setBadgesVisible(true)).toBe(true);
    expect(scans).toBe(0);
  });

  it('toggle HIDES when the flag desynced but a badge is visible (never a second set on top)', () => {
    seedWrapper(true);
    expect(pageSession.badgesVisible).toBe(false);
    expect(toggleHints()).toBe(false); // ended hidden — it dismissed what the user saw
  });
});

describe('borrowBadgeScreen', () => {
  it('takes only what was showing, and gives exactly that back', async () => {
    pageSession.badgesVisible = true;
    const borrow = borrowBadgeScreen();
    expect(borrow.took).toBe(true);
    expect(pageSession.badgesVisible).toBe(false); // hidden for the borrower

    borrow.restore();
    await settle();
    expect(pageSession.badgesVisible).toBe(true);  // given back
  });

  it('takes nothing from a hidden screen and restores nothing', async () => {
    const borrow = borrowBadgeScreen();
    expect(borrow.took).toBe(false);
    borrow.restore();
    await settle();
    // Under manual visibility the badges were already hidden before the
    // borrower ran; re-showing would be a state change the user never asked for.
    expect(pageSession.badgesVisible).toBe(false);
  });

  it('restores once — whichever exit path runs first wins, later ones no-op', async () => {
    pageSession.badgesVisible = true;
    const borrow = borrowBadgeScreen();
    borrow.restore();
    await settle();
    expect(pageSession.badgesVisible).toBe(true);

    pageSession.badgesVisible = false; // something else hid the screen since
    borrow.restore();                  // a second exit path fires
    await settle();
    expect(pageSession.badgesVisible).toBe(false); // spent borrow stayed inert
  });

  it('snapshots the compound read, not the flag (a painted badge counts)', () => {
    seedWrapper(true);
    expect(pageSession.badgesVisible).toBe(false);
    const borrow = borrowBadgeScreen();
    expect(borrow.took).toBe(true);
  });
});
