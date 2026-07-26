/**
 * The mode stack — ONE lifetime per user mode, one entry/exit pair, one escape
 * order, one plugin mirror. Primitive 2 of
 * notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md.
 *
 * What it replaces (Wave 3, not yet — nothing imports this file):
 * keyboard.ts's four mode fields and getMode()'s precedence ladder,
 * escape-cascade.ts's fixed layer list, caret.ts's entryFloor/findFloor and
 * escape()'s internal three-layer order, range-disambiguation.ts's
 * PickEntryState/restoreBadges, and the per-frame hand-maintained tag mirrors
 * with their per-mode guards. Each of those is a rule written N times; every
 * finding in the design doc's review table is a missed edit in the Nth place.
 *
 * The stack's claims, each of which was violated somewhere in the review:
 *
 *   - Escape order is TEMPORAL — last pushed, first peeled (resolved question
 *     1). The cascade's fixed "a pick outranks everything" was an approximation
 *     of this: a pending pick is always the newest layer by construction (it
 *     captures bare keys and its exclusive holder swallows codewords, so
 *     nothing can be entered over it without landing above it).
 *   - A mode's floor is recorded at push and restored at pop, for EVERY mode —
 *     not for the two that grew hand-written floors (`entryFloor`,
 *     `restoreBadges`). The floor is the previous top plus whatever payload the
 *     entry carried in (badge visibility rides as payload; it is deliberately
 *     NOT a stack layer — escape closes things, it doesn't mute them).
 *   - Exit pops ONLY the named entry. A find session sitting below a caret
 *     session survives the caret's exit untouched, by construction rather than
 *     by a findFloor field (review finding: `/quick` Enter, `v`, `y` tore down
 *     the user's find).
 *   - The plugin mirror is DERIVED from the stack, not maintained beside it.
 *     The stack reports mirrored-mode edges to an injected sink; the service
 *     worker arbitrates across frames with derive-mirror.ts. No chrome imports
 *     here, no transport — the sink is the seam Wave 3's C4 wires.
 *   - A clear signal survives until the sink confirms (the Wave 1 correction:
 *     what made hint_gate.go safe was the ABSENCE of an early-out, not Delete
 *     ordering). Here that is structural: the confirmed-set advances only on a
 *     sink `true`, so a failed post leaves the edge pending and every later
 *     stack change — or an explicit flushMirror() — re-attempts it. No guard
 *     can swallow the retry, because there is no guard to get wrong.
 *
 * Deliberately NOT modes, recorded here so the next reader does not "fix" the
 * absence: forced insert and per-site exclusion stay in keyboard.ts — voice
 * cannot be in them, so they are keyboard transients, not layers. The mark arm
 * and a half-typed key sequence likewise. Badge visibility is a payload, not an
 * entry. The hint typed prefix and the caret session's visual stage are
 * INTRA-mode transients, peeled via a spec's peelInner without popping.
 *
 * Sensing freeze: passive state + an injected sink. No observer, no timer, no
 * gate, no memo, and nothing here reads a clock — floors are structural.
 */

export type ModeId = 'hint' | 'caret' | 'find' | 'range_pick' | 'palette' | 'video';

export interface ModeSpec {
  id: ModeId;
  /** Bare-key ownership while this is the top of the stack. */
  capture: 'none' | 'bare-keys';
  /** How the plugin sees it. null = extension-only, and null is a DECISION
   *  with a recorded reason (the D2 lint checks the field exists, not that it
   *  is non-null): the hints tag and the range-pick projection are not
   *  projections of user mode. See the design doc's resolved questions 1-2. */
  mirror: { tag: string; exclusive: boolean; speaker: 'any-frame' } | null;
  /** Peeled by escape? Badge visibility deliberately is not — see header. */
  peelable: boolean;
  /** Peel an INTRA-mode transient without popping: hint mode's typed prefix,
   *  the caret session's visual→caret stage. peelTop asks the top entry this
   *  first; a non-null return consumed the escape and the entry stays. Never
   *  pops — popping is the stack's job, so the floor bookkeeping cannot be
   *  bypassed. Returns the name of what it peeled, or null when the mode has
   *  no transient up right now. */
  peelInner?(): string | null;
}

/**
 * Inner-transient probes. A spec's peelInner is declared in the table (it is
 * part of the mode's shape — hint HAS a typed-prefix stage, find does not) but
 * the transient's state lives with the module that owns it (the typed prefix
 * is KeyHandler state; the visual stage is CaretController state), and Wave 2
 * wires nothing. So the table's peelInner entries delegate to a probe this
 * registry holds: Wave 3's C2 installs the real probes alongside the push/pop
 * call sites; tests install synthetic ones. An unregistered probe reads as "no
 * transient up" — peelTop then pops, which is also the correct degraded
 * behavior if a wiring step ever misses a probe: the mode is still escapable,
 * just not stage-by-stage.
 */
