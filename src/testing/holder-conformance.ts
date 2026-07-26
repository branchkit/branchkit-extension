/**
 * CodewordHolder conformance — the suite owns the invariants, the holder is
 * an input.
 * Design: notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md ("Testing
 * strategy", "Conformance suites").
 *
 * The workspace already runs this shape: sdk-test is a harness that owns the
 * SDK invariants and takes the participant binary as input, so a new SDK's
 * failure mode is "implement these handlers", not a silent wire drift. This
 * is the extension-side counterpart for holders. Every holder's test file
 * invokes describeCodewordHolderConformance with a factory; the registration
 * meta-test in labels/holder-registry.test.ts iterates the registered set so
 * a holder cannot skip the suite by not writing a test file — which is the
 * "failure mode is implement-these-methods" property the registry claims,
 * enforced rather than hoped.
 *
 * THE FACTORY CONTRACT: each call must
 *   - reset the holder registry (__resetHolderRegistry),
 *   - return a harness whose grant() makes the holder hold codewords, end to
 *     end: after grant(['ab']), held() yields 'ab' and resolve('ab') acts.
 *
 * Two LIVENESS MODELS, declared per participant (the suite's third arg):
 *   - 'ambient' (default): the holder exists and is registered EMPTY at
 *     factory return — the store's shape.
 *   - 'armed': registration IS liveness — the holder is born holding (a
 *     RangeBadgeSet registers when created with ranges and unregisters when
 *     it empties or disposes), so `harness.holder` exists only after the
 *     first grant, grant() arms (the suite grants at most once per test),
 *     and the suite additionally checks that dispose UNREGISTERS — the
 *     property that makes an exclusive holder in the list a live question.
 *
 * Codewords are word-form pool tokens; their letter form is the codeword
 * with spaces stripped (labels/words.ts), and prefixes are letter-form.
 * The suite grants single-token codewords so the two forms coincide and no
 * per-holder translation leaks into the invariants.
 *
 * What "republish is idempotent" can mean here: the suite has no wire to
 * watch, so it checks the half every holder shares — a second republish
 * leaves held() identical and throws nothing. The wire-level half (no
 * duplicate Puts) belongs to each holder's own tests, where the fake
 * transport lives.
 */

import { describe, it, expect } from 'vitest';
import {
  CodewordHolder, HolderOutcome, SETTLE_KINDS,
  holdersByPriority, registerHolder, resolveCodeword, anyHolderMatchesPrefix,
} from '../labels/holder-registry';

export interface HolderHarness {
  holder: CodewordHolder;
  /** Make the holder hold these codewords (fresh grants, not replacements). */
  grant(codewords: string[]): void;
}

export type HolderFactory = () => HolderHarness;

function heldSet(h: CodewordHolder): Set<string> {
  return new Set(h.held());
}

/**
 * A synthetic CodewordHolder for registry tests and for the suite's own
 * claim-contract probes. Exported so tests register SYNTHETIC PARTICIPANTS
 * instead of vi.mock-ing modules (design doc, "Synthetic participants
 * instead of vi.mock"). The log records every hook call so fan-out tests
 * assert delivery without spying.
 */
export interface SyntheticHolder extends HolderHarness {
  holder: CodewordHolder;
  log: string[];
  /** Mark a held codeword as off-screen: resolve refuses it. */
  markOffScreen(codeword: string): void;
}

