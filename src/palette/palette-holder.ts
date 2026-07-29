/**
 * BranchKit Browser — the palette's CodewordHolder, host-side.
 *
 * The palette badges rows with spoken codewords, but it lives in an
 * extension iframe (the isolation boundary — see render/palette-host.ts) and
 * the whole codeword stack is content-script resident. So it forked: its own
 * assignment, its own transport, its own narrowing, and no registry
 * membership at all, which is why speaking a palette codeword gave no
 * mid-utterance feedback while page hints dimmed.
 *
 * This is the bridge, and it is the shape the MODE STACK already uses: the
 * host joins the registry on the frame's behalf, keyed to the iframe lifetime
 * it already owns (`modes.push('palette')`). Design:
 * notes/DESIGN_CROSS_REALM_CODEWORD_HOLDERS.md.
 *
 * WHY A MIRROR RATHER THAN AN ASYNC INTERFACE. Four of the contract's
 * members return values the keyboard path consumes synchronously
 * (`held`, `matchesPrefix`, `soleMatch`, `resolve`). Making the interface
 * async to serve one remote participant would contaminate the three local
 * holders that have no such problem. Instead the frame publishes its
 * assignment once — it assigns once per open and never reassigns on
 * refilter, so there is a single publish point and no mid-session drift —
 * and only the two void-returning legs (`narrow`, and activation on
 * `resolve`) travel back across the boundary, where fire-and-forget is
 * already the contract.
 *
 * The mirror is a one-way projection off that single event, NOT two
 * artifacts kept in sync. If assignment ever becomes incremental, this
 * design has to be revisited rather than patched — `adopt()` asserting a
 * fresh generation is where that would surface.
 */

import {
  CodewordHolder, HolderOutcome, SettleKind,
  EXCLUSIVE_OVERLAY_PRIORITY, registerHolder, unregisterHolder,
} from '../labels/holder-registry';
import { letterFormOf, exactCodewordMatch, anyCodewordMatchesPrefix } from '../labels/codeword-typing';
import type { PaletteCodewordWire } from './relay';

/** The frame-facing legs. All void — nothing the registry asks synchronously
 *  is allowed to depend on a round trip. */
export interface PaletteFrameLegs {
  /** Mid-codeword progress; '' resets. Visual only, inside the frame. */
  narrow(prefix: string): void;
  /** A codeword resolved to this row — activate it. */
  activate(rowId: string): void;
  /** Alphabet or display mode changed — re-render badge text. */
  relabel(): void;
}

/**
 * The palette's holder. EXCLUSIVE at overlay priority: while the palette is
 * open it owns the screen's codewords outright, which is the in-page half of
 * the suppression the plugin's exclusive palette tag performs matcher-side.
 * The two must agree — that is the risk this design carries, and it fails
 * visibly (page badges left live, or not restored on close) rather than
 * silently.
 */
export class PaletteHolder implements CodewordHolder {
  readonly id = 'palette';
  readonly priority = EXCLUSIVE_OVERLAY_PRIORITY;
  readonly claim = 'exclusive' as const;

  /** token ("o r") -> rowId. The mirror. */
  private rows = new Map<string, string>();
  private unregister: (() => void) | null = null;

  constructor(private readonly legs: PaletteFrameLegs) {}

  /**
   * Take the frame's assignment and register. Registration IS liveness (the
   * RangeBadgeSet model), so an exclusive holder in the list is always a live
   * question — adopting an empty set unregisters rather than sitting in the
   * list swallowing codewords for a palette that badged nothing.
   */
  adopt(wire: readonly PaletteCodewordWire[]): void {
    this.rows = new Map();
    for (const { token, rowId } of wire) {
      if (!token || !rowId) continue; // unmappable word — unspeakable, not mis-bound
      this.rows.set(token, rowId);
    }
    if (this.rows.size === 0) {
      this.unregisterSelf();
      return;
    }
    if (!this.unregister) this.unregister = registerHolder(this);
  }

  // -- identity / pool --

  held(): Iterable<string> {
    return this.rows.keys();
  }

  /**
   * No-op by construction, permanently. `republish` re-sends grammar records
   * into a rotated session; palette entries do not travel the grammar batch —
   * they are POSTed separately and drained on close, so no session rotation
   * can strand them.
   *
   * An earlier draft hedged this as "if the transport folds into the batch,
   * this becomes a real re-POST". That fold is RETIRED (see
   * notes/DESIGN_CROSS_REALM_CODEWORD_HOLDERS.md, "Also in scope, downstream"):
   * the batch is a per-frame session protocol built for anchors that move, and
   * the palette's cannot. There is no session here to rotate.
   */
  republish(): void {}

  /**
   * Unreachable today — the palette assigns from its own alphabet rather than
   * claiming from the shared pool, so the SW pool never refuses it anything.
   * Implemented as a real removal anyway: the contract is that a rejected
   * codeword leaves held(), and a holder that lies about that is exactly the
   * drift the registry exists to kill.
   */
  onCodewordRejected(codeword: string): void {
    this.rows.delete(codeword);
  }

  // -- eligibility --

  private entries(): Array<readonly [string, string]> {
    return [...this.rows.keys()].map((token) => [token, letterFormOf(token)] as const);
  }

  matchesPrefix(prefix: string): boolean {
    return anyCodewordMatchesPrefix(this.entries(), prefix);
  }

  /** Visual only — never touches the mirror. Crosses into the frame. */
  narrow(prefix: string): void {
    this.legs.narrow(prefix);
  }

  resolve(codeword: string): HolderOutcome {
    const rowId = this.rows.get(codeword);
    if (rowId === undefined) return 'not_mine';
    this.legs.activate(rowId);
    return 'acted';
  }

  soleMatch(prefix: string): string | null {
    if (prefix === '') return null;
    let found: string | null = null;
    for (const [token, letters] of this.entries()) {
      if (!letters.startsWith(prefix)) continue;
      if (found !== null) return null; // more than one still live
      found = token;
    }
    return found;
  }

  // -- paint --

  relabel(): void {
    if (this.rows.size > 0) this.legs.relabel();
  }

  // -- lifecycle --

  /**
   * Safe no-op for every settle kind. Palette rows are laid out by the frame
   * and do not move with page scroll, resize or DOM churn — the overlay is
   * fixed and its list is a snapshot. There is nothing for a settle to
   * reconcile, which is the volatility argument in the design note: the
   * palette's anchors cannot move, so it inherits none of the machinery that
   * exists because page anchors can.
   */
  reconcile(_settle: SettleKind): void {}

  dispose(_reason: string): void {
    this.rows = new Map();
    this.unregisterSelf();
  }

  private unregisterSelf(): void {
    if (this.unregister) {
      this.unregister();
      this.unregister = null;
    } else {
      // Defensive: identity-matched and safe to call twice, so a holder that
      // never registered (or was cleared by a registry reset) still leaves.
      unregisterHolder(this);
    }
  }
}

/** The whole-codeword lookup, exported for tests and for any caller that
 *  wants to ask without acting. */
export function paletteRowFor(
  rows: ReadonlyMap<string, string>, typed: string,
): string | null {
  const token = exactCodewordMatch(
    [...rows.keys()].map((t) => [t, letterFormOf(t)] as const), typed,
  );
  return token === null ? null : rows.get(token) ?? null;
}
