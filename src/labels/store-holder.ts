/**
 * The element wrapper store as a registered CodewordHolder — holder #0.
 * Design: notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md ("The store becomes
 * holder #0").
 *
 * Today `store.all` is the membership list nine lifecycle sweeps iterate, and
 * non-element holders are the exception bolted on beside it. This adapter
 * inverts that: the store answers the same interface as everything else, so
 * every sweep asks the registry and no sweep needs to know the store exists.
 *
 * WHO HOLDS is answered at CLAIM level — `w.scanned.codeword`, assigned when
 * the intersection tracker claims from the pool — never through
 * `store.byCodeword`, which resolves through `w.label`, assigned at PAINT
 * time. Between the two moments (indefinitely, under manual hint visibility
 * or a find session that hides badges) a wrapper holds a codeword byCodeword
 * cannot see; the reservoir's leak sweep asked the paint-level question and
 * reclaimed a LIVE wrapper's codeword, queueing a plugin-side Delete
 * (design doc, corrected 2026-07-26; regression tests in
 * scan/element-wrapper.test.ts, "claimed-vs-painted"). Every query here —
 * held, resolve, matchesPrefix, soleMatch — goes through the claim-level
 * field, so the eligibility surface widens slightly against today's
 * paint-level call sites: a claimed-but-unpainted hint is typable, and the
 * narrow delegate's reveal is what makes it visible.
 *
 * WHAT THE STORE DOES about its codewords stays where it lives today —
 * content.ts owns activation, paint, republish, rejection recovery, and
 * teardown — and arrives here as constructor-injected delegates. This is
 * wiring-time injection, not the v1 seam's module-scoped setter: NOTHING
 * constructs a StoreHolder at module load. Wave 3 (C1) constructs it in
 * content.ts with the real delegates and registers it; until then the only
 * constructors are tests, whose fake delegates are held to the same contract
 * by the conformance suite (src/testing/holder-conformance.ts). That is the
 * difference between this and `StoreCodewordHooks` — the injected shim this
 * adapter retires existed to dodge an import cycle and carried a resolve()
 * that was dead code; here the injection direction is the design (behavior
 * stays in the monolith until its Wave 3 step, the QUESTION moves now).
 *
 * Prefixes arrive in the SW-translated letter form ("as" for the pair
 * "a s"), so the claim-level letter form is the codeword with its spaces
 * removed — same convention the pool tokens are minted in (labels/words.ts).
 */

import type { WrapperStore, ElementWrapper } from '../scan/element-wrapper';
import {
  CodewordHolder, HolderOutcome, SettleKind, prefixClaimedByOther,
  AMBIENT_PRIORITY, overlayCodewordsLive,
} from './holder-registry';
import {
  letterFormOf, exactCodewordMatch, anyCodewordMatchesPrefix,
} from './codeword-typing';

/** Ambient — the default the additive holders fall through to, and the rank
 *  the spoken path's `resolveCodewordAboveAmbient` cuts at (the spoken
 *  element leg resolves snapshot-first with dispatch context this interface
 *  cannot carry). */
export const STORE_HOLDER_PRIORITY = AMBIENT_PRIORITY;

/**
 * The store behaviors content.ts owns today, injected at wiring time.
 * Each delegate is the CURRENT implementation moved behind a name, not a new
 * behavior — the Wave 3 commit that constructs the real StoreHolder lists
 * the call site each one came from.
 */
export interface StoreHolderDelegates {
  /** Paint the prefix onto the hints ('' resets). The reveal DECISION is not
   *  the delegate's — `StoreHolder.narrow` owns the rule and calls `reveal`
   *  below; `claimedElsewhere` is passed through for the delegate's own
   *  narrowing display. */
  narrow(prefix: string, claimedElsewhere: boolean): void;
  /** Paint the page's hints if they are currently hidden. The store's hints
   *  can be HIDDEN while their codewords stay published (find's onActivate
   *  hides them; manual mode starts hidden), so a prefix can arrive for a
   *  badge nobody can see — revealing is the only way it can be finished by
   *  eye. WHEN to reveal is the holder's rule (see narrow); a no-op when the
   *  badges are already up is the delegate's own guard. */
  reveal(): void;
  /** Activate a resolved wrapper (activate/keyboard-activation.ts) plus the TYPED
   *  path's sole-completion bookkeeping (new-tab arming, badge hide / hint
   *  mode exit). Only the typed path reaches this — the spoken path resolves
   *  elements itself, snapshot-first, with its dispatch params (see
   *  resolveCodewordAboveAmbient) — so v1 keyboard parity, not the spoken
   *  path's sealed strict gate, is the contract here. */
  activate(wrapper: ElementWrapper): void;
  /** Re-Put every wrapper's grammar record into the current session. */
  republish(): void;
  /** Strip the losing wrapper back to unhinted and re-claim (content's
   *  onConfirmRejected). Must clear the wrapper's claim-level codeword. */
  onCodewordRejected(codeword: string): void;
  /** Re-render badge text (alphabet / display-mode change). */
  relabel(): void;
  /** The store's settle-time sweep for this kind. */
  reconcile(settle: SettleKind): void;
  /** Frame teardown: release codewords, remove paint. */
  dispose(reason: string): void;
}

export class StoreHolder implements CodewordHolder {
  readonly id = 'store';
  readonly priority = STORE_HOLDER_PRIORITY;
  readonly claim = 'additive' as const;

