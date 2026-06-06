# Codeword Stability Across Navigation

**Status (2026-06-06):** Regime B (SW-memory, ~62%), Regime A **mouse**
table-switch (DOM-survivor spare, `7af5cb8`), and now Regime A **voice**
table-switch (soft-detach, `9ff5b89`) are all landed — the voice re-attempt is
**LANDED and user-confirmed working** (sidebar codewords stay stable across a
voice table-switch). The original soft-detach revert (YouTube steady-state
regression) was caused by the placement limbo-skip (`reconcilePlacement`/
`ensureBound`), which the positioning migration deleted; reconcile positions on
`target.isConnected`, so a limbo survivor stays glued. Plan + research below.

## Re-attempt plan, post positioning-migration (2026-06-06) — LANDED `9ff5b89` (user-confirmed)

**Why the revert cause is gone.** The soft-detach was reverted because it parked
persistent chrome in limbo, and `reconcilePlacement` → `ensureBound` (the
anchor-name re-writer) deliberately skipped limbo wrappers, so those badges
dangled to the document origin. The positioning migration deleted
`reconcilePlacement`/`ensureBound` entirely. `reconcileRead` positions on
`target.isConnected` (NOT `disconnectedAt`), so a soft-detached-but-connected
survivor is still positioned every reconcile pass. The plan is therefore viable
and **simpler than the original** — no `observersSuspended` flag is needed (it
existed only to keep placement running for suspended survivors; placement is gone).
Reusing `disconnectedAt` + an `isConnected` guard on the rebind pool is sufficient.

**The change (4 edits + a breadcrumb), grounded against the current tree:**

1. **`softDetachAllForNav()`** — for each `store.all` wrapper:
   `resizeObserver`/`tracker`/`attentionObserver`.unobserve (the same wedge preempt
   `detachWrapper` does, content.ts:1188-1190), seed `lastRect` from the warm
   layout cache, then `enterLimbo(w, now)`. Do NOT call `removeWrapperByElement` —
   codeword, registry id, and pending Put/Delete state are untouched (identity
   retained; no `queueDelete`).
2. **Activate-click swap** — replace `preNavDetachAll('activate_click')`
   (content.ts:2575) with `softDetachAllForNav()`. The pre-click unobserve (wedge
   preempt) is byte-for-byte preserved; only the identity release is dropped.
3. **Finalize re-observe** — `finalizeExpiredLimboWrappers` (content.ts:3395)
   graduates a still-connected expired-limbo wrapper (`disconnectedAt=null`) but
   does NOT re-observe it → blind. Add `tracker.observe` + `resizeObserver.observe`
   (clear `disconnectedAt` first, mirroring `attachWrapper`; not attentionObserver).
   Level-triggered backstop: a survivor un-blinds within ≤250ms (LIMBO_DEADLINE_MS).
4. **Rebind-steal guard** — `collectLimboWrappers` (content.ts:3223) adds
   `&& !w.element.isConnected` so a live survivor in limbo can't be
   fingerprint-rebind-stolen by new content. No-op for today's behavior (limbo only
   ever held disconnected elements); a guard for the new path.

Plus a `pipeline.cs_nav_step {step:'soft_detach'}` breadcrumb.

**Behavior:** voice table-switch keeps the persistent sidebar's codewords (no
reshuffle); badges stay positioned via reconcile during the ≤250ms window; doomed
swapped-out content reaps/rebinds via the generic limbo path (bonus: content-rebind
by fingerprint now also covers the voice path).

**Carried constraints / test gate:** wedge preempt preserved — re-verify YouTube
channel "Videos" voice-activate does NOT freeze; soft-detach queues no Delete so
codewords stay matchable across the nav; no double-claim on re-observe (IO skips
limbo + claims only when no codeword held — order: clear `disconnectedAt` before
`observe`). Residual watch: the ≤250ms blind window (scroll/resize during it won't
reposition — low impact for a table-switch) and a brief pool overlap (doomed +
survivor codewords both claimed until finalize).

