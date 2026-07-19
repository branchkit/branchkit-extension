import { describe, it, expect } from 'vitest';
import { buildReconcileReport, type ReconcileWrapper } from './reconcile';

function painted(
  codeword: string,
  strict: boolean,
  lastSent = strict,
): ReconcileWrapper {
  return {
    scanned: { codeword, in_strict_viewport: strict },
    hint: { isVisible: true },
    lastSentStrictViewport: lastSent,
  };
}

const GATE_ON = {
  active_tags: ['plugin.browser.hints'],
  eligible: [{ requires_tags: ['plugin.browser.hints'] }],
};
const GATE_OFF = { active_tags: [], eligible: [] };

describe('buildReconcileReport', () => {
  it('flags strictly-painted badges as drift when the hints gate is inactive', () => {
    const r = buildReconcileReport([painted('air bat', true)], GATE_OFF);
    expect(r.strict_painted).toBe(1);
    expect(r.hints_gate_active).toBe(false);
    expect(r.verdict.some((v) => v.includes('INACTIVE'))).toBe(true);
  });

  it('is clean when gate active, command eligible, and ACK\'d', () => {
    const r = buildReconcileReport([painted('air bat', true)], GATE_ON);
    expect(r.verdict.some((v) => v.startsWith('OK'))).toBe(true);
    expect(r.verdict.some((v) => v.includes('DRIFT'))).toBe(false);
  });

  it('treats scroll-ahead (non-strict) painted badges as expected, not drift', () => {
    const r = buildReconcileReport([painted('air bat', false)], GATE_OFF);
    expect(r.scroll_ahead).toBe(1);
    expect(r.strict_painted).toBe(0);
    expect(r.verdict.some((v) => v.includes('DRIFT'))).toBe(false);
  });

  it('flags a pending strict re-push when in_strict_viewport != lastSentStrictViewport', () => {
    const r = buildReconcileReport([painted('air bat', true, false)], GATE_ON);
    expect(r.send_pending).toBe(1);
    expect(r.verdict.some((v) => v.includes('pending/missed strict re-push'))).toBe(true);
  });

  it('reports nothing painted as such (no false drift)', () => {
    const r = buildReconcileReport(
      [{ scanned: { codeword: 'air bat', in_strict_viewport: true }, hint: null }],
      GATE_OFF,
    );
    expect(r.painted).toBe(0);
    expect(r.verdict).toContain('No badges painted.');
  });
});
