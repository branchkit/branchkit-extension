# Design sketch: extension-owned command vocabulary + plugin-as-registrar

**Status:** Sketch, 2026-06-18. Phase 2 of extension independence
(`PLAN_EXTENSION_INDEPENDENCE.md`). Cross-repo — **needs sign-off before
implementing.** Phase 1 (letter inversion) is committed; this is the next gap:
the extension should OWN its static voice phrases and contribute them up, with
the browser plugin reduced to a registrar.

## Current state (verified against the code)

- **The plugin owns the phrases.** `plugins/browser/src/*.go` builders define the
  spoken grammar: `buildScrollCommands` / `buildFindCommands` /
  `buildNavigationCommands` / `buildReferenceCommands` each return
  `[]CommandSpec` — a pattern (word slots + `{number}`/`{text}` captures), an
  action (`browser.scroll` + params), a `Category`, and `RequiresTags(appTag)`
  where `appTag = "plugin.browser.active"`. `pushAllCommands` unions them and
  `PushCommandSpecs` REPLACE-pushes the set to the actuator matcher.
- **The extension owns ids/keys/metadata.** `command-catalog.ts:COMMAND_CATALOG`
  has `{id, label, group, description, mappable, params}` per command and
  `DEFAULT_KEYMAP` has the keybinds. Command ids already line up with the
  plugin's action suffixes (`scroll_down`, `find_next`, …).
- **The voice panel reads the wrong way.** `voice-commands.ts` fetches the
  plugin's authed `GET /voice-commands` and maps `browser.<id>` → phrases to
  show "you can also say…". Works only when connected; phrases originate
  platform-side. This is the interim flagged in the independence note.

## Target

- **One catalog entry per command carries action + key(s) + optional voice
  pattern(s).** The static phrases move OUT of the Go builders INTO
  `command-catalog.ts`.
- **The plugin becomes a thin registrar.** It holds whatever the extension
  contributed and folds it into `pushAllCommands` — it no longer authors scroll/
  find/navigation phrases.
- **The voice panel sources phrases from the catalog**, not `/voice-commands`.
  "Voice enabled" is just runtime state (BranchKit connected).

## Data shape (extension side)

Attach voice patterns to the existing `CommandMeta` so the entry is the single
source:

```ts
interface VoicePattern {
  pattern: string;                 // "scroll down" | "scroll down {number}" | "find {text}"
  params?: Record<string, string>; // action params this phrase binds, e.g. {direction:"down", amount:"step"}
}
interface CommandMeta {
  …                                // id, label, group, description, mappable, params
  voice?: VoicePattern[];          // the command's spoken forms (optional)
}
```

- `{number}` / `{text}` inline captures map to the plugin's `Capture`/`Text`
  slots; everything else is a literal word slot.
- Several phrases can bind one action with different params — e.g. `scroll`
  carries `"scroll down"→{down,step}`, `"page down"→{down,half}`, `"scroll
  sidebar"→{down,step,region:leftSidebar}`. This is the command's own mini-
  grammar, co-located with it.
- Keybinds stay in `DEFAULT_KEYMAP`; catalog `id` already joins keys ↔ phrases,
  so "one entry" is logical (by id), not a struct merge. (Open Q4.)

## Contribution protocol

The extension already feeds the plugin per-element hint grammar via
`GRAMMAR_BATCH` → SW `postGrammarBatch` → plugin `/grammar/batch`. Static
commands are a **sibling channel** of the same shape:

```
extension catalog  ──CONTRIBUTE_COMMANDS──►  SW  ──POST /commands/contribute──►  plugin
   (VoicePattern[] per command id)        (authed client)            (stores latest, re-runs pushAllCommands)
```

- Payload: a flat list of `{action, params, pattern}` derived from the catalog's
  `voice` entries (action = `browser.<id>`).
- The plugin stores the contributed set and includes it in `pushAllCommands`'s
  union, applying its OWN defaults so the extension stays platform-agnostic:
  `RequiresTags(appTag)` (browser-active gate) and a `Category`. The extension
  never names a platform tag. `buildScrollCommands`/`buildFindCommands`/
  `buildNavigationCommands` are deleted; the registrar consumes contributed data
  instead.
- **Lifecycle:** the extension contributes on connect (alongside the first
  grammar push / on `reactivate`) and on a catalog change. REPLACE semantics +
  the `pushMu` consolidation already make a re-push idempotent.

## Scroll model (three inputs / two behaviors) — concrete