**Research validation (2026-06-06).** Cloned Rango + surveyed Vimium / Vimium C /
Surfingkeys / Tridactyl / Talon + identity/observer best practices. Outcome: label
stability across SPA nav is greenfield — Rango deliberately resets labels on nav
and keys identity on the live `Element` object (no fingerprint, only bfcache
heap-restore); Vimium's maintainer says there's "no good general solution." So our
fingerprint + limbo + confidence-ladder is ahead of the field and the right shape —
nothing to copy. Rango's `ElementWrapper.suspend()` (unobserve + keep-object +
re-observe) validates the soft-detach pattern, and no tool uses a separate
"observers suspended" flag — confirming **Choice A** (reuse `disconnectedAt` + an
`isConnected` rebind-pool guard) over the original `observersSuspended` proposal
(which only existed for the now-deleted placement limbo-skip). Reinforced
guardrails: (a) the IntersectionObserver initial-callback is THE double-claim
gotcha — clear `disconnectedAt` before `observe` in finalize, keep claim idempotent
(already so); (b) ambiguous fingerprint ties ⇒ fall back to a fresh codeword, never
guess (our `refuse_distance` already does this); (c) follow-up fingerprint-quality
fix — normalize counts out of accessible names ("Issues 42→43"), already a known
risk.

## Soft-detach attempt — implemented, confirmed, then reverted (2026-06-06)

