import { Message } from '../types';

/**
 * Firehose breadcrumbs: posted to the SW around burst paths that can wedge the
 * main thread (full-page DOM swaps, scroll storms). A `:start` without a
 * matching `:end` in the actuator log pins which body wedged. See
 * notes/INVESTIGATION_YOUTUBE_WATCH_PERF.md (nav-time wedge, firehose).
 *
 * Per-step threshold: each caller picks its own minimum size. The default of 1
 * (effectively unconditional) is only safe for low-rate call sites (settle
 * cadence or rarer). Burst-path callers — anything in the MutationObserver
 * callback chain, which fires ~80×/sec on churny pages — MUST pass an explicit
 * threshold: each step below it is a sendMessage + SW wakeup + localhost HTTP
 * POST, and ungated steps once put hundreds of messages/sec on that path (the
 * nav-wedge diagnostic pass loosened them and they stayed loose for weeks).
 *
 * Module-level rate limiter (long-session review backlog): thresholds gate on
 * SIZE, not RATE — on Slack/Linear-class pages every batch clears the size
 * threshold and the MO chain still shipped ~320-480 msg/s during bursts. The
 * limiter caps the wire rate here, where no caller can forget it: a rolling
 * one-second window of MAX_STEPS_PER_SEC messages; excess steps are dropped
 * and COUNTED, and the first message after the window reopens carries a
 * `firehose:dropped` summary (visible compression, never a silent gap —
 * mirrors the actuator's plugin-stderr limiter). Diagnostic ordering survives:
 * the summary marks exactly where the gap sat.
 */
const MAX_STEPS_PER_SEC = 25;

let windowStartMs = 0;
let windowCount = 0;
let droppedSinceSummary = 0;

function post(step: string, size: number): void {
  chrome.runtime.sendMessage({
    type: 'DEBUG_LOG',
    tag: 'pipeline.cs_firehose_step',
    data: { step, size, ts: Math.round(performance.now()) },
  } as Message).catch(() => {});
}

export function firehoseStep(step: string, size: number, threshold: number = 1): void {
  if (size < threshold) return;
  const now = performance.now();
  if (now - windowStartMs >= 1000) {
    windowStartMs = now;
    windowCount = 0;
  }
  if (windowCount >= MAX_STEPS_PER_SEC) {
    droppedSinceSummary++;
    return;
  }
  windowCount++;
  if (droppedSinceSummary > 0) {
    const dropped = droppedSinceSummary;
    droppedSinceSummary = 0;
    windowCount++; // the summary spends a slot too
    post('firehose:dropped', dropped);
  }
  post(step, size);
}

/** Test-only: reset limiter state between cases. */
export function _resetFirehoseForTests(): void {
  windowStartMs = 0;
  windowCount = 0;
  droppedSinceSummary = 0;
}
