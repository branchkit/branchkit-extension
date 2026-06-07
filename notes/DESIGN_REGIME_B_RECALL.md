# Regime B recall — raise codeword reclaim across full reloads (Layer 3)

**Status:** metric + fix A LANDED 2026-06-07 (soak-owed for push). Extends
`notes/completed/DESIGN_CODEWORD_STABILITY.md` (Regime A/B model) and follows
`notes/DESIGN_CODEWORD_KEY_OWNERSHIP.md` (Layer 1, same-document re-mounts). This
is the lever that note deferred: the **full-reload** case.

## Landed (2026-06-07)

Built the reclaim metric first, then fix A in two parts, measured each on a
130-link reloading fixture (`scripts/_test-regime-b-recall.mjs`):

- **Metric:** `recall_stats` in the debug snapshot (reclaimed / missed /
  no_memory, plus viewport split), compared against a frozen "as-loaded"
  persisted recall (`persistedCodeword`) so the live in-session index can't make
  everything look reclaimed. `rebind_counters` also added to the snapshot.
- **Finding that sharpened the fix:** baseline reclaim was **0%**, not the ~70%
  the QuickBase snapshot suggested. The scan path was claiming recalled codewords
  in *pool order*, not per element — so links got recycled letters, just the
  *wrong* ones. The leak was scan-path mismatch, more than the refill cap.
- **A1 — scan path requests per-element preferred** (`content.ts` resolves each
  element's remembered codeword by fingerprint; `claimLabels`/reservoir forward
  it). 0% → **54%**.
- **A2 — size the initial fill to the recalled set** (`label-reservoir.ts`
  `ensureReady`, capped at `MAX_INITIAL_RESERVATION=300`), so every remembered
  codeword reaches `free` instead of only the first 100. 54% → **100%** on the
  fixture.

Net: 0% → 100% reclaim across a full reload on the (same-content) fixture.
Covers up to the 200-fingerprint memory cap; pages beyond that need fix C below.

- **A3 — reserve recalled codewords from fresh claims (added after a real test
  exposed the gap).** Driving voice table-switches on QuickBase, the *sidebar*
  still churned ~45% even with A1/A2. Cause: a table-switch is a reload to a page
  with the SAME sidebar but DIFFERENT body content. The new body has no memory,
  so it claims fresh — and A2 had just pre-filled the pool with every recalled
  codeword, so the body grabbed the sidebar's reserved letters front-of-pool
  before the sidebar claimed them. A2 helped same-content but *widened* this.
  Fix: the reservoir marks recalled codewords as `reserved`; a fresh (no-memory)
  claim prefers generic codewords and skips reserved ones, falling back to them
  only when generic is exhausted (starvation guard). The remembered owner still
  reclaims via `preferred`; a released codeword un-reserves.
  - Verified by a cross-content fixture (stable sidebar + body that changes with
    `?t=`): same-content reload 140/140 = 100% (A1/A2 intact), and the sidebar
    survives a body change **20/20 = 100%** (was ~45% before A3).

618 unit tests, chrome+firefox builds clean. B (prioritize visible) still not
needed to hit target; revisit only if real pages past the 200 memory cap fall
short. Dup-fingerprint elements (table cells) remain an inherent partial-reclaim
ceiling — they need distinct letters, so recall can only return one.

## Why this exists

Some pages (a QuickBase app we measured, old server-rendered apps) do a **full
document reload** on navigation rather than a same-document swap. A reload
destroys the content script, store, and registry — so Layer 1's in-memory
transfer can't reach across it (nothing survives to transfer). The only thing
that persists is the service-worker `chrome.storage` recall (fingerprint →
codeword). Codeword stability across a reload therefore *must* go through that
recall. It already works — measured ~70% on a 111-link sidebar — and this layer
raises that.

