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

interface AuditResult {
  held: number;
  unroutable: string[];
  foreign: string[];
}

async function computeAudit(): Promise<AuditResult | null> {
  if (pageSession.isTornDown) return null;
  const held = store.all.map((w) => w.scanned.codeword).filter((cw) => cw !== '');
  if (held.length === 0) return { held: 0, unroutable: [], foreign: [] };
  let resp: { unroutable?: string[]; foreign?: string[] } | undefined;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'POOL_AUDIT',
      doc_id: documentInstanceId,
      labels: held,
    });
  } catch {
    return null; // SW asleep / orphan — next tick retries
  }
  return {
    held: held.length,
    unroutable: resp?.unroutable ?? [],
    foreign: resp?.foreign ?? [],
  };
}

async function auditOnce(trigger: string): Promise<void> {
  const result = await computeAudit();
  if (!result || result.held === 0) return;
  if (result.unroutable.length === 0 && result.foreign.length === 0) return;
  bkLog('BK_POOL_AUDIT_DIVERGENCE', {
    trigger,
    held: result.held,
    unroutable: result.unroutable.length,
    foreign: result.foreign.length,
    // Full label lists so the report is actionable without a repro.
    unroutable_labels: result.unroutable,
    foreign_labels: result.foreign,
  });
}

// On-demand audit for the lifecycle harness (DESIGN_LIFECYCLE_HARNESS.md):
// a page-dispatched CustomEvent triggers the same audit and mirrors the FULL
// result — clean or not — onto a dataset attribute the driver polls. Detail
// objects don't cross MAIN→ISOLATED, so freshness rides a monotonic seq in
// the payload; the driver clears the attribute before dispatching. Divergence
// still breadcrumbs through auditOnce's log path so harness runs and field
// runs report identically.
let auditSeq = 0;

async function auditOnDemand(): Promise<void> {
  const result = await computeAudit();
  const payload = result
    ? { seq: ++auditSeq, ...result }
    : { seq: ++auditSeq, held: -1, unroutable: [], foreign: [] }; // -1 = SW unreachable
  document.documentElement.dataset.branchkitPoolAudit = JSON.stringify(payload);
  if (result && (result.unroutable.length > 0 || result.foreign.length > 0)) {
    void auditOnce('on_demand');
  }
}

/** Arm the tripwire + the harness's on-demand surface. Called once from the
 * content bootstrap; no-op in release builds. */
export function initPoolAudit(): void {
  if (!harnessHooksEnabled()) return;
  pageSession.resources.timeout(() => { void auditOnce('boot'); }, FIRST_AUDIT_MS);
  pageSession.resources.pausableInterval(() => { void auditOnce('interval'); }, AUDIT_INTERVAL_MS);
  pageSession.resources.listen(document, '__branchkit__pool_audit' as keyof DocumentEventMap, () => {
    void auditOnDemand();
  });
}