The voice table-switch reshuffle was correctly diagnosed (see "Voice-path
finding"), a soft-detach fix was built, and a live trace confirmed it fixed the
voice table→table case (`softened:281`, **zero** re-minted sidebar wrappers on a
same-document switch). It was then **reverted** because of a steady-state
regression on YouTube.

**Why it was reverted — the limbo/placement collision.** Badges glue to their
target via an inline `anchor-name` on the target; YouTube rewrites target inline
styles ~10×/sec, constantly stripping it. `reconcilePlacement` → `ensureBound`
(content.ts) re-writes the `anchor-name` every scroll/resize tick to keep the
badge glued — but it **deliberately skips limbo wrappers** (`disconnectedAt !==
null`). The soft-detach parked *every* wrapper (including persistent chrome like
the YouTube left rail) in limbo, so for that window the anchor-repair stopped
running for exactly those elements → their badges dangled to the document origin
and "scrolled off."

**Root conflict:** `disconnectedAt` conflates two states — "disconnected,
rebind-eligible" (which placement *should* skip) and "live survivor with
observers suspended for the wedge preempt" (which placement must *not* skip).
Soft-detach overloaded the first to mean the second. Any future revival must NOT
reuse `disconnectedAt`: use a separate `observersSuspended` flag, keep
`reconcilePlacement`/`ensureBound` running for suspended-but-connected survivors,
and re-observe on graduate. That is more surgery in the highest-blast-radius area
and needs its own nav-soak + YouTube wedge re-verify.

**Also corrected — the QuickBase regime reality (Playwright + live traces).** The
original "Regime A re-render" premise was wrong: on a same-document table→table
switch QuickBase does **not** re-render the sidebar — the table-list nodes persist
(same nodes, same `anchor-name`s), so the mouse-spare keeps them stable. The
reshuffle is **Regime B full reloads**: `overview→table` (fresh-tab/myqb entry)
and **record open/close** both hard-reload the top frame (new content script),
which is the dominant real-world churn. Voice vs mouse is a red herring for the
regime; source-page type decides it (table view = same-document, overview/record
= full reload). So the highest-value next work is raising Regime B reclaim above
~62%, which covers records + entry for both mouse and voice.

---

## Voice-path finding (2026-06-06, trace-confirmed)

The earlier Outcome below said Regime A "landed, flicker-free." That was verified
on **mouse** table-switch only. A `trace.nav_lc` probe on a live voice
table-switch (QuickBase, `chdiinc.quickbase.com`, sidebar of `*Workflows*`
tables) shows the voice path is **not** fixed, and the mechanism is **not** what
this note hypothesized (re-render + limbo-rebind miss).

**What the trace shows.** Across the session the sidebar links (role `link`)
logged **531 `fresh`** but only **3 `limbo_in` / 3 `limbo_fin` / 4 `rebind`**.
`Agreement Workflows` got six `fresh` wrappers (new registry id each time) and
**never once** entered limbo or rebound. The sidebar DOM survives the nav — but
its wrappers are thrown away anyway, before the rebinder can see them.

**Mechanism.** The voice activate path runs **`preNavDetachAll('activate_click')`
*before* the click** (`content.ts`, the non-input branch of the BRANCHKIT_ACTION
handler) with `sparePersistent = false`. It hard-detaches **every** wrapper —
including the persistent sidebar — and `detachWrapper` releases each codeword to
the pool and unregisters its id immediately. There is **no limbo entry**, so the
deferred rediscovery's `tryRebindFromLimbo` has no candidate and mints fresh
codewords. The trace:

```
15:50:25.921  pre_nav_detach  reason=activate_click  detached:332  spared:0
15:50:26.202  pre_nav_detach  reason=rescan          detached:0    spared:7
```

**Why the spare fix missed it.** Commit `7af5cb8` added `sparePersistent` only to
the **rescan** call (`preNavDetachAll('rescan', true)`). The earlier conclusion
"detached:0 everywhere — NOT the teardown" was reading that rescan call; the
*activate_click* call (a separate, earlier `preNavDetachAll`) is the one that
wipes the store on voice. Mouse navigation has no activate_click teardown, so the
rescan-path spare covers it — consistent with the mouse `spared:~290` result.

**Also relevant (root-causes the bypass):** the nav rescan's deferred
`doScan → processScanBatch` path never consults limbo at all — it filters out
refs that already have a wrapper, then claims *fresh* codewords for the rest.
Limbo-rebind lives only in the MutationObserver discovery path
(`discoverInSubtree`/`discoverInSubtreeBatched` → `attachDiscovered` →
`tryRebindFromLimbo`). So even if limbo retention were extended, the ~2s deferred
nav scan could not reclaim through it.

## Proposed fix: soft-detach in the activate_click path

The activate_click teardown exists to tear down per-wrapper observers
**synchronously before the swap** (the wedge preempt). At pre-click time
*everything is still connected*, so a `sparePersistent` filter would spare
everything (`detached:0`) and lose the preempt. The spare trick structurally
can't help here.

So replace the *hard* detach with a **soft detach** that preserves the preempt
while retaining identity:

1. **`softDetachAllForNav()`** — for each wrapper: `tracker.unobserve` +
   `resizeObserver.unobserve` + `attentionObserver.unobserve` (the exact
   observer teardown the wedge needs, unchanged), seed `lastRect` from the layout
   cache, then `enterLimbo(w, now)`. Do **not** remove from the store, release the
   codeword, unregister the id, or queue a delete. Call it from the activate_click
   path instead of `preNavDetachAll('activate_click')`.
2. **Re-observe survivors** — `finalizeExpiredLimboWrappers` already graduates a
   still-connected limbo wrapper back (`disconnectedAt = null`) but does **not**
   re-`observe` it. Add the `tracker.observe` + `resizeObserver.observe` there so
   a survivor regains its observers. This 4Hz sweep is the backstop that closes
   the "missed re-observe path → blind wrapper" risk. (Optionally also graduate
   proactively in the deferred rescan to shrink the blind window from ≤250 ms to
   ~16–40 ms.)

**Why this beats the two dead ends.**
- vs **reclaim-after-wipe** (flickered): the codeword is *never released*, so the
  badge never repaints fresh-then-corrected. No flicker by construction.
- vs the earlier **"suspend observers, keep wrappers"** rejection (blind-wrapper
  risk): the finalize sweeper's re-observe is a level-triggered backstop, so a
  survivor can't stay blind even if a proactive re-observe is missed.

**Bonus.** Swapped-out content now *does* enter limbo (instead of hard-detach), so
new content nodes can rebind by fingerprint through the existing MO path — which
also covers the mouse re-render case the original note worried about. This widens
the surface, so the first shipped layer may want to keep scope to sidebar
survival and treat content-rebind as observed-not-relied-on.

**Risks to watch in soak.**
- **Wedge regression** — the `unobserve` loop is byte-for-byte the work hard-detach
  did, so the preempt should be intact; must still re-verify on a YouTube channel
  "Videos" voice-activate (must not freeze).
- **Blind window** — sidebar wrappers are observer-less until graduated (≤250 ms
  via finalize, less if proactive). Scroll/resize in that window won't reposition
  badges; low impact for a table-switch.
- **Pool/grammar churn** — limbo wrappers keep codewords claimed until finalize;
  brief overlap with fresh content claims. Bounded by the 250 ms deadline.

### Verified against code before implementing (2026-06-06)

Four assumptions the design rests on, checked in source:

- **No double-claim on re-observe (safe).** `IntersectionTracker.handleEntries`
  skips limbo wrappers outright (`if (wrapper.disconnectedAt !== null) continue`,
  `intersection-tracker.ts:164`) and only claims when no codeword is held
  (`if (!wrapper.scanned.codeword)`, `:177`). Re-observing a survivor that still
  holds its codeword cannot mint a second one. **Implementation order matters:**
  in the finalize graduate-back, clear `disconnectedAt` *before* `tracker.observe`
  + `resizeObserver.observe`, so the fresh initial IO callback runs with the
  wrapper non-limbo and updates `isInViewport`/`lastRect` cleanly. Mirror
  `attachWrapper`: re-observe tracker + resize only, **not** attentionObserver.
- **Codewords stay matchable across the nav (safe).** `syncNow`
  (`label-sync.ts:219`) is delta-based — it pushes only queued Puts/Deletes; the
  plugin's grammar is cumulative on `sentCodewords`. Soft-detach queues no Delete,
  so survivor + doomed codewords stay live until an explicit Delete. Doomed
  content's Delete is queued by `detachWrapper` at finalize; survivors graduate and
  are never deleted. `reconcileTeardown` only walks `disconnectedAt === null`
  wrappers (`content.ts:1670`), so it won't release a survivor.
- **Rebind-steal (real — must fix as part of layer 1).** After soft-detach the
  limbo pool contains the **still-connected survivors** alongside the doomed
  content. `collectLimboWrappers` filters only on `disconnectedAt !== null`
  (`content.ts:3267`), and `rebindWrapper` does not check `isConnected` — so new
  content with a colliding fingerprint could `consume` + rebind a *live* sidebar
  wrapper, yanking its badge onto content. Rare (distinct text+href) but a
  correctness bug. **Fix:** add `&& w.element.isConnected === false` to
  `collectLimboWrappers`. No-op for today's behavior (limbo only ever held
  disconnected elements); a guard for the new path.
