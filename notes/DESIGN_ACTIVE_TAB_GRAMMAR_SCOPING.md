# Active-Tab Grammar Scoping: Stop Background Tabs Clobbering the Hint Vocab

Painted hint badges on the focused tab are not voice-matchable. The
matcher only ever holds a tiny slice of the visible codewords. Root cause:
the per-prefix hint collections are a single global namespace, but every
tab (focused or not) rebuilds and REPLACEs them from its own state, so the
last tab to push wins and orphans everyone else. This doc records the
mechanism and the fix.

## Status

| Step | What | Status |
|---|---|---|
| 0 | Attribution (live actuator collection inspection) | Done (2026-05-30) |
| 1 | Root-cause trace | Done (2026-05-30) |
| 2 | Design | This doc |
| 3 | Implementation (Option A) | Done (2026-05-30) |
| 3b | Cross-*browser* gate (Chrome+Firefox concurrent) | Done (2026-05-30) |
| 3c | Always-reactivate on app-refocus | Done (2026-05-30) |
| 4 | Verify on real browser | Done (2026-05-30) — user-confirmed on YouTube |
| 5 | Clobber recurred (unbound `conn=""` client) — A-vs-B re-opened | Diagnosed (2026-06-01) — see amendment at end |
| B1-B4 | Option B impl (store all, project focused) + gate removal | Done (2026-06-01) |
| B5 | Routing repoint (`LastTabID`→`FocusedTabID`) + dead-code cleanup | Done (2026-06-01) |
| B6 | Projection tests + docs | Done (2026-06-01) |

> **Resolution (2026-05-30).** Shipped Option A (gate the grammar push to the
> active tab) and went further. Three coupled fixes landed and were
> user-verified:
>
> 1. **Option A cross-tab gate** — the extension stamps the active tab and the
>    plugin rejects grammar batches from non-active tabs, so a background tab
>    can no longer REPLACE the global per-prefix collections. `LastTabID`
>    becomes correct for free (only the active tab pushes). Extension commits
>    `7270943` (scope to active tab) + `3a124e0` (recover grammar after
>    extension reload, closing the `cachedActiveTabId==null` fail-open window).
> 2. **Cross-*browser* gate** — the per-tab gate is per-service-worker, so it
>    can't stop Chrome + Firefox both POSTing to the same plugin. Added a
>    plugin-side focus gate keyed on `FocusedBundleID` (the OS-focused app),
>    primed at startup from `native.frontmost_app` so it isn't stuck failing
>    open until the first focus change. Browsers stamp `bundle_id` on batches
>    and on the SSE `/events` connect; dispatch/rescan fan out only to the
>    focused browser's clients. Browser plugin `96655bb` + extension `c24c2bb`.
> 3. **Always-reactivate on app-refocus** — `pushRescanToClients()` now always
>    sends `reactivate` (full re-push) instead of a `from_cache` delta. The
>    plugin clears a tab's grammar on browser switch, tab switch, AND session
>    end, so a `from_cache` rescan after any of those sends zero elements and
>    the per-prefix collections stay empty (badges paint but won't voice-match).
>
> The open questions below (where to gate, tab-switch republish, stale state on
> deactivation, multi-window) were resolved in passing by the implementation;
> retained for the rationale.

## Evidence (live, 2026-05-30)

Queried the running actuator's collections via
`/inspector/collection/<name>` while the user's YouTube tab had many hint
badges painted:

| Collection | Contents |
|---|---|
| `browser_hints_prefix` | `{ bat }` — one prefix |
| `browser_hints_bat` | `{ jury }` — one suffix |
| `browser_hints_cap` | empty |
| `browser_hints_air` | empty |

So the only voice-matchable hint in the whole browser was `bat jury`. Every
`cap …` / `air …` badge the user saw was unmatchable — `cap` and `air` were
not even in `browser_hints_prefix`, so the `<prefix:browser_hints_prefix>`
capture could never resolve them.

`entity_cache_keys=36` in MATCHER_DIAG is a red herring: that is
`entity_cache.len()` — total collection keys across all plugins (numbers,
letters, command-sets, plus per-prefix hint collections) — not a count of
matchable codewords.

Plugin log at the same time showed `tab=29 frame=0` pushing
`kind=incremental elements=1` batches in a tight loop, each one a
`session cleanup … reason=session_id_changed`. `tab=29` is a background tab,
not the YouTube tab.

## Root cause

Two coupled facts in the browser plugin:

1. The per-prefix collections use a **global** name —
   `browser_hints_<prefix>` and `browser_hints_prefix`
   (`batch.go` push, `cleanupFrameSessionLocked`). There is no per-tab
   namespacing.

2. Each grammar batch rebuilds those collections from a **single tab's**
   sessions — `buildTabPrefixState(req.TabID)` (`batch.go:366`, called at
   `batch.go:501`) — and pushes them with dynamic-collection REPLACE
   semantics.

Therefore any tab's push REPLACEs the global collection with only that
tab's contents. The `browser_hints_prefix` list is the worst case: a
background tab holding one hint (`bat jury`) re-pushes the prefix list as
`{ bat }`, wiping every prefix the focused tab contributed. The focused
tab's `browser_hints_<other-prefix>` entries may physically survive (they
weren't in that push's `affectedPrefixes`), but with their prefix gone from
the prefix list they're unreachable.

