# Design: One rule, one place — a holder registry, a mode stack, and a phrase collector

**Status:** Proposal, 2026-07-26. Arises from the architecture review of the
phrase-box / codeword-badge arc landed 2026-07-25/26 (extension `3bdfbeb..363c86d`,
browser `66cfb66..2952c9d`, voice `d7b1894`). Nothing here is landed. Supersedes
the participant lists in `DESIGN_CODEWORD_KEY_OWNERSHIP.md` and extends the mode
model in `DESIGN_KEYBOARD_MODES.md`; the badge seam in
`DESIGN_BADGE_TARGET_SEAM.md` stands unchanged.

## Problem

Three seams were introduced this week, each to kill a rule that had two
implementations:

- `activate/codeword-routing.ts` — who owns a spoken/typed codeword. Written
  because the keyboard knew only the element store while the spoken path knew
  all three holders.
- `activate/escape-cascade.ts` — what "get me out of this" peels, and in what
  order. Written because voice declared the order and the key's order emerged
  from a guard sequence, and they had drifted.
- `labels/codeword-holders.ts` — which non-element things hold pool codewords.
  Written because store-scoped sweeps stole a live pick's codewords.

Each seam is correct. Each migrated exactly one caller and documented the job as
finished. The review found:

| Rule | Declared in | Also implemented in | Live failure |
|---|---|---|---|
| codeword ownership order | `codeword-routing.ts` | `content.ts:2602`, `content.ts:2899` | speaking a search-badge prefix re-paints every hint find hid |
| escape layer order | `escape-cascade.ts` | `keyboard.ts` guards, `content.ts:3127/3134`, `caret.ts:481`, `palette-page.ts:450`, `caret.go:93` | committed find + hint mode: key closes find, "over" exits hint mode |
| "does anyone still hold this codeword" | `content.ts:564` (holder half right, store half wrong) | `scan-orchestrator.ts:413` (store-only) | live chip silently unspeakable |
| "exit restores what was underneath" | `caret.ts:242` (`entryFloor`) | `range-disambiguation.ts:79` (`restoreBadges`, half) | pick returns badges but not hint mode |
| "which frame speaks for a page mode" | `selection-commands.ts:60` (top-only) | `content.ts:468` (every frame) | subframe caret sets no tag — "copy that" dead |
| "a clear signal must survive until the actuator takes the tag" | `hint_gate.go:96` (by having no early-out) | `caret.go:52`, `find.go:57`, `palette.go:80`, `video.go:75` (by ordering — and they get it wrong) | failed Delete strands an exclusive tag, unretryable |
| escape must reach every mode | `escape-cascade.ts` | `caret.go:93` (caret, palette only) | video mode: exclusive tag clears, keyboard stays captured |

## Core insight: the repo keeps building seams where it needs registries

A **seam** names its participants by import. `codeword-routing.ts` imports
`range-disambiguation` and `search-badges` and branches on them in three
functions. `escape-cascade.ts` imports its four layers and tests them in a fixed
order. `reconcileExternalTagClears` names caret and palette in two
`plugin.Subscribe` calls.

A **registry** lets participants declare themselves, and derives the rule from
what registered.

The difference is exactly whether adding the fourth participant is a
registration or an edit in N files — and every row in the table above is a
missed edit in the Nth file. `codeword-holders.ts` is the one registry in the
set, and it is the only place where the failure mode is "implement these
methods" rather than a silent bug. That is the pattern to generalize.

Three registries are missing. Every finding in the review is an instance of one
of them being open-coded.

---

## Primitive 1: `CodewordHolder` — who owns a codeword

### What it is today

`labels/codeword-holders.ts` has three hooks — `held`, `republish`,
`onCodewordRejected` — which cover **pool accounting** and nothing else. Its own
header names nine store-scoped sweeps; four are bridged here, one
(`typed hint picker`) is bridged through the *separate*, hardcoded
`codeword-routing.ts`, and four are not bridged at all. A sweep of the real call
sites turns up roughly six more store-only iterations outside that list of nine.

