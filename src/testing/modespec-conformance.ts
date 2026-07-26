/**
 * ModeSpec conformance — the sdk-test pattern in vitest: the suite owns the
 * invariants, the table supplies the participants. Invoked over the REAL
 * MODE_SPECS table (mode-stack.test.ts does), so registration IS the trigger:
 * a Wave 3 entry added to the table gets every block below without anyone
 * writing a test file, which is the "failure mode is implement-these-methods"
 * property the design claims — enforced rather than hoped. Design:
 * notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md, "Testing strategy".
 *
 * What every entry must satisfy, each one a review finding stated as a check:
 *
 *   - an EXPLICIT mirror decision (null allowed; the recorded reason is a
 *     comment the D2 lint reads — here we check the field exists, because a
 *     forgotten field is how caret got a mirror and video didn't);
 *   - push then pop restores the previous top, the capture state, and the
 *     recorded floor (the entryFloor/restoreBadges class: floors for every
 *     mode, not for the two that grew them by hand);
 *   - a mirrored spec emits exactly ONE sink transition per edge — the
 *     dedupe-vs-drop failure in both directions — and an unmirrored spec
 *     emits none;
 *   - a peelable spec is what peelTop pops;
 *   - peelInner, when present, consumes the escape WITHOUT popping — the
 *     floor bookkeeping cannot be bypassed by a stage peel.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ModeStack, clearInnerTransientProbes, setInnerTransientProbe,
  type MirrorEdge, type ModeSpec,
} from '../core/mode-stack';

/** A synthetic sink that records every edge and can be told to fail — the
 *  suite's stand-in for the C4 transport, per the design's "synthetic
 *  participants instead of vi.mock". */
export class RecordingSink {
  calls: MirrorEdge[] = [];
  fails = false;
  post(edge: MirrorEdge): boolean {
    if (this.fails) return false;
    this.calls.push(edge);
    return true;
  }
}

export function describeModeSpecConformance(
  suiteName: string,
  specs: readonly ModeSpec[],
): void {
  describe(suiteName, () => {
    it('table has entries and unique ids', () => {
      expect(specs.length).toBeGreaterThan(0);
      expect(new Set(specs.map((s) => s.id)).size).toBe(specs.length);
    });

    for (const spec of specs) {
      describe(`spec: ${spec.id}`, () => {
        let sink: RecordingSink;
        let stack: ModeStack;
        // A base layer from the table itself, so the floor checks exercise a
        // real neighbor rather than a synthetic one. Undefined only if the
        // table ever shrinks to one entry.
        const base = specs.find((s) => s.id !== spec.id);

        beforeEach(() => {
          clearInnerTransientProbes();
          sink = new RecordingSink();
          stack = new ModeStack(specs, { post: (e) => sink.post(e) });
        });

        afterEach(() => {
          clearInnerTransientProbes();
        });

        it('declares an explicit mirror decision', () => {
          // null is allowed — it is a decision with a recorded reason — but
          // the FIELD must be present. An entry that omits it would compile
          // if the interface made mirror optional; the table type does not,
          // and this pins it at runtime for good measure.
          expect(Object.prototype.hasOwnProperty.call(spec, 'mirror')).toBe(true);
          if (spec.mirror !== null) {
            expect(spec.mirror.tag).toMatch(/^plugin\./);
            expect(typeof spec.mirror.exclusive).toBe('boolean');
            expect(spec.mirror.speaker).toBe('any-frame');
          }
        });

        it('push then pop restores the previous top, capture, and floor', () => {
          if (base) stack.push(base.id);
          const prevTop = stack.top();
          const prevCapture = stack.capture();
          const payload = { sentinel: `floor-${spec.id}` };

          expect(stack.push(spec.id, payload)).toBe(true);
          expect(stack.top()).toBe(spec.id);
          expect(stack.capture()).toBe(spec.capture);

          const floor = stack.pop(spec.id);
          expect(floor).not.toBeNull();
          expect(floor!.below).toBe(prevTop);
          expect(floor!.payload).toBe(payload);
          expect(stack.top()).toBe(prevTop);
          expect(stack.capture()).toBe(prevCapture);
        });

        if (spec.mirror) {
          it('emits exactly one sink transition per edge', () => {
            const mine = () => sink.calls.filter((c) => c.id === spec.id);

            stack.push(spec.id);
            expect(mine()).toHaveLength(1);
            expect(mine()[0].kind).toBe('enter');
            expect(mine()[0].tag).toBe(spec.mirror!.tag);
            expect(mine()[0].exclusive).toBe(spec.mirror!.exclusive);

            // Joining the existing lifetime (the second entry path) is not an
            // edge — the video proof case generalized to every mirrored mode.
            expect(stack.push(spec.id)).toBe(false);
            expect(mine()).toHaveLength(1);

            stack.pop(spec.id);
            expect(mine()).toHaveLength(2);
            expect(mine()[1].kind).toBe('exit');

            // The mode is gone; popping again is not an edge either.
            expect(stack.pop(spec.id)).toBeNull();
            expect(mine()).toHaveLength(2);
            expect(stack.mirrorSettled()).toBe(true);
          });

          it('a failed sink leaves the transition re-emittable', () => {
            sink.fails = true;
            stack.push(spec.id);
            expect(stack.mirrorSettled()).toBe(false);
            sink.fails = false;
            stack.flushMirror();
            expect(stack.mirrorSettled()).toBe(true);
            expect(sink.calls.filter((c) => c.id === spec.id)).toHaveLength(1);
          });
        } else {
          it('emits no sink transitions (mirror: null is extension-only)', () => {
            stack.push(spec.id);
            stack.pop(spec.id);
            expect(sink.calls.filter((c) => c.id === spec.id)).toHaveLength(0);
            expect(stack.mirrorSettled()).toBe(true);
          });
        }

        if (spec.peelable) {
          it('is peeled by peelTop', () => {
            stack.push(spec.id);
            const r = stack.peelTop('conformance');
            expect(r).toEqual({ peeled: 'mode', id: spec.id, reason: 'conformance' });
            expect(stack.has(spec.id)).toBe(false);
          });
        } else {
          it('is stepped over by peelTop, never popped (escape cannot reach it here)', () => {
            stack.push(spec.id);
            const r = stack.peelTop('conformance');
            expect(r).toEqual({ peeled: 'none' });
            expect(stack.has(spec.id)).toBe(true);
          });
        }

        if (spec.peelInner) {
          it('peelInner consumes the escape without popping', () => {
            let armed = true;
            setInnerTransientProbe(spec.id, () => {
              if (!armed) return null;
              armed = false;
              return 'transient';
            });
            stack.push(spec.id);
            const before = stack.depth();

            const first = stack.peelTop('conformance');
            expect(first).toEqual({ peeled: 'inner', name: 'transient', reason: 'conformance' });
            expect(stack.depth()).toBe(before);
            expect(stack.top()).toBe(spec.id);

            // Transient gone — the next escape pops the mode itself.
            const second = stack.peelTop('conformance');
            expect(second).toEqual({ peeled: 'mode', id: spec.id, reason: 'conformance' });
          });
        }
      });
    }
  });
}
