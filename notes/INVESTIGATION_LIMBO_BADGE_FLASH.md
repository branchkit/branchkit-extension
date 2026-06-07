# Investigation — flashing left-edge badges on YouTube /watch (comment churn)

**Status:** root-caused 2026-06-07 during the restructure soak. Two distinct,
**pre-existing** bugs (neither introduced by the restructure — see "Restructure
innocence" below). Fix not yet landed; deliberately deferred so it doesn't muddy
the in-progress restructure soak.

## Symptom

On a long-lived YouTube `/watch` tab with the comments section loaded, a column
of hint badges **flashes down the far-left edge** of the page, not attached to
anything visible. Refresh clears it. Debug overlay showed `refuse_no_match: 256`
(vs `rebind_clean: 32`, `refuse_distance: 1`).

## Evidence (Ctrl+Option+A snapshots)

Four snapshots captured during the soak (`plugins/browser/snapshots/2026-06-07T16-*`).
Wrapper-count trajectory: **201 → 48 → 159 → 44** (the 44 is post-refresh). The
buggy 201-wrapper snapshot is dominated by **duplicate-fingerprint comment
action buttons**:

```
x21  button "More actions"
x10  link   "Dislike this comment"
x10  link   "Reply"
x10  button "Action menu"
x9   link   "3 weeks ago"
...  (77 dup-fingerprint wrappers across 12 fingerprints)
```

The point-in-time snapshot caught **zero** visible badges on zero-rect elements —
because the strand is a sub-250ms transient that a single snapshot rarely lands on.

## Root cause 1 — the flash: limbo badges stranded at (0,0)

The user-visible flash. Chain of pre-existing facts:

1. `enterLimbo` (`scan/element-wrapper.ts`) sets `disconnectedAt` only — it does
   **not** hide the wrapper's badge.
2. The IntersectionTracker hides a badge on viewport-exit
   (`intersection-tracker.ts:221`), but that's an async IO callback, and a DOM
   **removal** frequently produces no clean exit callback — so a wrapper that
   disconnects *while in-viewport* keeps `hint.isVisible = true`.
3. `scheduleReposition` (`content.ts`) selects `store.all.filter(w => w.hint?.isVisible)`
   with **no `isConnected` check**. A limbo wrapper (disconnected, badge still
   visible) is included; `placeBadges` reads `getCachedRect` of the gone element =
   `{0,0,0,0}` and positions the badge at the origin.

So for up to the 250ms limbo window, any reposition (scroll / resize /
mutation-settle) yanks disconnected wrappers' badges to (0,0). Heavy churn =
many overlapping windows = a flashing left-edge column.

## Root cause 2 — the feeder: fingerprint collisions defeat rebind

Why so much churn (`refuse_no_match: 256`, 201 wrappers): YouTube comment rows
each carry action controls with **identical fingerprints** — `role`+`name`+`tag`+
`text` are the same for every "More actions" / "Reply" / "Dislike" / "Action
menu". The fingerprint (`scan/registry.ts computeFingerprint`) can't tell 21
"More actions" buttons apart. As the comment list virtualizes on scroll, rows
disconnect (→ limbo) and new rows attach; `tryRebindFromLimbo` finds many
fingerprint matches and can't disambiguate by position once layout shifts, so
most limbo wrappers expire without a rebind (`refuse_no_match`) and re-attach as
fresh wrappers with fresh codewords. Combined with the eager-attach model (a
wrapper per connected hintable — the documented "unbounded growth on
infinite-scroll pages" trade-off), the store bloats to 201.

## Restructure innocence

Every mechanism above is unchanged by `30baddb..HEAD`:
- `enterLimbo`, `isLimboExpired` — `scan/element-wrapper.ts`, untouched.
- limbo/rebind (`tryRebindFromLimbo`, `collectLimboWrappers`, finalize) — moved
  to `observe/limbo.ts` **verbatim**.
- the fingerprint (`computeFingerprint`/`fingerprintsEqual`, `findLimboMatch`) —
  `scan/registry.ts` / `labels/rebind.ts`, untouched.
- eager-attach (`attachDiscovered`) — moved to `core/wrapper-lifecycle.ts` verbatim.
- `scheduleReposition` — kept in `content.ts`, logic unchanged.

The delta cut only altered grammar-sync *timing*; it creates no wrappers and
moves no badges. A comment-heavy `/watch` page would churn identically on the
pre-restructure build. (Definitive A/B available: build `30baddb^`, scroll the
same page, watch `refuse_no_match` climb.)

## Fix options

**A. Flash (the user-visible bug) — LANDED 2026-06-07.**
`scheduleReposition`'s filter narrowed to
`w.hint?.isVisible && w.element.isConnected`. A badge whose target is gone keeps
its last position through the limbo window (imperceptible) instead of jumping to
origin; rebind retargets it or finalize destroys it. tsc clean, 584 tests green.
Addresses the observed nesting-mode strand; if anchor/reconcile-mode strands turn
up, the more robust option below (hide on limbo entry) is the follow-up.
Earlier-considered alternative:
- *Cleaner:* hide the badge on limbo entry (`enterLimbo` → `w.hint?.hide()`), so a
  disconnected wrapper shows nothing while parked. Requires confirming the rebind
  path re-shows on retarget (`rebindWrapper` → `hint.retarget`); slightly larger.

Recommend the minimal reposition guard, optionally plus the limbo-entry hide.

**B. Churn (the feeder) — deeper, separate, known territory.**
Identical-fingerprint elements can't be told apart, so they churn instead of
rebinding. Options, roughly increasing cost: cap wrappers-per-fingerprint;
add a positional / DOM-path / sibling-index discriminator to the fingerprint so
sibling comment buttons fingerprint distinctly; or prune eager-attached wrappers
that fall far outside the viewport. This is the same fingerprint-disambiguation
problem the rebind design has wrestled with; treat as its own effort.

## Recommendation

- **Do not** land this during the restructure soak (keep that soak isolated).
- After the restructure pushes: land fix A as its own commit + mini-soak. It
  stops the visible flashing cheaply.
- Track fix B separately — it's the real "comment churn" problem and predates
  this work.