The element wrapper store is not a participant. It is the membership list the
sweeps iterate, and holders are the exception bolted on beside it.

**Corrected 2026-07-26 during Wave 1:** an earlier draft of this doc called the
leak sweep's predicate at `content.ts:564` the canonical-correct form of "does
anyone still hold this codeword". Its *holder* half is right; its *store* half is
not. `store.byCodeword` resolves through `w.label`, which is assigned at PAINT
time (`settle-engine.ts:440` `prepareBadge`), whereas `w.scanned.codeword` is
assigned at CLAIM time (`intersection-tracker.ts:354`). A wrapper that has
claimed a codeword but not yet painted — indefinitely, under manual hint
visibility — answers `undefined`. So the reservoir's 30s leak sweep can reclaim a
LIVE wrapper's codeword and queue a plugin-side Delete. The correct form is
`store.all.some(lw => lw.scanned.codeword === cw) || heldOutsideStore(cw)`.

That sharpens the case for this primitive rather than weakening it. `held()` on
a registered holder is the only form that cannot drift, because the holder
answers about its own bookkeeping rather than about a projection of it.

**Fixed 2026-07-26 (post-Wave-1):** the leak sweep at `content.ts` now uses the
claim-level form above; regression tests are in `scan/element-wrapper.test.ts`
("claimed-vs-painted"). That closes the site with teeth — it was the one that
could DELETE a live wrapper's codeword plugin-side — but it does not close the
class: the remaining sites still ask their own versions of "who holds this", and
the fix is one more hand-written predicate that the next store-shape change can
falsify. The primitive is still the structural answer; this was a bug fix, not a
substitute for it.

### The change

**The store becomes holder #0.** `store.all` stops being the membership list;
`holders` becomes it. Every sweep asks the registry and each holder answers for
itself.

The interface grows by concern, not by method count. Four groups:

```ts
interface CodewordHolder {
  /** Registration order is not the contract — this is. Exclusive holders
   *  outrank additive ones, which outrank ambient. */
  readonly priority: number;
  /** 'exclusive' swallows every codeword while live (the pick); 'additive'
   *  claims only its own and falls through (search badges, the store). */
  readonly claim: 'exclusive' | 'additive';

  // -- identity / pool (today's three, unchanged) --
  held(): Iterable<string>;
  republish(): void;
  onCodewordRejected(codeword: string): void;

  // -- eligibility (replaces codeword-routing.ts's if-chain) --
  matchesPrefix(prefix: string): boolean;
  narrow(prefix: string): void;
  resolve(codeword: string): HolderOutcome;
  soleMatch(prefix: string): string | null;

  // -- geometry / paint (unbridged today) --
  reposition(): void;
  relabel(): void;

  // -- lifecycle (unbridged today) --
  reconcile(settle: SettleKind): void;
  dispose(reason: string): void;
}
```

`codeword-routing.ts` then collapses to a sort:

```ts
export function resolveCodeword(cw: string): CodewordOutcome {
  for (const h of holdersByPriority()) {
    const out = h.resolve(cw);
    if (out !== 'not_mine') return out;
    if (h.claim === 'exclusive') return 'swallowed';   // exclusivity, declared
  }
  return 'none';
}
```

Exclusivity stops being `if (!isRangePickPending())` written twice and becomes a
field. The voice path and the key path both call this. `StoreCodewordHooks` — the
injected shim that exists only to dodge an import cycle, and whose `resolve` is
currently dead code — goes away, because the store is a registered holder like
anything else.

### Explicit non-goal: do not merge the two badge lifecycles

The review asked whether `RangeBadgeSet` and the wrapper store should have one
reconcile/reap/republish/band implementation. **No.** They already share the part
that should be shared — `lifecycle/band-window.ts`, the band planner — and they
differ on something real: a wrapper **rebinds** (an element can be re-found after
DOM churn, which is what `observe/limbo.ts` and the identity registry exist for),
and a `Range` **never** rebinds (once its nodes go, it collapses and nothing
brings it back). `RangeBadgeSet`'s reap is three lines because of that; the
store's lifecycle is not.

