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

## What does not converge

**Allocation stays per-surface.** Page hints need codewords stable across
rescans and full reloads — `codeword-memory.ts` recalls them by DOM fingerprint,
and `label-pool.ts:478-500` returns labels en bloc so an immediate re-claim of
the same count yields the same labels. Palette rows are ephemeral, assigned in
empty-state order, discarded on close. Those are different requirements, and the
exclusive tag means the palette does not need the shared pool. Forcing it onto
the reservoir would fight page-hint stability memory and buy nothing.

Tabs scope has already converged on the right thing on its own — a row's
codeword is its tab's stable strip mark (`palette-page.ts:519-527`), so the badge
matches the strip. That instinct is correct and this note preserves it.

**Rendering stays per-surface.** The frame paints its own rows; `HintBadge`
positions against viewport rects and mounts a shadow host with page-adversarial
defences that mean nothing inside a trusted extension document. The frame
implements dim/undim locally against its own CSS. `BadgeVariant` is the existing
declaration of exactly this kind of per-surface paint policy and needs no change.

What converges is **eligibility, narrowing, exclusivity, and resolution** — the
rules that were duplicated. Not the paint, and not the pool.

## The tradeoff that must not be re-litigated

**One-word codewords and mid-utterance feedback are mutually exclusive.**
Feedback requires a step boundary; a step boundary requires at least two words.
No transport, registry or matcher change alters this. A single-token capture has
no midpoint to report.

`palette/codewords.ts:32` allocates uniform-length badges by row count: singles
at ≤26 rows, pairs to 650, triples beyond. The recommendation is to **keep that
tiering**:

- **≤26 rows → singles, no dimming, and none is owed.** The word *is* the whole
  key; there is no partial state to visualise. The user pays one word, as today.
- **>26 rows → pairs, dimming for free** once the holder is registered and
  capture progress is role-keyed.

This puts the feedback exactly where the complaint originates and taxes nothing
where it doesn't. The uniform-length-per-open invariant that makes chopping safe
(`codewords.ts:9-21`) is untouched — tiers still never mix within a session.

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

1. **`focus.go` capture progress keyed on role.** Independent, testable alone,
   and inert until a second multi-step capture exists. Land first.
2. **Relay message + host-side mirror.** No behaviour change yet — the mirror is
   populated and asserted against the frame's own map in tests.
3. **Register the holder.** Narrowing goes live. Palettes above 26 rows dim; the
   exclusive claim moves from ambient assumption to registry fact.
4. **HUD `title` field.** Independent of 1–3; can land any time.
5. **Fold `POST /palette` into the grammar batch.** Separate wave.

Steps 1 and 3 are the ones that close the reported gap. Step 2 is the transport
they both need.

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
