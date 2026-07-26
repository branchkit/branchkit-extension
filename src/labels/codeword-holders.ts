/**
 * Non-element codeword holders.
 *
 * `store.all` is not just a container — it is the membership list that nine
 * independent lifecycle sweeps iterate: session-rotation republish, the
 * visibility plan, the occlusion gather, clip observation, stripped-host
 * reattach, confirm-rejection recovery, the reservoir leak sweep's `isHeld`,
 * bfcache pool reconfirm, and the typed hint picker. Anything that holds a
 * pool codeword while staying OUT of the store is invisible to every one of
 * them at once.
 *
 * The range-pick chips (activate/range-disambiguation.ts) are the first such
 * holder, deliberately outside the store because a Range is not an Element and
 * the store's consumers hit-test and click. Search-match badges will be the
 * second. This registry is the seam those sweeps consult so a new holder does
 * not have to rediscover nine invariants — and so the failure mode is a
 * compile-time "implement these two methods" rather than a silent 30-second
 * codeword theft.
 *
 * Deliberately tiny: two questions, both of which the store answers for
 * wrappers. Anything richer belongs to the holder.
 */

export interface CodewordHolder {
  /** Codewords this holder owns right now. Read by the reservoir leak sweep
   *  (via content's `isHeld`) so a live holder's grants are not mistaken for
   *  leaked ones, and by the bfcache/SW-restart pool reconfirm so the SW keeps
   *  routing them to this frame. */
  held(): Iterable<string>;
  /**
   * Re-publish this holder's grammar records into the CURRENT session.
   *
   * Called after a session rotation. Every rotation path enumerates
   * `store.all`, so a non-element holder is never re-Put; plugin-side its
   * codewords are inherited as unconfirmed and then dropped by the rotation's
   * `is_final` batch, leaving badges painted but unspeakable.
   */
  republish(): void;
}

const holders = new Set<CodewordHolder>();

/** Register a holder. Returns an unregister function. */
export function registerCodewordHolder(holder: CodewordHolder): () => void {
  holders.add(holder);
  return () => { holders.delete(holder); };
}

/** Does any non-element holder own this codeword? */
export function heldOutsideStore(codeword: string): boolean {
  for (const h of holders) {
    for (const cw of h.held()) if (cw === codeword) return true;
  }
  return false;
}

/** Every codeword owned outside the store, for the pool-reconfirm paths. */
export function allHeldOutsideStore(): string[] {
  const out: string[] = [];
  for (const h of holders) for (const cw of h.held()) out.push(cw);
  return out;
}

/** Re-publish every non-element holder's records after a session rotation. */
export function republishHeldOutsideStore(): void {
  for (const h of holders) h.republish();
}

/** Test-only reset. */
export function __resetCodewordHolders(): void {
  holders.clear();
}