Merge the **dispatch**, not the **implementation**. Every sweep iterates holders;
each holder's `reconcile`/`dispose` stays its own. That closes every finding in
the review at a fraction of the risk of merging the lifecycles, and it is the
version where the third Range-backed holder is a registration.

---

## Primitive 2: the mode stack — what the user is in

### What it is today

Ten pieces of state that are modes, in three processes:

| mode | extension state | plugin tag | records what it entered from |
|---|---|---|---|
| hint | `KeyHandler.mode` | `plugin.browser.hints` (grammar-owned) | no |
| caret / visual | `CaretController.mode` + `KeyHandler.caretMode` | `.caret` (exclusive) | `entryFloor` |
| field selection | `CaretController.fieldEl` | same tag | no |
| find session | `find.ts` `state.active` + bar/pill presence | `.find` | no |
| find sub-mode | `state.mode` | — | no |
| range pick | `pending` | projection filter, not a tag | badges only |
| search badges | `badges` | ordinary hint grammar | no |
| palette | `frame` + SW `paletteVoice` | `.palette` (exclusive) | focus only |
| video (keyboard) | `KeyHandler.videoMode` | — | no |
| video (voice) | — | `.video_mode` (exclusive, matcher-written) | n/a |

Entry and exit are hand-written at ~30 sites. The escape order is declared in
five places. The plugin mirror is maintained by hand with different guards per
mode (`isTopFrame` for caret, every frame for find), different RPC ordering
(bookkeeping-before-Delete in four places, after in one), and different
completeness (`reconcileExternalTagClears` covers two of three exclusive tags).

This is a two-artifacts-kept-in-sync design, which is the shape we've ruled out
elsewhere. The extension flag and the plugin tag are the two artifacts and there
is no single source.

### The change

Modes are declared once, as data:

```ts
interface ModeSpec {
  id: ModeId;
  /** Bare-key ownership while this is the top of the stack. */
  capture: 'none' | 'bare-keys';
  /** How the plugin sees it. null = extension-only, and null is a DECISION
   *  with a recorded reason (the D2 lint checks the field exists, not that it
   *  is non-null): forced insert and hint mode are null because their tags —
   *  none, and the grammar-owned hints gate — are not projections of user
   *  mode. See resolved question 2. */
  mirror: { tag: string; exclusive: boolean; speaker: 'any-frame' } | null;
  /** Peeled by escape? Badge visibility deliberately is not — see below. */
  peelable: boolean;
  /** Peel an INTRA-mode transient without popping: hint mode's typed prefix,
   *  the caret session's visual→caret stage. peelTop asks the top entry this
   *  first; a non-null return consumed the escape and the entry stays. This is
   *  how the cascade's "hint prefix outranks hint mode" and caret's staged
   *  unwind survive without making a keystroke a mode. Never pops — popping is
   *  the stack's, so the floor bookkeeping cannot be bypassed. */
  peelInner?(): string | null;
}
```

Entry and exit go through one pair of functions:

```ts
modes.push(id, payload);   // records the current top as this entry's floor,
                           // applies capture, drives the mirror
modes.pop(id);             // restores the recorded floor, drives the mirror
modes.peelTop(reason);     // the escape cascade — derived, not declared
```

The escape order **is** the stack order. There is no list to keep in sync,
because there is no list.

### What this deletes, structurally

- `entryFloor` and `restoreBadges` — the stack records the floor for every mode,
  not for two of them, and not for one of the two things a pick captured.
- `escape-cascade.ts`'s hardcoded order, `keyboard.ts`'s
  `mode`/`caretMode`/`videoMode`/`forcedInsert` precedence chain, and
  `getMode()`'s if-ladder — all one stack.
- `caret.escape()`'s internal three-layer order. Under a stack, find is its own
  entry sitting **below** caret's, so `caret.exit()` pops only caret and a
  pre-existing find survives untouched. That fixes review finding #2 by
  construction rather than by adding a `findFloor` beside `entryFloor`.