In always-mode every tab runs continuous MO-driven incremental sync
(`label-sync.ts` `syncNow`, `kind:'incremental'`). The push is **not**
gated on the tab being active. The `browserFocused` guard at `batch.go:467`
only protects the hints *tag* (the exclusive gate), not the collection
push. So a noisy background tab clobbers the focused tab's vocabulary on
every mutation.

The routing side has the same defect. `state.LastTabID` is set to
`req.TabID` on **every** batch (`batch.go:446`), and voice action routing
reads it (`collections.go:254`, `bridge.go:425`) to decide which tab gets
the click. So "which tab the codeword routes to" is "last tab to POST",
not "focused tab".

## The intent was already active-tab-only

This is a missing enforcement, not a missing design. The code already says
the active tab is the only one that should matter:

- `pushRescanToClients` (`focus.go:84-87`) routes with `target=active`:
  "only the active tab's state matters for what the user can speak."
- `handleSessionEnded` (`focus.go:201-207`) deliberately avoids using a
  stale background batch's gate state as a focus proxy.

The grammar push and `LastTabID` simply never got the same treatment. They
use "last tab to push" as a stand-in for "focused tab", which is correct
only when background tabs are silent — and in always-mode they never are.

## Secondary: session ping-pong (likely a test artifact)

On `tab=29 frame=0` two distinct `session_id`s alternate, each
`ensureFrameSession` call wiping the other's codewords
(`session_id_changed cleared=N`). Since `sessionId` is module-load-stable
per content script and only rotates on alphabet change
(`label-sync.ts:107-118`), two ids on one frame means two content-script
instances on that frame — almost certainly an orphaned CS from an extension
reload during this investigation (see the "extension reload orphans CS"
note), not a product defect. Tracked here only so it isn't re-discovered;
out of scope for the fix below. If it recurs on a clean profile it graduates
to its own investigation.

## Options

**A. Gate the grammar push to the active tab (extension side).** A content
script only POSTs grammar batches when its tab is the active tab.
Background tabs keep their local wrapper store and pending-put queue but
suppress the POST; on becoming active they flush. The background already
tracks the active tab (`chrome.tabs.query({active:true})`) and owns the
GRAMMAR_BATCH relay, so it can drop batches from non-active senders (or
hand the CS its active-ness). Tab activation must trigger a republish of
the now-active tab — the existing `target=active` + `from_cache=true`
rescan path already does this for app refocus; tab-switch activation needs
the same nudge.

- Pro: matches the stated intent; smallest conceptual change; `LastTabID`
  becomes correct for free because only the active tab pushes; global
  collection naming stays.
