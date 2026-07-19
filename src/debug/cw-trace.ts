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
// Hardened across three rounds of live false positives (2026-07-19):
// - v2: grace measured from tracer boot, not page load (an extension-
//   reload reinjection into an old tab started with "page life" of an
//   hour and got zero grace for its boot scan wave); up to MAX_FIRES
//   captures per session, spaced, so an early burst can't exhaust the
//   trap. Snapshot ids are timestamps, so captures never collide.
// - v3: grace measured from the FIRST RING EVENT, not module load. A
//   content script injected into a hidden background tab defers its
//   initial scan until the tab is activated — 15s+ after module load —
//   so the scan wave (200+ grants in ~300ms on a QuickBase-sized page)
//   escaped the boot grace. The boot-equivalent moment is when tracing
//   STARTS, wherever that lands. A real storm still fires: either the
//   page has prior codeword activity (grace long since expired) or the
//   storm itself outlasts the grace window and trips on its tail.

const STORM_EVENTS = 200;
const STORM_WINDOW_MS = 5000;
const FIRST_ACTIVITY_GRACE_MS = 15_000;
const MAX_FIRES = 3;
const REFIRE_SPACING_MS = 60_000;

let stormCapture: (() => void) | null = null;
let stormFires = 0;
let lastFireT = -Infinity;
let firstEventT: number | null = null;

export function setStormAutoCapture(cb: () => void): void {
  stormCapture = cb;
}

export function traceCw(op: string, who: string, cw: string): void {
  if (cwTrace.length >= 5000) cwTrace.shift();
  const t = Math.round(performance.now());
  if (firstEventT === null) firstEventT = t;
  cwTrace.push({ t, op, cw, who });
  if (stormCapture === null || stormFires >= MAX_FIRES) return;
  if (t - firstEventT < FIRST_ACTIVITY_GRACE_MS) return;
  if (t - lastFireT < REFIRE_SPACING_MS) return;
  if (cwTrace.length < STORM_EVENTS) return;
  if (t - cwTrace[cwTrace.length - STORM_EVENTS].t >= STORM_WINDOW_MS) return;
  stormFires += 1;
  lastFireT = t;
  setTimeout(stormCapture, 0);
}
