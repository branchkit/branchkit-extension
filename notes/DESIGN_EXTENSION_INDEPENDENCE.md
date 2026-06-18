# Design: Extension independence + voice as an overlay

**Status:** Direction / proposal, 2026-06-17. No code yet. Records the
architectural decision that the browser extension is a standalone product and
voice (BranchKit) is an optional layer that hooks into it — and what has to
change for that to be true.

## Principle

The browser extension must be fully usable **without BranchKit installed**.
Hints + keyboard navigation are the product on their own; voice is an opt-in
enhancement that layers on when BranchKit is present. **The extension is the
foundation and the single source of truth; BranchKit consumes and feeds off it,
never the reverse.**

## The two-layer model

- **Base layer — letters (extension-owned, standalone).** Each hint badge shows
  a letter label (`a`, `as`, `df`, …). You activate a hint by **typing** its
  letter(s). This needs nothing from BranchKit.
- **Voice overlay — codewords + alphabet (BranchKit, optional).** When voice is
  active, each letter gets a spoken codeword via the *alphabet* — a spoken-word
  ↔ letter mapping (e.g. "arch" → `a`) — so you can say a hint instead of typing
  it. The alphabet is purely the voice-addressing layer; it only matters when
  voice is on.

The letter is primary; the codeword is a projection of it. Today the code has
this backwards (see Gaps).

## Source of truth: the extension owns its vocabulary

The extension defines its command vocabulary (each command = an action + a
default key binding + an optional voice phrase) and its hint labels. When
BranchKit is present, the extension **contributes** what voice needs up to the
browser plugin — exactly as it already contributes the dynamic hint grammar
today. The platform never originates the extension's commands or labels.

## Where the current build violates this (the gaps)

1. **Hint labels are coupled to the voice layer.** The label pool assigns a
   *codeword* first, and the badge letter is derived from it via the alphabet
   (`poolLabelToAssignment` → `WORD_TO_LETTER`). With no alphabet loaded,
   `showHints` bails with "is BranchKit running?". The letter is a projection of
   the codeword, when it should be the other way around.
2. **Cross-frame label coordination lives in BranchKit.** The label pool
   (`CLAIM_LABELS`) hands out codewords so two frames in a tab don't collide.
   Standalone hints need an extension-owned authority that does this for
   *letters*.
3. **Static voice phrases live platform-side.** "scroll down", "show", "find",
   etc. are defined in the browser plugin's `commands.json` (BranchKit), not the
   extension — so the extension doesn't own its own voice vocabulary.
4. **The voice panel reads `commands.enumerate`** (platform → extension). For an
   extension that should *own* its phrases, that's the wrong direction; it works
   only because it renders nothing when disconnected.

## The direction (fixes)

1. **Invert the hint-label dependency.** The extension assigns its own **letter**
   labels locally (deterministic, Vimium-style — home-row letters, then pairs),
   with cross-frame coordination in the **background SW** (it already mediates
   `CLAIM_LABELS`, so it's the natural letter authority). The codeword/alphabet
   becomes an optional overlay the voice layer maps onto the existing letters.
   Typing a letter and clicking-through work with zero BranchKit.
2. **Extension owns its command vocabulary.** Each command carries its action,
   default key(s), and an optional voice phrase. When BranchKit is present the
   extension registers those phrases with the browser plugin, which becomes a
   thin **registrar** of what the extension contributes (mirroring the dynamic
   hint-grammar path) rather than a hardcoded `commands.json`.
3. **Voice panel sources phrases from the extension's catalog,** not
   `commands.enumerate`. "Voice enabled" is just a runtime state (BranchKit
   connected/not).

## Command-model implications

- **Keyboard binds to extension-owned commands, not platform command ids.**
  Binding to `commands.enumerate` ids would couple the keyboard to BranchKit and
  break standalone — rejected.
- **Context routing is a consumer concern.** The "browser scroll when in-browser,
  OS-level scroll everywhere else" idea: the *browser* scroll is extension-owned
  and works alone. The OS-level fallback and the by-context routing (the
  platform's command `variants`, gated on the browser-active tag) live
  **platform-side and apply only when BranchKit is present** — layered onto the
  extension's command, not defining it.

## Rejected approaches (and why)

- **Platform-owns-commands** (keyboard binds to `commands.enumerate` ids;
  commands defined only in the browser plugin's `commands.json`): breaks
  standalone — the keyboard would require BranchKit to function.
- **Dual-sync mapping** (extension mirrors the platform's scroll params to line
  voice up with per-direction keymap commands): two artifacts that must be kept
  in lockstep → silent-drift fragility. A single owner (the extension) removes
  the need to sync at all.

## Open questions / phasing

- Letter-assignment authority in the SW: the scheme (home-row first? `a`–`z`
  then pairs?), per-tab cross-frame coordination, and how it replaces/wraps the
  current codeword pool.
- Migration of static voice phrases out of `commands.json` into the extension,
  and the plugin-as-registrar contribution protocol.
- How the extension contributes voice phrases to BranchKit — likely an extension
  of the existing grammar-contribution channel.
- Relationship to `DESIGN_KEYMAP_CONFIG.md`: the keymap editor is a sub-piece of
  the extension-owned command vocabulary; the catalog there grows to carry the
  optional voice phrase per command.