- Con: needs an active-ness signal the CS or relay can act on, and a
  guaranteed republish on tab activation (not just app refocus).

**B. Per-tab namespaced collections + publish the active namespace.** Push
to `browser_hints_<tabid>_<prefix>` and, on focus/activation change, point
the matcher's hint commands at the active tab's namespace.

- Pro: every tab's state is retained server-side; switching is a cheap
  re-point, no rescan round-trip.
- Con: the command patterns bind fixed collection names
  (`browser_hints_prefix`, `browser_hints_${prefix.codeword}`), so this
  needs an indirection/aliasing layer in the matcher or a per-switch
  command-set re-push. Larger blast radius; more moving parts; retains
  vocab for tabs the user can't act on anyway.

**C. Make the actuator hint collections active-tab-scoped at the platform
level.** Generalize per-tab/active-scope as a collection feature.

- Pro: one mechanism, no plugin-side gating.
- Con: this is plugin-specific scoping logic; pushing it into the actuator
  violates the actuator-stays-generic rule. Rejected on that basis.

## Recommendation

**Option A.** It enforces the scoping the codebase already declares, keeps
the global collection naming, and fixes routing (`LastTabID`) as a side
effect because the active tab becomes the only pusher. The retained-state
benefit of B is moot — the matcher should never hold codewords for tabs the
user isn't looking at (matching one would route a click to an invisible
tab). The one real cost is ensuring tab-switch activation republishes; the
`target=active` / `from_cache=true` path is most of that machinery already.

## Open questions for implementation

- **Where to gate.** Background relay (drop GRAMMAR_BATCH from non-active
  `sender.tab.id`) vs. content script (skip the POST when told it's
  inactive). Relay-side is closer to the source of truth (it already does
  `tabs.query`) and keeps the CS dumb.
- **Tab-switch republish.** Confirm whether `chrome.tabs.onActivated`
  already triggers a rescan to the newly-active tab; if not, wire one
  through the existing `target=active`, `from_cache=true` path.
- **Stale state on deactivation.** When a tab loses active status, should
  its codewords be cleared from the global collections immediately, or left
  until the new active tab's republish overwrites them? Clearing avoids a
  brief window where the old tab's codewords are matchable but route
  nowhere; leaving them is simpler. Republish-overwrite is probably enough
  if activation reliably republishes.
- **Multi-window.** `active:true` is per-window; the focused-app gate is
  global. Decide whether "active tab" means active-in-focused-window only.
  **Resolved (2026-06-01): "focused tab" = the active tab in the OS-focused
  window.** Under Option B the projected source is `(FocusedConnID,
  FocusedTabID)`, and `FocusedTabID` comes from the extension's `/active-tab`
  POST. The extension reports the active tab of the window that just gained OS
  focus (`chrome.windows.onFocusChanged` / `tabs.onActivated`), so a second
  background window in the same browser process never advances `FocusedTabID` —
  its tab churn lands in `ConnActiveTab` for that conn but only the focused
  window's report is the one fresh at focus time. No extra per-window keying
  needed: one connection serves all windows of a browser, and the active-tab
  signal already collapses to the focused window.

## Amendment (2026-06-01): the clobber recurred — Option A has an unbound-client hole

Option A shipped and held for ordinary tab/browser switches, but the clobber
came back live with **two browser clients connected at once** (`sse=2`):

- bound client `conn="60f0b2a9…"`, small tab ids (34/43), 808 grammar batches
- **unbound** client `conn=""`, huge tab id 148763457, 13 grammar batches

The unbound client's batches REPLACEd the global per-prefix collections from
its own state, producing 18 `silent_eviction_rebuild` of the focused client's
codewords at one instant and a Vosk vocab flap (375↔377 = a full recognizer
rebuild per clobber = a deaf window). Symptom the user hit: "hints don't
update, and a command on a fresh page didn't navigate."

### Why the gate let it through