- `reconcileExternalTagClears`' hardcoded `(caret, palette)` pair — derived from
  every spec with a non-null `mirror`, so video cannot be forgotten.

Video mode is the proof case: today it is a mode in two processes with no shared
state, entered by two disjoint paths (`w` sets the flag and no tag; "video" sets
the tag and no flag) and exited by two disjoint paths. As a `ModeSpec` it is one
entry with a mirror, and both inputs drive the same push/pop.

### The mirror is derived, and arbitrated in the service worker

The content script is per-frame; the SW is the only singleton. Today each frame
decides for itself whether to speak — caret says top-frame-only (so a subframe
caret session, which `resolveSelectTo` *deliberately* creates, sets no tag), find
says every frame (so two subframes fight over a single-slot `FindConnID`).

Under the stack, frames post their stack top and the **SW computes the mirror**:
a tag is held iff any frame's stack contains that mode. That is the same hop the
messages already take (`sendMessage` → `background.ts:492` → `postToPlugin`), so
it adds no transport, and it makes the subframe caret bug unrepresentable.

Plugin-side, every tag sync issues its Delete **before** clearing its own
bookkeeping, so a failed RPC leaves the next drain able to retry.

**Corrected 2026-07-26 during Wave 1:** an earlier draft cited `hint_gate.go:96`
as the Delete-first example. It is not — it sets `g.state = hintGateIdle` on
line 99, *before* the Delete on line 100, the same order the four mirrors use.
What makes it safe is different: it has **no early-out**, so every later clear
signal re-issues the Delete regardless of what the flag says. The four mirrors
have no second chance because their drain guards *are* the early-out. The
invariant is "a clear signal survives until the actuator has actually taken the
tag"; ordering reaches it in one place and absence-of-early-out in the other.
Stating it as an ordering rule would have been a rule the cited example does not
follow.

### Video's tag is hold-scoped; its keyboard layer is sticky

`plugin.browser.video_mode` carries
`lifecycle: {clear_on_event: [_platform.input.session_boundary]}`, and
`session_boundary` fires at **key release** — so the tag clears at the end of
every hold in which video mode was entered, attributed to the platform rather
than to a user escape. The extension's `KeyHandler.videoMode`, entered by `w`,
is sticky until Escape/`q`/`w`.

That mismatch is why video is deliberately **absent** from the plugin's
mode-mirror forwarder table today: a forwarder would emit an exit imperative on
every hold boundary, and the moment the extension registered a handler, a
hold-scoped voice mode ending would tear down a key layer the user entered by
keyboard and never asked to leave. Caret and palette do not have this problem —
their tags mirror sticky extension state, which is exactly what makes them safe
to forward.

Resolving it is this primitive's job, not a patch: under one `ModeSpec` the mode
has a single lifetime and both inputs drive the same push/pop. The candidate
discriminator if a forwarder is ever wanted before then is the write's author
(the platform's lifecycle sweep versus a peer plugin's escape) — untested, and
noted here only so the next reader does not "fix" the missing table entry.

Note also that the `"video"` entry command is **action-less** (`SetsTags` with no
`Action`), so speaking it sets the tag and never arms the key layer. The real
Wave 1 defect is therefore narrower than first reported: a `w`-entered layer that
voice cannot peel, fixable in the escape cascade alone, because with no exclusive
tag held the browser's own "over" is not suppressed and reaches the extension.

### Deliberately not in the stack

Badge visibility. Escape closes things; it doesn't mute them — `dismiss`/`hide`
own that, and `escape-cascade.ts` already states this. Visibility becomes a
payload a mode entry can carry (which is what `restoreBadges` was reaching for),
not a stack layer.

---

## Primitive 3: `PhraseCollector` — collect a phrase, then act

### What it is today

Two surfaces collect a phrase and act on it: the find box (`scan/find.ts`) and
the palette input (`palette-page.ts`). They duplicate seven concepts, and the
duplicates have already diverged in ways that are bugs:

- the keyCode-229 text-commit sentinel is declared twice, with near-identical
  prose citing the same field report — and the find box's *own* keydown handler
  doesn't have it, so an IME confirmation Enter commits mid-composition;
- "an insert longer than one character is dictation" is written twice with
  different predicates (find accepts `insertReplacementText`, which is what
  macOS **autocorrect** emits, and the find input doesn't set `autocorrect=off`
  — so autocorrect auto-commits the search) and different timing constants
  (80 ms vs 400 ms);
- the palette closes on blur with a load-bearing reason; the find box has no blur
  handler, and because `content.ts:3127` gates on element presence rather than
  focus, clicking the page with the bar open kills every BranchKit key.

Meanwhile `FindMode` is not polymorphism. Its only real content is a glyph and a
placeholder (`MODE_UI`) plus three `mode !== 'find'` branches; `highlight` and
`extend` are byte-identical inside `find.ts`, and the consumer discards the
distinction — `content.ts:491` is literally `onPhrase: (_mode, query) => …`, and
`caret.extendToRange` decides select-vs-extend from whether a selection already
exists, not from the mode.

### The change

`PhraseCollector` owns the **input semantics** and no DOM. (The palette lives in
an extension-origin iframe behind a host relay for the Firefox privilege reason;
a collector that owned its DOM couldn't serve both.) It owns:

- key ownership while open, including the 229 sentinel and `isComposing`;
- the dictation wire: chunked-insert detection, the utterance-gap accumulator,
  replace-vs-append on a re-dictation;
- commit, cancel, and the guarantee that a pending commit can't outlive its
  session.

Consumers supply render, `onQueryChanged` (live feedback: highlights, or filtered
rows), and `onCommit`. `FindMode` dies: `find`, `highlight` and `extend` become
three callers with three `onCommit`s, which is what they already are.

---

## What gets deleted

The end state has no transitional layer. In order of the migration:

`codeword-routing.ts`'s three if-chains · `StoreCodewordHooks` · the inline voice
codeword path (`content.ts:2602`, `:2899`) · `store.all` as a membership list ·
`escape-cascade.ts`'s layer list · `keyboard.ts`'s four mode fields and
`getMode()`'s ladder · `caret.ts`'s `entryFloor` and `escape()`'s internal order ·
`range-disambiguation.ts`'s `restoreBadges` and `pickWindowHooks.captureKeys/releaseKeys` ·
`selection-commands.ts`'s `caretActivePushed` and its `isTopFrame` mirror guards ·
`reconcileExternalTagClears`' hardcoded pair · `find.ts`'s `FindMode` and `MODE_UI` ·
the duplicated 229 sentinel and dictation predicates in `palette-page.ts`.

## What this does not touch

The recognition engine and the matcher (Layer 1 / Layer 2) are unchanged — no
grammar, vocabulary, `narrow_to`, or DAG work. The band planner
(`lifecycle/band-window.ts`) is unchanged. The badge target seam
(`render/badge-target.ts`, `BadgeVariant`) is unchanged. The two badge lifecycle
implementations stay two, by decision.

## Sensing-freeze accounting

No new observer, timer, gate or memo. `reconcile(settle)` consumes settle kinds
the settle engine already emits (today's `afterScrollSettle`-only wiring is the
bug, not the budget). Retired: `caretActivePushed`, `restoreBadges`,
`entryFloor`, `pickWindowHooks`, `StoreCodewordHooks`, and — once the SW
arbitrates the mirror — the 300 ms window-focus caret re-assert timer, which
exists only because the flag/tag pair can desync.

## Risks

**The mode stack touches every input path.** This is the one that can break the
product for a day. Mitigation: land the stack driving the *existing* flags first
(push/pop set `KeyHandler.mode` etc. as they do now), verify, then delete the
flags in a separate commit. Transitional, and the final commit removes it.

**Holder registration touches teardown.** Orphan-CS teardown is the known
high-blast-radius area; the holder `dispose` hook lands on it. One layer at a
time there, per the standing rule — the teardown wiring is its own step, not
folded into the registry step.

**The SW mirror adds an arbitration point.** If it's wrong, an exclusive tag
sticks and suppresses every command system-wide. Mitigation: the Delete-first
ordering fix (Wave 1) lands before the arbitration change, so a stuck tag is
recoverable by the existing drains.

## Resolved questions (design pass, 2026-07-26)

### 1. The range pick is both — and the either/or was the bundling, not the pick

The question dissolves once the two primitives exist, because the current
module bundles two concerns that belong to different registries:

- **Its chips are a `CodewordHolder`** — they already are, via `RangeBadgeSet`'s
  registration. Under the v2 interface they carry `claim: 'exclusive'`, which is
  where `refusePickWindowCodeword`'s swallow-everything rule stops being an
  `if (!isRangePickPending())` written twice and becomes a declared field.
- **Its modality is a stack entry**: `{ id: 'range_pick', capture: 'bare-keys',
  mirror: null, peelable: true }`. The plugin-side projection narrow (the
  `RANGE_PICK` message) is not a tag and does not become one — it stays an
  entry/exit effect of the mode's payload, not a mirror.
- **`PickEntryState` is the stack's floor.** `badgesVisible` + `hintMode` is
  exactly what push records and pop restores, for every mode instead of this
  one. `pickWindowHooks` and `PickEntryState` die on the C3 schedule.

On escape ordering: under the stack the order is **temporal** — last pushed,
first peeled — and the cascade's fixed "a pick outranks everything" was an
approximation of that. A pending pick is always the newest layer *by
construction*: it captures bare keys (no key-driven mode entry underneath it)
and its exclusive holder swallows codewords (no codeword-driven entry). A voice
command that genuinely opens a new layer over a pending pick lands above it and
peels first, which is correct — Wave 1's A3 fix ("peel whichever layer is
newer, not a fixed rank") already conceded that fixed rank is wrong wherever
the difference is observable.

The hint **prefix** does not become a stack entry. It is an intra-mode
transient, handled by hint mode's `peelInner` (see the interface) — same
mechanism that keeps the caret session's visual→caret staging inside the caret
entry. That preserves the cascade's observed order (prefix before mode, pick
before both) without making a keystroke a mode.