- **Pool pressure (graceful, watch on huge pages).** During the overlap window
  doomed codewords stay claimed while new content claims fresh. `labelReservoir`
  returns `''` on exhaustion and the wrapper stays unhinted, retried by the
  level-triggered reconcile after finalize frees the doomed codewords — no crash,
  no dup. On a normal ~332-wrapper page the transient ~2× is well under the 676
  pool; only a very large page risks a brief unhinted-content window. Soft-detach
  never touches the reservoir, so its single-sender + dedup invariants are
  unaffected.

The bfcache-restore path (`content.ts:2168`) hard-detaches any limbo wrapper, but
it fires on `pageshow{persisted:true}` — a different trigger than a table-switch,
no interaction.

---

## Outcome (2026-06-06) — superseded for Regime A voice by the finding above

- **Regime B (full reloads — record open/close, app entry): landed, phases 1–4.**
  SW-persisted per-frame fingerprint→codeword memory (`labels/codeword-memory.ts`),
  write path (REMEMBER_CODEWORDS on claim), read path (RECALL_CODEWORDS →
  `labels/codeword-recall.ts` confidence ladder → `preferredCodeword`), and the
  reservoir initial preferred-fill. Live result on QuickBase record open/close:
  **~62% reclaim** (148/239 of memory-matched elements), best-effort — the misses
  are release-before-claim ordering + the newest-100 fill cap. Commits up to
  `f1c132c`.
- **Regime A (same-document navs — sidebar / table-switch): landed for MOUSE
  only.** On the spa_nav rescan, `preNavDetachAll` now **spares wrappers whose
  element is still connected** (commit `7af5cb8`). The persistent sidebar keeps
  its wrappers + codewords with no memory, no reclaim, **flicker-free**.
  Live-verified: sidebar stable on **mouse** table-switch (`spared:~290`).
  **The VOICE table-switch is NOT fixed** — see "Voice-path finding" above; the
  spare was applied to the rescan call but the voice path's *earlier*
  `preNavDetachAll('activate_click')` still hard-detaches the whole store.
  - **Caveat (timing):** the spare is effective only when the sidebar DOM persists
    AND the idle-scheduled rescan runs before limbo finalizes the store. An
    earlier run spared 0 (rescan ~2s late, store already churned). A *re-rendering*
    sidebar still falls back to limbo-rebind, which the diagnosis showed is
    unreliable (mostly `no_match`/`refuse` on the swapped content). Committed as
    the low-risk increment; harden the re-render path only if churn recurs in use.
  - **Two earlier Regime-A attempts that missed** (kept here so we don't repeat
    them): (1) reclaim-after-wipe via a recall refresh on spa_nav — *flickered*
    (badge painted fresh then corrected); (2) the spare-connected change targeted
    `preNavDetachAll`, which on a slow rescan finds the store already emptied by
    the page's own mutation path. The teardown is distributed across the
    mutation observer + deferred doScan + rescan (the "nav-rebuild smell").

**Soak watch-items:** (a) any *unrelated* steady-state browsing breakage (the
nav-teardown change is in the high-blast-radius area); (b) sidebar codewords
churning again on table-switch (would mean the re-render path needs hardening).

---

**Original design below (Proposed).**

