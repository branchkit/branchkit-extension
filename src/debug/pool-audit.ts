/**
 * BranchKit Browser — painted-vs-routable field tripwire (content side).
 *
 * Periodically asks the SW pool whether every codeword this document's
 * wrappers hold is actually ASSIGNED TO THIS DOCUMENT — i.e. whether a
 * spoken pair would route here or refuse `no_such_hint`. This is the
 * invariant behind both 2026-07-24 field failures (prerender poisoning,
 * bfcache non-reassert): painted-but-unroutable badges are invisible until
 * a user speaks one. The tripwire makes NORMAL browsing surface them — a
 * divergence lands in browser.log as a WARN with the exact labels, no
 * scripted manual soak required.
 *
 * Dev builds only (harnessHooksEnabled — release builds get no new timer).
 * REPORT-ONLY by design: no self-healing here. A healer would mask exactly
 * the bugs this exists to catch; the existing recovery paths (rejection
 * flush, restore reconfirm, level-triggered reclaim) stay the healers.
 *
 * The POOL_AUDIT message is a pure READ — deliberately outside the
 * reservoir's single-sender invariant, which governs pool MUTATIONS.
 */

import { store } from '../core/store';
import { pageSession } from '../lifecycle/page-session';
import { documentInstanceId } from '../labels/document-identity';
import { harnessHooksEnabled } from './harness-hooks';
import { bkLog } from './bk-log';

// First audit shortly after boot — the boot window is where both known
// divergence classes struck (prerender confirms, bfcache restore). Then a
// slow steady cadence; pausableInterval stops it while the tab is hidden.
const FIRST_AUDIT_MS = 7_000;
const AUDIT_INTERVAL_MS = 60_000;

async function auditOnce(trigger: string): Promise<void> {
  if (pageSession.isTornDown) return;
  const held = store.all.map((w) => w.scanned.codeword).filter((cw) => cw !== '');
  if (held.length === 0) return;
  let resp: { unroutable?: string[]; foreign?: string[] } | undefined;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'POOL_AUDIT',
      doc_id: documentInstanceId,
      labels: held,
    });
  } catch {
    return; // SW asleep / orphan — next tick retries
  }
  const unroutable = resp?.unroutable ?? [];
  const foreign = resp?.foreign ?? [];
  if (unroutable.length === 0 && foreign.length === 0) return;
  bkLog('BK_POOL_AUDIT_DIVERGENCE', {
    trigger,
    held: held.length,
    unroutable: unroutable.length,
    foreign: foreign.length,
    // Full label lists so the report is actionable without a repro.
    unroutable_labels: unroutable,
    foreign_labels: foreign,
  });
}

/** Arm the tripwire. Called once from the content bootstrap; no-op in
 * release builds. */
export function initPoolAudit(): void {
  if (!harnessHooksEnabled()) return;
  pageSession.resources.timeout(() => { void auditOnce('boot'); }, FIRST_AUDIT_MS);
  pageSession.resources.pausableInterval(() => { void auditOnce('interval'); }, AUDIT_INTERVAL_MS);
}
