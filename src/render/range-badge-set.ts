/**
 * A set of codeword badges anchored to text Ranges, with a rolling viewport
 * window.
 *
 * This is the reusable half of what "highlight <phrase>" built: N badges over
 * N ranges, claiming from the shared codeword pool, converging on the viewport
 * as the user scrolls, following their text through layout shifts, and cleaning
 * up after themselves. The range-pick disambiguation question
 * (activate/range-disambiguation.ts) is one POLICY on top of it; search-match
 * badges are the next. Policy — hiding the page's own badges, owning every
 * codeword, narrowing the Discovery HUD, what a pick MEANS — stays with the
 * owner, because those differ per feature and search wants almost none of them.
 *
 * What lives here is everything that would otherwise be copied:
 *
 *   - band membership via the SHARED planner (lifecycle/band-window.ts) — the
 *     same derivation the link badges claim by, so scarce codewords land
 *     nearest-the-viewport-first rather than in document order;
 *   - the two cuts: the BAND decides who wears a badge (pre-claiming past the
 *     fold is what makes one already painted when you scroll to it), the STRICT
 *     viewport decides who is speakable;
 *   - codeword stability across the window — a badge you are mid-way through
 *     saying does not get renamed — via release-before-claim;
 *   - liveness: a Range never rebinds, so a set reaps its own dead;
 *   - CodewordHolder registration (labels/holder-registry.ts), without which
 *     the registry-driven lifecycle sweeps treat these codewords as garbage
 *     and the two input paths cannot reach them.
 *
 * The registered holder is the set's mechanism plus the owner's POLICY,
 * declared in `options.holder`: id/priority/claim name the holder's rank in
 * the registry's order (a pick is exclusive and swallows, search is additive
 * and falls through), `resolve` is what acting on a member MEANS (answer the
 * pick vs jump to the match), and `reconcile` may wrap the set's own settle
 * sweep with owner liveness (search clears itself when the find session died
 * without a deactivate). Registration is liveness: the holder registers when
 * the set is born holding and unregisters when it empties or disposes, which
 * is what makes an exclusive holder in the list a live question.
 *
 * Multiple sets can be live at once; nothing here is a singleton. Each owns its
 * codewords and its holder registration, and `dispose()` gives both back.
 */

import { HintBadge } from './hints';
import { rangeTarget } from './badge-target';
import type { BadgeVariant } from './badge-variant';
import { placeBadgeAtRect } from '../placement/position';
import { isAncestorChainInVisibleViewport } from '../lifecycle/strict-viewport';
import { type BandCandidate, bandOverhang, planBandWindow } from '../lifecycle/band-window';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { labelReservoir } from '../labels/label-reservoir';
import { exactCodewordMatch } from '../labels/codeword-typing';
import { poolLabelToAssignment, isVoiceAlphabetLoaded, type LabelAssignment } from '../labels/words';
import { publishRecords, retireRecords, cancelPendingDelete } from '../labels/label-sync';
import {
  registerHolder, type CodewordHolder, type HolderOutcome, type SettleKind,
} from '../labels/holder-registry';
import { getDisplayMode } from '../config';
import { bkLog } from '../debug/bk-log';
import type { ScannedElement } from '../types';

/** One member: the range it answers for, its badge, and the label the prefix
 *  filter tests against (kept rather than re-derived on every progress event). */
interface Member {
  range: Range;
  badge: HintBadge;
  label: LabelAssignment;
  /** The `in_strict_viewport` value last published. Mirrors
   *  ElementWrapper.lastSentStrictViewport: eligibility is re-sent only when a
   *  badge crosses the screen edge, not on every scroll. */
  strict: boolean;
  /** Is this record live plugin-side, or at least on its way? Set optimistically
   *  when a publish goes out and cleared again if that publish didn't admit it,
   *  so `false` is exactly the set that needs a retry — a badge painted and
   *  typeable but with no grammar entry (no voice alphabet, transport failure,
   *  plugin refusal). Reconcile retries those, the way the element path's
   *  `queuePut` does. Optimism is what keeps a reconcile that re-mints a
   *  codeword from publishing it twice in the same pass. */
  published: boolean;
}

