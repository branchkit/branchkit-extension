# Design: Extension Log Retrieval

**Status:** Proposal (2026-07-26). Motivated by transcript mining of the ~24 agent sessions from 2026-07-24..26 — every log-fetching command those sessions actually ran, extracted from `~/.claude/projects/`.
**Goal:** An agent (or a human) diagnosing extension behavior should answer "what did the extension do in the last N seconds?" in one query — no exclusion filters, no timestamp regexes, no timezone math, no hand-rolled diff-marking.

The emission side is in good shape and is NOT the subject of this note. `bk-log.ts`, `activate-path-log.ts`, and the firehose limiter are doing their jobs; investigations keep adding the right tags (`3bdfbeb` "Log why search badges armed or didn't" is the pattern working). The weak side is retrieval: the tags land in a stream that is expensive to query and disconnected from the correlation spine.

## The evidence

What the mined sessions actually did, in descending frequency:

1. **Grep `plugin-logs/browser.log`** — every non-trivial query carried exclusion filters (`grep -vE "BK_CS_BOOT|firehose"`, `-vE "BK_ACTIVATE_PATH"`) and hand-rolled time windows (`grep -E "15:3[2-9]:"`, `awk -F'[][]' '$2 >= "2026-07-24T18:54:07" && $2 <= "..."'`).
2. **jq over `show-all.current.jsonl`** filtering `plugin.stderr_line` for `plugin_id=="browser"` — again always excluding `bk_diag_plugin_commit|cs_firehose|capture.progress`.
3. **Grep `actuator.log`** — nearly all invocations carry `-vE "cs_firehose|band_discovery"`.
4. **Mark-and-diff, reinvented per session:** `BEFORE=$(wc -l < "$LOG")` → act → `sleep N` → `tail -n +$((BEFORE+1)) | grep`. Exists solely because there is no "everything since 30s ago" query.
5. **`events.query` by `tr_`** — used ~8×, at least twice with a raw show-all grep fallback written *preemptively in the same command*, because the chain was expected to stop at the plugin boundary (extension lines carry no `tr_`).

Two dark spots: in 24 sessions there was exactly **one** Playwright console read — content-script and SW `console.*` output is effectively unreachable, and an uncaught exception leaves no trace anywhere an agent can see. And at least one visible UTC-vs-local stumble ("around 09:43 local" annotated on a grep for `13:4[0-5]`).

The noise numbers: of the last 5,000 lines of `browser.log`, **4,103 are `BK_CS_BOOT`** (82%). Next: `BK_SESSION_ROTATE` 199, `BK_GRAMMAR_SHADOW_DESYNC` 161, `BK_SUSPEND` 159. Every query pays a filter tax for one tag, and an unfiltered `tail` is boot spam.

Four pieces, ordered by leverage-per-cost.

## A. Coalesce the boot spam

`BK_CS_BOOT` fires once per content-script boot — every frame, every prerender-pool churn, every settings-page iframe. Boot lines are load-bearing (the orphan-teardown and pool-poisoning arcs leaned on boot counts and boot-URL identity), so demoting the tag to debug throws away signal at default thresholds. Coalesce instead.

**Where:** the SW, in `forwardPluginDebugLog`'s caller path (`background.ts` `PLUGIN_DEBUG_LOG` handler). It is the single choke point every CS line already passes through, and the only place that can see across CS contexts — a per-context limiter in the CS can't help when each boot is a fresh context.

**Mechanism:** reuse the firehose limiter's shape (visible compression, never a silent gap). A small per-tag coalescer, initially configured for `BK_CS_BOOT` only: first line in a rolling window forwards immediately; subsequent same-tag lines within the window accumulate; on window close (or on the next forwarded line) emit one `BK_CS_BOOT_COALESCED {count, window_ms, urls: [top 3 distinct]}` summary. Counts and distinct-URL identity survive — the two things the past investigations actually consumed — while the line volume drops by an order of magnitude.

Cost: ~40 lines in the SW + tests. No plugin-side change. This is not a new sensor/timer under the one-in-one-out freeze — it is a projection on an existing forwarding path, same class as the firehose limiter.

## B. A read surface with relative time and tag filtering

Kill patterns 1, 4, and the timezone math with one endpoint. The right owner is the **actuator**, not the browser plugin: `plugin-logs/<id>.log` is a platform-wide convention (voice.log has the same retrieval problem), the file format is uniform (`[ISO-UTC] [LEVEL] [TAG] json`), and a generic reader stays plugin-agnostic — no browser-specific logic enters the actuator.

