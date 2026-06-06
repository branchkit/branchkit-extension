# Codeword Stability Across Navigation

**Status:** Proposed.

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

## QuickBase

QuickBase is the reason Regime B matters as much as A, not as an afterthought:

- It is **iframe-heavy** (confirmed in prior work: the EH-ghost and harp_pit
  multi-frame cases were real nested-iframe wrappers). The per-frame
  `_strict`-viewport aggregation already exists because of this.
- Its navigation model is **mixed and must be determined empirically**: classic
  surfaces tend toward full page loads / iframe content swaps (Regime B), while
  newer app surfaces may be History-API SPA (Regime A). Whether a given
  table→report→form move is A or B per frame is the first thing to measure — the
  fix differs by regime.

Implication: for QuickBase, an inner content frame reloading its own document is
Regime B even while the top frame is Regime A. The SW-persisted memory below is
therefore not an "optional ambitious tier" for QuickBase — it is likely the
primary mechanism for the inner frames where the user's hints actually live.

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

For full reloads and inner-iframe reloads (the QuickBase primary case), persist
the association where frame teardown can't reach it:

- A per-tab, **per-frame** artifact in `chrome.storage.session` (alongside
  `LabelStack`): a bounded list of `{fingerprint, codeword, lastRect}`.
- **Write** as wrappers confirm codewords.
- **Read** on fresh content-script startup: for each newly-discovered element,
  compute its fingerprint, run the *same* confidence ladder against the memory,
  and set `wrapper.preferredCodeword` on a confident match. The existing
  `claimLabels` Pass 1 honors it if the codeword is still free.

Keying is per-frame because iframe reloads are per-frame; tab+frame is the natural
key. Per-host is a further dial (survives across tabs) but adds staleness across
redesigns — not needed for v1.

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

1. **Determine the regime on QuickBase** (and a second React SPA) by trace. Use
   the existing `RebindCounters` plus the `pipeline.cs_nav_step` breadcrumbs to
   answer, per frame: does navigation fire `spa_nav` (Regime A) or destroy the
   frame's content script (Regime B)? This decides which mechanism leads. Do not
   write code first.
2. **Confirm the detach-bypass empirically** on a Regime-A surface: a `spa_nav`
   should show `pre_nav_detach detached=N` followed by a reconcile that rebinds 0
   (all fresh codewords). That nails the root cause in the user's own environment.
3. **Regime A fix** — limbo-lite identity carry + DOM-survivor short-circuit +
   nav-keyed retention, replacing the unconditional `preNavDetachAll`. Nav-soak
   for wedge regressions.
4. **Regime B fix** — per-frame SW-persisted fingerprint→codeword memory. Likely
   the higher-value half for QuickBase's inner frames.
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
