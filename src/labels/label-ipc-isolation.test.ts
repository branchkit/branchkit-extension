/**
 * Source-scan guard for the label-pool IPC single-sender invariant.
 *
 * Asserts that quoted-string references to `CLAIM_LABELS`, `RELEASE_LABELS`,
 * and `CONFIRM_LABELS` only appear in an allowlist of files. The invariant
 * itself — why the reservoir must be the sole sender — lives in the header
 * of `label-reservoir.ts`. If this test fires, that header is where to go.
 *
 * Matches single- and double-quoted literals only (`'CLAIM_LABELS'`,
 * `"CLAIM_LABELS"`). Backtick-quoted references in JSDoc are fine
 * (`` `CLAIM_LABELS` ``) and won't match.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';

const SRC_ROOT = join(__dirname, '..');

const FORBIDDEN = ['CLAIM_LABELS', 'RELEASE_LABELS', 'CONFIRM_LABELS'];

const ALLOWLIST = new Set([
  'labels/label-reservoir.ts',
  'labels/label-ipc-isolation.test.ts',
  'types.ts',
  'background.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function isAllowed(relPath: string): boolean {
  if (ALLOWLIST.has(relPath)) return true;
  return relPath.endsWith('.test.ts');
}

describe('label-pool IPC single-sender invariant', () => {
  const files = walk(SRC_ROOT).map(f => ({ full: f, rel: relative(SRC_ROOT, f) }));

  for (const token of FORBIDDEN) {
    const pattern = new RegExp(`(['"])${token}\\1`);

    it(`only sends ${token} from allowlisted files`, () => {
      const offenders: string[] = [];
      for (const { full, rel } of files) {
        if (isAllowed(rel)) continue;
        const src = readFileSync(full, 'utf8');
        const lines = src.split('\n');
        lines.forEach((line, i) => {
          if (pattern.test(line)) offenders.push(`${rel}:${i + 1}`);
        });
      }
      expect(
        offenders,
        `${token} is sent from non-reservoir code. Read the SINGLE-SENDER ` +
          `INVARIANT section in src/labels/label-reservoir.ts and either ` +
          `route through labelReservoir.{claim,release}() or update the ` +
          `allowlist after confirming the invariant still holds.`
      ).toEqual([]);
    });
  }
});