/** The owner's half of the registered holder — see the module header. */
export interface RangeHolderSpec {
  /** Names the holder in outcomes and dispatch reporting ('pick', 'search'). */
  id: string;
  /** Rank in the registry's order. Above AMBIENT_PRIORITY, or the input
   *  paths' above-ambient consult can't reach the set. */
  priority: number;
  /** 'exclusive' swallows every codeword while the set is live (the pick);
   *  'additive' claims only its own and falls through (search). */
  claim: 'exclusive' | 'additive';
  /** What acting on a codeword MEANS. Called for every offer the registry
   *  routes here, held or not — the owner's policy already answers
   *  'not_mine' for strangers, and may drop-and-decline a stale member
   *  (dropping it from held() in the same call, per the holder contract). */
  resolve(codeword: string): HolderOutcome;
  /** Owner wrapper around the set's settle sweep. Default: reconcile on
   *  'general' only — every settle lands a 'general' from the same pass, and
   *  the supplemental 'scroll' that follows it would be pure rework. */
  reconcile?(settle: SettleKind): void;
  /** Owner teardown policy for the registry's dispose fan-out (the orphan-CS
   *  path). Default: the set's own dispose — right for an overlay with no
   *  state beyond the set. An owner with module state around it (the pick's
   *  pending question and plugin-side narrow, search's session binding)
   *  routes its full cancel here so a registry dispose cannot leave a
   *  zombie policy behind a disposed set. */
  dispose?(reason: string): void;
}

export interface RangeBadgeSetOptions {
  /** EVERY match, not just the badged ones — membership is a rolling window
   *  over this list, so the full set has to outlive the initial claim. */
  ranges: Range[];
  variant: BadgeVariant;
  /** The owner's holder policy; registration itself is the set's. */
  holder: RangeHolderSpec;
  /** Most badges to hold at once. A promise, not a target: the planner is
   *  asked to hard-cap, because the common case is a dozen matches all on
   *  screen at overhang 0, where band-tightening has nothing to separate them
   *  by. */
  budget: number;
  /** The live codeword set changed (claimed, dropped, reaped or rejected).
   *  Owners maintaining a projection re-arm it here. */
  onMembershipChanged?: (codewords: string[]) => void;
  /** The set emptied itself and disposed. `reason` is for logs/toasts. */
  onEmpty?: (reason: string) => void;
  /** Tag for the bkLog breadcrumbs, so two live sets are distinguishable. */
  logTag?: string;
}

export class RangeBadgeSet {
  private readonly members = new Map<string, Member>();
  private readonly opts: RangeBadgeSetOptions;
  private readonly unregisterHolder: () => void;
  /** The registered CodewordHolder this set answers as (mechanism here,
   *  policy from opts.holder). Exposed for the conformance harness. */
  readonly holder: CodewordHolder;
  private disposed = false;

  /**
   * Claim, paint and publish an initial window. Returns null when nothing could
   * be badged — no match within a band of the viewport, or the codeword pool is
   * dry. The caller decides what that means: a pick acts on the first match
   * instead of arming a question the user can neither see nor say.
   */
  static create(opts: RangeBadgeSetOptions): RangeBadgeSet | null {
    const set = new RangeBadgeSet(opts);
    const { plan, isStrict } = set.plan(new Set());
    if (plan.toClaim.length === 0) {
      set.unregisterHolder();
      return null;
    }
    if (set.add(plan.toClaim, isStrict) === 0) {
      set.unregisterHolder();
      return null;
    }
    bkLog(`${set.tag}_START`, {
      matches: opts.ranges.length, inBand: plan.toClaim.length,
      badged: set.members.size, margin: plan.margin,
    });
    return set;
  }