1. **Keyboard (extension, standalone).** `DEFAULT_KEYMAP` binds `shift+KeyJ` →
   `scroll_down` → the extension's smart scroll. No BranchKit.
2. **Browser-context voice (extension-contributed).** The catalog's scroll
   entries carry `voice` patterns; the extension contributes them; the plugin
   registers them gated on browser-active. A match dispatches the SAME
   `browser.scroll` action that the keyboard path already routes through
   (`BRANCHKIT_ACTION` scroll → content dispatcher). Inputs 1 and 2 are two
   inputs to ONE catalog entry.
3. **Generic voice (platform-owned).** A separate, platform-owned "scroll" for
   non-browser apps (OS wheel). The extension knows nothing about it. With
   BranchKit on there are then TWO "scroll down" voice commands — the
   extension-contributed browser one (browser-active gated) and the generic one
   — disambiguated by focused-source projection + tag priority. **Whether this
   generic command exists today is out of scope here** (it may be a later
   platform/system-plugin item); Phase 2 only needs the extension to contribute
   its browser scroll.

## What moves / what's deleted

- **Into the extension catalog:** scroll, find, page-navigation, and static hint
  phrases (`show`/`hide`/`toggle`/`activate first`).
- **Deleted plugin-side:** `buildScrollCommands`, `buildFindCommands`,
  `buildNavigationCommands` (phrase authorship). Replaced by the registrar path.
- **Stays plugin-side (for now):** the hint-skeleton activate-by-codeword command
  (coupled to the dynamic alphabet/codeword grammar — Phase 1 territory) and
  references (user-named, runtime — like hints). Note as Q3.
- **Deleted extension-side:** `voice-commands.ts`, the SW `GET_VOICE_COMMANDS`
  handler, the plugin's `GET /voice-commands` endpoint; the keymap editor reads
  `catalog.voice` directly.

## Open decisions (please weigh in)

- **Q1 — contribution channel.** New `POST /commands/contribute` sibling to
  `/grammar/batch` (recommended — clean separation, plugin stays the actuator
  authority), vs. extending the grammar batch payload with a static-commands
  section (one channel, but conflates per-element hints with fixed commands).
- **Q2 — who owns context gating.** Recommended: the plugin applies its own
  `RequiresTags(appTag)` + `Category` to every contributed command, so the
  extension never references platform tag namespaces. Alternative: the extension
  declares an abstract context (e.g. `when:"browser-focused"`) the plugin maps.
- **Q3 — scope of the move.** Just the static phrases (scroll/find/nav/static
  hints) this phase, leaving activate-by-codeword + references plugin-side? Or
  pull those in too (bigger, touches the Phase 1 grammar path)?
- **Q4 — catalog struct.** Keep keys in `DEFAULT_KEYMAP` + phrases in
  `COMMAND_CATALOG` (joined by id, least churn) vs. merge keys into the catalog
  entry so it's literally one struct.

## Phased steps (after sign-off)

1. **Extension:** add `voice` to `CommandMeta`; port the Go builders' phrases
   into `COMMAND_CATALOG` (faithful 1:1, incl. captures + region params).
2. **SW + plugin:** `CONTRIBUTE_COMMANDS` message + `POST /commands/contribute`;
   plugin stores + folds into `pushAllCommands`; apply appTag/category defaults.
   Contribute on connect/reactivate.
3. **Plugin cleanup:** delete the phrase builders once the registrar path is
   verified (clean end state, no transitional dual authorship left behind).
4. **Voice panel:** source from `catalog.voice`; delete `voice-commands.ts` +
   `/voice-commands` + `GET_VOICE_COMMANDS`.
5. Conformance: actuator matcher still resolves every former phrase; a
   BranchKit-on soak confirms scroll/find/show voice parity with today.

## Risks

- **Parity gap:** the Go builders encode subtle phrasing (per-region scroll, full
  vs half page, `{number}`/`{text}` captures). The port must be 1:1 or voice
  silently loses phrases — diff the contributed set against the old union before
  deleting the builders.
- **REPLACE-push race:** contributed commands must be in EVERY `pushAllCommands`
  union (startup, batch arrival, reference update), or a later push drops them.
  The existing `pushMu` + single-union consolidation already guards this; the
  registrar must read the stored contribution inside the lock.
- **Cross-repo commit ordering:** SDK/plugin contract first, then extension,
  per the workspace rule; don't bump app submodule pins unprompted.
