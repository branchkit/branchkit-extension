# Hint-show latency — why hints lag after an extension reload, and the fix

Date: 2026-06-29
Status: proposal. Two fixes; Fix B is a safe tune, Fix A is in the fragile
injection layer and is soak + dual-CS-harness gated.

Companion to `DESIGN_EXTENSION_RELOAD_SURVIVAL.md` (the reinject machinery) and
`DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md` (the dual-CS race this must not reintroduce).

## Symptom

Pressing the show-hints shortcut (the user's Ctrl+S) sometimes does nothing;
the user switches away, comes back, and the hints appear — often only after
reloading the extension. A perceptible lag, worst right after an extension
reload.

## Investigation findings

1. **Show is content-script-local.** There is no `commands` block in
   `manifest.json`; Ctrl+S is intercepted by the content script's keydown handler
   (`content.ts:3160`) and dispatched through `keyHandler` →
   `dispatcher.register('show_hints' / 'toggle_hints')` (`content.ts:822,847`) →
   `doScan(); showHints()`. So showing hints REQUIRES a live content script in
   the tab. No live CS → Ctrl+S is a no-op.
2. **Reload → reinject gap (dominant).** On reload, `reinjectContentScripts`
   (`background.ts:1161`) fans out eagerly, but each tab routes through
   `ensureContentScriptInjected` (`injection.ts:229`): ping the dead orphan →
   unconditional **500ms** wait (`PING_RETRY_DELAY_MS`, `injection.ts:227,231`) →
   ping again → lock → `status:'loading'` skip (`injection.ts:250-252`) → flush →
   inject. So an already-open tab has NO working CS for ≥500ms after a reload,
   longer if mid-load. `tabs.onActivated` re-enters this path — which is why
   refocusing the tab "fixes" it.
3. **Auto-show settle (secondary).** Even once a fresh CS boots, the always-mode
   auto-show in `kickInitialScan` (`content.ts:694`) chains storage read →
   `setTimeout(0)` → coalesced scan → `whenDOMSettles` → `flushNow` → `showHints`.
   `whenDOMSettles` waits for the DOM to be quiet 200ms, capped at
   `SETTLE_MAX_WAIT_MS = 3000` (`content.ts:550`); on a busy, constantly-mutating
   page it waits the full ~3s. (Manual Ctrl+S bypasses this — it's the auto path
   that's slow.)
4. **No-reload case = visibility lifecycle.** A tab loaded hidden defers all hint
   machinery until first shown (Lever 2; `kickInitialScan` gated on
   `hintMachineryEnabled`, `content.ts:718`); a backgrounded tab suspends and
   resumes on return (`onVisibilityChange`, `content.ts:3414`). Refocusing
   triggers the scan + paint — not the earlier keypress.
5. Sticky factor: `toggle_hints` persists `setHintsShown` (`content.ts:857,862`)
   and `shouldAutoShowHints` requires it true (`content.ts:577`) — toggled-off
   stays off across reloads until an explicit show.

## The constraint — don't reintroduce the dual-CS race

The 500ms retry and the `status:'loading'` skip are **deliberate**. A
freshly-loading manifest content script doesn't register its message listener
until module init finishes (~tens of ms, longer on heavy pages). If the SW
injects in that window, two live content scripts land in one frame and
ping-pong-wipe each other's grammar — the race `scripts/_test-dual-cs-race.mjs`
gates against. Deleting these protections reintroduces that race.

## The key insight

The dual-CS race requires a **fresh manifest CS booting**, which only happens on
a page **load** — never on an extension **reload**. MV3 does not re-fire
declarative `content_scripts` into already-open tabs on reload (the whole reason
the reinject machinery exists). So on the `reinjectContentScripts` path, a tab
that is already `status:'complete'` has only the **dead orphan** present — there
is no fresh CS to race, and the 500ms wait protects nothing. It is pure latency
on exactly the user's scenario.

## Fixes

**Fix A — skip the retry on the reload path (dominant lag).** Add a `fromReload`
option to `ensureContentScriptInjected`; `reinjectContentScripts` passes it. With
it set: ping once → if dead, enter the lock immediately → KEEP the
`status:'loading'` skip (so a tab mid-navigation during the reload still defers
and stays race-protected) → flush + inject. Removes ~500ms+ per tab on reload.
- Residual risk: a tab that finished loading within ~tens of ms of the reload
  (fresh CS mid-init, status already `complete`) could be raced. Requires a
  navigation and an extension reload to coincide within that window — very rare,
  and self-healing via the grammar-epoch handshake. Conservative alternative: a
  shorter retry (e.g. 150ms) on the reload path instead of skipping it.

**Fix B — lower the auto-show settle cap (secondary lag).** Drop
`SETTLE_MAX_WAIT_MS` from 3000 to ~1000 (`content.ts:550`). `whenDOMSettles` has
a single caller (the boot auto-show, `content.ts:703`), so this only affects how
long the always-mode first paint waits on a busy page. Low risk — it paints
sooner and the reconcile pass catches later mutations.

## Validation

- `scripts/_test-dual-cs-race.mjs` stays green — Fix A does not touch the
  default (non-`fromReload`) path that test exercises (fresh-install/load race).
- `npm run soak:orphan` stays PASS (teardown unaffected).
- Manual: reload the extension on a heavy open tab (YouTube /watch) and confirm
  hints paint promptly without a refocus; confirm no double-badge / grammar
  flap (the dual-CS tell).
- This is the fragile injection layer (`[[orphan-teardown-high-blast-radius]]`),
  so a real-browser soak precedes any push.

## Status

Implemented (Fix A: `fromReload` in `injection.ts` + `background.ts`; Fix B:
`SETTLE_MAX_WAIT_MS` 3000 -> 1000 in `content.ts`). Automated validation green:
tsc, unit tests, both builds, `_test-dual-cs-race.mjs` **GATE: PASS** (default
race-protection path intact), `npm run soak:orphan` **PASS**. Remaining gate
before push: the manual real-reload soak (heavy open tab → reload extension →
hints paint promptly, no double-badge / grammar flap).
