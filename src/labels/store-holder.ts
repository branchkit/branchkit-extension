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
  AMBIENT_PRIORITY,
} from './holder-registry';

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
  /** Activate a resolved wrapper (content's activateWrapper) plus the TYPED
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
  /** Re-place every painted badge. */
  reposition(): void;
  /** Re-render badge text (alphabet / display-mode change). */
  relabel(): void;
  /** The store's settle-time sweep for this kind. */
  reconcile(settle: SettleKind): void;
  /** Frame teardown: release codewords, remove paint. */
  dispose(reason: string): void;
}

/** Letter form of a claim-level codeword: "a s" -> "as". */
function letterFormOf(codeword: string): string {
  return codeword.replace(/\s+/g, '');
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

  matchesPrefix(prefix: string): boolean {
    if (this.disposed) return false;
    if (prefix === '') return this.store.all.some((w) => w.scanned.codeword !== '');
    return this.store.all.some((w) =>
      w.scanned.codeword !== '' && letterFormOf(w.scanned.codeword).startsWith(prefix));
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

  soleMatch(prefix: string): string | null {
    if (this.disposed || prefix === '') return null;
    let found: string | null = null;
    for (const w of this.store.all) {
      if (w.scanned.codeword === '') continue;
      if (!letterFormOf(w.scanned.codeword).startsWith(prefix)) continue;
      if (found !== null) return null;
      found = w.scanned.codeword;
    }
    return found;
  }

  reposition(): void {
    if (this.disposed) return;
    this.delegates.reposition();
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