When you navigate within a JS-framework app — switching views in a React/Vue SPA,
or moving between tables/reports/forms in QuickBase — the persistent page chrome
survives the navigation, but its hint codewords get reshuffled. An element that
didn't move and didn't change gets a new codeword anyway.

The motivation is **perceptual continuity**, not blind muscle memory. You're
looking at the element when you say its codeword — you read the tag off the
screen. The cost of a reshuffle isn't a misfire from memory; it's that your eyes
have to re-find and re-read a tag that should have stayed put. Stable codewords
on stable elements let your gaze rest.

The primary target is React/Vue SPAs generally, and **QuickBase specifically**
(the author's daily driver). GitHub was an early example but is *not* the main
case; the QuickBase reality (iframe-heavy, mixed navigation model) drives this
design, see "QuickBase" below.

## Root cause (verified against current code, 2026-06-06)

The notes referenced here (`DESIGN_NAV_TIME_RESCAN`, `DESIGN_WRAPPER_IDENTITY_STABILITY`)
are a week old, so the claims below were re-checked against live source. The
mechanisms those notes describe are still wired — but the conclusion is sharper
than "the stability machinery has gaps":

**On an SPA navigation, the limbo-rebind machinery is bypassed entirely.**

- A normal within-page disconnect routes a wrapper into *limbo* (`enterLimbo`,
  held `LIMBO_DEADLINE_MS = 250` ms, content.ts:3250), keeping its codeword +
  fingerprint so a follow-up render can rebind the same identity via
  `tryRebindFromLimbo` → `findLimboMatch` (content.ts:3181, the confidence ladder
  is live).
- An SPA navigation does **not** use that path. `rescanForNav` on `reason ===
  'spa_nav'` (content.ts:2288) calls `preNavDetachAll` (content.ts:2217), which
  runs `detachWrapper` on *every* wrapper — a full teardown that releases the
  codeword back to the pool. There is no limbo pool left, so the reconcile walk
  rediscovers the new page from scratch and `tryRebindFromLimbo` matches nothing.
  Every element, including chrome whose DOM node survived the nav, gets a fresh
  front-of-pool codeword.

So codewords cannot survive an SPA nav today regardless of fingerprint quality or
retention tuning — the identity is thrown away before the rebinder ever runs.
This is the bespoke nav-time wipe+rebuild already on the books as an architectural
smell ("SPA navs should flow through the generic mutation path"). Fixing codeword
stability and paying down that debt are the same change.

`preNavDetachAll` exists for a reason: it tears observers down synchronously
*ahead* of the page's heavy DOM swap, which is part of how the nav-time main-thread
wedge was fixed. So the fix can't just delete it — it has to preserve codeword
identity across the nav **without** reintroducing the freeze (see Mechanism).

## What already exists (and is current)

- **Confidence ladder** — `labels/rebind.ts`: `rebind_clean` (one fingerprint
  match → reuse), `rebind_position` (several → nearest within
  `REBIND_DISTANCE_THRESHOLD_PX = 50`), `refuse_distance` (scrambled → fresh).
  Live, called from `tryRebindFromLimbo`.
- **Identity carry on rebind** — `rebindWrapper` (content.ts:3229) preserves
  codeword, badge, label, and registry id across a DOM-node swap. Exactly the
  primitive a nav fix needs; it's just never invoked on nav.
- **Sticky reclaim** — `claimLabels` `preferred[]` Pass 1 (label-pool.ts:166)
  re-grants a prior codeword if still free; releases return in order.
- **Pool survives nav** — `clearStack` is tab-close-only (label-pool.ts:343), so
  released codewords sit in the free list across a nav, reclaimable.
- **Fingerprint** — `scan/registry.ts` `computeFingerprint`
  (`{role, name, tag, text, href?, inputType?}`) + `fingerprintsEqual`.

The pieces exist. The nav path just doesn't route through them.

## Navigation regimes

| Regime | Example | Content script | Fingerprint registry | Pool |
|---|---|---|---|---|
| **A — SPA / same-document** | React/Vue route change, History pushState | Survives | Survives | Survives |
| **B — full-document** | full reload, cross-origin, **iframe content reload** | Destroyed + recreated (per frame) | Lost (per frame) | Survives (in SW, tab-scoped) |

Regime A is the History-API-SPA case: `webNavigation.onHistoryStateUpdated` →
`scheduleSpaRescan` (background.ts:1430) → `spa_nav` rescan → the `preNavDetachAll`
bypass above. The fix is to stop throwing identity away here.

Regime B is per-frame: when a frame's content script is destroyed (full reload or
an iframe navigating its own document), that frame's registry dies, but the
**tab-scoped pool persists in the SW** and `releaseFrame` (label-pool.ts:308)
returns the dead frame's codewords to free. There's no limbo wrapper to rebind
against, so stability needs the association persisted somewhere the frame teardown
doesn't reach — the service worker.