const innerProbes = new Map<ModeId, () => string | null>();

export function setInnerTransientProbe(id: ModeId, probe: (() => string | null) | null): void {
  if (probe) innerProbes.set(id, probe);
  else innerProbes.delete(id);
}

/** Test-only: drop every registered probe (paired with ModeStack.reset). */
export function clearInnerTransientProbes(): void {
  innerProbes.clear();
}

/**
 * The mode inventory, as data. Derived from the design doc's ten-row table:
 * ten pieces of state in three processes collapse to six specs, because four
 * rows were never modes of their own —
 *
 *   - field selection is a payload on the caret entry (same tag, same
 *     lifetime, different movement surface — CaretController.fieldEl);
 *   - the find sub-mode (`find`/`highlight`/`extend`) dies with the phrase
 *     collector (design doc, Primitive 3): three callers, not three modes;
 *   - search badges are a CodewordHolder, not a mode — they add speakable
 *     things without changing what the user is in;
 *   - video (keyboard) and video (voice) are ONE mode entered by two paths —
 *     the doc's proof case. Today they are two lifetimes in two processes
 *     with no shared state; under this table both `w` and the spoken "video"
 *     drive the same push, and Escape/q/"over" the same pop. Mirroring it
 *     here IS the resolution of the sticky-vs-hold-scoped mismatch that keeps
 *     video out of the plugin's modeMirrors table today: once the tag is a
 *     projection of this single lifetime (C4), the hold-scoped
 *     `clear_on_event: session_boundary` lifecycle stops being the tag's
 *     writer of record and the forwarder hazard (an exit imperative at every
 *     hold boundary tearing down a key-entered layer) is gone by construction.
 *
 * Forced insert is absent on purpose: voice cannot be in it, so it is a
 * keyboard transient in keyboard.ts, not a layer (see header).
 */
export const MODE_SPECS: readonly ModeSpec[] = [
  {
    id: 'hint',
    capture: 'bare-keys',
    // mirror: null is a DECISION (resolved question 2): `plugin.browser.hints`
    // asserts "these codewords are decodable", not "the user is in a mode".
    // Its lifetime is the grammar's — under always-on hint visibility the tag
    // is held for the whole page session while keyboard hint mode toggles
    // freely — and hint_gate.go is the one tag machine the review found
    // correct (the no-early-out invariant). Driving it from here would add a
    // second writer to the only tag with exactly one good one. Mode-shaped
    // tags are stack-derived; grammar-shaped tags are grammar-derived.
    mirror: null,
    peelable: true,
    // The typed prefix: first escape abandons the letters, not the mode.
    peelInner: () => innerProbes.get('hint')?.() ?? null,
  },
  {
    id: 'caret',
    capture: 'bare-keys',
    // Exclusive while selecting: only caret-gated commands ("select word",
    // "copy that") match. speaker any-frame is the review's finding #5 made
    // unrepresentable: resolveSelectTo deliberately creates subframe caret
    // sessions, and top-frame-only speaking left them tagless ("copy that"
    // dead). Which frames hold the mode is the SW's derivation, not a
    // per-frame guard. Field selection is a payload on this entry, not its
    // own mode — same tag, same lifetime.
    mirror: { tag: 'plugin.browser.caret', exclusive: true, speaker: 'any-frame' },
    peelable: true,
    // The staged unwind: visual collapses back to caret before caret exits.
    peelInner: () => innerProbes.get('caret')?.() ?? null,
  },
  {
    id: 'find',
    // The find session never modally captures the page's bare keys the way
    // hint/caret/video do: while the bar is open the input has focus, and a
    // committed pill leaves the page's keys alone (n/N are ordinary binds).
    capture: 'none',
    // Non-exclusive: find AUGMENTS ("next"/"previous" become matchable) while
    // everything else stays live — plugin.json declares no exclusive flag on
    // the .find gate, unlike caret/palette/video_mode.
    mirror: { tag: 'plugin.browser.find', exclusive: false, speaker: 'any-frame' },
    peelable: true,
    // No peelInner: the find sub-mode dies with the phrase collector (B3).
  },
  {
    id: 'range_pick',
    capture: 'bare-keys',
    // mirror: null is a DECISION (resolved question 1): the plugin-side
    // RANGE_PICK projection narrow is a payload effect of entry/exit, not a
    // tag, and it does not become one. The pick's chips are a CodewordHolder
    // (claim: exclusive) — that half lives in the holder registry, not here.
    mirror: null,
    peelable: true,
  },
  {
    id: 'palette',
    // The palette lives in an extension-origin iframe with its own focused
    // input; the page content script is not capturing bare keys for it.
    capture: 'none',
    mirror: { tag: 'plugin.browser.palette', exclusive: true, speaker: 'any-frame' },
    // Not peelable FROM THIS STACK (decided at C3, when peelTop became the
    // cascade's decider): while the palette is open its iframe owns focus, so
    // the page-side Escape listener never sees the key — the palette's own
    // document peels it, and losing focus closes it (the load-bearing blur
    // rule). The spoken exit is plugin-side (the exclusive tag's external
    // clear), which C4 routes through the mirror. A page-side peel here could
    // only fire on a desynced stack and would pop an entry whose iframe it
    // cannot reach.
    peelable: false,
  },
  {
    id: 'video',
    capture: 'bare-keys',
    // The proof case (see table header): one lifetime, two entry paths, one
    // mirror — which is what makes reconcileExternalTagClears derivable for
    // video instead of deliberately incomplete.
    mirror: { tag: 'plugin.browser.video_mode', exclusive: true, speaker: 'any-frame' },
    peelable: true,
  },
];