The cross-browser focus gate (`batch.go:561`) has precondition
`connCount > 1 && focusedBundle != "" && req.ConnID != "" && boundBundle != "" && boundBundle != focusedBundle`.
The `req.ConnID != ""` and `boundBundle != ""` clauses **fail open for an
unbound connection** by design ("can't prove it's the background one"), so a
batch with `conn=""` skips the gate entirely. Confirmed: `REJECTED
inactive_browser` count was 0 during the clobber. The damage is therefore
**invisible** in the actuator log — the gate reports nothing because it never
fires.

### Where conn="" comes from (not a current-build bug)

The current extension cannot emit `conn=""`. There is exactly one POST path to
`/grammar/batch` (`background.ts:postGrammarBatch`), and it overwrites the
field with the module-level `connId = crypto.randomUUID()`
(`background.ts:84`, stamped at `:537`); both SSE connect paths (Chrome
offscreen `:650`, Firefox direct `:665`) carry the same `connId`. The
content-script's hardcoded `conn_id: ''` (`content.ts:1450`) is always
overwritten. `connId` was introduced in commit `598a996` (2026-05-31 00:26).

So a `conn=""` client is a browser running a build **older than `598a996`** —
i.e. a stale extension that was never reloaded after that commit. In the live
incident the unbound client was **Google Chrome running since 2026-04-28**
(month-long session → huge tab id 148763457, never reloaded), while the
focused, reloaded Firefox was the bound `conn="60f0b2a9…"` client. The
leftover `rod`/Playwright Chromium instances on the machine carry no extension
(`--load-extension` absent) and are not the source.

The deeper point is not "a stale build existed." It is that **Option A's
correctness depends on two things the runtime cannot guarantee: correct focus
attribution AND every grammar-posting client being bound.** A stale build, a
browser whose SSE never bound, or any future unbound poster is
indistinguishable from a legitimate "can't prove background" client, and it
silently clobbers the shared global namespace with zero log signal.

### Re-opening A vs. B (recorded decision, not silent drift)

The original recommendation rejected Option B partly because "the matcher
should never hold codewords for tabs the user isn't looking at." That argument
still stands for the *retained-state* benefit, but it missed a structural
property that the freeze evidence now foregrounds:

- **Option A keeps the single global namespace** (`browser_hints_prefix`,
  `browser_hints_<prefix>`) and protects it with a *gate*. Any unbound or
  mis-attributed poster that slips past the gate REPLACEs the whole namespace.
  The blast radius of one bad poster is "everyone." The gate is also the *only*
  thing standing between a background poster and total clobber, and it fails
  open in exactly the case that bit us.
- **Option B namespaces per source** (`browser_hints_<tabid>_<prefix>`, or a
  per-browser key) and publishes the active namespace. There is **no shared
  global collection to REPLACE**, so an unbound or background poster writes to
  its *own* namespace and cannot clobber the focused source's vocabulary at
  all. Focus resolution moves from "gate every write" to "point the matcher at
  the active namespace" — a read-time selection, not a write-time veto.

In other words, B is **structurally immune** to the unbound-client clobber that
A can only ever gate against. This reframes B's cost (the matcher needs an
aliasing/indirection layer so the fixed command patterns resolve to the active
namespace) as buying clobber-immunity, not just retained state. A related
observation from adjacent freeze work: B would also **retire the per-source
clear-and-rebuild** (`cleanupFrameSessionLocked` rebuilding the global prefix
list from one tab), because there would be no global list to rebuild — each
source owns its own and switching is a re-point. See
[[project_hint_grammar_multitab_clobber]] and the dependent-captures track,
which is an *orthogonal* axis (per-prefix → one capture; it does not address
the per-source dimension).

This is **not** a decision to switch to B. It records that the freeze evidence
materially changes the A-vs-B tradeoff that was settled on 2026-05-30, so the
choice is explicitly re-opened rather than left to drift.

### Fix directions still open (none implemented)

1. **Harden A (defensive).** Refuse a global-collection REPLACE from an
   unbound (`conn=""`) batch whenever `connCount > 1` — treat "unbound while
   others are bound" as "probably background/stale, must not clobber." Flips
   the fail-open clause to fail-safe. Smallest change; keeps the global
   namespace; still relies on focus attribution for the bound-vs-bound case.