  private disposed = false;

  constructor(
    private readonly store: WrapperStore,
    private readonly delegates: StoreHolderDelegates,
  ) {}

  /** Claim-level: every wrapper that has claimed a codeword, painted or not. */
  held(): Iterable<string> {
    if (this.disposed) return [];
    const out: string[] = [];
    for (const w of this.store.all) {
      if (w.scanned.codeword !== '') out.push(w.scanned.codeword);
    }
    return out;
  }

  republish(): void {
    if (this.disposed) return;
    this.delegates.republish();
  }

  onCodewordRejected(codeword: string): void {
    if (this.disposed) return;
    this.delegates.onCodewordRejected(codeword);
  }

  /** Is any of this holder's paint actually on screen right now? */
  private get painted(): boolean {
    for (const w of this.store.all) if (w.hint?.isVisible) return true;
    return false;
  }

  /**
   * Can the store finish `prefix`? — with one refusal that is about the SCREEN
   * rather than the codewords.
   *
   * While an overlay tier holds codewords AND none of this holder's badges are
   * painted, the store is not typeable: find borrowed the screen, or a pick
   * hid it, and its own badges are the ones in front of the user. Typing at
   * hints nobody can see is not a thing to support — and answering "yes, mine"
   * here is what let a single keystroke repaint the whole page over a live
   * find session (field, 2026-07-27: `/ query Enter f` then any letter the
   * search badges could not finish put ten link hints over three results).
   *
   * The two callers both want this answer. The keyboard's accept gate
   * (anyHolderMatchesPrefix) refuses the key outright, so nothing narrows and
   * nothing reveals; and `narrow`'s reveal rule below asks the same question
   * of itself. The `painted` half is what keeps the documented coexistence
   * working: re-show the hints mid-session (Shift+F) and they are typeable
   * again, because now they can be seen.
   *
   * Deliberately NOT applied to `resolve`: the SPOKEN path never comes through
   * here, and speaking a link hint's codeword during a find session is exactly
   * the additive behaviour search badges are documented to preserve.
   */
  matchesPrefix(prefix: string): boolean {
    if (this.disposed) return false;
    if (overlayCodewordsLive() && !this.painted) return false;
    return anyCodewordMatchesPrefix(this.claimEntries(), prefix);
  }

  narrow(prefix: string): void {
    if (this.disposed) return;
    const claimedElsewhere = prefix !== '' && prefixClaimedByOther(this, prefix);
    // The reveal rule, in its ONE tested home: hidden hints reveal only when
    // the store itself can finish the prefix and no other holder claims it —
    // revealing on a search badge's prefix is the drifted copy that re-painted
    // every link hint find had just hidden (2026-07-26).
    if (prefix !== '' && !claimedElsewhere && this.matchesPrefix(prefix)) {
      this.delegates.reveal();
    }
    this.delegates.narrow(prefix, claimedElsewhere);
  }

  resolve(codeword: string): HolderOutcome {
    // '' is "no codeword", not a codeword: an unclaimed wrapper's field is
    // the empty string, so an unguarded find would hand the first unclaimed
    // wrapper to activate.
    if (this.disposed || codeword === '') return 'not_mine';
    // Claim-level lookup, NOT store.byCodeword — see the header. Off-screen
    // refusal is deliberately not this holder's: only the typed path reaches
    // this resolve, and it keeps v1 keyboard parity (see the activate
    // delegate's doc); the spoken path's sealed strict gate stays with the
    // spoken path's own element resolution.
    const w = this.store.all.find((lw) => lw.scanned.codeword === codeword);
    if (!w) return 'not_mine';
    this.delegates.activate(w);
    return 'acted';
  }

  /**
   * Fires on the WHOLE painted codeword — the one typing rule
   * (labels/codeword-typing.ts), shared with the range sets.
   *
   * This used to fire on a prefix that narrowed to exactly one, which reads as
   * correct only because the store is USUALLY dense: with a hundred hints a
   * first letter is never unique, so the user types the whole thing anyway. On
   * a page with four links it is unique, and a bare `a` clicked a link before
   * the user finished naming it — the same defect that made pick chips vanish
   * mid-word, at a frequency low enough to have gone unnoticed. Rarer is not
   * different.
   */
  soleMatch(prefix: string): string | null {
    if (this.disposed) return null;
    return exactCodewordMatch(this.claimEntries(), prefix);
  }

  /**
   * [codeword, letterForm] for every wrapper holding a claim — this holder's
   * ONE projection, read by both the gate (matchesPrefix) and the fire
   * (soleMatch). Claim-level, per the header: a wrapper that has claimed but
   * not painted is typable, and narrowing's reveal is what makes it visible.
   * `narrow` deliberately does NOT read this — it paints, so it asks the
   * paint-level label (see the narrow delegate).
   */
  private *claimEntries(): Generator<readonly [string, string]> {
    for (const w of this.store.all) {
      if (w.scanned.codeword === '') continue;
      yield [w.scanned.codeword, letterFormOf(w.scanned.codeword)] as const;
    }
  }

  relabel(): void {
    if (this.disposed) return;
    this.delegates.relabel();
  }

  reconcile(settle: SettleKind): void {
    if (this.disposed) return;
    this.delegates.reconcile(settle);
  }

  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.delegates.dispose(reason);
  }
}
