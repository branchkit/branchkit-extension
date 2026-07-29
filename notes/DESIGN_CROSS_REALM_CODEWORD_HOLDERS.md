# Design: Codeword holders across a realm boundary

**Status:** Proposal, 2026-07-29. Extends `DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md`
(Primitive 1) with the participant it could not reach. Nothing here is landed.
The badge target seam (`DESIGN_BADGE_TARGET_SEAM.md`) and the two badge
lifecycles stand unchanged; this note adds no third one.

## Problem

Speaking a page-hint prefix dims the badges that can't finish it. Speaking a
palette codeword does nothing until the whole key lands — no dimming, no
progressive narrowing, no feedback of any kind. The Discovery HUD does enumerate
palette rows, but it subtitles them with raw `row_id` values (`tab:12`,
`cmd:pin_tab`).

The instinct is to add dimming to the palette. That is the wrong unit of work,
and the reason is worth stating precisely, because it generalises.

## The taxonomy is off by one

It is natural to read the surfaces as three kinds of hint — page links/inputs,
search/highlight, palette rows. In the code the first two are **already one
engine**, and have been since the range-badge work:

| | page hints | search badges | pick chips | palette rows |
|---|---|---|---|---|
| codewords from | label reservoir | label reservoir | label reservoir | own module |
| allocation | `label-pool.ts` pairs | same | same | `palette/codewords.ts` 1–3 tiers |
| transport | `POST /grammar/batch` | same | same | `POST /palette` |
| collection | `browser_hints_*` | same | same | `browser_palette` |
| capture | `prefix`+`suffix` | same | same | `{browser_palette}`, single |
| renderer | `HintBadge` | same | same | iframe DOM |
| `CodewordHolder` | yes (`store`) | yes (`search`) | yes (`pick`) | **no** |
| narrowing | free | free | free | **none** |

Search and pick differ from page hints in exactly one declared place —
`BadgeVariant.nonCandidate`, `'hide'` versus `'dim'` (`render/badge-variant.ts:56`).
That is the reuse working as designed.

So there is one engine and one defector. And the axis that separates them is not
what kind of thing is being labelled. It is **which JS realm the surface lives
in.**

## Why the palette forked: a realm boundary, not a preference

`render/palette-host.ts:4-10` is explicit — the palette is an extension-served
iframe rather than an in-page shadow DOM because palette keystrokes reveal tab
titles and command names and the host page must not observe them. That
constraint is correct and this note does not reopen it.

The consequence is that the entire codeword stack — `holder-registry.ts`,
`label-reservoir.ts`, `codeword-typing.ts`, `HintBadge` — is content-script
resident and unreachable from `palette-page.ts`. So the palette re-derived it:

- `palette/codewords.ts:9-21` re-argues chop-safety from scratch, arriving at
  the uniform-length invariant that `label-pool.ts:21-27` already encodes.
- `background/palette.ts:93` adds `POST /palette` beside the grammar batch.
- `palette-page.ts:338` (`typeMarkLetter`) implements narrowing as a list
  re-render, gated to tabs scope in letter mode (`:456`) — keyboard-only, no dim
  state, no voice path. In the full palette, keystrokes go to fuzzy title search
  (`:409`) and multi-word codewords have no partial feedback at all.

None of that is careless. Each piece is a locally correct answer to "the shared
one isn't reachable from here."

The predecessor note's own diagnosis applies verbatim: *the difference is
exactly whether adding the fourth participant is a registration or an edit in N
files.* For `CodewordHolder` the palette was neither — it was a reimplementation,
because registration was not physically available to it.

## The precedent already exists

The palette **does** participate in the sibling registry from that note. The
mode stack reaches it — but not from inside the frame:

```
render/palette-host.ts:114   modes.push('palette');   // the stack rides the overlay's one lifetime
render/palette-host.ts:121   modes.pop('palette');
```

The **host content script** joins the registry on the frame's behalf, keyed to
the iframe's lifetime, which it already owns. The frame never touches `modes`.

That is the shape this note generalises. The host is the palette's proxy into
content-script-realm registries. One registry already works this way. The second
should too, in the same file, on the same lifetime.

## The change

**1. The host registers a `CodewordHolder` for the palette.** In
`palette-host.ts`, beside the existing `modes.push`/`modes.pop` pair:
`registerHolder(...)` on open, unregister on close. `claim: 'exclusive'`,
`priority: EXCLUSIVE_OVERLAY_PRIORITY` — the palette already suppresses page
hints via its exclusive plugin tag, and this makes the in-page half of that
suppression a registry fact instead of an ambient assumption.