### 2. `plugin.browser.hints` stays outside the mirror table

The mirror table is for tags that assert *the user is in a mode*. The hints tag
asserts *these codewords are decodable* — `hint_gate.go` sets it when a scan's
first grammar batch lands and clears it at session end. The two lifetimes are
demonstrably different: under always-on hint visibility (the shipped default
posture for this user), the tag is held for the whole page session while the
keyboard's hint mode toggles freely. That is the same lifetime-mismatch class
that keeps video out of the plugin's `modeMirrors` table today — except here
the mismatch is *correct and permanent*, not a defect the stack unifies.

Two further reasons not to move it:

- `hint_gate.go` is the one tag machine the review found **correct** (the
  no-early-out invariant). Driving its tag from a stack-derived mirror adds a
  second writer to the only tag that has exactly one good one.
- The anchoring rule is structural role, not plugin identity: mode-shaped tags
  are stack-derived, grammar-shaped tags are grammar-derived. This is the
  extension-side twin of the platform's "engine narrowing reacts only to
  exclusive gates via the shared predicate — never per-tag awareness."

Hint mode's `ModeSpec` therefore has `mirror: null` with the grammar-owned
reason recorded, and the D2 lint accepts a null mirror that carries a reason.

### 3. `reconcile(settle: SettleKind)` is a discriminated hook, not a subscription

Discriminated hook. The deciding argument is the failure mode this arc exists
to kill: a subscription model recreates "participant missed the Nth wiring
site" — forgetting to subscribe to a kind is precisely the
`afterScrollSettle`-only bug, silent again. A discriminated hook delivers every
kind to every holder; a holder ignoring a kind is a visible branch in its own
code, and its conformance suite calls `reconcile` with **every** member of the
closed enum, so "new kind, holder unhandled" surfaces in the holder's own
tests (and, with an exhaustive `switch`, at compile time).

