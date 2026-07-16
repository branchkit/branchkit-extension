#!/usr/bin/env node
/**
 * Settle-storm capture summary — reads the actuator log's cs_firehose_step
 * stream (shipped only from the FOCUSED tab) and prints, for the last N
 * seconds: settle rate, trigger-source breakdown, strict-flip / stamp
 * attribution, and the top mutation targets. The reading half of the
 * settle-storm diagnosis loop (notes/DESIGN_SETTLE_TRIGGER_SCOPING.md):
 * focus the tab under test, idle (or interact), then run
 *
 *   node scripts/storm-summary.mjs [seconds]   # default 90
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const windowSec = Number(process.argv[2] ?? 90);
const logPath = join(homedir(), 'Library/Application Support/BranchKitDev/actuator.log');

const cutoff = Date.now() - windowSec * 1000;
const lines = readFileSync(logPath, 'utf8').split('\n');

const steps = new Map(); // step -> { count, sizeSum, sizeMax }
let settles = 0;
let firstTs = null;
let lastTs = null;

for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i];
  if (!line.includes('cs_firehose_step')) continue;
  const tsMatch = line.match(/^\[([0-9T:.\-]+Z)\]/);
  if (!tsMatch) continue;
  const ts = Date.parse(tsMatch[1]);
  if (ts < cutoff) break; // log is chronological; done
  const jsonStart = line.indexOf('{"step"');
  if (jsonStart < 0) continue;
  let payload;
  try {
    payload = JSON.parse(line.slice(jsonStart));
  } catch {
    continue;
  }
  firstTs = ts; // walking backwards: last assignment = earliest in window
  lastTs ??= ts;
  const s = steps.get(payload.step) ?? { count: 0, sizeSum: 0, sizeMax: 0 };
  s.count++;
  s.sizeSum += payload.size;
  s.sizeMax = Math.max(s.sizeMax, payload.size);
  steps.set(payload.step, s);
  if (payload.step.startsWith('settle:enter:')) settles++;
}

if (lastTs === null) {
  console.log(`no cs_firehose_step lines in the last ${windowSec}s — is the tab under test focused?`);
  process.exit(1);
}

const spanSec = Math.max(1, (lastTs - firstTs) / 1000);
console.log(`window: last ${windowSec}s requested, ${spanSec.toFixed(0)}s of data (${new Date(firstTs).toISOString()} → ${new Date(lastTs).toISOString()})`);
console.log(`settles: ${settles}  (${(settles / (spanSec / 60)).toFixed(1)}/min)\n`);

const groups = [
  ['settle triggers', (k) => k.startsWith('settle:enter:')],
  ['strict flips', (k) => k.startsWith('strictflip:') || k.startsWith('stamp_disagree:')],
  ['mutation targets', (k) => k.startsWith('mo_target:') || k.startsWith('vismo_target:')],
  ['everything else', () => true],
];
const seen = new Set();
for (const [title, match] of groups) {
  const rows = [...steps.entries()]
    .filter(([k]) => !seen.has(k) && match(k))
    .sort((a, b) => b[1].count - a[1].count);
  if (rows.length === 0) continue;
  console.log(`--- ${title} ---`);
  for (const [k, s] of rows.slice(0, 15)) {
    seen.add(k);
    console.log(`  ${String(s.count).padStart(5)}x  size avg ${(s.sizeSum / s.count).toFixed(1).padStart(7)} max ${String(s.sizeMax).padStart(5)}  ${k}`);
  }
  const hidden = rows.length - Math.min(rows.length, 15);
  if (hidden > 0) console.log(`  (+${hidden} more)`);
  console.log('');
}