2. **Close the binding gap.** Find why a real browser ever posts grammar
   without an SSE-bound `conn_id` and make binding a precondition for
   accepting global-collection writes. (In this incident the cause was a stale
   build, which reloading fixes — but that does not harden against recurrence.)
3. **Adopt B (structural).** Per-source namespaces + active-namespace
   publish; removes the shared global namespace entirely. Largest blast radius,
   needs the matcher aliasing layer, but eliminates the clobber class.

Before any of these, confirm the current code still matches this writeup
(grep `buildTabPrefixState`, `LastTabID`, `req.ConnID`, the `batch.go:561`
gate) — the hint subsystem has a history of fixes landing against a moved
target.

## Feasibility verdict (2026-06-01): B is plugin-side, no actuator change

Direction 3 was deferred originally because it looked like it needed "matcher
aliasing." Tracing the code shows it does not. Two findings:

1. **The actuator is already generic here.** Every `browser_hints*` reference
   in `actuator/src` is a *test fixture* (`commands.rs` `make_cmd(...)`,
   `context_engine.rs` `entity_cache.insert(...)`). The dependent-capture
   substitution `<prefix:browser_hints_prefix> <suffix:browser_hints_${prefix.codeword}>`
   is generic string substitution over arbitrary collection names; the matcher
   has no knowledge that these names are special. The plugin owns the names
   (`collections.go:126,182-188`) and their contents (`batch.go` `pushFn`).
2. **The plugin already separates store from project.** The per-batch handler
   (a) stores codewords in `session.Codewords` inside `state.FrameSessions`,
   keyed per `(conn, tab, frame)` — already isolated per source
   (`batch.go:621`); then (b) projects *one* source via
   `buildTabPrefixState(req.ConnID, req.TabID)` (`batch.go:633`) into the
   canonical `browser_hints_*` collections (`642-717`). The entire clobber is
   in step (b), purely because it runs on every batch keyed on the *pusher's*
   `(conn, tab)`.

So B does not need persisted per-source collections or an aliasing layer. The
per-source "namespace" is the in-memory `FrameSessions` map that already
exists. B = **always store, project the focused source only.** A background /
unbound / stale-build source updates its own in-memory session and never
touches the canonical collections; there is nothing shared to clobber. The
matcher keeps reading the same fixed canonical names, unchanged.

## Phased plan for B (plugin + extension only)

End state: the plugin tracks an authoritative focused `(conn, tab)`, projects
only that source into the canonical collections, and the three write-time gates
are deleted. Routing (`LastTabID`) is fixed as a side effect. No actuator
change; no `plugin.json` change (the `apps` privilege primeFocusedBundle needs
already landed), so each Go phase is `just rebuild browser` and each extension
phase is an extension rebuild + reload in *both* browsers (F5 affected tabs to
clear orphaned content scripts — see the "extension reload orphans CS" note).

Phases are ordered so each lands safely: 1-2 are behavior-equivalent under the
existing gates (no-op while gates are on), the behavioral switch happens at 3-4,
and 5 deletes the now-dead machinery for a clean end state.

**Phase 1 — Plugin learns the authoritative focused `(conn, tab)`.** Additive;
nothing reads the new fields yet.
- Add `FocusedConnID`, `FocusedTabID` to `State` (`main.go`).
- `FocusedConnID`: set in `handleAppFocused` / `reconcileFocusBindingLocked`
  (`focus.go`) by reverse-looking-up `SSEClientBundles` for the conn whose
  bundle == `FocusedBundleID`.
- `FocusedTabID`: extend the existing browser→plugin `/focus` POST
  (`background.ts:591`, currently `{conn_id, focused}`) to carry
  `active_tab_id`, and ALSO send it on `chrome.tabs.onActivated` (tab switch
  without an app refocus). Plugin records `FocusedTabID`.
