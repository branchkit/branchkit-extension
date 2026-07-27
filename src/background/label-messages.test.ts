/**
 * BranchKit Browser — label-pool message unit tests.
 *
 * These pin the wire-edge invariants, not the arbitration (that is
 * label-pool.test.ts). Specifically the three that are expensive to get wrong:
 * prerender senders never reach the pool, the SENDER's frame identity is used
 * rather than the payload's, and every refusal resolves an empty answer instead
 * of rejecting — because a CONFIRM_LABELS rejection strips wrappers, and a
 * rejection escaping to the router closes the channel with undefined.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

type Mod = typeof import('./label-messages');

const claimLabels = vi.fn();
const confirmLabels = vi.fn();
const releaseLabels = vi.fn();
const auditLabels = vi.fn();
const senderMayMutatePool = vi.fn();
const rememberCodewords = vi.fn();
const recallCodewords = vi.fn();
const forwardDebugLog = vi.fn();

async function load(): Promise<Mod> {
  vi.resetModules();
  vi.doMock('../labels/label-pool', () => ({
    claimLabels, confirmLabels, releaseLabels, auditLabels, senderMayMutatePool,
  }));
  vi.doMock('../labels/codeword-memory', () => ({ rememberCodewords, recallCodewords }));
  vi.doMock('../plugin/plugin-api', () => ({ forwardDebugLog }));
  return await import('./label-messages');
}

const inTab = { tab: { id: 4 }, frameId: 0 } as any;
const noTab = { frameId: 0 } as any;      // popup / offscreen — no tab context
const noFrame = { tab: { id: 4 } } as any;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  senderMayMutatePool.mockReturnValue(true);
  claimLabels.mockResolvedValue(['ape', 'bay']);
  confirmLabels.mockResolvedValue({ rejected: ['bay'] });
  releaseLabels.mockResolvedValue(undefined);
  auditLabels.mockResolvedValue({ unroutable: ['x'], foreign: [] });
  rememberCodewords.mockResolvedValue(undefined);
  recallCodewords.mockResolvedValue([{ fp: 'a', codeword: 'ape' }]);
});

describe('CLAIM_LABELS', () => {
  const msg = { type: 'CLAIM_LABELS', doc_id: 'd1', count: 2, preferred: ['ape'] };

  it('grants from the pool using the sender frame, not the payload', async () => {
    const { labelMessageHandlers: h } = await load();

    await expect(h.CLAIM_LABELS({ ...msg, tabId: 999, frameId: 999 }, inTab))
      .resolves.toEqual({ labels: ['ape', 'bay'] });
    expect(claimLabels).toHaveBeenCalledWith(4, 'd1', 0, 2, ['ape']);
  });

  it('refuses a prerender sender with an empty grant and logs it', async () => {
    const { labelMessageHandlers: h } = await load();
    senderMayMutatePool.mockReturnValue(false);

    expect(h.CLAIM_LABELS(msg, inTab)).toEqual({ labels: [] });
    expect(claimLabels).not.toHaveBeenCalled();
    expect(forwardDebugLog).toHaveBeenCalledWith(
      'pool.prerender_claim_denied', { tab_id: 4, frame_id: 0 },
    );
  });

  it('refuses senders with no tab or frame context', async () => {
    const { labelMessageHandlers: h } = await load();

    expect(h.CLAIM_LABELS(msg, noTab)).toEqual({ labels: [] });
    expect(h.CLAIM_LABELS(msg, noFrame)).toEqual({ labels: [] });
    expect(claimLabels).not.toHaveBeenCalled();
  });

  it('requires a non-empty doc_id', async () => {
    const { labelMessageHandlers: h } = await load();

    for (const doc_id of [undefined, '', 42, null]) {
      expect(h.CLAIM_LABELS({ ...msg, doc_id }, inTab)).toEqual({ labels: [] });
    }
    expect(claimLabels).not.toHaveBeenCalled();
  });

  it('resolves an empty grant when the pool throws', async () => {
    const { labelMessageHandlers: h } = await load();
    claimLabels.mockRejectedValue(new Error('storage'));

    await expect(h.CLAIM_LABELS(msg, inTab)).resolves.toEqual({ labels: [] });
  });
});

describe('CONFIRM_LABELS', () => {
  const msg = { type: 'CONFIRM_LABELS', doc_id: 'd1', labels: ['ape'] };

  it('returns the arbitration result unchanged', async () => {
    const { labelMessageHandlers: h } = await load();

    await expect(h.CONFIRM_LABELS(msg, inTab)).resolves.toEqual({ rejected: ['bay'] });
    expect(confirmLabels).toHaveBeenCalledWith(4, 'd1', 0, ['ape']);
  });

  it('a transient pool error rejects NOTHING — rejecting would strip wrappers', async () => {
    const { labelMessageHandlers: h } = await load();
    confirmLabels.mockRejectedValue(new Error('transient'));

    await expect(h.CONFIRM_LABELS(msg, inTab)).resolves.toEqual({ rejected: [] });
  });

  it('accepts nothing from a prerender sender rather than rejecting', async () => {
    const { labelMessageHandlers: h } = await load();
    senderMayMutatePool.mockReturnValue(false);

    expect(h.CONFIRM_LABELS(msg, inTab)).toEqual({ rejected: [] });
    expect(confirmLabels).not.toHaveBeenCalled();
  });

  it('refuses malformed input with an empty rejection list', async () => {
    const { labelMessageHandlers: h } = await load();

    expect(h.CONFIRM_LABELS({ ...msg, labels: 'nope' }, inTab)).toEqual({ rejected: [] });
    expect(h.CONFIRM_LABELS({ ...msg, doc_id: '' }, inTab)).toEqual({ rejected: [] });
    expect(h.CONFIRM_LABELS(msg, noTab)).toEqual({ rejected: [] });
    expect(confirmLabels).not.toHaveBeenCalled();
  });
});

describe('RELEASE_LABELS', () => {
  it('frees through the pool and answers nothing', async () => {
    const { labelMessageHandlers: h } = await load();

    expect(h.RELEASE_LABELS({ type: 'x', doc_id: 'd1', labels: ['ape'] }, inTab)).toBeUndefined();
    expect(releaseLabels).toHaveBeenCalledWith(4, 'd1', ['ape']);
  });

  it('ignores senders with no tab and payloads with no doc_id', async () => {
    const { labelMessageHandlers: h } = await load();

    h.RELEASE_LABELS({ type: 'x', doc_id: 'd1' }, noTab);
    h.RELEASE_LABELS({ type: 'x' }, inTab);
    expect(releaseLabels).not.toHaveBeenCalled();
  });

  it('swallows a pool error rather than surfacing an unhandled rejection', async () => {
    const { labelMessageHandlers: h } = await load();
    releaseLabels.mockRejectedValue(new Error('storage'));

    expect(h.RELEASE_LABELS({ type: 'x', doc_id: 'd1', labels: [] }, inTab)).toBeUndefined();
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled());
  });
});

describe('POOL_AUDIT', () => {
  it('is read-only: a prerender sender is NOT gated out', async () => {
    const { labelMessageHandlers: h } = await load();
    senderMayMutatePool.mockReturnValue(false);

    await expect(h.POOL_AUDIT({ type: 'x', doc_id: 'd1', labels: ['ape'] }, inTab))
      .resolves.toEqual({ unroutable: ['x'], foreign: [] });
  });

  it('answers empty on malformed input or a throwing audit', async () => {
    const { labelMessageHandlers: h } = await load();
    const empty = { unroutable: [], foreign: [] };

    expect(h.POOL_AUDIT({ type: 'x', doc_id: 'd1', labels: 'no' }, inTab)).toEqual(empty);
    expect(h.POOL_AUDIT({ type: 'x', doc_id: 'd1', labels: [] }, noTab)).toEqual(empty);

    auditLabels.mockRejectedValue(new Error('boom'));
    await expect(h.POOL_AUDIT({ type: 'x', doc_id: 'd1', labels: [] }, inTab)).resolves.toEqual(empty);
  });
});

describe('codeword memory', () => {
  it('REMEMBER_CODEWORDS persists per frame and answers nothing', async () => {
    const { labelMessageHandlers: h } = await load();
    const entries = [{ fp: 'a', codeword: 'ape' }];

    expect(h.REMEMBER_CODEWORDS({ type: 'x', entries }, inTab)).toBeUndefined();
    expect(rememberCodewords).toHaveBeenCalledWith(4, 0, entries);
  });

  it('REMEMBER_CODEWORDS ignores a non-array payload', async () => {
    const { labelMessageHandlers: h } = await load();

    h.REMEMBER_CODEWORDS({ type: 'x', entries: 'nope' }, inTab);
    h.REMEMBER_CODEWORDS({ type: 'x', entries: [] }, noFrame);
    expect(rememberCodewords).not.toHaveBeenCalled();
  });

  it('RECALL_CODEWORDS returns this frame’s entries, empty on failure', async () => {
    const { labelMessageHandlers: h } = await load();

    await expect(h.RECALL_CODEWORDS({ type: 'x' }, inTab))
      .resolves.toEqual({ entries: [{ fp: 'a', codeword: 'ape' }] });
    expect(recallCodewords).toHaveBeenCalledWith(4, 0);

    recallCodewords.mockRejectedValue(new Error('gone'));
    await expect(h.RECALL_CODEWORDS({ type: 'x' }, inTab)).resolves.toEqual({ entries: [] });

    expect(h.RECALL_CODEWORDS({ type: 'x' }, noTab)).toEqual({ entries: [] });
  });
});
