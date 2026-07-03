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
 */
export function firehoseStep(step: string, size: number, threshold: number = 1): void {
  if (size < threshold) return;
  chrome.runtime.sendMessage({
    type: 'DEBUG_LOG',
    tag: 'pipeline.cs_firehose_step',
    data: { step, size, ts: Math.round(performance.now()) },
  } as Message).catch(() => {});
}