  private constructor(opts: RangeBadgeSetOptions) {
    this.opts = opts;
    // Without this the codewords are invisible to every registry-driven
    // sweep: the reservoir's leak sweep reclaims them after 30s, session
    // rotation drops them plugin-side, a pool rejection is ignored — and
    // neither input path can act on them. Mechanism is the set's, policy is
    // the owner's (see RangeHolderSpec).
    const spec = opts.holder;
    this.holder = {
      id: spec.id,
      priority: spec.priority,
      claim: spec.claim,
      held: () => this.members.keys(),
      republish: () => this.republishAll(),
      onCodewordRejected: (cw) => this.onRejected(cw),
      matchesPrefix: (prefix) => this.matchesPrefix(prefix),
      narrow: (prefix) => this.filterByPrefix(prefix),
      resolve: (cw) => spec.resolve(cw),
      soleMatch: (prefix) => this.soleMatch(prefix),
      reposition: () => this.reposition(),
      relabel: () => this.relabel(),
      reconcile: (settle) => {
        if (spec.reconcile) spec.reconcile(settle);
        // Default self-selection: 'general' fires at the tail of EVERY settle
        // pass; the 'scroll' kind arrives immediately after a 'general' from
        // the same pass, so reconciling on it too would be pure rework.
        else if (settle === 'general') this.reconcile();
      },
      dispose: (reason) => {
        if (spec.dispose) spec.dispose(reason);
        else this.dispose(reason);
      },
    };
    this.unregisterHolder = registerHolder(this.holder);
  }

  private get tag(): string {
    return this.opts.logTag ?? 'BK_RANGE_BADGES';
  }

  get size(): number {
    return this.members.size;
  }

  get codewords(): string[] {
    return [...this.members.keys()];
  }

  has(codeword: string): boolean {
    return this.members.has(codeword);
  }

  /** The range a codeword names, or null. */
  rangeFor(codeword: string): Range | null {
    return this.members.get(codeword)?.range ?? null;
  }

  /**
   * Is this codeword's text on screen RIGHT NOW?
   *
   * Read live rather than from the published `strict` flag: that only refreshes
   * on reconcile, and a dispatch can land mid-scroll. Callers gate activation
   * on this — the band paints past the fold, so a badge can hold a codeword the
   * user has never read, and acting on it would be acting on something they
   * can't see.
   */
  isOnScreen(codeword: string): boolean {
    const range = this.rangeFor(codeword);
    return range !== null && isRangeOnScreen(range);
  }

  /**
   * Mid-codeword progress: badges that can't complete `prefix` are marked
   * non-candidates, the rest show their spoken prefix. The variant decides how
   * each reads. `''` resets.
   */
  /**
   * Does any member's codeword start with `prefix`?
   *
   * The keyboard asks before accepting a keystroke: a letter no painted badge
   * can complete is a stray key, not the start of a codeword. The wrapper store
   * answers this for link hints; holders outside it must answer for themselves
   * or they stay invisible to the keyboard.
   */
  matchesPrefix(prefix: string): boolean {
    if (prefix === '') return this.members.size > 0;
    for (const { label } of this.members.values()) {
      if (label.letter.startsWith(prefix)) return true;
    }
    return false;
  }

  /** Fires on the WHOLE painted codeword — the one typing rule, shared with
   *  the element store (labels/codeword-typing.ts). Narrowing stays local and
   *  prefix-based (filterByPrefix), so the set still converges as you type. */
  soleMatch(prefix: string): string | null {
    return exactCodewordMatch(
      (function* (members) {
        for (const [codeword, { label }] of members) yield [codeword, label.letter] as const;
      }(this.members)),
      prefix,
    );
  }

