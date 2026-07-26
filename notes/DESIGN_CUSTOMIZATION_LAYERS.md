# Design: customization layers — defaults, user deltas, and reset

**Status:** Phase 1 in progress, 2026-07-25. Extension-side; no actuator change.
Extends `DESIGN_KEYMAP_CONFIG.md` (which built the editor) and
`../../notes/DESIGN_COMMAND_PHRASE_OVERRIDES.md` (which built the voice override
layer). This note makes the two halves of a command card behave the same way.

## The problem

A command card on the keyboard-shortcuts page has two halves, and they rest on
two different storage models:

| | Default lives in | User change lives in | Layered? | Reset available |
|---|---|---|---|---|
| **Voice phrase** | `command-catalog.ts` (`voice[].pattern`) | actuator `_platform.command_overrides`, keyed `(action, default_pattern)` | yes — keyed delta, replace-transform at union build | per phrase (`↺`) |
| **Keybind** | `command-catalog.ts` (`DEFAULT_KEYMAP`) | `chrome.storage.sync.keymap` — the **full effective map** | **no** — a snapshot | whole section only |

The voice half is right. The keys half stores defaults and user edits in one
undifferentiated array, so nothing can answer *"what did I change?"* — and a
per-key "reset to default" has nothing to reset **to**.

Three consequences today:

1. **No per-item or per-command reset for keys.** Only the section-wide
   `#km-reset`, which stages all of `DEFAULT_KEYMAP` — all or nothing.
2. **`mergeNewDefaults()` is a heuristic standing in for the missing delta.** It
   backfills a default whose command the snapshot doesn't bind *and* whose key is
   free, so commands shipped after a save still appear. Its documented accepted
   edge: a command you *deliberately* unbound comes back, because absence and
   deliberate-removal are indistinguishable in a snapshot.
3. **`#km-reset` is mislabeled.** It sits above a UI showing keys *and* voice
   phrases and resets only keys — voice overrides and aliases survive it silently.

## Target: one model, three granularities

**Keys move to the same shape voice already has** — catalog default plus a keyed
user delta — and both halves then expose reset at three levels:

- **per item** — one phrase (`↺`) or one added phrase (`✕`). Voice only; see below.
- **per command** — one card's keys back to their shipping bindings.
- **whole section** — all keys, or all voice customizations.

Each reset follows the **commit model of the edits it undoes**: key changes are
staged behind Save/Cancel, voice changes apply immediately (they're stored in the
actuator so you can speak them straight away). One button spanning both would
make Cancel restore half the change, so every reset stays on one side of that
seam rather than forcing one model onto both.

**Revised during implementation** — the note originally called for per-item reset
on both halves and a per-command reset spanning both. Neither survived contact:

- **Keys have no per-key reset**, because the delta's unit is the command. "Reset
  this one key" is either identical to resetting the command (single-bind case)
  or means "remove this key", which the existing `✕` already does. A third
  control for a state the other two cover is noise.
- **Per-command reset is keys-only.** A single `↺` clearing keys *and* voice
  would straddle the staged/immediate seam — Cancel would restore the keys and
  not the phrases. Voice keeps its own per-phrase `↺` and per-alias `✕`, which
  are already per-item and already immediate.

### Changed-vs-shipped marking

Every customized item carries a mark, and its per-item reset renders **only when
changed** (nothing to reset otherwise). Voice phrases already do this via the
`.changed` class; keys gain the equivalent once the delta exists.

This is load-bearing, not cosmetic. During development the shipped default and a
local override are edited in different places, and **an override silently shadows
the default** — change a phrase in the UI, later change it in the catalog, and
you're speaking the old phrase while reading the new code. The mark is the only
thing that makes that visible. A row whose override differs from the *current*
catalog default should say so.

### Promotion is deliberately not a feature

Turning a personal override into a shipped default means editing
`command-catalog.ts` — source that gets compiled and distributed. A packaged
extension has no checkout, so this is an **artifact boundary, not a permission
boundary**: it cannot work outside a dev tree, and there's nothing to gate.

It's also rare enough that tooling is premature. Promotion happens by asking an
agent (or hand-editing) — and it is always **two steps**: edit the catalog *and*
clear the override. Skipping the second leaves the override shadowing the new
default. Considered and dropped: a `just promote-phrases` recipe, a "Copy as
default" clipboard button, and a dev-only endpoint that writes the catalog from a
UI click (rejected outright — a runtime process editing source in a working tree
races the parallel agent sessions this repo runs).

Keymap **export/import** stays a separate, legitimately user-facing feature
(`DESIGN_KEYMAP_CONFIG.md` Phase 4) — "seed my second machine", not "change what
ships". The dev-only decision above must not swallow it.

## Phase 1 — keys delta storage

`chrome.storage.sync.keymap` changes from a flat effective array to a
**per-command delta map**:

```ts
type KeymapDelta = Record<string, KeymapBinding[]>;  // commandId → its COMPLETE key list
interface KeymapBinding { keys: string; params?: Record<string, string> }
```

- **Absent command** → its `DEFAULT_KEYMAP` bindings apply.
- **Present** → wholesale replacement of that command's bindings.
- **`[]`** → explicitly unbound, and it *stays* unbound.

`KeymapBinding` drops `KeymapEntry`'s `command` field — the command is the map
key, so the id isn't stored twice.

