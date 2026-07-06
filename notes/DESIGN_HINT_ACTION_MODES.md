# Design: Hint action modes — pick a badge, do X (not just click)

**Status:** Scope / proposal (2026-07-06). Vimium's "hint modes": a badge you
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

## Voice control of caret/visual mode (the load-bearing new piece)

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
