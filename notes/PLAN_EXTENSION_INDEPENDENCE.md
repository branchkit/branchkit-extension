# Plan: Extension independence — phased implementation

**Status:** Phasing pass, 2026-06-18. Companion to
`DESIGN_EXTENSION_INDEPENDENCE.md` (the direction) and `DESIGN_KEYMAP_CONFIG.md`
(the keymap/catalog substrate). Records the concrete phases + the open design
decisions, verified against the current `unified-reconciler-2026-06` code.

## What the code actually does today (verified)

- **Codeword is the cross-frame identity.** The per-tab label pool
  (`labels/label-pool.ts`) builds 676 two-word pairs from BranchKit's 26-word
  alphabet (`buildPool`), and the background SW hands them out per frame via
  `CLAIM_LABELS`/`CONFIRM_LABELS`/`RELEASE_LABELS`. `getFrameForLabel(codeword)`
  routes voice to the owning frame. The reservoir (`label-reservoir.ts`) caches
  a frame-local slice; `label-sync.ts` POSTs the codewords to the plugin as the
  dynamic hint grammar.
- **Letter is derived from the codeword.** `poolLabelToAssignment(codeword)` maps
  each word → letter via `words.ts:WORD_TO_LETTER` (populated only when BranchKit
  pushes the alphabet over SSE → `storeAlphabet` → `chrome.storage.local`).
- **Typing already picks by letter.** `KeyHandler` accumulates typed chars and
  `store.matchingLetterPrefix(prefix)` filters badges by `label.letter`. So the
  *interaction* is already letter-based — only the *identity* and the *gate* are
  codeword/alphabet-bound.
- **The gate.** `showHints` bails `"Is BranchKit running?"` when
  `!isAlphabetLoaded()`. No alphabet → no pool → no codewords → no letters → no
  hints. This is the single coupling that makes hints non-standalone.
- **Static phrases are platform-side.** "scroll down", "show", "find" etc. live
  in the browser plugin (Go: `commands_register.go` / `plugin.json`), and the
  voice panel reads them back via the plugin's authed `GET /voice-commands`
  (`commands.enumerate`) — the wrong direction under independence.

## Target model (from the design note)

- **Letter is the primary identity** — locally assigned, deterministic,
  BranchKit-independent. The SW pool coordinates **letters** across frames.
- **Codeword is a projection** — when BranchKit pushes its 26-word alphabet, each
  letter maps to a spoken word; voice addresses the letter via that overlay.
- The extension **contributes** phrases up to the plugin (which becomes a thin
  registrar), never reads them back.

## Open design decisions (surface before building)

### D1 — Letter-label scheme (forks Phase 1) — DECIDED: A (2026-06-18)

**Decision: uniform two-letter pairs (A), to match the voice plugin's two-token
(prefix × suffix) grammar.** The labels are two letters because that is exactly
what the plugin supports; this keeps the pool/reservoir/sync/routing identical and
preserves the voice invariant. Rationale below.


The pool is emphatic that hints are **uniform two-token pairs, no singles**, to
kill prefix ambiguity for the two-stage voice grammar (prefix collection ×
per-prefix suffix collection). Three ways to assign letters:

- **A. Uniform two-letter pairs (recommended).** Feed `buildPool` a fixed
  26-letter alphabet instead of 26 codewords → tokens like `f d`, square-fill
  ordered. The badge shows `fd`; you type `fd`. **1:1 with every existing
  mechanism** (pool / reservoir / sync / grammar / routing all stay; only the
  pool's source array changes). Preserves the voice prefix×suffix invariant.
  Cost: the first hint needs 2 keystrokes (no single-char shortcut).
- **B. Vimium variable-length** (home-row singles first, then pairs; prefix-free).
  Fewest standalone keystrokes. But a single-letter hint projects to a
  single-word codeword, reintroducing the prefix ambiguity the pool was built to
  avoid, and it's a larger rewrite of the pool/reservoir ordering — risk to the
  tuned voice path.
- **C. Hybrid** — variable-length for typing, uniform-pair projection for voice.
  Two label shapes to reconcile; most complexity.

Recommendation: **A**. It's the faithful inversion with the smallest blast radius
on a subsystem the memory flags as high-risk ("ship one layer at a time, long
soak"). B is a later ergonomic refinement decoupled from voice, if standalone
keystroke count proves annoying.

### D2 — SW letter-authority (low risk)

The SW already mediates an opaque cross-frame token pool. Keep it verbatim; just
change the pool's source "alphabet" from BranchKit's 26 codewords to a fixed
extension-owned 26-letter constant. No new IPC, no new authority — this is the
natural reading of "it already mediates `CLAIM_LABELS`." A side benefit: hint
identities stop churning when BranchKit connects/disconnects, because the alphabet
swap no longer regenerates the pool.

### D3 — extension→plugin contribution protocol (later phase, NEEDS CONFIRM)

To keep voice working after the inversion **without a plugin change**, the
extension translates letter-pair ↔ codeword at its own boundaries:
- outbound (grammar POST in `label-sync`): token `f d` → `<word_f> <word_d>`,
- inbound (voice activation `message.codeword`): codeword → `f d` → `byCodeword`,
- badge word/both display: letter → codeword via the overlay.

That is all extension-internal and is part of Phase 1. The **cross-repo** half —
static phrases move into the extension catalog, the plugin becomes a thin
registrar of contributed phrases (same channel as the dynamic hint grammar), the
voice panel sources from the catalog, two distinct scroll commands — is Phase 2+
and needs sign-off before starting.

## Phases

- **Phase 1 — invert the hint labels (extension-internal). IMPLEMENTED 2026-06-18,
  pending real-Chrome soak.** What landed:
  1. `words.ts`: `LETTERS_26` (ergonomic order) is the pool's alphabet.
     `setAlphabet` now installs a VOICE OVERLAY (`LETTER_TO_WORD` /
     `WORD_TO_LETTER` by alphabetical index) instead of feeding the pool;
     `isVoiceAlphabetLoaded()` replaces `isAlphabetLoaded()`. New translation
     helpers `tokenToSpokenCodeword` / `spokenCodewordToToken` /
     `letterToSpokenWord` / `spokenWordToLetter`. `labelToDisplay` shows letters
     standalone, spoken words via the overlay.
  2. `label-pool.ts`: `getAlphabet()` returns `LETTERS_26`; pool token = letter
     pair. SW/reservoir/sync mechanics unchanged (opaque tokens). Removed the
     now-dead `regenerateAllStacks` (alphabet no longer churns the pool).
  3. `content.ts`: dropped the `showHints` + `doScanBatched` alphabet gates;
     `poolLabelToAssignment` derives the letter from the token; new `isPaintReady`
     paints badges full-opacity standalone (grammarReady only gates when voice is
     on); the on-load + onChanged alphabet handlers no longer wipe codewords —
     they just adopt the overlay, re-render, and re-push.
  4. Voice overlay confined to the SW boundary (plugin unchanged): `background.ts`
     `postGrammarBatch` translates outbound letter→spoken AND the response's
     succeeded/failed spoken→letter; `frame-router.ts` translates inbound voice
     params spoken→letter before routing + forwarding. `label-sync.postBatch`
     short-circuits to a local ACK when voice is off (so wrappers attach with no
     plugin). The grammar-epoch shadow hashes the SPOKEN translation so the
     plugin's digest still matches.
  5. `tsc` + `vitest` (865) green; both bundles build. **NOT YET DONE: 30+ min
     real-Chrome soak** — steady-state browsing, type-to-pick standalone, and
     BranchKit connect/voice/disconnect transitions. Per the high-blast-radius
     history this is the merge gate.

  Known follow-up: clean overlay teardown on SSE disconnect (voice-on → quit) so
  a stale overlay can't leave new badges stuck pending; deferred to avoid a
  transient-disconnect footgun.

- **Phase 2 — extension owns its command vocabulary. IMPLEMENTED 2026-06-18,
  pending soak.** Static scroll/find/nav phrases moved into the
  `command-catalog` (`voice` per entry); the plugin became a thin registrar over
  `POST /commands/contribute` (its hardcoded phrase builders deleted); the voice
  panel + the `/voice-commands` endpoint were retired so the editor sources
  phrases from the catalog. Full design + decisions + commit list in
  `DESIGN_COMMAND_CONTRIBUTION.md`. Scope A: activate-by-codeword + references
  stay plugin-side (grammar-coupled). The platform-generic OS scroll (the third
  scroll input) is out of scope — a later platform item.

## Constraints carried in

- No unprompted pushes / no submodule-pin bumps; commit per sub-repo; check
  `git diff --cached` before each commit (parallel sessions share the checkout).
- Don't relaunch the app / restart plugins unprompted.
- Label changes are high blast radius — one layer at a time, long soak before
  merge; a sync throw may be load-bearing backpressure.
</content>
</invoke>