  filterByPrefix(prefix: string): void {
    for (const { badge, label } of this.members.values()) {
      const matches = prefix !== '' && label.letter.startsWith(prefix);
      badge.setFiltered(prefix !== '' && !matches);
      // Arbitrary prefix lengths and every display mode, inherited — no
      // charAt(0) special case for exactly two words.
      badge.setMatchedChars(matches ? prefix.length : 0);
    }
  }

  /** Re-place every badge against its range's live rect (the holder
   *  geometry hook; the settle-driven positioner pass handles steady-state,
   *  so this is the explicit re-place for sweeps that ask for one). */
  reposition(): void {
    if (this.disposed) return;
    for (const m of this.members.values()) {
      const target = rangeTarget(m.range);
      placeBadgeAtRect(m.badge, target.element, target.rect());
    }
  }

  /** Re-render badge text after an alphabet or display-mode change. Letters
   *  (and so prefix matching) are unchanged — the alphabet maps letters to
   *  spoken words, so only word/expand-mode text moves. The store-only loop
   *  this bridges left chips wearing the old alphabet's words after a swap. */
  relabel(): void {
    if (this.disposed) return;
    for (const [cw, m] of this.members) {
      m.label = poolLabelToAssignment(cw);
      m.badge.updateLabel(m.label, getDisplayMode());
    }
  }

  /**
   * Re-derive membership against the viewport, reap dead ranges, and re-publish
   * eligibility for anything that crossed the screen edge.
   *
   * Owners drive this from a signal that already exists (the settle engine's
   * afterScrollSettle) rather than adding one.
   */
  reconcile(): void {
    if (this.disposed) return;
    if (this.reapDead()) return; // emptied and disposed
    const { plan, isStrict } = this.plan(new Set(
      [...this.members.values()].map((m) => m.range)));

    // Nothing would remain in band: keep what's painted rather than going to
    // zero. An owner that swallows codewords while live depends on there being
    // something on screen to explain itself; scrolling back restores these
    // anyway.
    const wouldEmpty = plan.toKeep.length === 0 && plan.toClaim.length === 0;
    if ((plan.toClaim.length > 0 || plan.toDrop.length > 0) && !wouldEmpty) {
      // Release BEFORE claiming so arrivals can reclaim the very codewords that
      // just left (the reservoir returns them to the front) — that recycling is
      // what keeps a badge from being renamed mid-utterance.
      if (plan.toDrop.length > 0) {
        this.drop(new Set(plan.toDrop));
      }
      const added = this.add(plan.toClaim, isStrict);
      if (this.members.size === 0) {
        this.empty('reconcile_empty');
        return;
      }
      bkLog(`${this.tag}_RECONCILE`, {
        dropped: plan.toDrop.length, added, live: this.members.size, margin: plan.margin,
      });
      // An add re-arms membership once its records land (see `add`); a pure
      // departure has no publish to ride, so notify now.
      if (added === 0) this.opts.onMembershipChanged?.(this.codewords);
    }

    // LAST, and unconditionally: eligibility moves independently of membership
    // — a badge that merely crossed the screen edge keeps its codeword and
    // flips speakable, which happens on scrolls that change nothing else. After
    // the mutations, so badges just dropped aren't re-sent on their way out.
    this.republishDelta(isStrict);
  }