**2. The frame reports its assignment once, over the existing relay.** The rows
live in the frame (`tabItems`/`commandItems`/`bookmarkItems`), and assignment is
already a single deterministic event —
`assignAndPublish` (`palette-page.ts:517`), once per open, never on refilter.
Add one frame → host relay message carrying the same `{codeword, row_id}` list
it already sends to the background, at the same call site.

This is a one-way projection off a single source with the same lifetime as the
collection push that already happens — not two artifacts kept in sync. There is
no mid-session drift to reconcile because there is no mid-session reassignment.

**3. Keep the interface synchronous.** With the codeword list mirrored host-side,
`held`, `matchesPrefix`, `soleMatch` and `resolve` answer locally and
synchronously — the keyboard path calls them synchronously and must keep doing
so. Only `narrow(prefix)` crosses the boundary, and its return type is already
`void`, so the crossing is fire-and-forget by construction.

**Making the 11-member interface `async` to serve one remote implementation is
the thing to avoid.** It would contaminate three healthy local holders to
accommodate the fourth. The mirror exists precisely to prevent that.

**4. Generalise capture progress on role, not on name.** `plugins/browser/src/focus.go:647`
reads `event.Captured["prefix"]` and returns if absent. That is a literal string
match against one command's capture name, so no other multi-step capture on any
surface can ever produce progress. It should forward on the structural property —
a non-terminal step of a multi-step capture — regardless of what the step is
called.

This is the piece that is actively wrong today rather than merely missing, and
it is what unblocks every future surface rather than this one.

## What does not converge, and the rule for deciding

**Allocation complexity tracks anchor volatility.** That is the whole rule, and
it is what separates the layer that converges from the layer that doesn't.

Every expensive mechanism in the label pool is a response to the anchor set
changing underneath it:

| pressure | machinery it forces |
|---|---|
| elements appear / vanish mid-session | rebinding, `observe/limbo.ts`, the identity registry |
| the viewport scrolls | claim on band entry, release on exit (`intersection-tracker.ts:330,236`) |
| the document reloads | fingerprint recall (`codeword-memory.ts`) |
| frames compete for one tab-scoped pool | free/reserved/assigned, stale-reservation steal, dead-doc reap, per-tab locks, confirm arbitration |
| the page is adversarial | shadow host, attribute defender, inline-style avoidance |

The palette receives **none** of those inputs. Its rows are assembled once at
open, assignment runs once in empty-state order, refiltering never reassigns, and
the set drains at close. The structural guarantee is stronger than convention:
`palette-page.ts` registers no `chrome.runtime.onMessage` listener at all — only
the `window.postMessage` relay — so nothing can push a row update into the frame.
The list cannot destabilize; the only mutation available to it is teardown.

So the pool's stability machinery would be pure overhead on a set that has no way
to become unstable, and adopting it would additionally fight page-hint recall for
a shared resource the palette's exclusive tag means it never needed.

**The rule for the next surface**, stated so this is judged rather than
re-argued: a new badge surface joins the holder registry **always** — eligibility,
narrowing, exclusivity and resolution are the same questions no matter how the
anchors behave. It inherits the **pool** only if its anchors can move.

Tabs scope is the worked example, and it got there on its own: a row's codeword is
its tab's stable strip mark (`palette-page.ts:519-527`), so the badge matches the
strip. Tab identity outlives the palette, so that allocation is borrowed rather
than invented — the volatility rule applied correctly without anyone writing it
down. This note preserves it.

**One thing the rule does not cover.** If a tab closes while the tabs palette is
open, that row's dispatch goes stale. That is a *liveness* failure — the row
points at something gone — not an *allocation* failure; the codeword remains
uniquely and correctly assigned. It wants its own answer (reject-and-report at
dispatch, most likely) and it is not an argument for the shared pool.

**Rendering stays per-surface.** The frame paints its own rows; `HintBadge`
positions against viewport rects and mounts a shadow host with page-adversarial
defences that mean nothing inside a trusted extension document. The frame
implements dim/undim locally against its own CSS. `BadgeVariant` is the existing
declaration of exactly this kind of per-surface paint policy and needs no change.

