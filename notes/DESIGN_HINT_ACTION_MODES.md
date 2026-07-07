# Design: Hint action modes — pick a badge, do X (not just click)

**Status:** Phases 1–4 **landed + live-verified** 2026-07-06 (committed local,
unpushed). Phase 1 (unify armed booleans → `pendingHintAction`), phase 2
(focus + copy-text, keyboard `gf`/`yc` + voice "focus {hint}"/"copy text
{hint}"), phase 3a (keyboard hover `gh`), phase 4 (**voice caret control** — the
architecture-aligned tag-mode: plugin `plugin.browser.caret` exclusive tag +
`POST /caret` + `context:"caret"`; extension `voiceContext:'caret'` +
`CARET_ACTIVE` push). Live-verified against the real extension: 6/6 in
`scripts/_verify-hint-actions.mjs` (yank regression + focus/copytext/hover),
24/24 in `scripts/_verify-marks-caret.mjs` (incl. voice-caret dispatch + the
`CARET_ACTIVE` push edges); plugin tag lifecycle in `caret_test.go`. Only the
matcher's tag-gating needs a live host to confirm. Phase 5
(**enter-caret-at-badge**): `caret_hint` (keyboard `gv` + voice "select {hint}")
→ `CaretController.enterAt(el)` starts a caret/visual selection at a picked
element — completing the pure-voice flow (pick by voice → drive by voice → "copy
that"). Extension-only (the voice verb rides the generic `{hint}` contribution
path). Verified 7/7 in `scripts/_verify-hint-actions.mjs` (`gv` + codeword →
caret at the link, extend+yank captures its text). Phase 3b (**hover contribution
consolidation**): hover's voice ("hover {hint}") moved from the plugin's bespoke
`collections.go` command into the extension catalog (`hover_hint`,
`retainsHints:true`) via the generic `{hint}` path — so every badge verb now
lives in one place. The plugin's manual hover block is deleted; the generic path
even improves it (uses the `_strict` voice-matchable suffix like the other
verbs). Plugin `grammar_test.go` count 6→5. Keyboard hover re-verified (7/7);
live "hover {codeword}" voice match needs a host. **All phases (1–5 + 3b)
complete.**

Vimium's "hint modes": a badge you
pick can do more than click — hover it, focus it, copy it, start a selection at
it. Vimium-C ships ~20; this scopes the high-value subset for BranchKit and,
importantly, cleans up an inconsistency the audit surfaced. Follow-on to
notes/DESIGN_MARKS_AND_CARET.md.

## Current state (grounded in the code)

A badge can already be:
- **clicked** — `activate` (voice `{hint}`, keyboard: hint mode + type)
- **opened in a new tab** — `activate_hint_newtab` (voice "blank", keyboard: the
  capital-letter affordance / `newTabArmed`)
- **opened in background** — `activate_hint_background` (voice "stash {hint+}")
- **URL-copied** — `yank_hint` (keyboard `yf`; `yankHintArmed`)
- **hovered** — voice "hover \<hint\>" → content's `dispatchHover` path
  (fully built, `content.ts` BRANCHKIT_ACTION `action === 'hover'`).

Two problems this exposes:

1. **Split contribution.** newtab/stash/yank are contributed by the **extension**
   (command-catalog.ts → `buildCommandContributions`); **hover** is contributed
   by the **plugin** (`plugins/browser/src/collections.go`). The extension is
   supposed to own the badge vocabulary (notes/DESIGN_COMMAND_CONTRIBUTION.md,
   [[project_extension_independent]]). Hover is on the wrong side.
2. **Ad-hoc keyboard verbs.** The keyboard side uses two module booleans
   (`activateInNewTab`, `yankHintArmed`) that `activateWrapper` branches on.
   There's no keyboard verb for hover, and the boolean pattern doesn't scale.

## Proposed additions (the high-value trio + parity)

- **Focus** — pick an element and focus it *without* activating (a form field →
  then type via Insert mode; distinct from `focus_input`, which is first-field).
