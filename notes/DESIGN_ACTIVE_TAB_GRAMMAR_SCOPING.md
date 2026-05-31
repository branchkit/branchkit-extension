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