Secondary reasons: scale (two kinds, ≤4 holders — subscription bookkeeping
would outweigh the fan-out it manages) and the sensing freeze (a subscription
registry is a new memo-shaped structure; the discriminated hook is a pure
fan-out of the settle engine's existing `afterSettle`/`afterScrollSettle`
signals, no new state). `SettleKind` starts as exactly the discriminants the
engine already distinguishes — `'scroll' | 'general'` — and grows only when the
engine does. Closed enum, structural not content: adding a kind is one visible
type edit, not a per-holder wiring hunt.

---

## Testing strategy

The gap that let all ten findings through is that every mode/escape test called
the module under test directly, with its collaborators mocked. The strategy has
five parts; the first three exist to make that shape impossible for the
primitives, the last two to make the migration's safety checkable.

### Conformance suites (the sdk-test pattern, in vitest)

The workspace already runs this shape: `sdk-test` is a harness that owns the
invariants and takes the participant as input, so a new SDK's failure mode is
"implement these handlers," not a silent wire drift. The extension-side
counterparts:

- **`src/testing/holder-conformance.ts`** exports
  `describeCodewordHolderConformance(name, factory)` — a shared describe-block
  generator each holder's test file invokes with a factory that produces a
  registered holder plus a way to make it hold codewords. Invariants every
  holder must pass: `held()` agrees with `resolve()` (an additive holder never
  resolves a codeword it doesn't hold); `republish()` is idempotent;
  `onCodewordRejected` removes from `held()`; `matchesPrefix`/`soleMatch`/
  `narrow` are mutually consistent; `reconcile` is a safe no-op for **every**
  `SettleKind` when nothing is live; `dispose` is idempotent and empties
  `held()`; an `'exclusive'` holder's swallow contract.
- **`src/testing/modespec-conformance.ts`** — for every entry in the ModeSpec
  table: the mirror field is present (null allowed, with reason); push then pop
  restores the previous top, capture state, and floor; a mirrored spec emits
  **exactly one transition per edge** into a synthetic mirror sink; a peelable
  spec peels via `peelTop`; `peelInner`, when present, never pops.
- **Registration is the trigger.** A meta-test iterates the real registry / the
  real ModeSpec table and runs the suite over every participant found there. A
  fourth holder cannot skip the suite by not writing a test file — which is the
  "failure mode is implement-these-methods" property the design claims,
  enforced rather than hoped.

### Property-based invariants (add fast-check)

No property-testing library is in the repo today; **add `fast-check`** as a
devDependency (dev-only, no runtime footprint, first-class vitest integration —
and shrinking is what makes a 40-op counterexample readable, which a
hand-rolled seeded walk does not give us). Model-based sequences over
`{push, pop, peelTop, mirror-rpc-fails}` × the ModeSpec table, checked against
a trivially-correct model (a plain array):

- `peelTop` pops in reverse push order;
- `pop` restores the recorded floor — top, capture, and mirror set all match
  the model after every op;
- a mirrored mode emits exactly one transition per edge (count sink calls
  against model edge count — the dedupe-vs-drop failure both directions);
- **no sequence leaves an exclusive tag set with the stack empty.** This is the
  "stuck exclusive tag suppresses every command system-wide" failure stated as
  a property, and the op alphabet includes *mirror RPC failure*: the invariant
  under failure is the Wave 1 correction's clear-signal-survives form — a
  failed transition leaves the derivation re-emittable, never silently
  swallowed.

### Synthetic participants instead of `vi.mock`

The mock leaderboard for the modules these primitives replace:
`range-disambiguation` ×3, `codeword-holders` ×3, `selection-commands` ×2,
`find` ×2 — plus `escape-key-path.test.ts`'s own header apologizing for two of
them (mocked because they touch `chrome.*` at module scope). Once participants
register, tests **register synthetic ones** instead of replacing modules:
`escape-key-path.test.ts`'s mocks become synthetic stack entries driven through
the real `peelTop`, and the file's stated residual gap shrinks accordingly.
Migration rule: a Wave 3 step that migrates a module converts the tests that
mock it in the same step; the `vi.mock` count for these four modules is the
tracked metric, expected to reach zero at C5.

`escape-key-path.test.ts` itself is **the gate, not a migration casualty**: its
assertions are untouchable through the whole arc. Through C2 it must stay green
unmodified; C3 may mechanically update its `reset()` helper (the flags it
resets stop existing) but any change to an assertion is a design regression to
stop on, not a test to update.

### The mirror derivation is a pure function

`deriveMirror(frameStacks: ReadonlyMap<FrameId, readonly ModeId[]>, specs):
TagAssertion[]` lives in its own module with zero `chrome` imports; the SW
calls it, tests table-test it — the extension-side counterpart to A1's Go table
test. Cases from the review's own findings: a subframe caret stack sets the
tag; two frames in find yield one claim; popping one frame while another is
still in-mode keeps the tag; the empty map yields the empty set. The
edge-transition diff (previous assertion set → next) is a second pure function,
table-tested the same way, so the SW's own job reduces to transport.

### Coverage as a migration safety net

None is configured today (no coverage config, no provider installed). Add
`@vitest/coverage-v8` and a `test:coverage` script. Protocol:

- **Before C1**: record a baseline (per-file covered-line counts for the
  blast-radius list — the deletion inventory plus `content.ts`, `keyboard.ts`,
  `find.ts`, `palette-page.ts`) and commit it with the Wave 2 close.
- **After each C-step**: `scripts/compare-coverage.mjs` diffs against the
  baseline and fails when a surviving file's covered-line **count** drops
  (counts, not percentages — deleting well-covered code raises the percentage
  while losing the tests). A deleted file's tests must be either deleted with
  the code or migrated, and the commit message lists which.
- This checks "the migration lost no coverage," not semantic equivalence — the
  Wave 1 regression tests are the semantic gate. It is a migration tool, not a
  permanent CI gate, and it is removed at C5 close (no legacy debt).

---

## The monolith ceiling: fixed by Wave 3, made honest now

The ratchet (`scripts/check-ceilings.mjs`) is RED and has stopped gating:
`content.ts` 3814 vs ceiling 3620, `background.ts` 1335 vs 1300. Decision:

- **This arc fixes `content.ts`'s ceiling, in Wave 3, not Wave 2.** Wave 2 is
  new files only and moves neither monolith. C1 deletes the inline voice
  codeword paths and the `StoreCodewordHooks` injection; C3 deletes the floors
  and hooks; C4 deletes the mirror guards and the focus re-assert timer —
  comfortably more than the 194-line overrun, and every Wave 2/3 addition lands
  in modules, so the monoliths only shrink.
- **Until then, raise the ceilings to the current actuals (3814 / 1335) in one
  visible commit whose message records this paragraph.** A check that is always
  red is not a guardrail — for this session or for the other sessions sharing
  main. Raising to actuals restores the check's actual function (the *next*
  line of growth fails), and the script's own RATCHET-DOWN arm then forces each
  Wave 3 deletion to lock in its win. This is the raise said out loud, not the
  silent one.

## Wave checkpoints for the freeze and the retirements

The sensing-freeze accounting above (add zero; retire `caretActivePushed`,
`restoreBadges`, `entryFloor`, `pickWindowHooks`, `StoreCodewordHooks`, and the
300 ms focus re-assert timer) settles at specific steps, so it can be checked
rather than trusted: **Wave 2 is neutral** — new files, nothing imported,
nothing added, nothing yet retired. C1 retires `StoreCodewordHooks`; C3 retires
`entryFloor`, `restoreBadges`, `pickWindowHooks`; C4 retires
`caretActivePushed` and the timer. A wave that ends without its scheduled
retirements is the arc failing its own accounting.
