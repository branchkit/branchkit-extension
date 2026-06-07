import { Message } from '../types';

/**
 * Firehose breadcrumbs: posted to the SW around burst paths that can wedge the
 * main thread (full-page DOM swaps, scroll storms). A `:start` without a
 * matching `:end` in the actuator log pins which body wedged. See
 * notes/INVESTIGATION_YOUTUBE_WATCH_PERF.md (nav-time wedge, firehose).
 *
 * Per-step threshold: each caller picks its own minimum size; default 1
 * (effectively unconditional) for the nav-wedge diagnostic pass.
 */
export function firehoseStep(step: string, size: number, threshold: number = 1): void {
  if (size < threshold) return;
  chrome.runtime.sendMessage({
    type: 'DEBUG_LOG',
    tag: 'pipeline.cs_firehose_step',
    data: { step, size, ts: Math.round(performance.now()) },
  } as Message).catch(() => {});
}
