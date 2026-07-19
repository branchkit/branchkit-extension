// TEMPORARY diagnostic ring for the 2026-07-19 band-flap storm
// (app notes/DESIGN_STORM_RESILIENCE.md track 2b): records every codeword
// grant/release with its origin site so the repro driver can see WHICH
// path drives the claim/release oscillation. Surfaced via the debug
// snapshot (`cw_trace`). DELETE with the fix.

export interface CwTraceEntry {
  t: number;      // performance.now(), ms, rounded
  op: string;     // grant site or release site tag
  cw: string;     // the codeword involved ('' when unknown)
  who: string;    // wrapper identity: accessible name / label text
}

export const cwTrace: CwTraceEntry[] = [];

// --- storm auto-capture (the trap springs itself) ---
// A storm announces itself in this ring long before a human notices voice
// going dead: STORM_EVENTS entries landing inside STORM_WINDOW_MS. When
// that rate appears outside the first PAGE_BOOT_GRACE_MS of page life
// (boot legitimately floods the ring with the initial scan/claim wave),
// fire the registered capture callback ONCE per page session — the same
// snapshot path as Ctrl+Alt+A, tagged storm_auto, so the evidence lands
// on disk without the user at the keyboard. A sustained storm that
// ignites at boot still trips this: the rate check keeps passing after
// the grace window ends, and the 5000-entry ring reaches back through
// ignition. Deferred via setTimeout(0) so the heavy capture never runs
// inside the claim/release hot path that called traceCw.

const STORM_EVENTS = 200;
const STORM_WINDOW_MS = 5000;
const PAGE_BOOT_GRACE_MS = 10_000;

let stormCapture: (() => void) | null = null;
let stormFired = false;

export function setStormAutoCapture(cb: () => void): void {
  stormCapture = cb;
}

export function traceCw(op: string, who: string, cw: string): void {
  if (cwTrace.length >= 5000) cwTrace.shift();
  const t = Math.round(performance.now());
  cwTrace.push({ t, op, cw, who });
  if (stormFired || stormCapture === null) return;
  if (t < PAGE_BOOT_GRACE_MS) return;
  if (cwTrace.length < STORM_EVENTS) return;
  if (t - cwTrace[cwTrace.length - STORM_EVENTS].t >= STORM_WINDOW_MS) return;
  stormFired = true;
  setTimeout(stormCapture, 0);
}
