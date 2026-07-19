/**
 * One-shot painted-vs-matchable reconcile (the Layer-2 badge-drift check).
 *
 * Pure and DOM-free so the service worker can run it. Joins the extension's
 * painted hint set (already captured in the Ctrl+Alt+A debug snapshot) against
 * the actuator's matchable view (GET /inspector/matchable) and classifies any
 * drift. Invoked ONLY on the demand-driven debug snapshot — no steady-state
 * cost, nothing on the scroll/paint path. One press = one report.
 *
 * Drift this catches:
 *  - strictly-painted badges while the hints gate is inactive (none matchable),
 *  - hints gate active but no hint command eligible (codewords can't resolve),
 *  - strictly-painted badges the plugin never ACK'd (extension->plugin sync gap),
 *  - a pending/missed strict re-push.
 * Scroll-ahead (non-strict) painted badges are expected, not drift.
 */

const HINTS_TAG = 'plugin.browser.hints';

/** Structural subset of a debug-snapshot WrapperRecord this reconcile reads. */
export interface ReconcileWrapper {
  scanned: { codeword: string; in_strict_viewport?: boolean };
  hint: { isVisible: boolean } | null;
  lastSentStrictViewport?: boolean;
}

/** Structural subset of GET /inspector/matchable this reconcile reads. */
export interface MatchableView {
  active_tags?: string[];
  eligible?: { requires_tags?: string[] }[];
}

export interface ReconcileReport {
  painted: number;
  scroll_ahead: number;
  strict_painted: number;
  send_pending: number;
  hints_gate_active: boolean;
  hint_commands_eligible: boolean;
  verdict: string[];
}

export function buildReconcileReport(
  wrappers: readonly ReconcileWrapper[],
  matchable: MatchableView | null,
): ReconcileReport {
  let painted = 0;
  let scrollAhead = 0;
  let strictPainted = 0;
  let sendPending = 0;

  for (const w of wrappers) {
    if (!w.hint?.isVisible || !w.scanned.codeword) continue;
    painted++;
    if (w.scanned.in_strict_viewport === true) {
      strictPainted++;
    } else {
      scrollAhead++;
    }
    if (w.scanned.in_strict_viewport !== w.lastSentStrictViewport) sendPending++;
  }

  const hintsGateActive = !!matchable?.active_tags?.includes(HINTS_TAG);
  const hintCommandsEligible =
    !!matchable?.eligible?.some((c) => (c.requires_tags ?? []).includes(HINTS_TAG));

  const verdict: string[] = [];
  if (painted === 0) {
    verdict.push('No badges painted.');
  } else if (strictPainted === 0) {
    verdict.push(`${painted} badge(s) painted, all scroll-ahead (none strictly matchable yet) — expected.`);
  } else {
    if (!hintsGateActive) {
      verdict.push(
        `DRIFT: ${strictPainted} strictly-painted badge(s) but hints gate (${HINTS_TAG}) is INACTIVE — none matchable.`,
      );
    } else if (!hintCommandsEligible) {
      verdict.push('DRIFT: hints gate active but no hint command is eligible — codewords cannot resolve.');
    }
    if (verdict.length === 0) {
      verdict.push(`OK: ${strictPainted} strictly-painted badge(s) — gate active, commands eligible.`);
    }
  }
  if (sendPending > 0) {
    verdict.push(
      `${sendPending} badge(s) with a pending/missed strict re-push (in_strict_viewport != lastSentStrictViewport).`,
    );
  }

  return {
    painted,
    scroll_ahead: scrollAhead,
    strict_painted: strictPainted,
    send_pending: sendPending,
    hints_gate_active: hintsGateActive,
    hint_commands_eligible: hintCommandsEligible,
    verdict,
  };
}