export function makeSyntheticHolder(opts: {
  id: string;
  priority: number;
  claim: 'exclusive' | 'additive';
}): SyntheticHolder {
  const held = new Set<string>();
  const offScreen = new Set<string>();
  const log: string[] = [];
  let disposed = false;
  const letterForm = (cw: string) => cw.replace(/\s+/g, '');

  const holder: CodewordHolder = {
    id: opts.id,
    priority: opts.priority,
    claim: opts.claim,
    held: () => [...held],
    republish: () => { if (!disposed) log.push('republish'); },
    onCodewordRejected: (cw) => { log.push(`reject:${cw}`); held.delete(cw); },
    matchesPrefix: (prefix) => {
      if (disposed) return false;
      if (prefix === '') return held.size > 0;
      return [...held].some((cw) => letterForm(cw).startsWith(prefix));
    },
    narrow: (prefix) => { log.push(`narrow:${prefix}`); },
    resolve: (cw): HolderOutcome => {
      if (disposed || !held.has(cw)) return 'not_mine';
      if (offScreen.has(cw)) return 'off_screen';
      log.push(`acted:${cw}`);
      return 'acted';
    },
    soleMatch: (prefix) => {
      if (disposed || prefix === '') return null;
      const matches = [...held].filter((cw) => letterForm(cw).startsWith(prefix));
      return matches.length === 1 ? matches[0] : null;
    },
    reposition: () => { log.push('reposition'); },
    relabel: () => { log.push('relabel'); },
    reconcile: (settle) => { log.push(`reconcile:${settle}`); },
    dispose: (reason) => {
      if (disposed) return;
      disposed = true;
      held.clear();
      log.push(`dispose:${reason}`);
    },
  };

  return {
    holder,
    log,
    grant: (cws) => { for (const cw of cws) held.add(cw); },
    markOffScreen: (cw) => { offScreen.add(cw); },
  };
}

export interface ConformanceOpts {
  /** See the factory contract above. Default 'ambient'. */
  liveness?: 'ambient' | 'armed';
}

/**
 * The shared suite. Invariants every holder must pass, whatever it badges —
 * see the design doc's Testing strategy for the list this implements.
 */
