/**
 * BranchKit Browser — grammar-epoch digest (Phase 2a of
 * notes/DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md).
 *
 * Order-insensitive digest of a codeword set: XOR of the FNV-1a 64 hash of
 * each codeword's UTF-8 bytes, as 16 lowercase hex chars. MUST stay
 * byte-identical to the plugin's grammarEpochFor (plugins/browser
 * src/batch.go) — the golden vectors in grammar-epoch.test.ts mirror
 * batch_epoch_test.go; a divergence here flags a false mismatch on every
 * batch. XOR keeps the digest order-free and self-inverse (add then remove
 * restores it), matching how the delta-sync shadow evolves.
 */

const FNV_OFFSET = 14695981039346656037n;
const FNV_PRIME = 1099511628211n;
const MASK64 = (1n << 64n) - 1n;

const utf8 = new TextEncoder();

function fnv1a64(s: string): bigint {
  let h = FNV_OFFSET;
  for (const byte of utf8.encode(s)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}

/** Digest a codeword set. Empty set → "0000000000000000". */
export function epochHashOf(codewords: Iterable<string>): string {
  let acc = 0n;
  for (const cw of codewords) acc ^= fnv1a64(cw);
  return acc.toString(16).padStart(16, '0');
}
