/**
 * The v2 codeword-holder registry — who owns a codeword, derived from what
 * registered instead of declared in an if-chain.
 * Design: notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md ("Primitive 1").
 *
 * The v1 registry beside this file (codeword-holders.ts) covers pool
 * accounting — three hooks, deliberately tiny — while the ownership ORDER
 * lives in a separate, hardcoded seam (activate/codeword-routing.ts) that
 * names its participants by import and branches on them in three functions.
 * The review that produced the design doc found that shape's failure mode
 * everywhere it looked: adding the Nth holder is an edit in N files, and every
 * missed edit is a silent bug (a codeword speakable but not typable, a prefix
 * that re-paints hints find just hid). Here the participants declare
 * themselves and the rule is a sort, so the failure mode becomes "implement
 * these methods" — checked by the conformance suite in
 * src/testing/holder-conformance.ts, which registration itself triggers.
 *
 * Wave 2 of the plan (notes/PLAN_MODE_HOLDER_IMPL.md): NEW FILES ONLY.
 * Nothing imports this yet; today's callers still go through v1 and the
 * routing seam. Wave 3 (C1) migrates them and deletes both.
 *
 * The interface grows by concern, not by method count — four groups:
 *
 *   pool         held / republish / onCodewordRejected — v1's three, unchanged
 *   eligibility  matchesPrefix / narrow / resolve / soleMatch — replaces the
 *                routing seam's if-chains
 *   geometry     reposition / relabel — the sweeps unbridged today
 *   lifecycle    reconcile(settle) / dispose(reason) — ditto
 *
 * Exclusivity is a FIELD, not a guard written twice: an 'exclusive' holder
 * (the range pick) swallows every codeword while live, because it is a
 * question that must be answered; an 'additive' one (search badges, the
 * store) claims only its own and falls through. Registration IS liveness —
 * the holders that exist register on create and unregister when they empty
 * (render/range-badge-set.ts), so an exclusive holder present in the list is
 * a live question. A holder that outlives its liveness must unregister, not
 * answer emptily.
 */

/**
 * The settle kinds the settle engine already distinguishes — a closed enum,
 * grown only when the engine grows (structural, one visible type edit).
 *
 * `reconcile(settle)` is a DISCRIMINATED HOOK, deliberately not a
 * subscription (design doc, resolved question 3): every holder receives every
 * kind and self-selects. A subscription model would recreate the exact bug
 * this arc exists to kill — "participant missed the Nth wiring site", the
 * afterScrollSettle-only wiring, silent again. Ignoring a kind is a visible
 * branch in the holder's own code, and the conformance suite calls reconcile
 * with every member of this array so a new kind surfaces in every holder's
 * own tests. The value-level list exists so that iteration needs no second
 * artifact to keep in sync; the type is derived from it.
 */
export const SETTLE_KINDS = ['scroll', 'general'] as const;
export type SettleKind = (typeof SETTLE_KINDS)[number];

/**
 * What ONE holder did with a whole codeword. Deliberately three-valued —
 * designed from what the routing seam's callers actually distinguish, not
 * from what holders could conceivably report:
 *
 *   'acted'       consumed and done ('picked', 'jumped', a wrapper activated —
 *                 the caller never branched on which; the holder's identity,
 *                 carried by CodewordOutcome, covers the reporting strings)
 *   'off_screen'  this holder's codeword, refused: the band paints past the
 *                 fold, so a badge can hold a codeword the user has never
 *                 read, and acting on it would be acting on something they
 *                 can't see. The holder stays live — scroll and retry.
 *   'not_mine'    not this holder's; the registry continues the loop. The
 *                 exclusive swallow is the REGISTRY's move, not the holder's:
 *                 a holder only ever answers for its own codewords.
 *
 * Contract, checked by the conformance suite: a holder never answers
 * 'not_mine' for a codeword it still holds afterward (a stale member may be
 * dropped and declined in the same call — search badges do — but then it is
 * gone from held() too).
 */
export type HolderOutcome = 'acted' | 'off_screen' | 'not_mine';

