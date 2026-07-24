/**
 * BranchKit Browser — bfcache liveness-port probe (orphan-paint arc layer 2).
 *
 * TEMPORARY instrumentation, notes/DESIGN_ORPHAN_PAINT.md. Answers the
 * DESIGN_PRERENDER_POOL_POISONING.md sec-5 open question with field + harness
 * evidence instead of a guess: after a bfcache restore, is this document's
 * liveness Port alive, self-healed, or silently dead? Two samples per
 * restore — at the restore instant, and 2s later (past the 500ms reconnect
 * ladder) to see whether the channel self-heals.
 *
 * The verdict is the (port, sw_tracked) pair:
 *   ('absent', *)          — CS-side onDisconnect DID fire; the reconnect
 *                            ladder should heal it (check the settled sample).
 *   ('post_ok', true)      — channel genuinely alive end-to-end.
 *   ('post_ok', false)     — SILENTLY DEAD: the CS believes the port is open
 *                            while the SW saw it disconnect. SW-restart resync
 *                            is broken for this page until something reopens
 *                            the port.
 *   ('post_threw', *)      — dead object, onDisconnect never fired.
 *   ctx_valid: false       — the extension was reloaded while this page sat
 *                            in bfcache: THE orphan-paint window. This page
 *                            will repaint badges no context can service —
 *                            layer 3's teardown decision point.
 *
 * Report-only, dev builds (harnessHooksEnabled; const-folded out of release).
 * No fixing here — findings first (retrospective constraint: understand the
 * mechanism before touching the teardown seam).
 */

import { pageSession } from '../lifecycle/page-session';
import { documentInstanceId } from '../labels/document-identity';
import { probeLivenessPortState } from '../plugin/liveness';
import { harnessHooksEnabled } from './harness-hooks';
import { bkLog } from './bk-log';

interface ProbeSample {
  when: 'restore' | 'settled';
  ctx_valid: boolean;
  port: 'absent' | 'post_ok' | 'post_threw';
  sw_tracked: boolean | null; // null = query unanswerable (dead context / SW asleep)
  t: number;
}

// Latest samples, newest last, capped — a long-lived tab can restore many times.
const samples: ProbeSample[] = [];
const MAX_SAMPLES = 10;

async function sample(when: 'restore' | 'settled'): Promise<void> {
  let ctxValid = false;
  try {
    ctxValid = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
  } catch {
    ctxValid = false;
  }
  const port = probeLivenessPortState();
  let swTracked: boolean | null = null;
  if (ctxValid) {
    try {
      const resp: { tracked?: boolean } | undefined = await chrome.runtime.sendMessage({
        type: 'LIVENESS_QUERY',
        doc_id: documentInstanceId,
      });
      swTracked = resp?.tracked === true;
    } catch {
      swTracked = null; // SW asleep mid-query — indistinguishable, stays null
    }
  }
  const s: ProbeSample = {
    when,
    ctx_valid: ctxValid,
    port,
    sw_tracked: swTracked,
    t: Math.round(performance.now()),
  };
  samples.push(s);
  if (samples.length > MAX_SAMPLES) samples.shift();
  // bkLog rides the SW — lost on a dead context, which is why the dataset
  // mirror below exists (readable by the harness and from a console even
  // when the page is an orphan).
  bkLog('BK_BFCACHE_PORT_PROBE', s);
  try {
    document.documentElement.dataset.branchkitBfcacheProbe = JSON.stringify(samples);
  } catch {
    /* document gone */
  }
}

/** Called from restoreFromBfcache (content.ts). No-op in release builds. */
export function probeBfcacheRestore(): void {
  if (!harnessHooksEnabled()) return;
  void sample('restore');
  pageSession.resources.timeout(() => {
    void sample('settled');
  }, 2_000);
}