## QuickBase (measured 2026-06-06, trace breadcrumbs on the live app)

The navigation model was determined empirically with `trace.cs_init` +
`trace.webnav` breadcrumbs on the user's real QuickBase instance. The earlier
guess — that QuickBase content lives in reloading iframes (Regime B) — was **wrong
on the mechanism but right on the conclusion**: the table content is a **top-frame
React SPA**, not a reloading iframe; QuickBase still needs the Regime B fix, but
because *record* views do full top-frame reloads, not because of iframes.

Measured regime per transition:

| Transition | Regime | Content script |
|---|---|---|
| Enter app shell (overview → table) | **B** | full top-frame load, `cs_init` |
| Table ↔ table (same `action/td`) | **A** | `same_document` on frame 0, CS **survives**, no `cs_init` |
| Table → record (`action/td` → `action/dr`) | **B** | same-doc route, then a `client_redirect` `committed` → full top load + `cs_init` |
| Record → table (back) | **B** | full top-frame load, `cs_init` |
| App overview / home page | **B** | embeds a classic `/db/` iframe that loads its own document |

Corrections to the original hypothesis:
- Table report views (`/nav/app/.../table/.../action/td`) are **top-frame React**,
  navigated **same-document** — switching tables is Regime A, the CS survives, no
  reloading content iframe involved.
- The `/db/` iframe (classic UI) only appears on the **overview/home** page, not
  the table flow — so "inner content frame reloading" applies to legacy dashboard
  surfaces, not where the user works.
- **Record open/close is the Regime B surface that matters:** QuickBase routes
  same-document to the record, then a client-side redirect forces a hard top-frame
  reload (to attach `?rid=...`), destroying + recreating the CS.

**Conclusion: QuickBase needs BOTH fixes.** The Regime A fix (limbo-lite identity
carry; stop `preNavDetachAll` wiping) gives stable codewords across **table
switches**; the Regime B fix (per-frame SW-persisted fingerprint→codeword memory)
gives them across **record open/close** and app entry. Neither alone covers the
daily workflow.

## Proposed mechanism

### Spine: gate on confidence, not on location

Reuse a codeword when the new element has one confident fingerprint match
(`rebind_clean`) or the nearest of several within the position threshold
(`rebind_position`); assign fresh when ambiguous (`refuse_distance`). This covers
every identifiable element on the page — strictly more ambitious than a header
allowlist — and self-limits where reuse is risky: templated, repeated,
weak-fingerprint controls (row buttons, identical "Edit"/"…") stay churny, while
distinctive elements hold still. It self-heals on redesign (changed fingerprint →
no clean match → fresh). Because the codeword is painted *on* what it routes to, a
wrong reuse is a visible stability miss the user adapts to, never a wrong click —
which, with the perceptual-continuity framing, keeps the stakes low and justifies
leaning into coverage.

### Regime A: stop bypassing limbo-rebind on SPA nav

The identity primitives (`enterLimbo`, `tryRebindFromLimbo`, `rebindWrapper`) all
exist; SPA nav just has to route through them instead of `preNavDetachAll`'s full
teardown. The constraint is the perf reason the detach exists (synchronous
observer teardown ahead of the DOM swap), so the shape is a **limbo-lite identity
carry**: across the nav, retain each wrapper's codeword + fingerprint (the
rebind-eligible identity) while still tearing down its per-target observers (the
expensive part the wedge fix targeted). The reconcile walk then runs
`tryRebindFromLimbo` against that retained set and re-grants codewords by
fingerprint.

Two refinements fall out:
- **DOM-survivor short-circuit.** A wrapper whose element is still `isConnected`
  after the nav settles never needed teardown at all — it's the same node with the
  same codeword. Skipping it is cheaper than rebinding it.
- **Limbo retention must span the nav.** 250 ms is tuned for incremental React
  renders; a route change's drop→rediscover can exceed it. The retained-identity
  set for a nav needs a deadline keyed to the rescan completing, not a fixed 250 ms.

### Regime B: service-worker-persisted fingerprint→codeword memory

For full reloads (the QuickBase record open/close + app-entry case), persist the
association where content-script teardown can't reach it:

- A per-tab, **per-frame** artifact in `chrome.storage.session` (alongside
  `LabelStack`): a bounded list of `{fingerprint, codeword, lastRect}`.
- **Write** as wrappers take codewords. The fingerprint is computed content-script
  side (`scan/registry.ts`), so the CS must send it with the codeword — a protocol
  addition (e.g. carry fingerprints on `CONFIRM_LABELS`, or a new
  `REMEMBER_CODEWORDS` message). The SW records `fingerprint→codeword` in the
  per-frame memory.
- **Read** on fresh content-script startup: load the memory, and for each
  newly-discovered element compute its fingerprint and run the *same* confidence
  ladder against it (CS-side, where `fingerprintsEqual` + `findLimboMatch` live) to
  pick a remembered codeword → set `wrapper.preferredCodeword`.

**The reservoir wrinkle (corrects the original "Pass 1 just honors it").** Claims
do **not** go straight to the SW pool — they go through the per-frame
`label-reservoir.ts`, a *synchronous local cache* of front-of-pool codewords.
`reservoir.claim(count, preferred)` Pass 1 only re-grants a preferred codeword that
is already in the **local** reservoir `free`. After a Regime B nav the fresh CS has
an empty reservoir filled with arbitrary front-of-pool codewords; the remembered
codeword is back in the **SW pool** `stack.free` (returned by `releaseFrame` on the
old frame's Port disconnect) but **not** in the local reservoir. So setting
`preferredCodeword` alone reclaims nothing across a nav.

The remembered codewords have to be pulled from the SW deliberately. The SW-side
`claimLabels(tabId, frameId, count, preferred)` (`label-pool.ts:166`) *already* has
a Pass 1 that grants preferred codewords from `stack.free` — but the reservoir's
`refill()` calls `CLAIM_LABELS {count}` with **no** `preferred`. The fix is a
**targeted preferred-refill**: after the first scan resolves remembered codewords,
the reservoir issues `CLAIM_LABELS {count, preferred:[remembered…]}` so the SW
grants those specific codewords into the reservoir; the existing
reconcile-after-refill (`refreshViewportClaims` / `onCodewordsChanged`) then
re-claims the affected wrappers and local Pass 1 hands each its remembered codeword.

**Risk note:** this threads new behavior through the reservoir, which is
race-prone and load-bearing — it carries the single-sender invariant and a history
of QuickBase dup-issue races (`outstanding` set, CONFIRM/RELEASE ordering). The
targeted-refill path must preserve those invariants (still the only CLAIM sender,
still dedups against `free ∪ outstanding`). So Regime B is additive (no nav-time
wedge path) but **not** trivially low-risk; it needs the reservoir's existing
dedup/ordering tests extended.

Keying is per-frame because reloads are per-frame; tab+frame is the natural key.
Per-host is a further dial (survives across tabs) but adds staleness across
redesigns — not needed for v1.

**Phased build (Regime B):**
1. SW per-frame `codewordMemory` store in `chrome.storage.session` + LRU cap;
   read/write helpers, unit-tested in isolation. No wiring yet.
2. Write path: carry fingerprints CS→SW on codeword take; SW records
   `fingerprint→codeword`. Verify the memory populates (no reclaim yet).
3. Read path: CS startup loads memory, resolves `preferredCodeword` per element via
   the confidence ladder. Verify the right codewords are *requested* (logging).
4. Targeted preferred-refill in the reservoir + reconcile re-claim; extend the
   reservoir dedup/ordering tests. This is the step that actually reclaims.
5. Live-verify on QuickBase record open/close; confirm no reservoir dup-issue
   regression (the `cap each` class).

**Reservoir keep/remove — measured 2026-06-06, verdict: KEEP.** We probed whether
the reservoir's sync-claim is worth its complexity (the question was whether to
delete it and claim straight from the SW, which would have collapsed Regime B).
Dense-scroll probe (`perf.reservoir_probe`): reservoir claim is effectively free
(`avg_claim_ms` 0.03–0.04), badge paint is `avg_paint_ms` 17–30 per ~12-badge
batch, and the `CLAIM_LABELS` IPC is a cheap 1–13 ms median **but spikes to
95–208 ms during heavy scroll** (SW per-tab-lock contention / backlog). With the
reservoir those spikes ride the async refill and never touch placement; without
it every batch's claim is that round-trip, so the tail lands on the hot path AND
gets more frequent (per-batch lock contention instead of one batched refill per
~70 claims). So the reservoir earns its keep on the **tail**, not the median —
exactly the dense-fast-scroll case it exists for. Removing it would reintroduce
scroll hitches. **Consequence:** Regime B keeps the targeted preferred-refill
(phase 4) — but that reclaim runs **once at CS startup**, before the rapid
claim/release/refill window where the reservoir's races live, so it's
materially lower-risk than a hot-path change. It only adds `preferred` to the
already-existing refill message (SW `claimLabels` Pass 1 already honors it) and
preserves the dedup (`free ∪ outstanding`) + single-sender invariants.

