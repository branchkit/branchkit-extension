# Codeword key-ownership (Regime A refinement) + soft-detach unification

**Status:** proposal (2026-06-07). Options with tradeoffs, not a locked plan.
Extends `notes/completed/DESIGN_CODEWORD_STABILITY.md` (the Regime A/B model and
the "gate on confidence, not location" spine). Pairs with
`notes/INVESTIGATION_LIMBO_BADGE_FLASH.md`.

## Why this exists

QuickBase table-switch churns the sidebar's codewords: every switch, each table
link (App home, Users, the JSC/SVC tables) re-letters and takes a fresh registry
id. Established this session:

- **Not a regression.** Confirmed by A/B against `3eabb0b` (pre-restructure
  baseline) — it churns there too. Nothing in the restructure / flash fix /
  live-recall work caused it.
- **It's app-specific.** Some QuickBase apps keep the sidebar DOM stable (no
  churn); others re-mount it. The churning ones are the target.
- **Root cause is an availability race, not a matching failure.** Snapshots show
  the fingerprints match exactly across the switch (href included). The letter
  still changes.

## The race, precisely

Letters come from a finite shared pool; no two live elements may hold the same
letter at once. On a churning app, QuickBase re-mounts the sidebar
**add-before-remove**: it builds the new "Users" `<a>` node *before* removing the
old one, across separate mutation batches.

1. Old "Users" holds `harp bat`.
2. New "Users" node appears and is discovered. It wants `harp bat` (recall knows
   the fingerprint→letter), but the old node is **still connected and still
   holding it** → pool can't grant it → new node gets a fresh `cap ink`.
3. Old node is removed, releasing `harp bat` — too late.

Why the existing rescues miss it:

- **limbo/rebind** only matches *disconnected* wrappers (it deliberately excludes
  still-connected ones, or it would steal letters off elements that are genuinely
  staying). During the overlap the old node is still connected → not eligible.
- **soft-detach** (voice path) parks everything in limbo to protect letters across
  the nav, but **graduation un-parks at 250ms** and QuickBase's swap lands later
  (measured ~300ms+), so the protection has lapsed by the time it's needed.

The letter is bound to the **DOM node**. "Node left" means "release," and a
re-mount is normal node departure — so the binding is anchored to the wrong thing.

## Layer 1 — anchor the letter to a stable key, not the node

Top tier of the confidence spine: when an element carries a key that is both
**stable** and **unique on the page** (`href`, `id`, and similar intrinsic
identifiers), treat that key as the owner of the letter instead of the DOM node.

- **Claim:** resolve the element's key → if a letter is already reserved for that
  key, the element takes it; else claim fresh and reserve it to the key.
- **Overlap is a non-event:** during add-before-remove, old and new "Users" share
  the same key, so they transiently share `harp bat`. No pool contention, nothing
  to wait for. When the old node leaves, the letter simply stays with the
  survivor. The order of operations stops mattering.
- **No steal risk:** the key is *unique on the page*, so there is no second
  element to take the letter from. This is the safety property the still-connected
  exclusion in limbo was protecting — preserved here by construction.

### The release question (the load-bearing part)

Node-ownership released on "node left." Key-ownership cannot — that's the whole
point. New rule:

> Release a key's letter when the **key is no longer present on the page** — i.e.
> no element with that `href`/`id` exists anymore — not when any single node
> leaves.

- During the overlap the key is continuously present → never released.
- Navigate away (the link genuinely disappears) → key absent → release.

Consequences, honestly:

1. **Detection cost:** we now release on *key absence*, which means checking "does
   any element with this key still exist?" The discovery/reconcile pass already
   walks the DOM, so the check rides along — no new traversal.
2. **Pool pressure:** at any instant we hold one letter per *distinct present
   key* — same order as today's live-element count, so steady state is no worse.
   The new risk is accumulation across long SPA sessions without a full reload.
   Backstop: release keys absent past a short grace, and LRU-evict *absent* keys
   if the pool runs tight. Never evict a present key (that would re-introduce
   churn).
3. **Timing moves to the forgiving side:** the only timing left is on *release*.
   Releasing a little late just holds a pool slot slightly longer (mild,
   self-correcting). The unforgiving, user-visible timing — the *claim* race — is
   gone. This is the core win.

### Fallback

