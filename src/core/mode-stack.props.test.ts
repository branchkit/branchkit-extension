/**
 * Mode stack — model-based property suite (fast-check, per the design doc's
 * "Property-based invariants"). Random op sequences over
 * {push, pop, peelTop, mirror-rpc-fails, flush} x the REAL MODE_SPECS table,
 * checked after every op against a trivially-correct model: a plain array of
 * entries plus a set of expected far-side tags. Shrinking is the point — a
 * 40-op counterexample arrives as the 3-op core that breaks the invariant.
 *
 * The headline property is the last one: NO op sequence leaves an exclusive
 * tag asserted with the stack empty — including sequences where the sink
 * fails. A stuck exclusive tag suppresses every command system-wide (the
 * matcher's Layer 2 filters on it), which is the worst failure this
 * architecture can produce; the invariant under failure is the Wave 1
 * correction's clear-signal-survives form — a failed transition leaves the
 * derivation re-emittable and VISIBLY unsettled, never silently swallowed.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  ModeStack, MODE_SPECS, type MirrorEdge, type ModeId,
} from './mode-stack';

const MODE_IDS = MODE_SPECS.map((s) => s.id);
const specOf = (id: ModeId) => MODE_SPECS.find((s) => s.id === id)!;
const tagOf = (id: ModeId) => specOf(id).mirror?.tag ?? null;
const EXCLUSIVE_TAGS = new Set(
  MODE_SPECS.filter((s) => s.mirror?.exclusive).map((s) => s.mirror!.tag),
);

type Op =
  | { op: 'push'; id: ModeId; token: number }
  | { op: 'pop'; id: ModeId }
  | { op: 'peel' }
  | { op: 'sink'; fails: boolean }
  | { op: 'flush' };

const pushArb = fc.record({
  op: fc.constant<'push'>('push'), id: fc.constantFrom(...MODE_IDS), token: fc.nat(),
});
const popArb = fc.record({ op: fc.constant<'pop'>('pop'), id: fc.constantFrom(...MODE_IDS) });
const peelArb = fc.record({ op: fc.constant<'peel'>('peel') });
const sinkArb = fc.record({ op: fc.constant<'sink'>('sink'), fails: fc.boolean() });
const flushArb = fc.record({ op: fc.constant<'flush'>('flush') });

/** The healthy alphabet: the sink never fails, so every edge drains at once
 *  and sink-call counting is exact. */
const healthyOps = fc.array(
  fc.oneof(pushArb, pushArb, popArb, peelArb, flushArb), { maxLength: 60 },
);
/** The full alphabet, failures included. */
const faultyOps = fc.array(
  fc.oneof(pushArb, pushArb, popArb, peelArb, sinkArb, flushArb), { maxLength: 60 },
);

/** The trivially-correct model: a plain array (each entry remembering the
 *  floor recorded at its push) and the mirror bookkeeping the drain implies —
 *  with a globally failing sink a drain changes nothing, with a healthy one
 *  it reconciles completely, so the model needs no queue. */
interface ModelEntry { id: ModeId; token: number; below: ModeId | null }
class Model {
  arr: ModelEntry[] = [];
  confirmed = new Set<ModeId>();
  fails = false;
  edges = 0;

  private desired(): Set<ModeId> {
    return new Set(this.arr.filter((e) => specOf(e.id).mirror).map((e) => e.id));
  }
  drain(): void {
    if (this.fails) return;
    this.confirmed = this.desired();
  }
  push(id: ModeId, token: number): void {
    if (this.arr.some((e) => e.id === id)) return;
    const below = this.arr.length ? this.arr[this.arr.length - 1].id : null;
    this.arr.push({ id, token, below });
    if (specOf(id).mirror) this.edges++;
    this.drain();
  }
  pop(id: ModeId): ModelEntry | null {
    for (let i = this.arr.length - 1; i >= 0; i--) {
      if (this.arr[i].id !== id) continue;
      const [e] = this.arr.splice(i, 1);
      if (specOf(id).mirror) this.edges++;
      this.drain();
      return e;
    }
    return null;
  }
  peel(): ModeId | null {
    // No probes installed: peelTop pops the newest PEELABLE entry, stepping
    // over non-peelable ones (the palette, whose escape lives in its own
    // focused document — see MODE_SPECS).
    for (let i = this.arr.length - 1; i >= 0; i--) {
      const id = this.arr[i].id;
      if (!specOf(id).peelable) continue;
      return this.pop(id)!.id;
    }
    return null;
  }
  settled(): boolean {
    const d = this.desired();
    if (d.size !== this.confirmed.size) return false;
    for (const id of d) if (!this.confirmed.has(id)) return false;
    return true;
  }
  top(): ModeId | null {
    return this.arr.length ? this.arr[this.arr.length - 1].id : null;
  }
}

/** The synthetic far side: holds the tags whose enter it has taken. This is
 *  the observed truth the headline property is about. */
class FarSide {
  tags = new Set<string>();
  calls: MirrorEdge[] = [];
  fails = false;
  post(edge: MirrorEdge): boolean {
    if (this.fails) return false;
    this.calls.push(edge);
    if (edge.kind === 'enter') this.tags.add(edge.tag);
    else this.tags.delete(edge.tag);
    return true;
  }
}

interface World { stack: ModeStack; model: Model; far: FarSide }