## Contention ordering (where "prioritize the header" survives)

Contention (two elements wanting the same prior codeword, or a near-full pool) is
rare under preferred-reuse. When it happens, resolve by priority: most-distinctive
/ longest-persistent wins the reuse, the loser takes fresh. The header sits at the
top of that order naturally — so the "prioritize header" instinct is a conflict
resolver, not a scope boundary.

## Risks

- **Mis-reuse** — contained by the confidence ladder and de-fanged by
  perceptual-not-blind use + paint-equals-route (a wrong reuse is visible, never a
  wrong click).
- **Reintroducing the nav-time wedge** — the Regime A fix must keep observer
  teardown synchronous; only the *identity* is retained across the nav, not the
  observers. This is the highest-risk part and needs the nav-soak that the
  nav-time work established.
- **Pool contention at the nav boundary (Regime B)** — the new frame's claim must
  run after the old frame's `releaseFrame`, or Pass 1 reclaim won't find codewords
  free. The main frame keeps `frameId 0` across a full nav, so the
  disconnect→`releaseFrame` vs new-claim ordering is a real question; may need a
  "preferred codeword still held by a dying same-id frame" tolerance analogous to
  `stillReservedToThisFrame` (label-pool.ts:187).
- **Memory growth (Regime B)** — LRU cap (~200 per frame) or TTL. Cheap data.
- **Fingerprint drift** — count badges ("Issues 42→43"), selection-state labels.
  Consider preferring `href`+`role`+`name` over raw `text` when an href exists;
  tune conservatively against soak data to avoid raising collisions.

## Phasing

1. **Determine the regime on QuickBase** by trace. **DONE 2026-06-06** (see the
   QuickBase section above). Result: table↔table is Regime A (top-frame
   same-document, CS survives); record open/close and app entry are Regime B
   (full top-frame reload); the classic `/db/` iframe is Regime B but only on the
   overview/home page. QuickBase needs both fixes.
2. **Confirm the detach-bypass empirically** on a Regime-A surface: a `spa_nav`
   should show `pre_nav_detach detached=N` followed by a reconcile that rebinds 0
   (all fresh codewords). Trace breadcrumbs are stripped; re-confirm with a
   temporary `pipeline.cs_nav_step` capture when implementing step 3.
3. **Regime A fix** — limbo-lite identity carry + DOM-survivor short-circuit +
   nav-keyed retention, replacing the unconditional `preNavDetachAll`. Nav-soak
   for wedge regressions. Gives stable codewords across QuickBase table switches
   (and GitHub / general React-Vue SPAs).
4. **Regime B fix** — per-frame SW-persisted fingerprint→codeword memory. Covers
   QuickBase **record open/close + app entry** (full top-frame reloads) and the
   legacy `/db/` dashboard iframes.
5. **Measure** codeword stability across nav on QuickBase + one more SPA, and the
   nav-time main-thread span (must not regress).

## Relationship to sibling notes

- Builds on `notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md` — uses its
  rebind primitive, extended to the nav boundary it currently skips.
- Pays down the `DESIGN_NAV_TIME_RESCAN.md` debt (the bespoke nav wipe+rebuild)
  and must respect its perf constraint (synchronous observer teardown).
- Distinct from `notes/DESIGN_HINT_REUSE.md` — that reuses the `HintBadge` DOM
  object for paint latency; this reuses codeword *identity* across navigation.
  Orthogonal; they compose.

## Open questions

- QuickBase per-frame regime split — which frames are A, which are B? (Trace
  decides; drives the A-vs-B effort balance.)
- Can the limbo-lite carry retain identity without retaining observers cleanly, or
  does the rebind path assume observers stay live? (rebindWrapper re-observes, so
  likely fine — verify.)
- Fingerprint coarseness for stable chrome — is dropping `text` in favor of
  `href`+`role`+`name` (when href present) safe, or does it collide on nav menus
  where href is the only differentiator?
- Should reuse be suppressed while the page is still settling post-nav, to avoid
  binding to a transient element about to be replaced again?
