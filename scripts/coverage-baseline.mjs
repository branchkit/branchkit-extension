#!/usr/bin/env node
/**
 * Coverage safety net for the Wave 3 mode-stack/holder migration
 * (notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md, "Testing strategy").
 *
 * The migration deletes and rewrites call sites across the blast-radius list
 * below. This records covered-line COUNTS per file before the first migration
 * step and fails a later compare when a surviving file's count drops — counts,
 * not percentages, because deleting well-covered code raises the percentage
 * while losing the tests. A file absent from the current run (deleted, or no
 * longer imported by any test) is reported, not failed: its tests must be
 * deleted with the code or migrated, and the commit message says which.
 *
 * This is a migration tool, not a permanent gate. It is removed at C5 close.
 *
 *   npx vitest run --coverage.enabled --coverage.reporter=json-summary
 *   node scripts/coverage-baseline.mjs record    # writes scripts/coverage-baseline.json
 *   node scripts/coverage-baseline.mjs compare   # exit 1 on a covered-count drop
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(root, 'scripts', 'coverage-baseline.json');
const SUMMARY = join(root, 'coverage', 'coverage-summary.json');

/** The migration's blast radius: the design doc's deletion inventory plus the
 *  files whose call sites it rewrites. content.ts and background.ts appear
 *  with count 0 — no test imports them (that untestability is the arc's
 *  thesis); the entry pins that a C-step doesn't silently make it worse by
 *  un-importing something that WAS covered. */
const BLAST_RADIUS = [
  'src/content.ts',
  'src/background.ts',
  'src/palette-page.ts',
  'src/activate/keyboard.ts',
  'src/activate/caret.ts',
  'src/activate/codeword-routing.ts',
  'src/activate/escape-cascade.ts',
  'src/activate/range-disambiguation.ts',
  'src/activate/selection-commands.ts',
  'src/activate/search-badges.ts',
  'src/scan/find.ts',
  'src/labels/codeword-holders.ts',
];

function currentCounts() {
  let summary;
  try {
    summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
  } catch {
    console.error(`No ${relative(root, SUMMARY)} — run:\n  npx vitest run --coverage.enabled --coverage.reporter=json-summary`);
    process.exit(1);
  }
  const byFile = {};
  for (const [abs, data] of Object.entries(summary)) {
    if (abs === 'total') continue;
    byFile[relative(root, abs)] = data.lines.covered;
  }
  const counts = {};
  for (const f of BLAST_RADIUS) counts[f] = byFile[f] ?? 0;
  return counts;
}

const mode = process.argv[2];
if (mode === 'record') {
  writeFileSync(BASELINE, JSON.stringify(currentCounts(), null, 2) + '\n');
  console.log(`wrote ${relative(root, BASELINE)}`);
} else if (mode === 'compare') {
  const baseline = JSON.parse(readFileSync(BASELINE, 'utf8'));
  const now = currentCounts();
  let failed = false;
  for (const [f, was] of Object.entries(baseline)) {
    const is = now[f] ?? 0;
    if (is < was) {
      let exists = true;
      try { readFileSync(join(root, f)); } catch { exists = false; }
      if (!exists) {
        console.log(`DELETED: ${f} (had ${was} covered lines) — its tests must be deleted with the code or migrated; say which in the commit message.`);
      } else {
        console.error(`COVERAGE LOST: ${f} covered lines ${was} -> ${is}. The migration dropped tests or un-imported covered code.`);
        failed = true;
      }
    } else if (is > was) {
      console.log(`ok: ${f} ${was} -> ${is} (gained)`);
    }
  }
  process.exit(failed ? 1 : 0);
} else {
  console.error('usage: node scripts/coverage-baseline.mjs record|compare');
  process.exit(1);
}
