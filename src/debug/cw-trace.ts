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

export function traceCw(op: string, who: string, cw: string): void {
  if (cwTrace.length >= 5000) cwTrace.shift();
  cwTrace.push({ t: Math.round(performance.now()), op, cw, who });
}