/**
 * One mirrored-mode edge, as reported to the sink. Carries the frame's whole
 * stack snapshot (bottom to top, post-change) because that is what C4's
 * transport actually forwards: the SW derives the tag set from every frame's
 * snapshot via deriveMirror, so the edge is the trigger and the snapshot is
 * the truth. A sink that only relays snapshots can ignore the edge fields.
 */
export interface MirrorEdge {
  id: ModeId;
  kind: 'enter' | 'exit';
  tag: string;
  exclusive: boolean;
  /** This frame's mode stack, bottom to top, after the change. */
  stack: readonly ModeId[];
}

/**
 * The injected mirror seam. Return true when the far side TOOK the edge —
 * that, and only that, advances the stack's confirmed-set. Returning false or
 * throwing leaves the transition pending: every subsequent stack change and
 * every flushMirror() re-attempts it. This is the clear-signal-survives
 * invariant (design doc, Wave 1 correction) as an interface contract rather
 * than a per-mode RPC-ordering convention.
 */
export interface ModeMirrorSink {
  post(edge: MirrorEdge): boolean;
}

/** What push recorded and pop hands back: the previous top and the payload
 *  the entry carried in (badge visibility, a pick's entry snapshot, a caret
 *  session's field element). */
export interface ModeFloor {
  below: ModeId | null;
  payload: unknown;
}

export type PeelResult =
  | { peeled: 'inner'; name: string; reason: string }
  | { peeled: 'mode'; id: ModeId; reason: string }
  | { peeled: 'none' };

interface ModeEntry {
  id: ModeId;
  floor: ModeFloor;
}

export class ModeStack {
  private entries: ModeEntry[] = [];
  private readonly byId = new Map<ModeId, ModeSpec>();
  /** Mirrored modes whose ENTER the sink has confirmed and whose exit it has
   *  not — the only bookkeeping the mirror keeps, advanced strictly on a sink
   *  `true`. Pending work is the DIFFERENCE between this and the live stack,
   *  never a flag, so it cannot be swallowed. */
  private confirmed = new Set<ModeId>();

  constructor(
    private readonly specs: readonly ModeSpec[],
    private readonly sink: ModeMirrorSink,
  ) {
    for (const s of specs) {
      if (this.byId.has(s.id)) throw new Error(`duplicate ModeSpec: ${s.id}`);
      this.byId.set(s.id, s);
    }
  }

  /** The stack's mode ids, bottom to top — the snapshot C4 forwards. */
  ids(): readonly ModeId[] {
    return this.entries.map((e) => e.id);
  }

  top(): ModeId | null {
    return this.entries.length ? this.entries[this.entries.length - 1].id : null;
  }

  depth(): number {
    return this.entries.length;
  }

  has(id: ModeId): boolean {
    return this.entries.some((e) => e.id === id);
  }

  /** Bare-key ownership is the TOP entry's, per the spec's contract ("while
   *  this is the top of the stack") — an empty stack owns nothing. */
  capture(): 'none' | 'bare-keys' {
    const t = this.top();
    return t ? this.spec(t).capture : 'none';
  }

  /**
   * Enter a mode. Records the floor (current top + payload), then drives the
   * mirror. A mode has ONE lifetime: pushing an id already in the stack joins
   * the existing entry and returns false — this is the video proof case, where
   * the `w` key and the spoken "video" are two entry paths into one mode, and
   * the second must not nest, re-floor, or re-emit. The first entry's floor
   * stands, because it snapshot the state the user was actually in when the
   * mode began.
   */
  push(id: ModeId, payload?: unknown): boolean {
    this.spec(id); // throw early on an unregistered mode
    if (this.has(id)) return false;
    this.entries.push({ id, floor: { below: this.top(), payload } });
    this.drainMirror();
    return true;
  }