  /** Give back every codeword and badge. Idempotent. */
  dispose(reason: string): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unregisterHolder();
    for (const { badge } of this.members.values()) badge.remove();
    const codewords = this.codewords;
    this.members.clear();
    retireRecords(codewords);
    labelReservoir.release(codewords);
    bkLog(`${this.tag}_END`, { reason, released: codewords.length });
  }

  // --- internals ------------------------------------------------------------

  /** Plan the window AND keep the overhangs, because eligibility needs them
   *  separately from membership. */
  private plan(held: Set<Range>): {
    plan: ReturnType<typeof planBandWindow<Range>>;
    isStrict: (r: Range) => boolean;
  } {
    const candidates = bandCandidates(this.opts.ranges, (r) => held.has(r));
    const overhang = new Map(candidates.map((c) => [c.item, c.overhang]));
    return {
      plan: planBandWindow(candidates, this.opts.budget, VIEWPORT_MARGIN_PX, { hardCap: true }),
      isStrict: (r) => overhang.get(r) === 0,
    };
  }

  /**
   * Remove badges whose range died, and dispose if that empties the set.
   *
   * The band planner structurally cannot do this: `bandCandidates` skips a
   * collapsed rect, so a dead range is neither a keep nor a drop, and when
   * EVERY range dies the would-empty guard skips the mutation block too.
   * Returns true when the set emptied.
   */
  private reapDead(): boolean {
    const dead: string[] = [];
    for (const [cw, m] of this.members) {
      if (!isRangeDead(m.range)) continue;
      m.badge.remove();
      this.members.delete(cw);
      dead.push(cw);
    }
    if (dead.length === 0) return false;
    retireRecords(dead);
    labelReservoir.release(dead);
    bkLog(`${this.tag}_REAP`, { dead: dead.length, remaining: this.members.size });
    if (this.members.size === 0) {
      this.empty('ranges_died');
      return true;
    }
    this.opts.onMembershipChanged?.(this.codewords);
    return false;
  }

  private drop(ranges: Set<Range>): void {
    const gone: string[] = [];
    for (const [cw, m] of [...this.members]) {
      if (!ranges.has(m.range)) continue;
      m.badge.remove();
      this.members.delete(cw);
      gone.push(cw);
    }
    if (gone.length === 0) return;
    retireRecords(gone);
    labelReservoir.release(gone);
  }

  /** Claim codewords, paint, publish, and re-arm membership once admitted.
   *  Returns how many were painted. */
  private add(ranges: Range[], isStrict: (r: Range) => boolean): number {
    if (ranges.length === 0) return 0;
    const codewords = labelReservoir.claim(ranges.length).filter((cw) => cw !== '');
    if (codewords.length === 0) return 0;

    const records: ScannedElement[] = [];
    const minted: string[] = [];
    for (let i = 0; i < ranges.length && i < codewords.length; i++) {
      const strict = isStrict(ranges[i]);
      // This codeword may have been released moments ago by the drop half (or
      // by a replaced set's dispose) and handed straight back by the
      // reservoir's sticky reclaim. That retire is queued for the DEBOUNCED
      // batch while the publish below goes out immediately — so without this
      // the delete lands after the put and strips a live badge from the hint
      // collections, leaving its Discovery HUD suffix menu empty.
      cancelPendingDelete(codewords[i]);
      this.members.set(codewords[i], {
        ...this.paint(ranges[i], codewords[i]), strict, published: false,
      });
      minted.push(codewords[i]);
      records.push(this.record(codewords[i], strict));
    }

    // Speakable and USABLE are not the same property, and admission decides
    // only the first. A badge whose record the plugin didn't take is still
    // perfectly typeable — the keyboard path resolves it out of `members`
    // without any grammar round-trip — so it STAYS PAINTED and gets retried on
    // the next reconcile, exactly as the element path keeps an unacked wrapper
    // painted and queues a re-Put (scan-orchestrator's ack partitioning).
    //
    // Non-admission here is never a cross-document collision: that arrives on
    // its own path (the SW pool's confirm rejection → `onRejected` below),
    // which does remove the badge, because a badge left painted for a codeword
    // another document won would act over THERE. What lands here instead is
    // "no platform to admit anything" (no voice alphabet — the case that left a
    // keyboard user staring at "Lost the highlighted matches" on a page where
    // the pick was fine, 2026-07-26), a transport failure, or a plugin-side
    // refusal — all of them local, all of them recoverable, none of them a
    // reason to take a working badge away.
    if (!isVoiceAlphabetLoaded()) {
      this.opts.onMembershipChanged?.(this.codewords);
      return minted.length;
    }

    this.markPublishing(records);
    void publishRecords(records).then((admitted) => {
      if (this.disposed) return;
      this.settlePublished(records, admitted);
      const unspeakable = minted.filter((cw) => !admitted.has(cw));
      if (unspeakable.length > 0) {
        bkLog(`${this.tag}_UNADMITTED`, { codewords: unspeakable, kept: this.members.size });
      }
      // Arm membership only now: arming before the publish lands would filter
      // these out of the owner's projection too (the plugin hasn't stored them
      // yet).
      this.opts.onMembershipChanged?.(this.codewords);
    });

    return minted.length;
  }

  /**
   * Mark records as needing no retry the moment they go out — optimistically,
   * before the answer.
   *
   * On-resolve marking would double-POST: one reconcile both re-mints
   * codewords (`add`, which publishes) and then sweeps for unpublished ones
   * (`republishDelta`, synchronous, before that publish's promise resolves),
   * so every window slide sent the same records twice.
   */
  private markPublishing(records: ScannedElement[]): void {
    for (const r of records) {
      const m = this.members.get(r.codeword);
      if (m) m.published = true;
    }
  }

  /** Take the optimism back for whatever the plugin didn't admit, putting it
   *  on the next reconcile's retry list. */
  private settlePublished(records: ScannedElement[], admitted: Set<string>): void {
    for (const r of records) {
      if (admitted.has(r.codeword)) continue;
      const m = this.members.get(r.codeword);
      if (m) m.published = false;
    }
  }

  /**
   * The reconcile-tail publish: eligibility deltas AND the retry.
   *
   * Two reasons a record needs to go out, one POST. Eligibility: a badge that
   * crossed the screen edge keeps its codeword and flips speakable — delta
   * only, mirroring the wrapper path's lastSentStrictViewport. Retry: a member
   * `add` painted but the plugin never took (transport down, refusal, or an
   * alphabet that hadn't arrived yet) is still unspeakable, and reconcile is
   * where it gets another go — the settle signal the set already runs on, no
   * timer of its own. When voice comes back, the next settle makes every
   * painted badge speakable without repainting anything.
   */
  private republishDelta(isStrict: (r: Range) => boolean): void {
    const records: ScannedElement[] = [];
    const retried: string[] = [];
    for (const [cw, m] of this.members) {
      const strict = isStrict(m.range);
      const moved = strict !== m.strict;
      m.strict = strict;
      if (!moved && m.published) continue;
      if (!moved) retried.push(cw);
      records.push(this.record(cw, strict));
    }
    if (records.length === 0) return;
    bkLog(`${this.tag}_STRICT`, { sent: records.map((r) => r.codeword), retried });
    this.markPublishing(records);
    void publishRecords(records).then((admitted) => {
      if (this.disposed) return;
      this.settlePublished(records, admitted);
    });
  }

  /** Re-Put every live record into the CURRENT session — the CodewordHolder
   *  contract. Rebuilds are assembled from `store.all`, which never contains
   *  these. */
  private republishAll(): void {
    if (this.disposed || this.members.size === 0) return;
    const records = [...this.members].map(([cw, m]) => this.record(cw, m.strict));
    bkLog(`${this.tag}_REPUBLISH`, { codewords: records.length });
    // The rotation invalidated the OLD session's admission (plugin-side these
    // are inherited unconfirmed and dropped if the re-Put doesn't land), so
    // this publish is what re-establishes it — and whatever it misses lands
    // back on reconcile's retry list.
    this.markPublishing(records);
    void publishRecords(records).then((admitted) => {
      if (this.disposed) return;
      this.settlePublished(records, admitted);
      this.opts.onMembershipChanged?.(this.codewords);
    });
  }

  private onRejected(codeword: string): void {
    const m = this.members.get(codeword);
    if (this.disposed || !m) return;
    // The ONE rejection that costs the badge. Another document won this
    // codeword from the SW pool, so it no longer addresses anything here —
    // saying or typing it would act over THERE. Distinct from a record the
    // plugin merely didn't take (see `add`): that one is still ours and still
    // typeable, so it keeps its badge and gets retried.
    m.badge.remove();
    this.members.delete(codeword);
    bkLog(`${this.tag}_REJECTED`, { codeword, remaining: this.members.size });
    if (this.members.size === 0) {
      this.empty('all_rejected');
      return;
    }
    this.opts.onMembershipChanged?.(this.codewords);
  }

  private empty(reason: string): void {
    const onEmpty = this.opts.onEmpty;
    this.dispose(reason);
    onEmpty?.(reason);
  }

  private record(codeword: string, strict: boolean): ScannedElement {
    return {
      label: codeword,
      id: 0, // not in the element registry — the codeword is the only address
      category: 'view',
      type: 'range_disambiguation',
      adapter: null,
      codeword,
      in_strict_viewport: strict,
    };
  }

  /**
   * Construct, show (which renders the text, so the box has a measurable size),
   * then place against the range's rect. Same order — and the same reason —
   * showBadges + placeBadges use for element hints.
   */
  private paint(range: Range, token: string): Member {
    const label = poolLabelToAssignment(token);
    const target = rangeTarget(range);
    const badge = new HintBadge(target, label, getDisplayMode(), this.opts.variant);
    badge.show();
    placeBadgeAtRect(badge, target.element, target.rect());
    return { range, badge, label, strict: false, published: false };
  }
}

