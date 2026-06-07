/**
 * BranchKit Browser — codeword-memory unit tests.
 *
 * In-memory chrome.storage.session mock; exercises the per-(tab,frame)
 * fingerprint→codeword store: round-trip, upsert dedup, LRU eviction,
 * per-frame isolation, and clear. No wiring — pure store behavior.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Fingerprint } from '../scan/registry';
import {
  rememberCodewords,
  recallCodewords,
  clearCodewordMemory,
  MEMORY_CAP_PER_FRAME,
  type CodewordMemoryEntry,
} from './codeword-memory';

function installMockChrome(): void {
  const session = new Map<string, unknown>();
  const area = {
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      if (keys === undefined || keys === null) {
        return Object.fromEntries([...session].map(([k, v]) => [k, structuredClone(v)]));
      }
      if (typeof keys === 'string') {
        return session.has(keys) ? { [keys]: structuredClone(session.get(keys)) } : {};
      }
      const out: Record<string, unknown> = {};
      for (const k of keys) if (session.has(k)) out[k] = structuredClone(session.get(k));
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [k, v] of Object.entries(items)) session.set(k, structuredClone(v));
    },
    async remove(key: string): Promise<void> {
      session.delete(key);
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = { storage: { session: area } };
}

function fp(over: Partial<Fingerprint> = {}): Fingerprint {
  return { role: 'link', name: '', tag: 'a', text: 'Home', href: '/home', ...over };
}

function entry(text: string, codeword: string): CodewordMemoryEntry {
  return { fp: fp({ text, href: `/${text}` }), codeword, rect: null };
}

const TAB = 7;
const FRAME = 0;

describe('codeword-memory', () => {
  beforeEach(() => installMockChrome());

  it('round-trips remembered entries', async () => {
    await rememberCodewords(TAB, FRAME, [entry('Issues', 'gust harp'), entry('Code', 'air ink')]);
    const recalled = await recallCodewords(TAB, FRAME);
    expect(recalled).toHaveLength(2);
    expect(recalled.map(e => e.codeword)).toEqual(['gust harp', 'air ink']);
  });

  it('recalls empty for an unseen frame', async () => {
    expect(await recallCodewords(TAB, FRAME)).toEqual([]);
  });

  it('is a no-op on empty input', async () => {
    await rememberCodewords(TAB, FRAME, []);
    expect(await recallCodewords(TAB, FRAME)).toEqual([]);
  });

  it('upserts by fingerprint identity — same element updates, never duplicates', async () => {
    await rememberCodewords(TAB, FRAME, [entry('Projects', 'aa bb')]);
    await rememberCodewords(TAB, FRAME, [entry('Projects', 'cc dd')]);
    const recalled = await recallCodewords(TAB, FRAME);
    expect(recalled).toHaveLength(1);
    expect(recalled[0].codeword).toBe('cc dd');
  });

  it('isolates memory per frame', async () => {
    await rememberCodewords(TAB, 0, [entry('Top', 'aa bb')]);
    await rememberCodewords(TAB, 3127, [entry('Iframe', 'cc dd')]);
    expect((await recallCodewords(TAB, 0)).map(e => e.codeword)).toEqual(['aa bb']);
    expect((await recallCodewords(TAB, 3127)).map(e => e.codeword)).toEqual(['cc dd']);
  });

  it('LRU-evicts oldest beyond the per-frame cap', async () => {
    const overflow = 5;
    const all = Array.from({ length: MEMORY_CAP_PER_FRAME + overflow }, (_, i) =>
      entry(`e${i}`, `cw${i}`));
    await rememberCodewords(TAB, FRAME, all);
    const recalled = await recallCodewords(TAB, FRAME);
    expect(recalled).toHaveLength(MEMORY_CAP_PER_FRAME);
    // Oldest `overflow` evicted; newest cap survive.
    expect(recalled[0].codeword).toBe(`cw${overflow}`);
    expect(recalled[recalled.length - 1].codeword).toBe(`cw${MEMORY_CAP_PER_FRAME + overflow - 1}`);
  });

  it('re-remembering moves an entry to newest so it survives eviction', async () => {
    // Fill exactly to cap.
    const base = Array.from({ length: MEMORY_CAP_PER_FRAME }, (_, i) => entry(`e${i}`, `cw${i}`));
    await rememberCodewords(TAB, FRAME, base);
    // Touch the oldest (e0) → moves to newest.
    await rememberCodewords(TAB, FRAME, [entry('e0', 'cw0')]);
    // Add one new entry → overflow evicts the now-oldest (e1), not e0.
    await rememberCodewords(TAB, FRAME, [entry('eNew', 'cwNew')]);
    const codewords = (await recallCodewords(TAB, FRAME)).map(e => e.codeword);
    expect(codewords).toHaveLength(MEMORY_CAP_PER_FRAME);
    expect(codewords).toContain('cw0');     // touched → survived
    expect(codewords).not.toContain('cw1'); // now-oldest → evicted
    expect(codewords).toContain('cwNew');
  });

  it('remembers a full QuickBase-scale page without eviction (fix C)', async () => {
    // The old 200 cap evicted stable chrome on a ~655-element page; the raised
    // cap keeps the whole page so the sidebar survives across a reload.
    const n = 655;
    expect(n).toBeLessThanOrEqual(MEMORY_CAP_PER_FRAME);
    const all = Array.from({ length: n }, (_, i) => entry(`e${i}`, `cw${i}`));
    await rememberCodewords(TAB, FRAME, all);
    const recalled = await recallCodewords(TAB, FRAME);
    expect(recalled).toHaveLength(n); // nothing evicted — every element reclaimable
  });

  it('clears a single frame, leaving siblings intact', async () => {
    await rememberCodewords(TAB, 0, [entry('Top', 'aa bb')]);
    await rememberCodewords(TAB, 3127, [entry('Iframe', 'cc dd')]);
    await clearCodewordMemory(TAB, 0);
    expect(await recallCodewords(TAB, 0)).toEqual([]);
    expect(await recallCodewords(TAB, 3127)).toHaveLength(1);
  });

  it('clears every frame for a tab when frameId is omitted', async () => {
    await rememberCodewords(TAB, 0, [entry('Top', 'aa bb')]);
    await rememberCodewords(TAB, 3127, [entry('Iframe', 'cc dd')]);
    await rememberCodewords(99, 0, [entry('OtherTab', 'ee ff')]);
    await clearCodewordMemory(TAB);
    expect(await recallCodewords(TAB, 0)).toEqual([]);
    expect(await recallCodewords(TAB, 3127)).toEqual([]);
    expect(await recallCodewords(99, 0)).toHaveLength(1); // other tab untouched
  });

  it('serializes concurrent writes to the same frame — no lost update', async () => {
    // Two REMEMBER_CODEWORDS for the same (tab, frame) overlap (the steady-state
    // case: rememberClaimedCodewords fires per onCodewordsChanged flush). Without
    // per-frame serialization both load the same base array and the second set()
    // clobbers the first's addition. Each call carries a distinct fingerprint, so
    // a correct store keeps both.
    await Promise.all([
      rememberCodewords(TAB, FRAME, [entry('First', 'aa bb')]),
      rememberCodewords(TAB, FRAME, [entry('Second', 'cc dd')]),
    ]);
    const recalled = await recallCodewords(TAB, FRAME);
    expect(recalled.map(e => e.codeword).sort()).toEqual(['aa bb', 'cc dd']);
  });

  it('serializes a burst of concurrent writes — every distinct entry survives', async () => {
    const N = 12;
    await Promise.all(
      Array.from({ length: N }, (_, i) => rememberCodewords(TAB, FRAME, [entry(`e${i}`, `cw${i}`)])),
    );
    const recalled = await recallCodewords(TAB, FRAME);
    expect(recalled).toHaveLength(N);
    expect(new Set(recalled.map(e => e.codeword)).size).toBe(N);
  });
});
