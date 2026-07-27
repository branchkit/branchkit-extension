/**
 * BranchKit Browser — per-tag coalescer for the PLUGIN_DEBUG_LOG choke point.
 *
 * BK_CS_BOOT fires once per content-script boot — every frame, every
 * prerender-pool churn, every settings-page iframe — and at 82% of recent
 * browser.log lines it drowned every other tag (see
 * notes/DESIGN_EXTENSION_LOG_RETRIEVAL.md, piece A). Boot lines are
 * load-bearing (the orphan-teardown and pool arcs consumed boot counts and
 * boot-URL identity), so they are coalesced, not demoted: the first line in
 * a rolling window forwards verbatim; the rest accumulate and flush as one
 * `<TAG>_COALESCED {count, window_ms, urls}` summary. Visible compression,
 * never a silent gap — same contract as the content-script firehose limiter.
 *
 * The SW is the only place this can live: each boot line comes from a fresh
 * content-script context, so no CS-side limiter can see across them. All
 * PLUGIN_DEBUG_LOG traffic already funnels through one handler in
 * background.ts; that handler calls forwardCoalesced() instead of
 * forwardPluginDebugLog() directly.
 *
 * Ordering: a pending summary flushes before any other line forwards, so
 * the summary always sits where the burst actually happened in the log.
 * A timer also flushes at window close, covering a burst followed by
 * silence. If the SW dies with a summary pending, those counts are lost —
 * acceptable: the transport below is already best-effort, and boots around
 * a SW death re-announce on recovery per the bk-log convention.
 */
import type { MessageHandler } from './message-router';
import { forwardPluginDebugLog } from '../plugin/plugin-api';

const COALESCED_TAGS = new Set(['BK_CS_BOOT']);
const WINDOW_MS = 1000;
const SUMMARY_URLS = 3;

interface TagWindow {
  openedAt: number;
  held: number;
  urls: Map<string, number>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const windows = new Map<string, TagWindow>();

function flush(tag: string): void {
  const w = windows.get(tag);
  if (!w) return;
  if (w.flushTimer !== null) clearTimeout(w.flushTimer);
  windows.delete(tag);
  if (w.held === 0) return;
  const urls = [...w.urls.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUMMARY_URLS)
    .map(([url, count]) => (count > 1 ? `${url} (×${count})` : url));
  void forwardPluginDebugLog(
    `${tag}_COALESCED`,
    { count: w.held, window_ms: WINDOW_MS, urls },
    'info',
  );
}

function flushAll(): void {
  for (const tag of [...windows.keys()]) flush(tag);
}

/** Drop-in replacement for forwardPluginDebugLog at the PLUGIN_DEBUG_LOG
 * choke point. Non-coalesced tags pass straight through (after flushing
 * any pending summary, to keep log order truthful). */
export function forwardCoalesced(tag: string, data: unknown, level: string): void {
  if (!COALESCED_TAGS.has(tag)) {
    flushAll();
    void forwardPluginDebugLog(tag, data, level);
    return;
  }

  const now = Date.now();
  const w = windows.get(tag);
  if (w && now - w.openedAt < WINDOW_MS) {
    w.held++;
    const url = typeof (data as { url?: unknown })?.url === 'string'
      ? (data as { url: string }).url
      : '(no url)';
    w.urls.set(url, (w.urls.get(url) ?? 0) + 1);
    return;
  }

  // Window closed or absent: settle the old one, forward this line
  // verbatim, and open a fresh window behind it.
  flush(tag);
  void forwardPluginDebugLog(tag, data, level);
  windows.set(tag, {
    openedAt: now,
    held: 0,
    urls: new Map(),
    flushTimer: setTimeout(() => flush(tag), WINDOW_MS),
  });
}

/** Test-only: drop all window state without emitting. */
export function _resetCoalescerForTests(): void {
  for (const w of windows.values()) {
    if (w.flushTimer !== null) clearTimeout(w.flushTimer);
  }
  windows.clear();
}

/**
 * Message handler owned by this module (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md).
 * Coalesced: BK_CS_BOOT bursts collapse to first-line + summary.
 */
export const logMessageHandlers: Record<string, MessageHandler> = {
  PLUGIN_DEBUG_LOG: (message) => {
    if (typeof message.tag !== 'string') return;
    forwardCoalesced(message.tag, message.data, typeof message.level === 'string' ? message.level : 'debug');
  },
};
