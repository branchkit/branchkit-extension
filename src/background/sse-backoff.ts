/**
 * BranchKit Browser — SSE retry backoff policy.
 *
 * Pure decision logic for the SW's SSE reconnect ladder; timers live in
 * background.ts. The one rule that isn't a textbook exponential ladder:
 * a reconnect earns the 1s reset only after the connection has HELD for
 * `stableResetMs`. Resetting on the connect edge itself (the pre-2026-07
 * behavior) meant a crash-looping host — connects, drops seconds later,
 * repeat — re-ran plugin discovery (a real fetch) every ~1s forever with
 * no escalation. See notes/DESIGN_SSE_RESILIENCE.md (2).
 */

const INITIAL_DELAY_MS = 1000;

export class SSEBackoff {
  private delayMs = INITIAL_DELAY_MS;
  private connectedAtMs: number | null = null;

  constructor(
    private readonly capMs = 30_000,
    private readonly stableResetMs = 30_000,
  ) {}

  /** Record a successful connect. Does NOT reset the ladder — that happens
   *  lazily at the next disconnect, iff this connection proved stable. */
  onConnected(nowMs: number): void {
    this.connectedAtMs = nowMs;
  }

  /** Delay to wait before the next retry attempt. Escalates the ladder for
   *  the attempt after this one; applies the stable-connection reset first
   *  when the preceding connection held long enough. */
  nextDelayMs(nowMs: number): number {
    if (this.connectedAtMs !== null) {
      if (nowMs - this.connectedAtMs >= this.stableResetMs) {
        this.delayMs = INITIAL_DELAY_MS;
      }
      this.connectedAtMs = null;
    }
    const delay = this.delayMs;
    this.delayMs = Math.min(this.delayMs * 2, this.capMs);
    return delay;
  }
}