export function describeCodewordHolderConformance(
  name: string, factory: HolderFactory, opts: ConformanceOpts = {},
): void {
  const armed = opts.liveness === 'armed';
  describe(`CodewordHolder conformance: ${name}`, () => {
    if (armed) {
      it('registration IS liveness: grant registers, dispose unregisters', () => {
        const h = factory();
        expect(holdersByPriority()).toHaveLength(0);
        h.grant(['ab']);
        expect(holdersByPriority()).toContain(h.holder);
        h.holder.dispose('conformance');
        expect(holdersByPriority()).not.toContain(h.holder);
      });
    } else {
      it('the factory registers the holder (registration is liveness)', () => {
        const h = factory();
        expect(holdersByPriority()).toContain(h.holder);
      });
    }

    it('held() reflects grants, at the holder\'s own bookkeeping', () => {
      const h = factory();
      if (!armed) expect(heldSet(h.holder).size).toBe(0);
      h.grant(['ab', 'ad']);
      expect(heldSet(h.holder)).toEqual(new Set(['ab', 'ad']));
    });

    it('resolve answers not_mine for a codeword it does not hold', () => {
      const h = factory();
      if (!armed) expect(h.holder.resolve('zz')).toBe('not_mine');
      h.grant(['ab']);
      expect(h.holder.resolve('zz')).toBe('not_mine');
    });

    it('resolve never disowns a codeword it still holds', () => {
      const h = factory();
      h.grant(['ab']);
      const out = h.holder.resolve('ab');
      // 'off_screen' is a legal refusal; 'not_mine' for a still-held codeword
      // is the drift the registry exists to kill (a live chip silently
      // unspeakable). A holder that declines-and-drops in one call (stale
      // ranges do) must be gone from held() by the time it answers.
      if (out === 'not_mine') expect(heldSet(h.holder).has('ab')).toBe(false);
      else expect(['acted', 'off_screen']).toContain(out);
    });

    it('republish is idempotent', () => {
      const h = factory();
      h.grant(['ab', 'ad']);
      const before = heldSet(h.holder);
      h.holder.republish();
      h.holder.republish();
      expect(heldSet(h.holder)).toEqual(before);
    });

    it('onCodewordRejected removes the codeword from held()', () => {
      const h = factory();
      h.grant(['ab', 'ad']);
      h.holder.onCodewordRejected('ab');
      expect(heldSet(h.holder).has('ab')).toBe(false);
      expect(heldSet(h.holder).has('ad')).toBe(true);
    });

    it('rejecting a codeword it never held is a safe no-op', () => {
      const h = factory();
      h.grant(['ab']);
      h.holder.onCodewordRejected('zz');
      expect(heldSet(h.holder)).toEqual(new Set(['ab']));
    });

    it('matchesPrefix and soleMatch agree with held()', () => {
      const h = factory();
      h.grant(['ab', 'ad']);
      expect(h.holder.matchesPrefix('a')).toBe(true);
      expect(h.holder.soleMatch('a')).toBe(null);       // two candidates
      expect(h.holder.matchesPrefix('ab')).toBe(true);
      expect(h.holder.soleMatch('ab')).toBe('ab');      // exactly one
      expect(h.holder.matchesPrefix('z')).toBe(false);
      expect(h.holder.soleMatch('z')).toBe(null);
      // The general half: a sole match is always a held, prefix-matching
      // codeword — soleMatch may be MORE conservative than this (the store
      // deliberately is, for ''), never less.
      const sole = h.holder.soleMatch('ab');
      if (sole !== null) {
        expect(heldSet(h.holder).has(sole)).toBe(true);
        expect(h.holder.matchesPrefix('ab')).toBe(true);
      }
    });

    it('narrow is visual: it never changes held(), and \'\' resets safely', () => {
      const h = factory();
      h.grant(['ab', 'ad']);
      const before = heldSet(h.holder);
      h.holder.narrow('a');
      h.holder.narrow('zz');
      h.holder.narrow('');
      expect(heldSet(h.holder)).toEqual(before);
    });

    it('reconcile is a safe no-op for EVERY SettleKind when nothing is live', () => {
      const h = factory();
      // The full closed enum, not a sampled kind — this is the point of the
      // discriminated hook (design doc, resolved question 3): every holder
      // receives every kind, so a new kind surfaces here, in the holder's
      // own conformance run, instead of as a silently unwired subscription.
      // For an armed holder "nothing is live" is the post-dispose state — the
      // sweeps still fan out to whatever they saw registered.
      if (armed) {
        h.grant(['ab']);
        h.holder.dispose('conformance');
      }
      for (const kind of SETTLE_KINDS) {
        h.holder.reconcile(kind);
        expect(heldSet(h.holder).size).toBe(0);
      }
    });

    it('dispose empties held() and is idempotent', () => {
      const h = factory();
      h.grant(['ab', 'ad']);
      h.holder.dispose('conformance');
      expect(heldSet(h.holder).size).toBe(0);
      h.holder.dispose('conformance_again');
      expect(heldSet(h.holder).size).toBe(0);
      // Post-dispose hooks must not resurrect or throw: sweeps fan out to
      // every registered holder and teardown ordering is not theirs to know.
      h.holder.republish();
      for (const kind of SETTLE_KINDS) h.holder.reconcile(kind);
      expect(heldSet(h.holder).size).toBe(0);
    });

    it('honours its claim contract against a lower-priority holder', () => {
      const h = factory();
      h.grant(['qq']); // live either way (an armed holder must exist to swallow)
      // A synthetic probe UNDER the participant that would act on 'zz'.
      const probe = makeSyntheticHolder({
        id: '__conformance_probe',
        priority: h.holder.priority - 1,
        claim: 'additive',
      });
      probe.grant(['zz']);
      registerHolder(probe.holder);

      if (h.holder.claim === 'exclusive') {
        // Swallow: while the exclusive holder is live (registered), a
        // codeword it does not hold reaches NOTHING below it.
        expect(resolveCodeword('zz')).toEqual({ kind: 'swallowed', holder: h.holder.id });
        expect(probe.log).not.toContain('acted:zz');
        // And the prefix gate answers alone.
        expect(anyHolderMatchesPrefix('z')).toBe(false);
      } else {
        // Fall-through: an additive holder claims only its own.
        expect(resolveCodeword('zz')).toEqual({ kind: 'acted', holder: probe.holder.id });
        expect(probe.log).toContain('acted:zz');
        expect(anyHolderMatchesPrefix('z')).toBe(true);
      }
    });
  });
}