/**
 * Rank every range by how far outside the viewport it sits, for the shared band
 * planner — the same derivation the link badges use.
 *
 * Liveness before geometry: a dead range usually reports a collapsed rect and
 * would fall out below anyway, but relying on that means a reap can be undone
 * in the same pass, since the range is still in the caller's list.
 *
 * The frame-level check comes first, so a range inside an iframe that is itself
 * scrolled out of view counts as out. Deliberately geometry-only: no occlusion
 * or CSS-visibility read. Text under a sticky header is still something the
 * user can reasonably be asked to pick, and the per-member cost those checks
 * carry is meant for hundreds of hint wrappers.
 */
function bandCandidates(ranges: Range[], held: (r: Range) => boolean): BandCandidate<Range>[] {
  if (!isAncestorChainInVisibleViewport(window)) return [];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const out: BandCandidate<Range>[] = [];
  for (const r of ranges) {
    if (isRangeDead(r)) continue;
    let rect: DOMRect;
    try { rect = r.getBoundingClientRect(); } catch { continue; }
    // A fully collapsed rect has nowhere to anchor a badge.
    if (rect.width === 0 && rect.height === 0) continue;
    out.push({ item: r, overhang: bandOverhang(rect, vw, vh), held: held(r) });
  }
  return out;
}

/**
 * Is this range's text still in the document?
 *
 * A Range does not rebind: once its nodes are removed it collapses and nothing
 * brings it back. Distinct from a merely COLLAPSED rect, which a connected
 * range reports transiently (a hidden accordion) and which must NOT drop a
 * badge. Element-derived the same way `rangeTarget` derives the badge's anchor,
 * so "dead" and "what the badge is pinned to" can't disagree — and because
 * Node.isConnected on a text node is not dependable across engines.
 */
function isRangeDead(range: Range): boolean {
  const node = range.commonAncestorContainer;
  const el = node instanceof Element ? node : node.parentElement;
  return el === null || !el.isConnected;
}

/** The strict cut: `bandOverhang === 0` is exactly what `isRectOnScreen`
 *  applies to elements, so ranges and elements can't disagree about "on
 *  screen". */
function isRangeOnScreen(range: Range): boolean {
  if (!isAncestorChainInVisibleViewport(window)) return false;
  let rect: DOMRect;
  try { rect = range.getBoundingClientRect(); } catch { return false; }
  if (rect.width === 0 && rect.height === 0) return false;
  return bandOverhang(rect, window.innerWidth, window.innerHeight) === 0;
}
