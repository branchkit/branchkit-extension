#!/usr/bin/env node
/**
 * Monolith line-ceiling ratchet (notes/DESIGN_RESTRUCTURE_ROUND3.md phase 3).
 *
 * Fails in two directions:
 *  - a file EXCEEDS its ceiling → the change grew a monolith; land the code
 *    as a feature module (see the design note) or, for a genuine emergency,
 *    raise the ceiling in the same PR where the reviewer can see it.
 *  - a file sits more than RATCHET_SLACK lines UNDER its ceiling → an
 *    extraction won headroom; lower the ceiling in the same PR so regrowth
 *    can't quietly refill it. The ceiling only ever tracks the file down.
 *
 * Run: node scripts/check-ceilings.mjs   (wired as a CI step)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RATCHET_SLACK = 100;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ceilings = JSON.parse(readFileSync(join(root, 'monolith-ceilings.json'), 'utf8'));

let failed = false;
for (const [file, ceiling] of Object.entries(ceilings)) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n').length;
  if (lines > ceiling) {
    console.error(
      `CEILING EXCEEDED: ${file} is ${lines} lines (ceiling ${ceiling}).\n` +
      `  New code lands in a feature module, not the monolith — see\n` +
      `  notes/DESIGN_RESTRUCTURE_ROUND3.md. Raising the ceiling is the\n` +
      `  visible-in-review escape hatch for a genuine emergency.`,
    );
    failed = true;
  } else if (ceiling - lines > RATCHET_SLACK) {
    console.error(
      `RATCHET DOWN: ${file} is ${lines} lines, ${ceiling - lines} under its ` +
      `ceiling (${ceiling}).\n  Lower the ceiling in monolith-ceilings.json to ` +
      `<= ${lines + RATCHET_SLACK} in this PR so the win stays locked in.`,
    );
    failed = true;
  } else {
    console.log(`ok: ${file} ${lines}/${ceiling}`);
  }
}

process.exit(failed ? 1 : 0);
