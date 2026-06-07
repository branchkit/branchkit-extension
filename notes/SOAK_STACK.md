# Consolidated soak — the un-pushed codeword-stability + restructure stack

Real-browser gate before pushing. Everything below is committed locally, tsc +
unit tests green, both builds clean, and (where noted) fixture/real-snapshot
verified — but none of it has had a sustained real-Chrome steady-state soak, and
the past orphan/perf incidents only showed up under live browsing. **Nothing is
pushed until this passes.** Supersedes `SOAK_RESTRUCTURE.md` (which covered only
the restructure portion).

## What's in the stack (push order = oldest first)

1. Extension restructure (Tier 0–2 + delta cut)
2. Flash fix — off-screen badges via one `isRectOnScreen` predicate
3. Live in-session codeword recall (`rememberLive`)
4. Layer 1 — key-ownership rebind (same-document re-mounts)
5. Layer 3 — Regime B reclaim: A1 (scan-path preferred), A2 (size initial fill),
   A3 (reserve recalled codewords), C (memory cap 200→1000)

Design context: `DESIGN_EXTENSION_RESTRUCTURE.md`,
`DESIGN_CODEWORD_KEY_OWNERSHIP.md`, `DESIGN_REGIME_B_RECALL.md`,
`INVESTIGATION_LIMBO_BADGE_FLASH.md`.

## Build & load

```
cd branchkit-extension && npm run build   # chrome + firefox
```
Load unpacked: Chrome → `dist/chrome`, Firefox → `dist/firefox`. Drive real sites
30+ min. Watch the actuator log + page console:
```
tail -f ~/Library/Application\ Support/BranchKitDev/actuator.log
```
A clean run = badges stay voice-matchable, no main-thread wedge / unresponsive
dialog, no runaway CPU, no `Extension context invalidated` spew.

## Watch items (priority order)

### 1. Orphan reload — HIGHEST blast radius (restructure background/injection)
- [ ] Several heavy tabs open (YouTube, Gmail, a Wikipedia article), reload the
      extension at `chrome://extensions`.
- [ ] Already-open tabs recover voice control WITHOUT close+reopen.
- [ ] No "Page Unresponsive" / runaway CPU in the first few minutes after reload.
- [ ] No double content-script, no ping-pong grammar wipes.

### 2. Grammar over/under-sync — the delta cut (restructure)
- [ ] Heavy/dynamic pages (YouTube `/watch`, Gmail, Slack): every visible badge
      is voice-matchable as content loads and as you scroll.
- [ ] No "badge painted but the command does nothing" (under-sync).
- [ ] Grammar isn't thrashing while idle (`grammar/batch` churn).

### 3. Flash fix — off-screen badges
- [ ] YouTube `/watch`: NO flashing badge column at the left edge.
- [ ] Open/close the collapsed nav drawer — badges appear only for on-screen
      items; nothing painted at x=0.

### 4. Layer 1 — key-ownership (same-document re-mounts)
- [ ] A churny SPA with in-place re-mounts (Gmail, Slack, a non-reloading
      QuickBase app): codewords stay put across re-renders.
- [ ] `rebind_key` climbs in Ctrl+Option+A snapshots; no rapid letter flipping
      (ping-pong) on a re-mount.
- [ ] No letter ever activates the wrong target (the dup-fingerprint steal guard).

### 5. Layer 3 + C — Regime B reclaim (full reloads)
- [ ] The reload-heavy QuickBase app: voice-switch between tables a few times.
- [ ] Sidebar codewords stay consistent across the switch (measured 97%).
- [ ] Ctrl+Option+A → `recall_stats`: `no_memory` low after warm-up, and
      `viewport_reclaimed / (viewport_reclaimed+viewport_missed)` healthy.
      Remaining misses should be dup-fingerprint table cells, not the sidebar.
- [ ] No runaway storage growth across a long multi-table session (cap is 1000).

### 6. Limbo / rebind churn (restructure observe/limbo)
- [ ] React-heavy re-renders (Gmail, Slack): codewords stable, no churn.
- [ ] Scroll down then back up: badges reappear on the same elements.

## If something breaks

Every commit is independently revertable; the per-commit history
(`git log --oneline 3eabb0b..HEAD`) makes bisecting straightforward. Note which
watch item failed and which area it maps to (headings name the surface).

## On pass

Push extension commits first, then the app submodule-pointer commits:
```
git -C branchkit-extension push
git push   # app pointers
```
