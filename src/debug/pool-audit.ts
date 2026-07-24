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
 *
 * The same sweep also carries the ORPHAN-PAINT half (2026-07-24, orphan
 * teardown arc layer 1): badge hosts stamped by a different content-script
 * context are stale paint from a dead elder — POOL_AUDIT can't see them
 * (they're not in the fresh store), so the DOM-side stamp comparison is the
 * only detector. See notes/DESIGN_ORPHAN_PAINT.md.
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
  /** Badge hosts in the DOM stamped by a DIFFERENT content-script context —
   * stale paint from an orphaned elder that can no longer service them.
   * `held: -1` (SW unreachable) still carries a real count: this half of the
   * audit is a pure DOM read and needs no SW. */
  stale_hosts: number;
  stale_docs: string[];
}

/** Count badge hosts whose creator stamp isn't ours (see hints.ts). Auxiliary
 * UI (toasts, mode chip, palette) uses `data-branchkit-hint=""` and is out of
 * scope — only real badge hosts (`="true"`) are stale-paint candidates. An
 * absent stamp reads as `unstamped` (a pre-stamp painter — also foreign). */
export function countForeignBadgeHosts(): { count: number; docs: string[] } {
  const docs = new Set<string>();
  let count = 0;
  for (const host of document.querySelectorAll('[data-branchkit-hint="true"]')) {
    const doc = host.getAttribute('data-branchkit-doc') ?? 'unstamped';
    if (doc !== documentInstanceId) {
      count++;
      docs.add(doc);
    }
  }
  return { count, docs: [...docs] };
}

async function computeAudit(): Promise<AuditResult | null> {
  if (pageSession.isTornDown) return null;
  const paint = countForeignBadgeHosts();
  const stale = { stale_hosts: paint.count, stale_docs: paint.docs };
  const held = store.all.map((w) => w.scanned.codeword).filter((cw) => cw !== '');
  if (held.length === 0) return { held: 0, unroutable: [], foreign: [], ...stale };
  let resp: { unroutable?: string[]; foreign?: string[] } | undefined;
  try {
    resp = await chrome.runtime.sendMessage({
      type: 'POOL_AUDIT',
      doc_id: documentInstanceId,
      labels: held,
    });
  } catch {
    // SW asleep / orphan — the pool half retries next tick, but the paint
    // half is still authoritative (DOM-only).
    return { held: -1, unroutable: [], foreign: [], ...stale };
  }
  return {
    held: held.length,
    unroutable: resp?.unroutable ?? [],
    foreign: resp?.foreign ?? [],
    ...stale,
  };
}

async function auditOnce(trigger: string): Promise<void> {
  const result = await computeAudit();
  if (!result) return;
  if (result.stale_hosts > 0) {
    // Separate tag from the pool divergence: this is a PAINT gap (a dead
    // elder's badges still visible), not a routing gap. The greppable spine
    // of the orphan-paint arc — see notes/DESIGN_ORPHAN_PAINT.md.
    bkLog('BK_STALE_PAINT', {
      trigger,
      stale_hosts: result.stale_hosts,
      stale_docs: result.stale_docs,
      live_doc: documentInstanceId,
    }, 'warn');
  }
  if (result.held <= 0) return;
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
    : { seq: ++auditSeq, held: -1, unroutable: [], foreign: [], stale_hosts: 0, stale_docs: [] }; // torn down
  document.documentElement.dataset.branchkitPoolAudit = JSON.stringify(payload);
  if (result && (result.unroutable.length > 0 || result.foreign.length > 0 || result.stale_hosts > 0)) {
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