- Verify: log both fields on every focus/activation change; confirm they track
  the browser the user is actually in. Gates still on, no behavior change.

**Phase 2 — Project the focused source (no-op under gates).**
- Change the per-batch projection (`batch.go:633` + push at `642-717`) and the
  `cleanupFrameSessionLocked` projection (`batch.go:270-300`) to build from
  `state.FocusedConnID, state.FocusedTabID` instead of `req.ConnID, req.TabID`.
- Add a re-projection trigger: Phase 1's focus/activation handler re-runs the
  projection for the now-focused source (rebuilds the canonical collections
  from its `FrameSessions` state).
- Why safe: with gates still on, only the focused source's batches arrive, so
  `req.{ConnID,TabID} == Focused{ConnID,TabID}` and output is identical. This
  is a pure refactor that relocates the projection key.
- Verify: no regression in single-browser, single-active-tab use.

**Phase 3 — Decouple store from project; remove the plugin cross-browser gate.**
- Make the handler ALWAYS store (`session.Codewords` update for any accepted
  batch) but keep projection focused-only (Phase 2). Remove the cross-browser
  focus gate (`batch.go:561`), including the `req.ConnID != ""` fail-open hole —
  non-focused batches are now accepted-and-stored, which is harmless because
  they never project.
- Scope `detectSilentEvictions` / `LastPushedSuffixes` (`batch.go:694`) to the
  focused-source projection only (a non-focused store does not push, so it must
  not run eviction detection).
- Verify: background browser POSTing grammar no longer clobbers; its codewords
  sit in its own `FrameSessions` entry; switching focus to it re-projects them.

**Phase 4 — Remove the extension-side gates.**
- Delete the active-tab gate in the GRAMMAR_BATCH relay (`background.ts:~1029`)
  and its `cachedActiveTabId==null` reload fail-open logic, and the CS-side
  gate (`content.ts:1512`, `syncNow` `if (!tabActive) return` at `:248`).
- Keep `cachedActiveTabId` ONLY as the source of the Phase 1 `active_tab_id`
  signal; its gating role is gone.
- `primeFocusedBundle` relaxes: a missing startup focus signal now means
  "project last-known / nothing yet," not "accept and clobber." Keep priming;
  drop its urgency.
- Verify: all sources POST freely; plugin stores all, projects focused; no
  clobber, no vocab flap across browser/tab switches.

**Phase 5 — Fix routing + delete dead code (clean end state).**
- Repoint routing reads of `LastTabID` (`collections.go:277`, `bridge.go:437`)
  to `FocusedTabID`. Remove `state.LastTabID = req.TabID` (`batch.go:579`) and
  the `LastTabID` field if unused.
- Delete the `inactive_browser` response path, `inactiveResponse`, dead gate
  helpers/logs, and any transitional remnants from phases 2-4.
- Simplify `detectSilentEvictions` if its cross-source-clobber detection role
  is now moot (within-focused-source eviction detection may still be worth
  keeping).

**Phase 6 — Verify live + docs.**
- Multi-browser live test: Chrome + Firefox, switch focus repeatedly, confirm
  the focused browser's painted hints are voice-matchable, the background
  browser cannot clobber, and Vosk vocab does not flap. Re-run the
  doubled-word (`bat bat`) and dependent-capture (`bat jury`) cases.
- Resolve open Q #4 (multi-window): define "focused tab" = active tab in the
  focused window.
- No branchkit-web narrative doc needed — B uses existing primitives (dynamic
  collections, dependent captures); it introduces no new collection kind or
  action type. (Confirm this still holds at implementation time.)
- Tests: `TestProjectsFocusedSourceOnly`,
  `TestBackgroundBatchStoresButDoesNotProject`, `TestFocusChangeReprojects`;
  remove/replace the cross-browser-gate tests.

Net effect: three write-time vetoes across two layers (extension relay gate, CS
gate, plugin cross-browser gate) collapse into one read-time projection
selector in the plugin, the unbound-client clobber class is eliminated by
construction, and routing is fixed for free.
