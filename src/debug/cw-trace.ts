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
// that rate appears outside the boot-grace window, fire the registered
// capture callback — the same snapshot path as Ctrl+Alt+A, tagged
// storm_auto, so the evidence lands on disk without the user at the
// keyboard. A sustained storm that ignites at boot still trips this: the
// rate check keeps passing after the grace ends, and the 5000-entry ring
// reaches back through ignition. Deferred via setTimeout(0) so the heavy
// capture never runs inside the claim/release hot path that called
// traceCw.
//
// Hardened after the first live fires (2026-07-19, both false positives):
// - Grace is measured from TRACER BOOT, not page load. performance.now()
//   is page-relative, so an extension-reload reinjection into an old tab
//   started with "page life" of nearly an hour and got zero boot grace —
//   its boot scan wave (~230 events in 0.6s) fired the trap instantly.
// - Up to MAX_FIRES captures per session, spaced REFIRE_SPACING_MS
//   apart. A legitimate early burst (boot wave, Wikipedia's restored-
//   scroll jump releasing/granting ~90 wrappers in one hop) must not
//   exhaust the trap before a real mid-session storm shows up. Snapshot
//   ids are timestamps, so multiple captures never collide on disk.

const STORM_EVENTS = 200;
const STORM_WINDOW_MS = 5000;
const TRACER_BOOT_T = performance.now();
const BOOT_GRACE_MS = 15_000;
const MAX_FIRES = 3;
const REFIRE_SPACING_MS = 60_000;

let stormCapture: (() => void) | null = null;
let stormFires = 0;
let lastFireT = -Infinity;

export function setStormAutoCapture(cb: () => void): void {
  stormCapture = cb;
}

export function traceCw(op: string, who: string, cw: string): void {
  if (cwTrace.length >= 5000) cwTrace.shift();
  const t = Math.round(performance.now());
  cwTrace.push({ t, op, cw, who });
  if (stormCapture === null || stormFires >= MAX_FIRES) return;
  if (t - TRACER_BOOT_T < BOOT_GRACE_MS) return;
  if (t - lastFireT < REFIRE_SPACING_MS) return;
  if (cwTrace.length < STORM_EVENTS) return;
  if (t - cwTrace[cwTrace.length - STORM_EVENTS].t >= STORM_WINDOW_MS) return;
  stormFires += 1;
  lastFireT = t;
  setTimeout(stormCapture, 0);
}