export interface CodewordHolder {
  /** Names the holder in outcomes, dispatch reports, and logs ('pick',
   *  'search', 'store'). Stable, unique per registered holder. */
  readonly id: string;
  /** Registration order is not the contract — this is. Exclusive holders
   *  outrank additive ones, which outrank ambient (the store, priority 0).
   *  Higher number = consulted first; ties keep registration order. */
  readonly priority: number;
  /** 'exclusive' swallows every codeword while live (the pick); 'additive'
   *  claims only its own and falls through (search badges, the store). */
  readonly claim: 'exclusive' | 'additive';

  // -- identity / pool (v1's three, unchanged in meaning) --

  /** Codewords this holder owns right now, at CLAIM level — the holder's own
   *  bookkeeping, never a projection of it (the paint-time byCodeword lookup
   *  answered "nobody holds it" for a claimed-but-unpainted wrapper, and the
   *  leak sweep reclaimed a live codeword — design doc, corrected 2026-07-26). */
  held(): Iterable<string>;
  /** Re-publish this holder's grammar records into the CURRENT session,
   *  after a rotation. Idempotent. */
  republish(): void;
  /** The SW pool refused this codeword — another document won it. Must drop
   *  it from held(); a badge painted for a codeword that now addresses a
   *  different document acts over there when spoken. */
  onCodewordRejected(codeword: string): void;

  // -- eligibility (replaces the routing seam's if-chains) --

  /** Can any held codeword's letter form complete `prefix`? The keyboard's
   *  gate for accepting a keystroke at all. */
  matchesPrefix(prefix: string): boolean;
  /** Mid-codeword progress: paint the holder's badges to show it ('' resets).
   *  Visual only — never changes held(). */
  narrow(prefix: string): void;
  /** Offer a whole codeword. See HolderOutcome. */
  resolve(codeword: string): HolderOutcome;
  /** The one held codeword `prefix` still leaves, if exactly one — so typing
   *  can fire at the same moment speaking the whole codeword would. */
  soleMatch(prefix: string): string | null;

  // -- geometry / paint (store-scoped sweeps unbridged in v1) --

  /** Badge positions may be stale (scroll, reflow) — re-place them. */
  reposition(): void;
  /** The alphabet or display mode changed — re-render badge text. */
  relabel(): void;

  // -- lifecycle (unbridged in v1) --

  /** A settle landed. Every holder receives EVERY kind and self-selects —
   *  see SETTLE_KINDS. Must be a safe no-op when nothing is live. */
  reconcile(settle: SettleKind): void;
  /** Tear down: release codewords, remove paint. Idempotent; empties held().
   *  `reason` is for logs. */
  dispose(reason: string): void;
}

/**
 * What the REGISTRY did with a codeword — the per-holder outcome plus the two
 * things only the loop can know: which holder it was (dispatch reporting
 * keys resolution strings and toast policy on this) and the exclusive
 * swallow.
 *
 *   'swallowed'  an exclusive holder declined the codeword but is live, so
 *                nothing below it may act — the stray badge codeword must not
 *                click a link out from under the question the chips are
 *                asking. The named holder owns the refusal guidance.
 *   'none'       nobody owns it; the caller continues (element resolution on
 *                the spoken path, stray-key handling on the typed one).
 */
export type CodewordOutcome =
  | { kind: 'acted'; holder: string }
  | { kind: 'off_screen'; holder: string }
  | { kind: 'swallowed'; holder: string }
  | { kind: 'none' };

// Registration order is preserved as the tiebreak for equal priorities, so
// the sort below is deterministic without holders having to know about each
// other. An array, not a Set: the registry is passive data plus fan-out —
// no observers, no timers, nothing cached (sensing freeze).
const holders: CodewordHolder[] = [];

/** Register a holder. Returns an unregister function (v1's pattern — the
 *  RangeBadgeSet holders unregister when they empty, and registration is
 *  what liveness means here). */
export function registerHolder(holder: CodewordHolder): () => void {
  holders.push(holder);
  return () => { unregisterHolder(holder); };
}

/** Remove a holder. Safe to call twice; identity-matched. */
export function unregisterHolder(holder: CodewordHolder): void {
  const idx = holders.indexOf(holder);
  if (idx >= 0) holders.splice(idx, 1);
}

/** Every registered holder, highest priority first, registration order
 *  breaking ties. Derived fresh per call — the list is small (≤4 holders)
 *  and a cached sort is one more thing to invalidate. */