  /**
   * Exit a mode, wherever it sits. Popping the top restores its recorded
   * floor; popping a mid-stack entry (a find closed by blur while a caret
   * session rides above it) excises exactly that entry and disturbs nothing
   * else — which is the "exit restores what was underneath" rule holding even
   * when the exit is not an escape. Returns the recorded floor so the caller
   * can restore the payload half (badge visibility, keyboard sub-state), or
   * null when the mode was not in the stack.
   */
  pop(id: ModeId): ModeFloor | null {
    let i = -1;
    for (let j = this.entries.length - 1; j >= 0; j--) {
      if (this.entries[j].id === id) { i = j; break; }
    }
    if (i < 0) return null;
    const [entry] = this.entries.splice(i, 1);
    this.drainMirror();
    return entry.floor;
  }

  /**
   * The escape — derived, not declared. Asks the top entry's peelInner first:
   * a non-null return means an intra-mode transient consumed the escape and
   * nothing pops (the hint prefix before hint mode; visual collapsing to caret
   * before caret exits). Otherwise the topmost PEELABLE entry pops — temporal
   * order, last pushed first peeled (resolved question 1). Non-peelable
   * entries are stepped over, not popped: escape closes what escape may close.
   */
  peelTop(reason: string): PeelResult {
    const t = this.top();
    if (t === null) return { peeled: 'none' };
    const inner = this.spec(t).peelInner?.();
    if (inner !== null && inner !== undefined) {
      return { peeled: 'inner', name: inner, reason };
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const id = this.entries[i].id;
      if (!this.spec(id).peelable) continue;
      this.pop(id);
      return { peeled: 'mode', id, reason };
    }
    return { peeled: 'none' };
  }

  /** True when the sink has confirmed every mirrored edge — i.e. nothing is
   *  pending. False is the visible form of "a clear (or assert) has not been
   *  taken yet"; it is never silently true. */
  mirrorSettled(): boolean {
    const desired = this.desiredMirror();
    if (desired.size !== this.confirmed.size) return false;
    for (const id of desired) if (!this.confirmed.has(id)) return false;
    return true;
  }

  /** Re-attempt pending mirror transitions. The retry surface for a sink that
   *  failed — stack changes also drain, so this exists for the quiet case
   *  where the transport recovers with no user activity to piggyback on. */
  flushMirror(): void {
    this.drainMirror();
  }

  /** Test-only: back to empty, forgetting confirmed state. Production code
   *  never resets a stack — modes end by popping, mirrors by draining. */
  reset(): void {
    this.entries = [];
    this.confirmed.clear();
  }

  private spec(id: ModeId): ModeSpec {
    const s = this.byId.get(id);
    if (!s) throw new Error(`unknown mode: ${id}`);
    return s;
  }

  private desiredMirror(): Set<ModeId> {
    const out = new Set<ModeId>();
    for (const e of this.entries) {
      if (this.spec(e.id).mirror) out.add(e.id);
    }
    return out;
  }

  /**
   * Reconcile confirmed toward the live stack, one sink post per differing
   * mode. Exits first — withdrawing a stale claim (an exclusive one
   * especially) before asserting the next keeps the far side's exclusive
   * filtering from briefly holding two modes. Stops at the first failed post:
   * the remaining difference stays pending and the next drain resumes. Because
   * a mode is enqueued nowhere (pending IS the confirmed/desired difference),
   * an enter that fails and then pops before retrying simply nets out — the
   * far side never saw it, so there is nothing to clear — while a confirmed
   * enter whose exit fails stays visibly unsettled until the exit lands. With
   * a healthy sink every stack change drains immediately, so a mirrored mode
   * emits exactly one transition per edge — the dedupe and the retry come from
   * the same derivation.
   */
  private drainMirror(): void {
    const desired = this.desiredMirror();
    for (const id of [...this.confirmed]) {
      if (desired.has(id)) continue;
      if (!this.tryPost(id, 'exit')) return;
      this.confirmed.delete(id);
    }
    for (const e of this.entries) {
      const m = this.spec(e.id).mirror;
      if (!m || this.confirmed.has(e.id)) continue;
      if (!this.tryPost(e.id, 'enter')) return;
      this.confirmed.add(e.id);
    }
  }

  private tryPost(id: ModeId, kind: 'enter' | 'exit'): boolean {
    const m = this.spec(id).mirror;
    if (!m) return true;
    try {
      return this.sink.post({
        id, kind, tag: m.tag, exclusive: m.exclusive, stack: this.ids(),
      }) === true;
    } catch {
      // A throwing sink is a failed post, not an exception path: the edge
      // stays pending, same as a false return. Nothing may escape here and
      // abort the caller's pop — teardown proceeds, the mirror retries.
      return false;
    }
  }
}
