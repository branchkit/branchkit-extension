# The hint engine — one piece, with declared boundaries between hint types

**Status:** PROPOSAL, nothing executed. Written 2026-07-27 at the end of a
session that fixed five field bugs in this area; the bugs are the evidence and
are catalogued in §2.

**One-line thesis:** the badge substrate is already *shared* — the audit that
went looking for duplicated engines did not find them — but it is not
*located*. It is spread across eight directories plus the wiring in
`content.ts`, so no one can hold it, and the rules that belong to it keep being
re-implemented in the seams instead. Every bug in §2 is that, not duplication.

**What this is NOT:** a proposal to merge the element and range lifecycles.
That remains a non-goal for a reason this session re-confirmed (§5.1).

---

## 1. The distinction this note turns on

Two different questions get conflated, and answering the first one "no" does
not answer the second:

1. *Is logic duplicated across link hints, search badges and pick chips?*
   Mostly **no**. `HintBadge`, the stylesheet, APCA colours, placement,
   the reposition registry, the band planner, the codeword pool, the grammar
   transport and the holder registry are each ONE implementation with two or
   three consumers. Several were extracted after drift caused real bugs.

2. *Is the hint engine a comprehensible piece?* **No.** Its parts are
   correct and shared and scattered. There is no file, and no directory, you
   can open to see what a hint IS.

This note is about (2). Answering (1) is what produced the current state: each
extraction went to the nearest sensible home, and the nearest sensible home
was a different directory every time.

### 1.1 Where the engine currently lives

```
render/      hints.ts (HintBadge, BADGE_CSS)  range-badge-set.ts
             badge-variant.ts  badge-target.ts  badge-colors.ts
             badge-visibility.ts  reconcile-positioner.ts  mode-chip.ts
labels/      holder-registry.ts  store-holder.ts  label-reservoir.ts
             label-sync.ts  words.ts  rebind.ts  codeword-typing.ts
lifecycle/   settle-engine.ts  band-window.ts  reconcile.ts
             strict-viewport.ts  limbo.ts
placement/   position.ts  geometry.ts  stacking.ts
observe/     intersection-tracker.ts  container-resize-tracker.ts
scan/        element-wrapper.ts  scanner.ts  find.ts
core/        store.ts  mode-stack.ts
activate/    range-disambiguation.ts  search-badges.ts  keyboard.ts
content.ts   the wiring that ties all of the above together
```

Twenty-nine files across eight directories, and the assembly instructions are
in a file with zero exports.

---

## 2. The evidence: five bugs, one shape

Every bug fixed on 2026-07-27 was a rule that belongs to the engine, living
somewhere the engine could not see it. None was a duplicated *engine*.

| # | Symptom | Where the rule was | Commit |
|---|---|---|---|
| 1 | `f` over a committed search repainted the whole page | `content.ts` hint_mode read `badgesVisible` as "nothing painted"; find had *borrowed* the screen | `674a723` |
| 2 | Armed-border cue never fired on search badges | tinted badges pinned the alpha inline in `hints.ts applyColors`, beating the inherited armed write | `674a723` |
| 3 | Escape mid-codeword cancelled the whole pick | `peelTop` asks only the top spec; the prefix belonged to a `hint` entry underneath | `674a723` |
| 4 | A pick swallowed the entire Normal keymap (j/k stopped scrolling) | `range-disambiguation` called `enterHintMode()`, AND `keyboard.ts` routed `range_pick` into `handleHintKey` | `674a723` |
| 5 | Search badges silently pointed at text that no longer existed | `isRangeDead` could not see a collapsed range; nothing re-found the retained query | `1153fa7` |

Plus two duplications that were real, and both were *rules*, not engines:

- **The typing rule** was written twice with divergent semantics
  (`StoreHolder.soleMatch` fired on a unique prefix, `RangeBadgeSet.soleMatch`
  on the whole codeword). Unified into `labels/codeword-typing.ts`. It broke
  **zero tests**, because nothing had ever pinned the prefix behaviour — the
  signature of accidental behaviour.
- **The relabel fan-out** existed (`relabelAll()`) and one call site bypassed
  it, so chips and search badges kept rendering the previous display mode.

Read the table as a diagnosis: in four of five cases a generic mechanism
already existed and a hint type reached around it. That is what a scattered
engine causes. A developer touching the pick does not see the hint router; a
developer touching tinted fills does not see the armed-cue contract.