export function holdersByPriority(): readonly CodewordHolder[] {
  return [...holders].sort((a, b) => b.priority - a.priority ||
    holders.indexOf(a) - holders.indexOf(b));
}

/**
 * Act on a whole codeword, in THE order. The routing seam's three if-chains
 * collapse to this loop; exclusivity stops being `if (!isRangePickPending())`
 * written twice and becomes a field consulted once.
 */
export function resolveCodeword(codeword: string): CodewordOutcome {
  for (const h of holdersByPriority()) {
    const out = h.resolve(codeword);
    if (out !== 'not_mine') return { kind: out, holder: h.id };
    if (h.claim === 'exclusive') return { kind: 'swallowed', holder: h.id };
  }
  return { kind: 'none' };
}

/**
 * Would `prefix` start (or continue) some codeword on screen? The keyboard's
 * gate for accepting a keystroke at all. An exclusive holder answers ALONE —
 * a letter no chip can complete is refused rather than falling through to
 * hints the pick has hidden.
 */
export function anyHolderMatchesPrefix(prefix: string): boolean {
  for (const h of holdersByPriority()) {
    if (h.matchesPrefix(prefix)) return true;
    if (h.claim === 'exclusive') return false;
  }
  return false;
}

/**
 * Mid-codeword progress, routed to whoever owns the codewords right now.
 * An exclusive holder takes progress and nothing else hears it; additive
 * holders all narrow in the same breath, because their badges are on screen
 * together. The reveal-hidden-hints decision is NOT here: it is the store
 * holder's own (see store-holder.ts), informed by prefixClaimedByOther —
 * the registry answers ownership, the holder decides its paint.
 */
export function narrowByPrefix(prefix: string): void {
  for (const h of holdersByPriority()) {
    h.narrow(prefix);
    if (h.claim === 'exclusive') return;
  }
}

/**
 * The codeword a typed `prefix` has narrowed to exactly one of, if any.
 * Same swallow as the other eligibility queries: while an exclusive holder
 * is live, nothing below it can be the sole match. (v1's soleHolderMatch
 * fell through a live pick to the search badges; the case was unreachable
 * because anyHolderMatchesPrefix refused the keystrokes first, and the
 * uniform swallow is what the exclusivity contract actually says.)
 */
export function soleHolderMatch(prefix: string): string | null {
  if (prefix === '') return null;
  for (const h of holdersByPriority()) {
    const sole = h.soleMatch(prefix);
    if (sole !== null) return sole;
    if (h.claim === 'exclusive') return null;
  }
  return null;
}

/**
 * Can any holder OTHER than `holder` complete `prefix`? The store holder's
 * reveal guard asks this: hidden hints reveal only when nothing else can
 * finish the prefix — revealing unconditionally is the live failure that
 * re-painted every link hint find had just hidden (2026-07-26, the routing
 * seam's header). Registry-level because ownership is the registry's
 * question; per-holder awareness of specific peers is the seam shape this
 * module exists to delete.
 */
export function prefixClaimedByOther(holder: CodewordHolder, prefix: string): boolean {
  for (const h of holders) {
    if (h !== holder && h.matchesPrefix(prefix)) return true;
  }
  return false;
}

/** Re-publish every holder's records after a session rotation. */
export function republishAll(): void {
  for (const h of holders) h.republish();
}

/** Tell every holder a codeword was refused by the pool. */
export function rejectAll(codeword: string): void {
  for (const h of holders) h.onCodewordRejected(codeword);
}

/** Fan a settle out to every holder — every holder, every kind, always
 *  (the discriminated hook; see SETTLE_KINDS). */
export function reconcileAll(settle: SettleKind): void {
  for (const h of holders) h.reconcile(settle);
}

/** Does anyone hold this codeword? The leak sweep's one question, answered
 *  by each holder about its own bookkeeping — the form that cannot drift. */
export function heldAnywhere(codeword: string): boolean {
  for (const h of holders) {
    for (const cw of h.held()) if (cw === codeword) return true;
  }
  return false;
}

/** Every codeword owned by anyone, for the pool-reconfirm paths. */
export function allHeld(): string[] {
  const out: string[] = [];
  for (const h of holders) for (const cw of h.held()) out.push(cw);
  return out;
}

/** Test-only reset. */
export function __resetHolderRegistry(): void {
  holders.length = 0;
}
