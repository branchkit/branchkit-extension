/**
 * BranchKit Browser — outbound message volume counters.
 *
 * Wraps chrome.runtime.sendMessage to count each call by `message.type` and
 * accumulate an approximate JSON byte size. The actuator receives one HTTP
 * POST per GRAMMAR_BATCH/CLAIM_LABELS, so this doubles as a proxy for
 * outbound HTTP volume from the SW. Surfaced in the perf snapshot.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

interface MessageCounters {
  bySendType: Record<string, number>;
  totalSends: number;
  totalBytesApprox: number;
}

const messageCounters: MessageCounters = {
  bySendType: {},
  totalSends: 0,
  totalBytesApprox: 0,
};

let sendMessageWrapped = false;

/**
 * Monkeypatch chrome.runtime.sendMessage to count calls. Lazy + idempotent
 * so test harnesses can install their own stub before the first message
 * fires; subsequent calls are no-ops.
 */
export function ensureSendMessageWrapped(): void {
  if (sendMessageWrapped) return;
  sendMessageWrapped = true;
  const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
  (chrome.runtime as any).sendMessage = function (message: unknown, ...rest: unknown[]) {
    try {
      const type = (message as { type?: string } | null)?.type ?? '(no-type)';
      messageCounters.bySendType[type] = (messageCounters.bySendType[type] || 0) + 1;
      messageCounters.totalSends++;
      messageCounters.totalBytesApprox += JSON.stringify(message).length;
    } catch { /* counter ops must not break sendMessage */ }
    return (orig as (m: unknown, ...r: unknown[]) => Promise<unknown>)(message, ...rest);
  };
}

export function resetMessageCounters(): void {
  messageCounters.bySendType = {};
  messageCounters.totalSends = 0;
  messageCounters.totalBytesApprox = 0;
}

/** Snapshot for the perf report: total sends, approx bytes, per-type counts. */
export function messageCountersSnapshot(): { total: number; bytes: number; byType: Record<string, number> } {
  return {
    total: messageCounters.totalSends,
    bytes: messageCounters.totalBytesApprox,
    byType: { ...messageCounters.bySendType },
  };
}