- **Enter caret/visual at a badge** — pick an element, start caret mode anchored
  there. Direct synergy with the caret/visual mode just shipped ("select from
  *this* paragraph").
- **Copy link text** — copy the element's visible text (complements copy-URL).
- **Hover keyboard verb** — parity with the existing voice hover.

## Design

### Keyboard: unify the armed booleans into one action

Replace `activateInNewTab` + `yankHintArmed` with a single:

```ts
type HintAction = 'activate' | 'newtab' | 'yank' | 'hover' | 'focus' | 'caret' | 'copytext';
let pendingHintAction: HintAction = 'activate';
```

A verb command arms it and enters hint mode (the existing `yank_hint` shape);
`activateWrapper` switches on it and resets to `'activate'` after. This kills the
boolean sprawl and makes every future verb a one-line add
([[feedback_no_legacy_debt]]). New commands (all rebindable):
`hover_hint`, `focus_hint`, `caret_hint`, `copytext_hint` — proposed binds live
under the `y*`/`g*` families (e.g. `yc` copy-text, `gh` hover, `gf`… taken by
frame-nav-that-we-don't-have, so pick freely). The capital-letter new-tab
affordance stays as-is (maps to `'newtab'`).

### Voice: one contribution home

Add catalog entries with voice patterns — "focus {hint}", "select {hint}",
"copy text {hint}" — and **move hover's contribution from the plugin into the
extension catalog**, deleting the `collections.go` hover block. All badge verbs
then live in one place; the plugin just resolves+dispatches. Cross-repo change
(extension + browser plugin), sequenced dependencies-first.

Content: add `'focus'`, `'caret'`, `'copytext'` branches to the BRANCHKIT_ACTION
handler, mirroring the existing `'hover'` branch (same three-tier codeword
resolution). `'focus'` → `el.focus()`; `'copytext'` → `copyText(el.textContent)`;
`'caret'` → `CaretController.enterAt(el)`.

### CaretController.enterAt(el)

New method on the caret controller: set a collapsed selection at the start of the
element's first text node, then enter caret mode — instead of the first-big-text
heuristic `enter()` uses. Small; reuses the rest of the controller.

## Every verb gets BOTH modalities (product decision, 2026-07-06)

The user's principle: **voice commands for everything**. So each hint action mode
ships with a keyboard verb *and* a voice pattern, and — decided — voice "select
{hint}" is the **handoff (b)**: it places the caret at the element, enters caret
mode, and the user then drives movement and yank **by voice** (not only
keyboard). That means caret/visual mode itself must be voice-drivable, which is
its own capability, below.

## Voice control of caret/visual mode — SHIPPED, aligned tag-mode (phase 4)

**Landed 2026-07-06 as the architecture-aligned gated version** (an initial
extension-only always-on form was upgraded the same day). An investigation into
"are we fighting the architecture?" found that BranchKit already has the exact
pattern for a sustained modal voice mode — `snap_mode`/`desk_mode` (declarative
tag) — and the content-owned-mode → derived-plugin-tag half is the palette
(`POST /palette` → tag). Caret is a composition of both. Crucially, the
"exclusive tag footgun" I'd feared is managed declaratively (the palette's
imperative tag has no `clear_on_unrelated_command`, so it can't drift; drains on
exit/focus-loss/disconnect bound any orphan) — so the gated version is *less*
risky than I'd thought, not more.

What shipped:
- **Plugin** (`plugins/browser`): a `plugin.browser.caret` **exclusive** tag
  collection (mirrors the palette tag), a `POST /caret {active}` endpoint
  (`caret.go`, the boolean twin of `POST /palette`) that Puts/Deletes the tag,
  a `context: "caret"` branch in `contribute.go` (`RequiresTags(caretTag)` — and
  *not* `ClearsTags`, since caret persists across many selection commands),
  and caret drains alongside the palette ones (focus loss / switch / SSE
  disconnect). Tag-lifecycle unit tests in `caret_test.go`.
- **Extension**: `caret_voice` gains `voiceContext:'caret'` (gated on the tag);
  the content CaretController pushes `CARET_ACTIVE {active}` to the background on
  the active/inactive edge (deduped across caret↔visual), which `POST`s `/caret`.
  `caret_voice` still dispatches to `CaretController.applyVoice(op)` and remains
  a content-side no-op if somehow reached while inactive (belt-and-suspenders).

Phrases: "select word/line/sentence", "select to end/start", "copy selection"/
"copy that", "stop selecting". Because the tag is exclusive, while selecting only
the caret voice commands match — mirroring the keyboard's modal capture.

Verified: plugin tag lifecycle (`caret_test.go`, Go), and the extension contract
in `scripts/_verify-marks-caret.mjs` (24/24: `CARET_ACTIVE` pushed true-on-enter/
false-on-exit with caret↔visual dedup, "select word"→visual, "copy that"→
clipboard). The one link the standalone harness can't exercise (no actuator/mic):
the matcher actually gating eligibility on the tag — verify on a live host.

### Design detail — why exclusive + imperative (not snap_mode's command-driven tag)

`snap_mode`'s tag is *command-driven* (`sets_tags`/`requires_tags` +
`clear_on_unrelated_command`). Caret can't use that shape: caret is
content-stateful and dual-input (keyboard `v` enters it without ever touching the
matcher), so the tag must be a **pure mirror** of the content mode (palette's
imperative Put/Delete from a content push), not something a voice command sets.
And `clear_on_unrelated_command` is deliberately OFF: under an exclusive tag,
unrelated commands are suppressed before they can match, so it would rarely fire
anyway — but more importantly, letting the matcher clear the tag could drift it
from the content's still-active selection. The tag changes *only* via the
extension's push, so content-state and tag stay in lockstep by construction.