---

## 3. What is one thing, and what genuinely differs

The engine is not "everything about badges". Some things really do differ per
hint type, for reasons that are documented and were each learned the hard way.
A reorganisation that flattens them regresses. §5.2 is the full list; the
structural point is that the differences fall on **four axes**, and only one of
them is currently expressed as data.

| Axis | Link hints | Search badges | Pick chips | Expressed as |
|---|---|---|---|---|
| **Paint policy** | page fill, hide non-candidates, page defences, video suppression | find tint, dim, defences, suppression | page fill, dim, no defences, no suppression | ✅ `BadgeVariant` |
| **Identity + lifecycle** | element; rebinds by fingerprint (`labels/rebind.ts`) | text occurrence; re-finds by query (`refindCommitted`) | text occurrence; does not recover, cancels | ❌ implicit in two class hierarchies |
| **Claim / arbitration** | ambient, additive | additive overlay | exclusive overlay | ⚠️ a `priority` + `claim` field passed at registration |
| **Input policy** | typing narrows then fires on the whole codeword | same | same, plus the pick owns the answer | ⚠️ split between `codeword-typing.ts` and per-holder `narrow` |

`BadgeVariant` is already the right idea — a declared, per-type policy object —
and its doc comment is the best statement of the boundary in the codebase:

> *"They share everything — shadow host, stylesheet, APCA colours, size
> settings, placement, the reconciler — and differ only in how the set narrows
> … plus how much page-defence machinery a seconds-long badge should carry."*

The proposal is: **make that sentence true of all four axes, not just paint.**
Today a reader learns the identity/lifecycle boundary by inferring it from
`StoreHolder` vs `RangeBadgeSet`, and the arbitration boundary from three
constants in a registry two directories away.

---

## 4. Proposed structure

A `hints/` module that contains the engine and *declares* the boundaries.
Sketch, not a final layout:

```
hints/
  README.md            what a hint is; the four axes; where each type differs
  badge.ts             HintBadge + the stylesheet (from render/hints.ts)
  variant.ts           the per-type policy — grown to all four axes
  target.ts            element and range anchors
  colors.ts  place.ts  position/APCA
  pool.ts              reservoir + words + label-sync boundary
  registry.ts          holder registry (arbitration)
  typing.ts            narrowing + firing (codeword-typing.ts, grown)
  set/
    element-set.ts     the store's lifecycle: discovery, rebind, limbo
    range-set.ts       RangeBadgeSet
  types/
    link-hints.ts      HINT_VARIANT + its policy
    search.ts          SEARCH_VARIANT + re-find policy
    pick.ts            RANGE_PICK_VARIANT + cancel-on-churn policy
```

Three properties matter more than the exact tree:

1. **One directory you can read.** Including a README that states the four
   axes, so the next person meets the boundary before the code.
2. **Per-type policy is data in one file each**, not behaviour spread between
   a variant object, a holder registration, a key router case, and a call site
   in `content.ts`.
3. **The two lifecycles stay two**, adjacent and comparable, under a shared
   `set/`. Adjacency is the goal; merging is not (§5.1).

### 4.1 Sequencing

Do it in the order that makes each step independently verifiable:

1. **Finish the rule-consolidation already started.** `codeword-typing.ts`
   took the firing rule; narrowing is still 3 hand-written implementations
   (`store-holder.ts:163`, `range-badge-set.ts:250`, `:269`). Also: 5 sites
   call `poolLabelToAssignment` to derive a label; `reposition` has two
   implementations and zero production callers. Cheap, no structural risk.
2. **Grow `BadgeVariant` to the identity/lifecycle axis** — a declared
   `onChurn: 'rebind' | 'refind' | 'cancel'`, replacing knowledge currently
   implicit in which class you instantiated. This is the step that would have
   prevented bug #5.
3. **Move files.** Last, mechanically, once the boundaries are declared.

Step 3 is the least valuable and the most disruptive; steps 1–2 deliver most
of the comprehensibility win and are separately shippable.

---

## 5. Non-goals, and the load-bearing differences

### 5.1 Do not merge the element and range lifecycles

`notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md:154` already records this, and
2026-07-27 re-confirmed it from the opposite direction. The reason is
**identity**:

- an element wrapper rebinds by **fingerprint** among limbo candidates
  (`labels/rebind.ts:60`, falling back to positional with a distance
  heuristic);