(Tell for "this was a reload, not a re-mount": registry ids restart at 1 in a
before/after snapshot. Layer 1 doesn't apply; this layer does.)

## The chain, and where it loses codewords

Reload reclaim flows: SW memory → CS recall load → reservoir initial fill →
per-wrapper seed → claim. Three stacked caps bleed reclaim on a heavy page:

1. **SW memory cap — `MEMORY_CAP_PER_FRAME = 200`** (`codeword-memory.ts`).
   Only the 200 most-recently-remembered fingerprints survive. On a 655-element
   page, 455 fingerprints aren't remembered at all → can't be reclaimed. Churny
   body content can evict stable chrome (the sidebar) from the 200.

2. **Reservoir initial-fill cap — `INITIAL_RESERVATION = 100`**
   (`label-reservoir.ts`). `ensureReady(recalledCodewords)` asks the SW for the
   first 100 preferred into the local `free` queue. A wrapper can only reclaim a
   codeword that's in `free` (claim pass 1), so at most ~100 reclaim from the
   initial fill regardless of how many fingerprints were remembered.

3. **Refills are generic.** `maybeRefill → refill(REFILL_AMOUNT)` carries **no
   preferred** — only `ensureReady` does. So every wrapper claimed after the
   initial 100 drains gets a fresh letter even if its codeword was remembered.
   This is the biggest leak on large pages: reclaim is capped at the first ~100
   claims, in claim order, which may not be the elements you look at.

The SW grant itself is fine: `claimLabels(count, preferred)` honors preferred
when free (label-pool.ts) — it just never *receives* preferred past the initial
fill.

## Goal

A measurable target, framed around what the user actually sees: **≥90% of
in-viewport elements reclaim their prior codeword across a full reload** on a
heavy page (today ~70% overall). Off-screen reclaim matters less — prioritize the
visible.

## Proposed work (leverage order)

**A. Carry preferred through refills — highest leverage, smallest change.**
Track which recalled codewords are still wanted (remembered, not yet reclaimed
into `free`/`outstanding`), and pass a slice of them as `preferred` on each
`refill`, not just `ensureReady`. Removes the ~100 ceiling: a wrapper claimed
late can still reclaim as long as its codeword is still in the pool. Stays within
the single-sender invariant (the reservoir remains the only SW talker).
- Risk: refill is the hot path; the preferred slice must be bounded and cheap.

**B. Prioritize the recall toward what's visible.**
Order `recalledCodewords()` (and ideally the SW memory's keep-set) by likelihood
of being looked at — in-viewport first, then persistent chrome — so within any
budget the sidebar/nav reclaim before off-screen body content. Turns "first 100
in claim order" into "the 100 that matter."
- Risk: needs a cheap visibility/position signal at load, before full layout.

**C. Rework the memory cap.**
Raise `MEMORY_CAP_PER_FRAME` (it's "data, not pool slots" per its own comment, so
it can be generous), and/or bias *what* gets remembered toward stable chrome over
churny content, so stable elements aren't evicted by body churn.
- Risk: storage growth on long-lived tabs; bias heuristic could misjudge.

Recommend A first (it alone should move the number a lot), then B, then C as
measurement shows where the remaining misses are.

## Measurement (this layer is a percentage, not a binary)

Unlike Layer 1's fixture, this is a reclaim *rate* tuned on real reloads.
- Add a load-time metric: of the in-viewport elements present both before and
  after a reload (matched by fingerprint), what fraction reclaimed their prior
  codeword. Surface it alongside the new `rebind_counters` in the snapshot.
- Drive it on a reload-heavy page (the QuickBase app) and a synthetic fixture
  that reloads, before/after each change.
- Secondary factor to rule out: fingerprint stability across the reload (if an
  element's role/name/text/href shifts on reload, it won't match regardless of
  caps). Measure mismatch rate separately so we don't tune caps to fix a
  fingerprint problem.

## Risks

- Touches the label-pool / reservoir / SW-memory area, which carries the
  **single-sender invariant** (`label-reservoir.ts` header) and per-tab pool
  accounting. Changes need to preserve it; the existing ipc-isolation test
  guards it.
- Verification is measurement-driven (soak on heavy pages), not a clean pass/fail
  — budget for tuning rounds.
- Will never be as airtight as the same-document case: more failure modes survive
  a reload (persistence, pool availability, fingerprint drift). ~90% is a
  realistic ceiling, not 100%.

## Rejected / deferred

- **Deterministic SW-side fingerprint → codeword assignment** (the SW always
  grants the same codeword for a given fingerprint, removing the CS reclaim
  dance). Conceptually clean and would raise reclaim further, but it's a larger
  rework of the pool's allocation model and collision handling. Revisit if A/B/C
  plateau below target.

## Sequencing

1. Add the reclaim-rate metric first (can't tune what we can't measure).
2. A (preferred through refills) as its own revertable change; measure.
3. B (prioritize visible) if the number isn't there yet.
4. C (cap rework) last, guided by where misses remain.