Caret/visual movement keys are currently owned by the self-contained caret
handler (they bypass the command registry, by design). To drive them by voice we
need a **context-gated voice grammar** that's live only while caret mode is
active — exactly the palette's pattern (`voiceContext: 'palette'` → the plugin
gates on an exclusive tag set while the palette is open, cleared at match).

Mechanism:
- On caret-mode entry, set an **exclusive caret context tag** (extension → plugin,
  the palette precedent). While active, Layer-2 eligibility narrows to the caret
  voice commands — consistent with the keyboard's modal capture (bare keys are
  fully owned in caret mode, so voice being modal too is coherent).
- Contribute caret voice commands with `voiceContext: 'caret'`. They dispatch to
  content actions that call the existing `CaretController` methods (`applyMove`,
  `selectLine`, `selectLexicalEntity`, `yank`, `exit`) — the movement engine is
  already built and live-verified; this just adds a spoken entry point.

Proposed spoken grammar (maps to the movement engine we already have):
- Move: "left"/"right"/"up"/"down" (char/line), "word right"/"word left",
  "next sentence"/"last sentence", "start of line"/"end of line",
  "top"/"bottom" (document).
- Select/objects: "select word"/"select line"/"select sentence" (text objects),
  "select" (caret→visual toggle), "swap" (`o` reverse).
- Finish: "copy"/"copy that"/"yank" (yank + exit), "cancel"/"exit"/"done" (exit).

Push-to-talk fits: each utterance is one command; caret mode persists between
utterances (content-side state) and the context tag keeps the caret grammar
eligible until exit. This retires the "coarse voice selection deferred" note in
DESIGN_MARKS_AND_CARET.md — it's now in scope here.

Open sub-question: does the exclusive caret tag suppress *all* other voice
(scroll, tabs) while active? Lean yes — it mirrors the keyboard modal capture,
and caret's own "down"/"top" cover scrolling. Revisit if it feels trapping.

## Scope cuts (deferred, low value / niche)

download-link/image, open-incognito (needs permission), copy-image/open-image,
search-with-link-text, open-with-queue (our `stash {hint+}` already multi-opens).
**Frame-nav (`gf`/`gF`) is dropped entirely** — BranchKit's hints are already
cross-frame (the frame-router resolves codewords to the right frame), so the need
Vimium's frame-cycling serves doesn't exist here.

## Risk

Touches `activateWrapper` — the badge activation path, high blast radius per prior
extension incidents ([[feedback_orphan_teardown_high_blast_radius]]). The
armed-flag unification especially. Mitigation: the refactor is mechanical and
behavior-preserving; cover it by extending the marks/caret live harness
(`scripts/_verify-marks-caret.mjs`) with hint-action scenarios; ship one verb at
a time with a soak.

## Effort

- Focus, copy-text, hover-keyboard-verb: **small** each.
- Enter-caret-at-element (`enterAt` + `caret_hint` + voice handoff): **medium**.
- Armed-flag unification: **small-medium**, needs live verify of the hint path.
- Moving hover contribution extension-side: **small but cross-repo** (delete the
  plugin collection, add the catalog entry).

## Plan (phased, each shippable + soakable)

Every phase ships keyboard **and** voice for its verbs (the product decision).

1. **Unify** the armed booleans → `pendingHintAction` (no behavior change;
   live-verify badge activation/newtab/yank unbroken).
2. **Focus + copy-text** — one-shot verbs. Keyboard (`focus_hint`,
   `copytext_hint`) + voice ("focus {hint}", "copy text {hint}").
3. **Hover parity** — keyboard `hover_hint`; consolidate the existing hover voice
   contribution into the extension catalog (cross-repo, delete the plugin block).
4. **Voice caret control** — the exclusive caret context tag + `voiceContext:
   'caret'` movement/select/yank/exit commands wired to `CaretController`. This
   is the biggest phase (cross-repo: extension contributes, plugin gates) and
   unblocks phase 5's voice handoff. Live-verify the tag lifecycle (set on enter,
   cleared on exit/yank) so caret voice can't strand the grammar.
5. **Enter-caret-at-badge** — `CaretController.enterAt(el)` + keyboard
   `caret_hint` + voice "select {hint}" (handoff into the phase-4 voice mode).

Phases 1–3 are self-contained and low-risk; **phase 4 is the substantial one**
(new voice-context plumbing) and should be its own soak. Phase 5 is small once 4
lands.
