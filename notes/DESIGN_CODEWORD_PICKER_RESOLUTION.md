# Codeword Picker Resolution (mode-agnostic)

**Status:** Proposal (2026-06-09).

Fix the "Pick from tab" codeword resolver so it accepts whatever the
user sees on the badge, in any display mode. Keep all display modes —
the earlier letters-only idea was dropped (the word/both modes are
worth keeping for onboarding).

## The bug

`Pick → type codeword → Resolve` does a literal lookup of the typed
string against the word-pair codeword:

- The label pool and `byCodeword` key on the spoken word pair, e.g.
  `"charlie golf"` (`label-pool.ts` `buildPool`; `element-wrapper.ts:242`
  splits on whitespace and matches two words).
- But the badge renders a *display form* that depends on the mode
  (`labelToDisplay`, `words.ts`): `letter` → `"cg"`, `word` →
  `"charlie golf"`, `both` (pair) → `"charlie golf"`, `first-word`
  (pair) → `"charlie g"`.

A user types what they see. In `letter` mode that's `"cg"`, which never
matches the `"charlie golf"` key, so they get *"… is not visible in that
tab."* Reproduced 2026-06-09 on a stable QuickBase page (not the orphan
artifact we first suspected).

The SW also pre-routes via `getFrameForLabel(typed)`, which fails for
the same reason before any frame is even asked.

## Principle: type what's on the badge (WYSIWYG)

The picker exists so users don't hand-write selectors. Forcing them to
translate the displayed letters into the spoken word pair defeats that.
So: **match the input against the displayed form for the active mode.**
Whatever the badge shows, typing that resolves it — including the
awkward `first-word` form `"charlie g"`.

As a free bonus, also accept the canonical word pair, so a power user
who thinks in spoken words can type `"charlie golf"` even in letter
mode. Both forms resolve; first match wins.

This keeps every display mode untouched — the picker simply stops
caring which one is active.

## Design

### In-frame match (`resolveHintLocally`, content frame)

Takes the current `displayMode`. Resolution order:

1. `store.byCodeword(input)` — exact canonical word pair / single (fast,
   mode-independent; covers "type what you say").
2. Else normalize `input` (trim, lowercase, strip spaces) and scan
   `store.all`: for each wrapper, rebuild its `LabelAssignment` from
   `scanned.codeword` (word pair) via the word→letter map, compute
   `labelToDisplay(assignment, displayMode)`, normalize, compare. First
   equal wins (codewords are unique per tab, so no ambiguity).

New helper `codewordToAssignment(codeword)` in `words.ts` rebuilds a
`LabelAssignment` from a stored word-pair string (returns null on
unknown words / wrong arity).

### Routing (`resolveHintFromTab`, SW)

Drop the `getFrameForLabel` pre-route for the picker — it can't see the
displayed form and the SW doesn't hold the alphabet anyway. Instead
enumerate the tab's frames with `chrome.webNavigation.getAllFrames`
(permission already granted) and send `RESOLVE_HINT` to each, returning
the first `ok`. This also fixes QuickBase, where the badge lives in an
iframe — the broadcast reaches it transparently.

Scope note: this only touches the **picker** path (`resolveHintFromTab`,
a manual click). The voice/keyboard hot path (`notifyActiveTab` →
`routeFrameForAction` → `getFrameForLabel`) is **unchanged**, so the
real blast radius is small despite the file being frame-routing code.

### UI

Options-page Pick placeholder changes from `"e.g. ape deck"` (assumes
words) to a mode-neutral hint. Popup placeholder is already neutral
(`"hint codeword"`).

## Files

- `src/labels/words.ts` — add `codewordToAssignment`; export it. Test.
- `src/plugin/resolve.ts` — `resolveHintLocally(store, codeword,
  displayMode)`; add displayed-form fallback. Test.
- `src/content.ts:2282` — pass `getDisplayMode()` into the handler.
- `src/background/frame-router.ts` — `resolveHintFromTab` enumerates
  frames + first-ok. Test (add `webNavigation` to the chrome mock).
- `options.html` — neutral Pick placeholder.

## Not doing

- Removing display modes (reverted decision).
- Touching the voice/keyboard routing or the label pool keys.