Anything without a unique stable key (icons, the many identical "Reply" /
"More actions" buttons on YouTube comments) is **not** eligible for
key-ownership. It falls straight back to today's fingerprint + limbo + position
behavior. Key-ownership only acts where identity is unambiguous.

### Voice resolution during overlap

While two nodes share a letter, the registry's two-tier resolution (live WeakRef,
then fingerprint) targets the live one; the departing node resolves away as it
disconnects. Sub-frame overlap, never user-visible.

## Rejected / deferred alternatives

- **Affinity pool + corrective reconcile** (released letter remembers its last
  owner; a second pass swaps the new node back onto its old letter): converges to
  stable but with a perceptible **re-letter flicker** each switch. User rejected
  the flicker. Key-ownership dominates it for the unique-key case (no flicker).
- **Deterministic letter from key (hash):** speakable letter set is too small;
  collisions are unavoidable and two elements can't share a letter for voice.
  Non-starter.
- **Looser fingerprint matching:** would help a *different* failure (elements
  whose visible text shifts under a stable identity), but raises false positives →
  letter points at the wrong element → saying it clicks the wrong thing. Worse
  than churn for voice. Not part of this note.
- **Name-as-handle** (voice targets well-labeled elements by name, no assigned
  letter): plausibly removes the problem for named nav entirely, but it's a larger
  interaction-model change. Flagged as an open question, out of scope here.

## Layer 2 — shrink soft-detach / unify the voice and mouse paths

**LANDED 2026-06-07.** `softDetachAllForNav` → `preNavObserverTeardown`: it now
only does the synchronous per-element observer teardown (the wedge preempt) and
no longer parks wrappers in limbo. Codeword stability across a voice nav flows
through the same reactive path as a mouse nav (dropDisconnectedWrappers on the
real disconnect → Layer 1 key-ownership / limbo-rebind / Regime-B recall), so the
voice path converges on the known-good mouse path and the graduation-timing
fragility (limbo un-parked at 250ms, ahead of slow swaps) is gone. The QuickBase
97% is unaffected — that comes from Regime-B *reload* reclaim, not the soft-detach
limbo. Dropped the now-dead `enterLimbo`/`peekCachedRect` imports in content.ts.
619 tests, both builds clean. Not fixture-coverable (content.ts voice path) — a
quick real-voice re-test is the only end-to-end check.

(Original analysis below.)

Enabled by Layer 1; not a standalone change.

Voice and mouse already converge at the shared `spa_nav` rescan. The only
divergence is the voice-only `softDetachAllForNav` pre-step, which bundles two
jobs:

1. **Wedge preempt (performance):** synchronously tear down per-element observers
   *before* the simulated click triggers the DOM swap, dodging the 600+
   observer-callback cascade (the nav-time wedge). Structurally voice-only — a
   real mouse click gives no hook to run code before it navigates.
2. **Codeword stability:** drop wrappers into limbo so letters survive the nav.

Layer 1 makes job 2 unnecessary: identity-anchored letters survive the generic
rescan without pre-parking. So:

- Strip job 2 out of `softDetachAllForNav`; it shrinks to a thin voice-only wedge
  preempt (job 1).
- Both paths get codeword stability from the same identity-anchored mechanism —
  one behavior, less special-case code, and the soft-detach/graduation timing
  fragility that bit QuickBase goes away.
- **Keep** the voice-only wedge preempt. A literal one-path merge is not a goal;
  that asymmetry (voice can preempt, mouse can only react) is real and earned.

Doing Layer 2 *without* Layer 1 backfires: deleting soft-detach today loses both
the wedge protection and voice codeword stability — strictly worse. Sequence
matters.

## Risks / what to verify

- **Blast radius:** Layer 1 changes pool accounting (a key→letter reservation
  alongside node-based release) and Layer 2 touches the limbo/teardown/nav code —
  the area that has repeatedly broken steady-state browsing despite green tests.
  Ship one layer at a time; **30+ min real-Chrome soak before either merges**
  (per the orphan-teardown incidents). Playwright is a smoke pass, not the soak.
- **Steal check:** verify dup-heavy pages (YouTube comments) fall back cleanly and
  do not regress — the unique-on-page gate is the safety boundary; prove it holds.