function makeWorld(): World {
  const far = new FarSide();
  return { stack: new ModeStack(MODE_SPECS, { post: (e) => far.post(e) }), model: new Model(), far };
}

/** Apply one op to both sides; return the pop results for floor checking. */
function step(w: World, op: Op): void {
  switch (op.op) {
    case 'push':
      w.stack.push(op.id, op.token);
      w.model.push(op.id, op.token);
      break;
    case 'pop': {
      const floor = w.stack.pop(op.id);
      const expected = w.model.pop(op.id);
      if (expected === null) {
        expect(floor).toBeNull();
      } else {
        // pop restores the recorded floor — the entry's below and payload as
        // remembered at PUSH time, however much churn happened in between.
        expect(floor).toEqual({ below: expected.below, payload: expected.token });
      }
      break;
    }
    case 'peel': {
      const r = w.stack.peelTop('prop');
      const expected = w.model.peel();
      if (expected === null) expect(r).toEqual({ peeled: 'none' });
      else expect(r).toEqual({ peeled: 'mode', id: expected, reason: 'prop' });
      break;
    }
    case 'sink':
      w.far.fails = op.fails;
      w.model.fails = op.fails;
      break;
    case 'flush':
      w.stack.flushMirror();
      w.model.drain();
      break;
  }
}

/** The per-step correspondence: stack, top, capture, settledness, and the
 *  far side all match the model after EVERY op. */
function checkInvariants(w: World): void {
  expect(w.stack.ids()).toEqual(w.model.arr.map((e) => e.id));
  expect(w.stack.top()).toBe(w.model.top());
  const t = w.model.top();
  expect(w.stack.capture()).toBe(t ? specOf(t).capture : 'none');
  expect(w.stack.mirrorSettled()).toBe(w.model.settled());
  expect([...w.far.tags].sort()).toEqual(
    [...w.model.confirmed].map((id) => tagOf(id)!).sort(),
  );
  // Re-emittability, stated as visibility: whenever the far side disagrees
  // with the stack about a mirrored mode, the stack must SAY so — a pending
  // transition is never reported settled. This is what forbids the silent
  // swallow: recovery is always one flush away and the need for it readable.
  for (const s of MODE_SPECS) {
    if (!s.mirror) continue;
    if (w.far.tags.has(s.mirror.tag) !== w.stack.has(s.id)) {
      expect(w.stack.mirrorSettled()).toBe(false);
    }
  }
}

describe('ModeStack properties', () => {
  it('peelTop pops the PEELABLE entries in strict reverse push order', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.constantFrom(...MODE_IDS)), (ids) => {
        const w = makeWorld();
        for (const id of ids) w.stack.push(id);
        const peeled: ModeId[] = [];
        for (;;) {
          const r = w.stack.peelTop('prop');
          if (r.peeled === 'none') break;
          if (r.peeled === 'mode') peeled.push(r.id);
        }
        // Non-peelable specs (the palette) are stepped over, never popped —
        // escape closes what escape may close; their own exit pops them.
        const peelable = (id: ModeId) => specOf(id).peelable;
        expect(peeled).toEqual([...ids].reverse().filter(peelable));
        expect(w.stack.depth()).toBe(ids.filter((id) => !peelable(id)).length);
      }),
    );
  });

  it('every op preserves the model correspondence (top, capture, floors, mirror set)', () => {
    fc.assert(
      fc.property(faultyOps, (ops) => {
        const w = makeWorld();
        for (const op of ops) {
          step(w, op);
          checkInvariants(w);
        }
      }),
    );
  });

  it('a mirrored mode emits exactly one transition per edge (healthy sink)', () => {
    fc.assert(
      fc.property(healthyOps, (ops) => {
        const w = makeWorld();
        for (const op of ops) {
          step(w, op);
          // With a sink that never fails, every drain settles immediately, so
          // the sink call count IS the edge count — one call per mirrored
          // enter/exit, none for joins, none for absent pops, none for
          // flushes with nothing pending. Over-emission (a re-assert on join)
          // and under-emission (a dropped exit) both break this equality.
          expect(w.far.calls.length).toBe(w.model.edges);
        }
      }),
    );
  });

  it('no op sequence strands an exclusive tag — even through sink failures', () => {
    fc.assert(
      fc.property(faultyOps, (ops) => {
        const w = makeWorld();
        for (const op of ops) step(w, op);
        // The user escapes out of everything, the transport comes back, one
        // flush runs (or any later stack activity — same drain). If ANY
        // exclusive tag survives this, every command system-wide is
        // suppressed by Layer 2 and the product is dead until restart.
        // Escape drains only the PEELABLE entries; a non-peelable mode (the
        // palette) exits by its own close, which is a pop.
        for (;;) {
          const before = w.stack.depth();
          step(w, { op: 'peel' });
          if (w.stack.depth() === before) break; // nothing peelable remains
        }
        for (const id of [...w.stack.ids()].reverse()) {
          step(w, { op: 'pop', id });
        }
        step(w, { op: 'sink', fails: false });
        step(w, { op: 'flush' });
        checkInvariants(w);
        expect(w.stack.mirrorSettled()).toBe(true);
        for (const tag of w.far.tags) {
          expect(EXCLUSIVE_TAGS.has(tag)).toBe(false);
        }
        expect(w.far.tags.size).toBe(0);
      }),
    );
  });
});