What converges is **eligibility, narrowing, exclusivity, and resolution** — the
rules that were duplicated. Not the paint, and not the pool.

## The tradeoff that must not be re-litigated

**One-word codewords and mid-utterance feedback are mutually exclusive.**
Feedback requires a step boundary; a step boundary requires at least two steps.
No transport, registry or matcher change alters this. A single-step capture has
no midpoint to report.

`palette/codewords.ts:32` allocates uniform-length badges by row count: singles
at ≤26 rows, pairs to 650, triples beyond. Keep that tiering: at ≤26 rows the
word *is* the whole key, there is no partial state to visualise, and the user
should keep paying one word. The uniform-length-per-open invariant that makes
chopping safe (`codewords.ts:9-21`) is untouched — tiers never mix within a
session.

### CORRECTION (2026-07-29): two words is not two steps

An earlier draft of this note said pairs get dimming "for free" once the holder
is registered and capture progress is role-keyed. **That was wrong**, and the
distinction it missed is the one that governs the whole feature.

`palette_select` captures `{browser_palette}` — ONE step, a single named-entity
lookup. A key of two *words* ("ocean river") is still one *capture*, so the
matcher has no boundary at which to emit progress. Verified empirically: every
`capture.progress` in `actuator.log` carries `next_collection: browser_alpha`
(the hint pair) and not one carries the palette.

So the holder registration and the role-keyed forwarding are **necessary and not
sufficient**. They are the transport; the palette currently has nothing to put
on it.

**The remaining piece is a prefix-shaped projection.** Allocation and capture
shape are separable, and only allocation was argued above: the palette can keep
assigning its own codewords (its rows can't move; it needs none of the pool's
stability machinery) while projecting them into a two-step collection family the
way `batch.go` does for hints — `browser_palette_<prefix>` plus a
`browser_palette_prefix` index, with `palette_select` becoming
`<prefix:…> <suffix:…>`. Then the boundary exists, progress fires, and the
already-built path lights up.

That is a matcher-facing change to a working selection flow, so it wants its own
wave and a live pass, not a bundle with the transport.

### Field confirmation + the exact emit condition (2026-07-29)

User test, tabs-scope palette, mark `io` → spoken key `"is opal"`:

```
words=["is","opal"]  → winner=GatedUnscoped   (the whole key matches; row activates)
words=["is"]         → winner=NoMatch, partials=0/4, gated_partial_seen=false
```

Zero partials — a bare prefix is not an in-progress match, it is an unmatched
word. So all three symptoms (no dim, no HUD narrow, no activation on pause) are
one cause.

**The emit condition, read off `matching_service.rs:2326-2349`.** Progress fires
when the command's NEXT token is either:

- a `DependentCapture` whose template resolves AND whose resolved collection is
  in `entity_cache`; or
- a plain collection `Capture` with a non-empty binding set (`!named.is_empty()`).

Hints take the second arm: both slots are `Capture(_, "browser_alpha")`
(`collections.go:204-206`), so once `prefix` binds, the next token is a plain
collection capture and progress emits with `next_collection: browser_alpha` —
exactly what the log shows. **The per-prefix `browser_hints_<prefix>`
collections are for HUD `DisplaySource`, not for matching.** (Note
`collections.go:139`'s doc comment still describes the older
`<suffix:browser_hints_${prefix}>` dependent form — stale against the code.)

So the requirement is exact: **the palette command needs a second capture
token.** Nothing else moves it.

**Why the palette must use ENTITY captures, not `browser_alpha`.** Copying the
hint shape (two `browser_alpha` slots) would make any alphabet word pair match,
with resolution deferred to the extension. That is safe for hints but not here:
a bare `"is"` would then COMPLETE a one-slot variant and fire before the user
reaches "opal" (per `collections.go:222-232`, a Complete beats a Partial). The
projection must therefore be precise —
`Capture("prefix", "browser_palette_prefix")` plus
`Capture("suffix", "browser_palette_${prefix.codeword}")` (the dependent form,
first arm), with the flat `browser_palette` collection holding ONLY single-word
keys so a pair's first word can never complete it.

**Mixed lengths are safe.** Within one open, keys are either uniform (full
palette, `codewords.ts:32`) or prefix-free (tabs scope: singles come from
`LETTERS_26.slice(0, MARKER_SINGLES)`, pairs only from the tail, so a pair's
first letter is never a single mark). A first word therefore either completes a
single key or starts a pair — never both.