**Per-command, not per-key**, because that's the unit the UI already presents
(one card, all its keys together) and it keeps the delta from having to model
added / removed / rebound as three separate concepts. "Reset this command" is
`delete delta[id]`; "reset all keys" is removing the storage key.

### What this deletes

`mergeNewDefaults()` goes away. A command shipped after the user's last save
simply isn't in the delta, so its defaults apply — no heuristic, no free-key
check, and the accepted edge disappears because `[]` distinguishes deliberate
unbinding from absence.

(It survives temporarily as a private helper inside the migration below, and dies
with it.)

### Derivation and ordering

`effectiveKeymap(delta)` walks `DEFAULT_KEYMAP`'s command order, emitting each
command's delta bindings when present and its defaults otherwise, then appends
any delta-only command (one bound purely by the user, which ships unbound).

Order matters: the registry matches **first-wins**, with a partial-match timeout
for sequences (`dispatcher.ts`). Substituting in place preserves today's relative
order for every command, so routing is unchanged for anyone who hasn't
customized.

### Editing back to the default clears the delta

When a command's mutated binding list deep-equals its defaults, its delta entry
is **removed** rather than stored as an identical copy — so the changed mark and
the per-command `↺` disappear on their own. This mirrors the voice editor, where
typing the default phrase back drops the override
(`keymap-options.ts:372-375`).

### Seam: consumers are untouched

`content.ts` (registry rebuild), `palette-page.ts`, and the help overlay all
consume a flat `readonly KeymapEntry[]`. `loadKeymap()` keeps that exact
signature and derives the effective list internally — the delta is private to the
storage module. Only the editor needs delta-aware calls, and only for granular
reset and the changed mark.

`saveKeymap(entries: KeymapEntry[])` also keeps its signature, deriving the delta
by diffing the supplied effective map against defaults. So **the editor keeps
working unchanged through this phase** — a command absent from the editor's draft
becomes `[]` (which is exactly right: the draft *is* the full effective map, so
absence means the user removed it). The granular-reset UI then lands on a stable
storage base rather than on top of a simultaneous rewrite.

New pure exports for the editor: `loadKeymapDelta`, `saveKeymapDelta`,
`resetCommand`, `isCommandChanged`, `defaultBindingsFor`, `effectiveKeymap`,
`deltaFromEffective`.

### Migration

Old stored values are arrays; new ones are objects — so the format is detectable
without a version field.

The migration's contract is that the **effective map doesn't change across it**:

```
effectiveKeymap(migrateSnapshot(stored)) === mergeNewDefaults(sanitizeKeymap(stored))
```

So it computes today's effective map with today's code, diffs it against
`DEFAULT_KEYMAP` per command, and records an entry for every command whose
binding list differs (including `[]` where the old map had none). That's faithful
by construction, including the awkward case where the old code kept a command
unbound because its default key was occupied.

It runs on load and rewrites storage in the new format. A follow-up commit
deletes `migrateSnapshot` *and* `mergeNewDefaults` together once it's run —
transitional code with a scheduled death, per the clean-end-state rule.

## Phase 2 — reset UI

- **Per-command `↺`** on a card whose keys differ from the shipping bindings,
  restoring them into the draft (staged — Save applies, Cancel reverts, like
  every other key edit). Renders only when changed, so it can't be clicked as a
  no-op and its presence *is* the signal that something differs.
- **Changed mark on key pills**, reusing the voice `.changed` treatment (accent
  colour + `•`) so "this isn't the shipped default" reads identically on both
  halves of a row.
- **Section reset split honestly** into keys (staged) and voice (immediate), so
  Cancel's scope stays truthful. The current `#km-reset` claims to reset
  everything and touches only keys.
- **Voice bulk reset** = N calls to the existing `commands.reset_override` /
  `commands.remove_alias` ops over the lists the editor already holds. No new
  contract surface; a bulk `commands.clear_overrides` op would be atomic and one
  recompile instead of N, but it's a cross-repo codegen ripple — add it only if
  partial failure or recompile churn actually bites. It reports partial failure
  rather than silently leaving some overrides in place.

The editor's draft stays a flat `KeymapEntry[]`; only the storage layer knows
about deltas. Changed-detection is therefore a comparison against
`defaultBindingsFor`, exposed as `isCommandCustomized(entries, commandId)` so the
binding-equality rules live in one module.

## Unrelated cleanup, noted here because it surfaced

`user_commands.json` holds a leftover `{"pattern": ["test"], "action":
{"type":"sequence","actions":[]}}`. `user_commands` chains into the matcher and
the grammar, so **"test" is a live matchable phrase that does nothing**. Delete
it.

## Risks

- **Routing order.** Substituting per command preserves order for uncustomized
  commands, but a delta-only command appends last. Sequence prefixes (`gg`, `yy`)
  are the sensitive case — covered by the existing dispatcher tests.
- **Migration fidelity.** The property test above is the gate; it must run
  against the real `DEFAULT_KEYMAP`, not a fixture, so a catalog change can't
  quietly invalidate it.
- **Sync races.** `onKeymapChanged` already guards self-echo via `keymapsEqual`;
  with a delta the compare is on the delta, and a cross-tab write during an
  in-progress edit keeps the existing "adopt only when not dirty" rule.
