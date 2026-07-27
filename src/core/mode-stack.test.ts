/**
 * Mode stack — example tests, each one a review finding from
 * notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md driven through the
 * primitive instead of through the module seams that let it happen:
 *
 *   - interleaved push/pop restores floors (the entryFloor/restoreBadges
 *     class — "exit restores what was underneath", for every mode);
 *   - a find below a caret survives the caret's exit (finding #2, by
 *     construction, no findFloor field);
 *   - peelTop follows reverse push order (the five drifting escape lists);
 *   - peelInner consumes an escape without popping (the hint typed-prefix
 *     shape);
 *   - video: two entry paths, one push; two exit paths, one pop (the proof
 *     case — today two lifetimes in two processes with no shared state);
 *   - a failed mirror post stays re-emittable (the Wave 1 correction:
 *     clear-signal-survives, no early-out to swallow the retry).
 *
 * The conformance suite (testing/modespec-conformance.ts) runs here over the
 * REAL table, so a Wave 3 spec addition cannot skip it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  ModeStack, MODE_SPECS, clearInnerTransientProbes, setInnerTransientProbe,
  type MirrorEdge,
} from './mode-stack';
import { describeModeSpecConformance, RecordingSink } from '../testing/modespec-conformance';

describeModeSpecConformance('MODE_SPECS conformance (real table)', MODE_SPECS);

describe('ModeStack', () => {
  let sink: RecordingSink;
  let stack: ModeStack;

  beforeEach(() => {
    clearInnerTransientProbes();
    sink = new RecordingSink();
    stack = new ModeStack(MODE_SPECS, { post: (e) => sink.post(e) });
  });

  afterEach(() => {
    clearInnerTransientProbes();
    stack.reset();
  });

  describe('floors', () => {
    it('interleaved push/pop restores each recorded floor', () => {
      // The pick-window shape: hint mode up with badges visible, a range pick
      // lands on top carrying the visibility snapshot as payload.
      stack.push('hint');
      expect(stack.capture()).toBe('bare-keys');
      const entrySnapshot = { badgesVisible: true };
      stack.push('range_pick', entrySnapshot);
      expect(stack.top()).toBe('range_pick');

      const floor = stack.pop('range_pick');
      // Both halves come back: the mode underneath (the keyboard half the
      // lone restoreBadges boolean dropped) and the payload (the visual half).
      expect(floor).toEqual({ below: 'hint', payload: entrySnapshot });
      expect(stack.top()).toBe('hint');
      expect(stack.capture()).toBe('bare-keys');

      const hintFloor = stack.pop('hint');
      expect(hintFloor!.below).toBeNull();
      expect(stack.depth()).toBe(0);
      expect(stack.capture()).toBe('none');
    });

    it('a caret exit leaves a pre-existing find untouched (finding #2)', () => {
      // /quick Enter -> v -> y: find is the OLDER layer. Under the stack the
      // caret's exit pops only caret — no findFloor field, no closeFindMode
      // guard, the find entry simply was not the one popped.
      stack.push('find');
      stack.push('caret');
      stack.pop('caret');
      expect(stack.has('find')).toBe(true);
      expect(stack.top()).toBe('find');
    });

    it('a mid-stack exit excises only its own entry', () => {
      // The converse: find dies underneath a live caret session (blur closed
      // the bar). The caret entry above is undisturbed, capture stays its.
      stack.push('find');
      stack.push('caret');
      const floor = stack.pop('find');
      expect(floor!.below).toBeNull();
      expect(stack.ids()).toEqual(['caret']);
      expect(stack.capture()).toBe('bare-keys');
    });

    it('re-push joins the existing lifetime and keeps the first floor', () => {
      stack.push('hint');
      stack.push('video', { entered: 'key' });
      expect(stack.push('video', { entered: 'voice' })).toBe(false);
      const floor = stack.pop('video');
      expect(floor!.payload).toEqual({ entered: 'key' });
    });
  });

  describe('peelTop', () => {
    it('peels in reverse push order — temporal, not ranked', () => {
      stack.push('find');
      stack.push('caret');
      stack.push('range_pick');
      expect(stack.peelTop('over')).toEqual({ peeled: 'mode', id: 'range_pick', reason: 'over' });
      expect(stack.peelTop('over')).toEqual({ peeled: 'mode', id: 'caret', reason: 'over' });
      expect(stack.peelTop('over')).toEqual({ peeled: 'mode', id: 'find', reason: 'over' });
      expect(stack.peelTop('over')).toEqual({ peeled: 'none' });
    });

    it('asks the top entry peelInner first — the hint prefix shape', () => {
      // A typed prefix: the first escape abandons the letters, the second
      // leaves the mode. The transient lives with its owner (here a local),
      // the stack only asks.
      let prefix = 'ab';
      setInnerTransientProbe('hint', () => {
        if (prefix.length === 0) return null;
        prefix = '';
        return 'hint_prefix';
      });
      stack.push('hint');

      expect(stack.peelTop('key_escape')).toEqual({
        peeled: 'inner', name: 'hint_prefix', reason: 'key_escape',
      });
      expect(stack.top()).toBe('hint'); // consumed the escape, nothing popped
      expect(stack.peelTop('key_escape')).toEqual({
        peeled: 'mode', id: 'hint', reason: 'key_escape',
      });
      expect(stack.depth()).toBe(0);
    });

    it('a lower entry transient does not intercept the top layer escape', () => {
      // Only the TOP entry's peelInner is asked: a hint prefix must not eat
      // the escape aimed at a layer riding above it. Video is the example
      // because it declares no transient of its own — the pick USED to be, and
      // is now the deliberate exception (next test), since it types into the
      // very prefix this probe peels.
      setInnerTransientProbe('hint', () => 'hint_prefix');
      stack.push('hint');
      stack.push('video');
      expect(stack.peelTop('over')).toEqual({ peeled: 'mode', id: 'video', reason: 'over' });
    });

    it('a pick peels the typed prefix before itself — it shares hint\'s', () => {
      // Arming a pick enters hint mode so the chips are typable, so the letters
      // typed at a chip ARE the pick's transient. First escape abandons the
      // letters and the chips stay up (the user mistyped and wants another go);
      // only a second escape cancels the pick. Both ids register the SAME peel,
      // as production does (keyHandler.peelHintPrefix from two call sites) —
      // one prefix, so whichever spec is asked, the letters go exactly once.
      let prefix = 'a';
      const peel = () => {
        if (prefix.length === 0) return null;
        prefix = '';
        return 'hint_prefix';
      };
      setInnerTransientProbe('hint', peel);
      setInnerTransientProbe('range_pick', peel);
      stack.push('hint');
      stack.push('range_pick');

      expect(stack.peelTop('key_escape')).toEqual({
        peeled: 'inner', name: 'hint_prefix', reason: 'key_escape',
      });
      expect(stack.top()).toBe('range_pick');   // the pick survived the undo
      expect(stack.peelTop('key_escape')).toEqual({
        peeled: 'mode', id: 'range_pick', reason: 'key_escape',
      });
      expect(stack.top()).toBe('hint');         // and hint mode is still under it
    });
  });

  describe('video — the proof case', () => {
    it('both entry paths drive one push, both exits one pop', () => {
      const videoEdges = () => sink.calls.filter((c) => c.id === 'video');

      // Entry path 1: the `w` key. Entry path 2: the spoken "video". The
      // second joins — one lifetime, one mirror enter.
      expect(stack.push('video')).toBe(true);
      expect(stack.push('video')).toBe(false);
      expect(videoEdges()).toHaveLength(1);
      expect(videoEdges()[0]).toMatchObject({
        kind: 'enter', tag: 'plugin.browser.video_mode', exclusive: true,
      });

      // Exit path 1: Escape/q. Exit path 2: the forwarded voice "over". The
      // second finds nothing — one pop, one mirror exit.
      expect(stack.pop('video')).not.toBeNull();
      expect(stack.pop('video')).toBeNull();
      expect(videoEdges()).toHaveLength(2);
      expect(videoEdges()[1].kind).toBe('exit');
      expect(stack.mirrorSettled()).toBe(true);
    });
  });

  describe('mirror failure semantics', () => {
    it('a failed enter is pending, then emitted once on flush', () => {
      sink.fails = true;
      stack.push('caret');
      expect(sink.calls).toHaveLength(0);
      expect(stack.mirrorSettled()).toBe(false);

      sink.fails = false;
      stack.flushMirror();
      expect(sink.calls).toHaveLength(1);
      expect(sink.calls[0]).toMatchObject({ id: 'caret', kind: 'enter' });
      expect(stack.mirrorSettled()).toBe(true);

      // Settled means settled: another flush emits nothing.
      stack.flushMirror();
      expect(sink.calls).toHaveLength(1);
    });

    it('a failed exit survives until the sink confirms — the clear signal is never swallowed', () => {
      stack.push('caret');
      expect(sink.calls).toHaveLength(1);

      sink.fails = true;
      stack.pop('caret');
      // The stack is empty but the far side still believes the exclusive tag
      // is held. That state must be VISIBLE (mirrorSettled false), and the
      // clear must re-emit — the four hand-written mirrors lost exactly this
      // to their drain guards' early-outs.
      expect(stack.depth()).toBe(0);
      expect(stack.mirrorSettled()).toBe(false);

      sink.fails = false;
      stack.flushMirror();
      expect(sink.calls).toHaveLength(2);
      expect(sink.calls[1]).toMatchObject({ id: 'caret', kind: 'exit' });
      expect(stack.mirrorSettled()).toBe(true);
    });

    it('a later stack change retries the pending clear without being asked', () => {
      stack.push('caret');
      sink.fails = true;
      stack.pop('caret');
      sink.fails = false;

      // No explicit flush: pushing an unrelated, unmirrored mode drains the
      // pending exit as a side effect — retry piggybacks on any activity.
      stack.push('hint');
      expect(sink.calls.map((c) => `${c.id}:${c.kind}`)).toEqual(['caret:enter', 'caret:exit']);
      expect(stack.mirrorSettled()).toBe(true);
    });

    it('an enter that fails and then pops nets out — nothing to clear', () => {
      sink.fails = true;
      stack.push('palette');
      stack.pop('palette');
      sink.fails = false;
      stack.flushMirror();
      // The far side never took the enter, so no exit is owed.
      expect(sink.calls).toHaveLength(0);
      expect(stack.mirrorSettled()).toBe(true);
    });

    it('a throwing sink is a failed post, not an escape from pop', () => {
      const throwing = new ModeStack(MODE_SPECS, {
        post: () => { throw new Error('context invalidated'); },
      });
      throwing.push('caret');
      expect(throwing.mirrorSettled()).toBe(false); // the enter is pending
      expect(() => throwing.pop('caret')).not.toThrow();
      expect(throwing.depth()).toBe(0);
      // The far side never took the enter, so the pop nets the pair out —
      // settled, with nothing owed in either direction.
      expect(throwing.mirrorSettled()).toBe(true);
    });
  });

  describe('edges carry the frame snapshot', () => {
    it('each post reports the stack state after the change', () => {
      const snapshots: (readonly string[])[] = [];
      const s = new ModeStack(MODE_SPECS, {
        post: (e: MirrorEdge) => { snapshots.push(e.stack); return true; },
      });
      s.push('find');
      s.push('caret');
      s.pop('find');
      s.pop('caret');
      expect(snapshots).toEqual([
        ['find'],           // find enter
        ['find', 'caret'],  // caret enter
        ['caret'],          // find exit (mid-stack pop)
        [],                 // caret exit
      ]);
    });
  });

  describe('capture', () => {
    it('is the top entry state, and none when empty', () => {
      expect(stack.capture()).toBe('none');
      stack.push('caret');
      expect(stack.capture()).toBe('bare-keys');
      stack.push('find');
      expect(stack.capture()).toBe('none'); // find's input owns keys, not the page capture
      stack.pop('find');
      expect(stack.capture()).toBe('bare-keys');
      stack.pop('caret');
      expect(stack.capture()).toBe('none');
    });
  });

  describe('guard rails', () => {
    it('rejects an unknown mode id and a duplicate spec table', () => {
      expect(() => stack.push('bogus' as never)).toThrow(/unknown mode/);
      expect(() => new ModeStack([...MODE_SPECS, MODE_SPECS[0]], sink)).toThrow(/duplicate/);
    });
  });
});