**Scope of the change.** The palette command is EXTENSION-CONTRIBUTED, not
plugin-built, so step 5 spans four places:
`command-catalog.ts` (the pattern) · `contribute.go`
(`parsePatternSlots` has no dependent-template form, and the palette needs its
own `DisplaySource` pair rather than the hint one at `:422-423`) ·
`palette.go` (split entries by word count; project the prefix index and the
per-prefix collections) · `plugin.json` (declare `browser_palette_prefix` and
`browser_palette_*`, with grammar seeds).

Three-word keys (>650 rows) stay atomic and unnarrowed — documented, and
vanishingly rare.

## Also in scope, downstream

`browser_palette` declares no `display` block, so HUD subtitles auto-derive from
`feeds_matching.value_field` — `row_id` (`matching_service.rs:2591-2597`). Rows
read `ocean` / `tab:12`. Page hints avoid this by pointing `DisplaySource` at the
object-shaped `_strict` collections. Add a human `title` field to the schema,
marked `display: secondary`, populated at the same single publish point.

`POST /palette` is a fourth strand of the same fork and should fold into the
grammar batch path, per the standing preference for extending the unified
collection API over adding RPCs. It is downstream of everything above, not a
prerequisite, and should not be bundled into the same wave.

## Sequencing

1. **`focus.go` capture progress keyed on role.** ✅ LANDED (browser `ecb7e82`).
   Plugin-side only — the event already carried `next_capture` /
   `next_collection`, so no actuator or contract change was needed. Inert until
   a second multi-step capture exists.
2. **Relay message + host-side mirror.** ✅ LANDED (ext `37d9897`).
3. **Register the holder.** ✅ LANDED (same commit). Runs the shared conformance
   suite and joins the registration meta-test. The exclusive claim is now a
   registry fact rather than an ambient assumption.
4. **HUD `title` field.** ✅ LANDED (browser `d621b08`, ext `e69ea2f`).
5. **Prefix-shaped palette projection.** ⬅ THE REMAINING PIECE. Until this
   lands, 1–3 are a transport with nothing on it: `{browser_palette}` is a
   single capture, so no progress is ever emitted for the palette and
   `narrow()` is never called. See the CORRECTION above. Wants its own wave —
   it changes the matcher-facing shape of a selection flow that works today.
6. **Fold `POST /palette` into the grammar batch.** Separate wave, unchanged.

Steps 1–4 are green and verified by unit tests, the conformance suite, and the
exhaustiveness lints. **None of them is user-visible yet.** The visible fix is
step 5, and honest reporting of that gap matters more than the green suites:
registration proves the palette can be narrowed, not that it is.

## Risks

**The exclusive claim changes suppression semantics in-page.** Today page hints
are suppressed while the palette is open by the plugin's exclusive tag, matcher
side. Registering an exclusive holder adds a second, in-page suppression via
`holder-registry.ts:288`. These must agree. The failure mode is a palette that
opens and leaves page badges live, or one that closes and doesn't restore them —
both visible immediately, neither silent.

**The mirror can go stale if assignment ever stops being once-per-open.** It is
once-per-open today and the module header commits to it (refiltering never
reassigns). If that ever changes, the mirror becomes a genuine dual-sync and this
design must be revisited rather than patched. Worth an assertion at the publish
point rather than a comment.

**Firefox relay privileges.** The relay exists because the frame's direct
`runtime.sendMessage` resolves undefined on Firefox (`palette/relay.ts:1-10`).
The new message is frame → host, the leg that already works there. It should
carry the same secret discipline as `RELAY_RESP`; a page-forged codeword map
would be a mis-dispatch, not just a rendering artifact.

## Sensing-freeze accounting

No new observer, timer, gate or memo. The holder registration rides the iframe
lifetime `palette-host.ts` already tracks. Retired on completion:
`palette-page.ts`'s local prefix-classification path (`typeMarkLetter` /
`classifyMarkInput`) once narrowing arrives through the registry, and the ad-hoc
`POST /palette` client at step 5.

## What this does not touch

The recognition engine and the matcher (Layer 1 / Layer 2) — no grammar,
vocabulary, `narrow_to` or DAG work. Capture progress is a plugin-side forwarding
fix, not a matcher change. The band planner, the badge target seam, the two badge
lifecycles, and the palette's iframe isolation boundary all stand unchanged.
