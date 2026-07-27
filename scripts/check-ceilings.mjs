#!/usr/bin/env node
/**
 * Monolith line-ceiling ratchet (notes/DESIGN_RESTRUCTURE_ROUND3.md phase 3).
 *
 * Fails in three directions:
 *  - a file EXCEEDS its ceiling → the change grew a monolith; land the code
 *    as a feature module (see the design note) or, for a genuine emergency,
 *    raise the ceiling in the same PR where the reviewer can see it.
 *  - a file sits more than RATCHET_SLACK lines UNDER its ceiling → an
 *    extraction won headroom; lower the ceiling in the same PR so regrowth
 *    can't quietly refill it. The ceiling only ever tracks the file down.
 *  - a ceiling is not a multiple of CEILING_GRANULARITY → see below.
 *
 * A CEILING IS A BAND MARKER, NOT A MEASUREMENT. The slack above is
 * one-directional — it only ever compels a ceiling DOWN — and nothing here
 * asks for zero headroom. But `content.ts` was once tightened to exactly its
 * own line count (3620/3620), where the next line added fails CI, and that
 * distorted two designs on 2026-07-27: a callback seam was wired as a direct
 * render call because the house pattern needed one line in the monolith and
 * there was none, and two comment blocks were trimmed purely to fit. A
 * constraint that changes WHAT you write rather than HOW MUCH has stopped
 * measuring what it was built to measure.
 *
 * That state cannot be detected after the fact: a ceiling pinned to the file
 * size and a file grown up to its ceiling are the same two numbers. So it is
 * made UNEXPRESSIBLE instead — a ceiling must be a multiple of
 * CEILING_GRANULARITY, which is coarser than any single edit. 3620 is not a
 * ceiling you can write; the neighbours are 3600 and 3650. Combined with the
 * slack, a ceiling always sits in a band above its file, so ordinary edits in
 * either direction stay silent and only a real extraction trips the
 * bank-the-win branch — which is exactly when it should.
 *
 * This is the mechanised form of a decision argued in prose in
 * notes/DESIGN_ENTRY_POINT_TOPOLOGY.md, which owns the ratchet. The prose had
 * already drifted to four different line numbers across two notes; a gate is
 * the one copy that cannot drift.
 *
 * Run: node scripts/check-ceilings.mjs   (wired as a CI step)
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RATCHET_SLACK = 100;
/** Two ratchet steps — coarse enough that no single edit can chase it. */
const CEILING_GRANULARITY = 50;

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ceilings = JSON.parse(readFileSync(join(root, 'monolith-ceilings.json'), 'utf8'));

let failed = false;
for (const [file, ceiling] of Object.entries(ceilings)) {
  const lines = readFileSync(join(root, file), 'utf8').split('\n').length;
  if (ceiling % CEILING_GRANULARITY !== 0) {
    const down = Math.floor(ceiling / CEILING_GRANULARITY) * CEILING_GRANULARITY;
    console.error(
      `OFF-GRID CEILING: ${file} is pinned at ${ceiling}, not a multiple of ` +
      `${CEILING_GRANULARITY}.\n  A ceiling is a band marker, not a measurement — ` +
      `pick ${down} or ${down + CEILING_GRANULARITY}. See the header: a ceiling\n` +
      `  tightened onto its own file size changes what you write, not how much.`,
    );
    failed = true;
    continue;
  }
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
