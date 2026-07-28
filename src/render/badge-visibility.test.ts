/**
 * Badge-visibility module tests (Wave 4 tail, notes/PLAN_MODE_HOLDER_IMPL.md).
 *
 * The primitive under test is the one that, hand-rolled, shipped a field bug
 * twice in one arc: the screen borrow (snapshot-then-hide, conditional
 * idempotent give-back) and the compound showing-read behind it. Real
 * singletons (store, pageSession, keyHandler) with fake badges, per the arc's
 * synthetic-participants rule.
 *
 * The one module mock is scan-orchestrator, and it is not an exception to that
 * rule: the rule is about the badges and the state this module OWNS, and
 * doScan is the discovery layer ABOVE it — pulling the real walk in (adapters,
 * rules, the observe stack) would make this a slow integration test of code
 * that has its own. The mock also gives back the observation the retired
 * `initBadgeVisibility({doScan})` hook used to provide for free.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../scan/scan-orchestrator', () => ({
  doScan: vi.fn(async () => {}),
}));
import { doScan } from '../scan/scan-orchestrator';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { store } from '../core/store';
import { pageSession } from '../lifecycle/page-session';
import { keyHandler } from '../core/singletons';
import {
  anyBadgesShowing, hideBadges, toggleHints,
  setBadgesVisible, borrowBadgeScreen, _resetBadgeVisibilityForTesting,
  assertBadgeScreenBorrow, returnBadgeScreenBorrow, discardBadgeScreenBorrow,
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

beforeEach(() => {
  vi.mocked(doScan).mockClear();
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
  keyHandler.resetHintAction();
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

// ('use before init' lived here. The module has no init step any more — it
// imports doScan directly — so there is no unwired state to be in and nothing
// for the assertion to catch. Kept as a note rather than rewritten into
// something that passes either way.)

describe('hideBadges', () => {
  it('clears the filter state, exits hint mode, drops the flag, hides every badge', () => {
    const w = seedWrapper(true);
    pageSession.badgesVisible = true;
    keyHandler.enterHintMode();
    keyHandler.armHintAction('yank'); // a verb armed but never resolved

    hideBadges();

    // Real state, not a hook-fired counter: the abandoned verb is disarmed, so
    // the next badge the user picks is a plain click.
    expect(keyHandler.takeHintAction()).toBe('activate');
    expect(keyHandler.isHintMode()).toBe(false);
    expect(pageSession.badgesVisible).toBe(false);
    expect(w.hint!.hide).toHaveBeenCalled();
    expect(w.hint!.setFiltered).toHaveBeenCalledWith(false);
  });

  // The catch-up rescan: the page mutated while badges were up, so the store is
  // stale by the time they come down. Asserted as a PAIR, because "doScan ran"
  // alone is also what an unconditional rescan produces — only the second case
  // separates the guard from no guard.
  it('schedules a catch-up rescan iff the page mutated while badges were up', () => {
    vi.useFakeTimers();
    try {
      pageSession.pendingMutation = true;
      hideBadges();
      expect(pageSession.pendingMutation).toBe(false); // consumed, not left armed
      expect(doScan).not.toHaveBeenCalled();           // deferred, not synchronous
      vi.advanceTimersByTime(100);
      expect(doScan).toHaveBeenCalledTimes(1);

      vi.mocked(doScan).mockClear();
      hideBadges(); // pendingMutation is down now
      vi.advanceTimersByTime(100);
      expect(doScan).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('setBadgesVisible / toggleHints', () => {
  it('showing from hidden scans and raises the flag', async () => {
    expect(setBadgesVisible(true)).toBe(true);
    expect(doScan).toHaveBeenCalledTimes(1);
    await settle();
    expect(pageSession.badgesVisible).toBe(true);
  });

  it('is a no-op when already at the requested state', () => {
    pageSession.badgesVisible = true;
    expect(setBadgesVisible(true)).toBe(true);
    expect(doScan).not.toHaveBeenCalled();
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

// The slot around the primitive. This was a bare `let` in content.ts, so the
// re-entrancy rule below — the whole reason the slot exists — had never been
// tested anywhere; find.test.ts pins the give-back paths, not the re-take.
describe('the badge screen borrow slot', () => {
  it('takes the screen on first assert', async () => {
    pageSession.badgesVisible = true;
    assertBadgeScreenBorrow();
    expect(pageSession.badgesVisible).toBe(false);

    returnBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(true);
  });

  // findImmediate re-fires the activate path over a live session. A second
  // borrow there would snapshot the hidden state the FIRST borrow caused, so
  // the give-back would decide the badges had always been hidden — an
  // always-mode page left bare, which is the 2026-07-26 field bug.
  it('re-asserting over a live borrow does not re-snapshot the hidden state', async () => {
    pageSession.badgesVisible = true;
    assertBadgeScreenBorrow();
    assertBadgeScreenBorrow();
    assertBadgeScreenBorrow();

    returnBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(true); // still given back
  });

  // The other half of the same rule: `f` mid-session re-showed the badges and
  // find still wants the screen, so a re-assert over a borrow that TOOK must
  // hide again rather than no-op.
  it('re-asserting re-hides badges that came back mid-session', () => {
    pageSession.badgesVisible = true;
    assertBadgeScreenBorrow();
    expect(pageSession.badgesVisible).toBe(false);

    pageSession.badgesVisible = true; // `f` re-showed them
    assertBadgeScreenBorrow();
    expect(pageSession.badgesVisible).toBe(false);
  });

  // A borrow that took nothing must not start hiding on re-entry — under
  // manual visibility the screen was already hidden and find never owned it.
  it('re-asserting over a borrow that took nothing stays inert', () => {
    assertBadgeScreenBorrow();          // hidden screen: took === false
    pageSession.badgesVisible = true;   // the user showed badges themselves
    assertBadgeScreenBorrow();
    expect(pageSession.badgesVisible).toBe(true);
  });

  it('returning is safe on a slot never taken, and safe twice', async () => {
    returnBadgeScreenBorrow();
    pageSession.badgesVisible = true;
    assertBadgeScreenBorrow();
    returnBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(true);

    pageSession.badgesVisible = false; // something else hid it since
    returnBadgeScreenBorrow();         // onPaintCleared after a plain close
    await settle();
    expect(pageSession.badgesVisible).toBe(false);
  });

  // Every find exit reaches a return, and the next session must take a FRESH
  // borrow. Asserting only the second hide would not prove that: a spent
  // borrow still reports took === true, so the re-assert arm hides either way.
  // The give-back is where a stale slot shows — `restore` is idempotent, so
  // the second session's return would no-op and leave the page bare.
  it('a returned slot takes again on the next session, and gives back again', async () => {
    pageSession.badgesVisible = true;
    assertBadgeScreenBorrow();
    returnBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(true);

    assertBadgeScreenBorrow();
    expect(pageSession.badgesVisible).toBe(false);
    returnBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(true);
  });

  // The same-document nav case. The slot outlived its page because nothing on
  // the nav path returned it, and a SPENT took===false slot is invisible in the
  // obvious assertion: re-asserting over it is inert either way (the test above
  // pins exactly that). What distinguishes discarded from stale is the borrow
  // AFTER — a discarded slot takes fresh and hides; a surviving one no-ops and
  // leaves the highlights under a live badge layer.
  it('a discarded slot takes fresh next time; a surviving one would not', async () => {
    assertBadgeScreenBorrow();          // over hidden badges: took === false
    discardBadgeScreenBorrow();         // the route changed
    pageSession.badgesVisible = true;   // the user shows badges on the new page

    assertBadgeScreenBorrow();          // find reopens
    expect(pageSession.badgesVisible).toBe(false); // fresh borrow, screen taken

    returnBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(true);  // and given back
  });

  // Discard is NOT restore, and that is load-bearing rather than a shortcut:
  // restore()'s showBadges is async and raises the flag a frame later, while
  // the nav path reads it synchronously on the next line to decide a
  // manual-mode hide. A restoring discard would paint badges onto a page the
  // nav had just decided to leave hidden.
  //
  // The flag alone does NOT prove that: an entirely inert discard leaves it
  // false too. (Mine did assert only the flag, and survived a `discard that
  // does nothing for took === true` mutant — review, 2026-07-27.) The slot has
  // to be shown GONE, and the only way to see that is the borrow AFTER it: a
  // fresh borrow over a hidden screen takes nothing, so its give-back restores
  // nothing. A surviving took === true slot would re-show here instead.
  it('discarding never re-shows, and the slot is gone rather than merely unrestored', async () => {
    pageSession.badgesVisible = true;
    assertBadgeScreenBorrow();          // took === true, badges now hidden
    expect(pageSession.badgesVisible).toBe(false);

    discardBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(false); // still hidden — nav decides

    assertBadgeScreenBorrow();          // the next find: must be a FRESH borrow
    returnBadgeScreenBorrow();
    await settle();
    expect(pageSession.badgesVisible).toBe(false); // took nothing, restored nothing
  });
});