```
GET /v1/plugins/{id}/log?since=30s&tag=BK_GRAMMAR_*&exclude=BK_CS_BOOT&level=warn&limit=200
```

- `since` accepts relative durations (`30s`, `5m`) or an absolute ISO timestamp; the server does the clock math, so callers never touch timezones. Relative `since` + re-query replaces mark-and-diff entirely.
- `tag` / `exclude` are comma-separated globs over the bracketed tag field.
- Response is the raw lines (or `{lines: [...]}` JSON) — no parsing ambition beyond the bracket-delimited prefix that already exists.
- Reads the file backwards from the tail; `since` windows are recent by construction, so no full-file scans.

Thin CLI verb for ergonomics: `branchkit-cli dev plog browser --since 30s --tag BK_GRAMMAR_'*'` (dev-gated like `dev say`/`dev smoke`). Add one line to the app CLAUDE.md's debugging section so future agents find it instead of re-deriving the grep idioms.

Cost: one handler in the actuator's dev HTTP surface + a CLI verb. Deliberately dumb — no indexing, no streaming, no retention changes.

## C. Thread `tr_` into extension lines

`tr_` is the system's one cross-stream join, and agents lean on it hard — but `browser.log` lines don't carry it, so correlated chains dead-end at the plugin and agents write show-all fallbacks preemptively. `activate-path-log.ts` already proves the pattern: the dispatch arrives over SSE with the actuator's correlation id and the event embeds it.

Generalize, minimally:

- **Dispatch-scoped context.** The dispatcher (`dispatcher.ts`) sets a module-level "current correlation id" on dispatch entry and clears it on exit (dispatches are synchronous on the CS main thread up to the first await; for async continuations, pass it explicitly — do not build async-context machinery for this).
- `bkLog` reads that context and attaches `correlationId` when present; explicit param overrides.
- **Plugin-side format:** when a forwarded line carries a correlation id, `bridge.go`'s writer stamps it in the actuator's greppable form — `{tr_XXXXXXXXXXX}` — into the line prefix. `grep tr_a3K9zPqR4m` then spans actuator.log, show-all, firehose, *and* browser.log in one sweep.

Explicit non-goal: putting plugin log lines on the bus. The unified-logging design keeps plugin trace/debug/info off the bus by decision, and `plugin_callers` already marks chains with plugin-side detail. This piece only makes the existing pointer followable; `events.query` integration can come later if the grep proves insufficient.

Cost: ~15 lines CS, ~10 lines Go, tests. Lines without a live dispatch context (boots, lifecycle) stay uncorrelated — correct, since nothing caused them.

## D. Uncaught-error capture

`bkLog` coverage is tag-by-tag manual, so an *unanticipated* failure — uncaught exception or unhandled rejection in the CS or SW — is invisible everywhere an agent can reach. Forward exactly that class through the existing path:

- **SW:** `self.addEventListener('error' | 'unhandledrejection')` → `forwardPluginDebugLog('BK_UNCAUGHT', {message, stack: first 3 frames, source: 'sw'}, 'error')`.
- **CS:** same listeners on `window`, with one guard: in the isolated world, `error` events from *page* scripts are also visible on `window` — filter to `event.filename` containing the extension origin (`chrome-extension://` / `moz-extension://`), else this becomes a firehose of other people's bugs. `unhandledrejection` fires per-world and needs no filter, but apply a small per-boot cap (say 20) as a backstop against a rejection loop.

Non-goal: piping `console.*` wholesale. The signal is crashes, not chatter; anything worth logging on purpose already has a `bkLog` tag.

## Non-goals (whole note)

- **CS-side buffering of sends while the SW is down.** The best-effort drop window is real, but the log-on-recovery convention (documented in `bk-log.ts`) already covers it, and a retry buffer is exactly the kind of mechanism the sensing freeze exists to challenge. Revisit only with a concrete incident the recovery lines failed to reconstruct.
- **Retention/rotation changes** to `plugin-logs/*.log`. At ~5MB the file is fine; piece B reads from the tail regardless.
- **A log viewer UI.** The Traffic tab and settings panels own human-facing views; this note is about the query path.

## Sequencing

A is standalone and immediate (extension-only, one rebuild). B and C land together naturally — B's reader is what makes C's stamps queryable — but B alone already pays for itself; B touches actuator + CLI, so it rides a full build and a pin bump. D is standalone extension-side work, any time. Nothing here blocks on anything else in flight; none of it touches Wave 3 surfaces.