- **Pool exhaustion:** exercise a long SPA session (many distinct keys over time)
  and confirm the absent-key grace + LRU bounds the reservation set.
- **Verification surface:** Ctrl+Option+A snapshots before/after a table switch —
  same key should keep id + letter. The churn tell is fresh ids + changed
  codewords on identical fingerprints.

## Open questions

- Which attributes count as "strong keys," and in what priority? (`href` for
  links is the clear first; `id`; `name`; `data-testid` where present.)
- How is "unique on the page" computed cheaply, and is it per-frame?
- Does key-ownership belong in the reservoir, the registry, or a new small
  key→letter table consulted at claim time?
- Name-as-handle: worth a separate exploration, or does key-ownership cover
  enough that it's unnecessary?

## Sequencing

1. Layer 1 (key-ownership + release-on-key-absence + fallback) as its own
   revertable change, with the steal/pool/soak checks above. This is the actual
   fix for the churn.
2. Layer 2 (soft-detach shrink / path unification) as the cleanup Layer 1
   unlocks, once Layer 1 has soaked.

## Layer 1 implementation plan (shape b — transfer via rebind) — 2026-06-07

Scoping at the reservoir confirmed the mechanism: `claim`'s preferred-reclaim only
grants a letter that's in the `free` queue (`label-reservoir.ts`). During the
overlap the predecessor holds the letter in `outstanding`, not `free`, so the
successor can't reclaim it. Shape (b) sidesteps the pool entirely: transfer the
existing wrapper (letter + id) onto the new node via the existing `rebindWrapper`.

**Refinement found while scoping — the safety gate is "one wrapper per key," not
"unique on page."** By the time the successor is discovered, the predecessor is
usually *live* again: on the voice path it has graduated out of soft-detach
(250ms) before QuickBase's later swap; on the mouse path it was never parked. So
we can't gate on limbo state, and we can't assume the predecessor is gone. The
gate that actually works: **rebind only when exactly one existing wrapper holds
the new node's strong key.**

- Transient overlap → exactly 1 predecessor wrapper with the key → rebind. Fixes
  both voice and mouse with no graduation-deferral.
- Genuine duplicate (header + footer both linking home) → 2+ wrappers with the
  key → ambiguous → skip, claim fresh (they keep distinct letters).
- This subsumes the earlier "unique on page" idea and removes the need for a new
  key-absence release sweeper — release stays the existing limbo→finalize path
  (the predecessor's old node is orphaned and reaped normally).

**Key scope:** `href` only for Layer 1 (links). It's action-equivalent (two same-
href elements do the same thing, so a wrong guess is harmless) and stable. `id`
is deferred — framework-generated ids (`:r1:`, `ember123`) are unstable and would
*cause* churn if used as a key.

**Ping-pong guard:** after transferring the wrapper to the new node, the old node
is briefly connected but wrapper-less. Mark it orphaned (`WeakMap<Element,
number>`); discovery skips recently-orphaned nodes for a short window
(~2s) so it isn't immediately re-grabbed and bounced back. Known residual edge:
two same-href nodes that both persist long-term *and* appear sequentially could
oscillate once per window — action-safe (same href), accepted.

**Touch points:**
- `scan/registry.ts` — `computeStrongKey(el): string | null` (href → `h:<href>`,
  else null for Layer 1).
- `observe/limbo.ts` — `collectStrongKeyIndex(): Map<string, ElementWrapper|null>`
  (null marks a key held by 2+ wrappers = ambiguous); `tryRebindByStrongKey(newEl,
  keyIndex, limboPool)` (consume from both index and limboPool on success, mark
  old node orphaned, call existing `rebindWrapper`); the orphaned WeakMap +
  `isRecentlyOrphaned`.
- `core/wrapper-lifecycle.ts` — `attachDiscovered` gains the orphan-skip and the
  strong-key step (before the fingerprint-limbo step), plus a `keyIndex` param.
- `content.ts` — `discoverInSubtree` / `discoverInSubtreeBatched` build the index
  (`collectStrongKeyIndex()`) once and pass it (mirroring `limboPool`).
- No change to the release path; no new sweeper.

**Invariant preserved:** one letter ↔ one element throughout (transfer, never
share), so grammar/delta-sync/routing are untouched. `rebindWrapper` keeps the id
and codeword, so no grammar re-push is needed for a transfer.
