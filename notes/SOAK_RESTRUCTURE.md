# Soak checklist — extension restructure (Tier 0–2 + background extractions)

Real-browser validation gate before pushing the restructure. The work is
committed (`30baddb..HEAD`, tip `e70a15e`), tsc clean, 584 unit tests green, both
builds clean, and the cloud ultrareview came back with no findings — but none of
that exercises runtime behavior on heavy live pages. The two prior orphan/perf
incidents passed tests + builds and only broke under sustained real browsing, so
this soak is the gate, not a formality.

**Nothing is pushed until this passes.** Design context:
notes/DESIGN_EXTENSION_RESTRUCTURE.md.

## Build & load

```
cd branchkit-extension
npm run build            # chrome + firefox
```
Load unpacked: Chrome → `dist/chrome`; Firefox → `dist/firefox`. Then drive real
sites for 30+ minutes. Watch the actuator log + the page console throughout:

```
tail -f ~/Library/Application\ Support/BranchKitDev/actuator.log
```

A clean run = badges stay voice-matchable, no main-thread wedge / unresponsive
dialog, no runaway CPU, no `Extension context invalidated` spew, and tabs recover
after an extension reload without close+reopen.

## Watch items (priority order)

### 1. Grammar over/under-sync — the delta cut (HIGHEST)
This is the one behavior-sensitive change: lifecycle attach/detach now drives
grammar via store deltas instead of scattered imperative `scheduleSync` calls.
Risk = a sync that fires too much (extra catchup POSTs) or, worse, too little (a
badge paints but its voice command is gone).

- [ ] Heavy/dynamic pages — YouTube `/watch`, Gmail inbox, Slack, QuickBase table
- [ ] Every visible badge is voice-matchable as content loads and as you scroll
- [ ] No "badge painted but the command does nothing" (the under-sync failure)
- [ ] Grammar isn't thrashing — watch for excessive `grammar/batch` churn while idle
- [ ] Initial page scan: badges come up and match (the path that newly triggers a
      catchup sync; expected to no-op on empty delta, confirm it does)

### 2. Mutation firehose — `observe/mutation-source` (perf-critical)
- [ ] Scroll soak on YouTube `/watch` (comments + chapters lazy-loading) — no
      unresponsive-script warning, no renderer wedge
- [ ] SPA nav (click a YouTube recommendation) re-badges the new page
- [ ] No `moCallback:start` without a matching `:end` in the firehose breadcrumbs

### 3. Limbo / rebind — `observe/limbo`
- [ ] React-heavy re-renders (Gmail, Slack) — codewords stay stable, no churn
- [ ] Scroll down then back up — badges reappear on the same elements

### 4. Orphan reload — `background/injection` (HIGHEST BLAST RADIUS)
The relocated inject-lock / orphan-recovery code. Past incidents lived here.
- [ ] With several heavy tabs open (YouTube, Gmail, a Wikipedia article), reload
      the extension at `chrome://extensions`
- [ ] Already-open tabs recover voice control WITHOUT close+reopen
- [ ] No double content-script (no two `cs_id` loads in one frame; no ping-pong
      grammar wipes)
- [ ] No "Page Unresponsive" / runaway CPU within the first few minutes after reload

### 5. Background routing & connection — `frame-router` / `actuator-client` / `state`
- [ ] Voice dispatch reaches the right tab and frame (incl. an iframe-hosted hint)
- [ ] Tab switch + window focus behave (active tab tracked, hints follow focus)
- [ ] Restart the actuator mid-session — SSE reconnects and grammar re-establishes
- [ ] `resolveHintFromTab` (options page → codeword → selector) still works

## If something breaks

Every commit is independently revertable. Note which watch item failed and which
area it maps to (the headings above name the module) — the per-commit history
(`git log --oneline 30baddb..HEAD`) makes bisecting straightforward. The delta
cut (`e70a15e`) is the most likely culprit for grammar issues; the background
injection commit (`76d1147`) for reload issues.

## On pass

Push order: extension commits first (`git -C branchkit-extension push`), then the
app submodule-pointer commits. (Nothing here is pushed yet.)