- a search range re-acquires by **re-running its query**
  (`scan/find.ts refindCommitted`), because a text range has no element
  identity to fingerprint — its identity is *(query, occurrence)*.

Those are different mechanisms for different kinds of thing. The engine should
make them adjacent and name the axis; it should not make them one function.
The store also carries discovery, occlusion planes, build budgeting and exit
hysteresis that a ≤24-member set structurally does not have.

### 5.2 Differences that must survive any reorganisation

Each of these is documented at its site with a reason, and several were
regressions once already. A refactor that "simplifies" them re-opens a closed
bug:

- **hide vs dim non-candidates** — hundreds of hints declutter by hiding; ≤9
  chips must not, because their spatial arrangement *is* the question asked.
- **page fill vs tint** — chips decline a tint deliberately (a pick hides the
  page's badges, so modality carries the meaning); search takes one because it
  has no modality to lean on.
- **matched-prefix fade is NOT variant-scoped** — deliberately uniform; chips
  and search used a gold accent until 2026-07-26 and consistency won.
- **defendAgainstPage off for chips** — a correctness constraint, not a cost
  one: `trackTargetMutations` is keyed 1:1 per element with an unconditional
  untrack, so a chip over a hinted element would disconnect that link badge's
  observer on teardown.
- **suppressOverVideo off for chips** — the failure mode inverts: the codeword
  stays live while paint is suppressed, so the user is asked to pick from
  options they cannot see.
- **trackContainer ON for both** — an explicitly *reverted* difference; chips
  were given no observers and stranded when a block was inserted above them.
- **exclusive vs additive claim** — a pick swallows every codeword; search
  falls through so link hints stay speakable.
- **occlusion/CSS-visibility excluded for ranges** — deliberate and named as a
  known gap, not parity: text under a sticky header is still pickable, and the
  per-member cost is meant for hundreds of wrappers.
- **claim-level vs paint-level "who holds"** — the store splits these because
  the reservoir's leak sweep once reclaimed a live wrapper's codeword; range
  sets have no such split.
- **band `hardCap` on for ranges, off for hints** — for hints the budget is a
  geometric target, for chips it is a promise the overflow toast makes.
- **a pick takes the screen but NOT the keyboard** (2026-07-27) — `f` hands
  the keyboard over for every hint type.

---

## 6. Open questions

1. **Does `BadgeVariant` become the single per-type object, or does a `HintType`
   descriptor own the variant plus lifecycle plus claim?** The second is more
   honest but touches registration order, which the exhaustiveness lint pins.
2. **Where does `content.ts`'s hint wiring go?** The engine could own its own
   registration (a `hints/install.ts`), which would remove ~17 seams from the
   monolith. This is the one place this note certainly overlaps
   `DESIGN_ENTRY_POINT_TOPOLOGY.md` — see §7.
3. **Is `store.all` still the right membership spine**, or does the element set
   become a peer of `RangeBadgeSet` under `set/`? The exhaustiveness lint pins
   81 `store.all` sites across 19 modules, which is a good measure of how much
   would move.
4. **Does the find session belong in the engine at all?** `refindCommitted`
   made search's recovery a find-module concern. Arguably right (the query
   lives there); arguably the engine should own "how a hint type recovers".
5. **Does anything here apply to a fourth hint type?** The design should be
   checked against one that does not exist yet — e.g. hints over a11y nodes,
   or over a canvas — to see whether the four axes are actually the axes.

---

## 7. Relationship to `DESIGN_ENTRY_POINT_TOPOLOGY.md`

Written independently and deliberately not shaped to avoid collision — the
author of this note read that note's thesis and phase list, and was asked not
to let it constrain the proposal, so that a genuine collision would be visible
rather than designed around.

The known overlap is **`content.ts`'s callback/init seams** (that note's Phase
2, ~17 seams; this note's §6.2). Both want to move them, for different reasons:
topology wants the monolith to stop knowing every module exists; the engine
wants its own wiring to live with it. Those may be the same move or opposite
ones. Whoever sequences second should read the other first; this note does not
try to resolve it.

Also worth noting: this session ADDED one such seam (`setRefusedKeyCallback`,
`4912f51`) as the correct fix to a two-writer bug, after the line ceiling had
previously pushed it the wrong way. That is a small worked example of the
tension — the right local fix grows the monolith's wiring.
