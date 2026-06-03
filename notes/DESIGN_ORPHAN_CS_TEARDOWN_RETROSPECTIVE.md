# Orphan content-script teardown — retrospective on a failed fix

A scratch design + post-mortem of the 2026-06-02 attempt to make extension
reload not require closing every YouTube tab. Two commits shipped, both
reverted within an hour because the "fix" itself made the page unresponsive
under steady-state browsing. Capturing what we tried, what went wrong, and
the constraints any future attempt must satisfy.

Reverted commits: `15c1381` (three-layer teardown) + `0d91d52` (TDZ fix on
top of it). Working state: pre-`15c1381`, which is the original "must close
tabs after extension reload" pain we set out to fix.

## The original problem

When the extension is reloaded at `chrome://extensions/` (or
`about:debugging` in Firefox), the old content script's runtime context is
invalidated — `chrome.runtime.id` becomes undefined — but its V8 execution
context (timers, observers, event listeners) keeps running. On a busy page
(YouTube /watch is the canonical pathological case), the orphan window
persists long enough for hundreds of `sendMessage` calls to fire. Each one
throws **synchronously** with "Extension context invalidated"; the
`.catch(() => {})` clauses we'd dotted everywhere only handle async
rejection; the sync throws escape and surface as uncaught errors from
whatever observer/handler called them. The error cascade renders the tab
unresponsive — the user has to close it.

Documented as a memory entry pre-this-attempt
([extension-reload-orphans-cs]): the workaround was "F5 every affected tab
after reloading the extension."

The infrastructure side has the pieces in place: `quiesceOrphan`
(`content.ts`) disconnects observers, `liveness.ts` discriminates orphan vs
transient SW restart, `background.ts:reinjectContentScripts` re-injects a
fresh content script after install/update. The gap is **completeness of the
teardown**: quiesceOrphan disconnects observers but leaves pending
`setTimeout` callbacks queued, document/window event listeners still
attached, and pending `requestAnimationFrame` callbacks unaccounted for.
Each of those continues firing into the dead `chrome.runtime.*` until the
isolated world dies (page navigation or F5).

## What we tried

Three layers, all shipped together in `15c1381`:

### Layer 1 — `AbortController` for module-level listeners

Added `eventAbortController` as a field on `PageSession`. Every
`addEventListener` in `content.ts` got `{ signal: pageSession.eventSignal }`
appended to its options object. `quiesceOrphan` calls
`pageSession.cancelScheduled()`, which calls `abortController.abort()`,
removing all owned listeners atomically.

Covered: `window` scroll/resize/focus/blur/pageshow; `document` focusin/
focusout/transitionend/animationend/keydown/keyup; the snapshot trigger;
the shadow-attach event.

Cross-browser status: `addEventListener({ signal })` is Chrome 90+ /
Firefox 86+ — well past our floor.

### Layer 2 — `PageSession.cancelScheduled()`

Clear the four tracked timer fields (`scrollRepositionTimer`,
`deferredRepositionTimer`, `hugeMutationTimer`, `reconcileTimer`) plus the
discovery `requestAnimationFrame` handle. Then abort the event signal.

Gap left in place: the file has ~20 ad-hoc `setTimeout` calls that are
NOT tracked in `pageSession` — the rebind sweeper's settle, the
`whenDOMSettles` helper, the doScan coalesce, label-reservoir refill
debounces, and several others. Layer 3 was the catch-all for whatever
those ad-hoc timers eventually called into.

### Layer 3 — `safeSendMessage` helper

New module `src/messaging/safe-send.ts`:

```typescript
export function safeSendMessage<T>(message: unknown): Promise<T | undefined> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return Promise.resolve(undefined);
  }
  try {
    return (chrome.runtime.sendMessage(message) as Promise<T>).catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
}
```

Drop-in replacement: returns a resolved promise so existing
`.catch(() => {})` chains continue to work. Migrated 14 `content.ts` call
sites + the `plugin/resolve.ts` dispatch-result emit. Deliberately left
`labels/label-sync.ts`, `labels/label-reservoir.ts`, and
`scan/element-wrapper.ts` alone — those already wrap their sendMessage in
`try/catch` and use the response value (replacing with a helper that
returns `undefined` on orphan would change semantics).

## What broke

Two distinct failures, surfaced in order.

### Failure 1 — Temporal dead zone (caught immediately)

`pageSession` was constructed at line 2051 of `content.ts`, but the
listeners that reference `pageSession.eventSignal` are at lines 1974+. JS
const declarations are hoisted as bindings but not initialized — accessing
one before its declaration line throws `ReferenceError: Cannot access
'pageSession' before initialization`. The module crashed on every page
load — no badges, no snapshot trigger.

Fix attempt: `0d91d52` moved the construction to right after the
idempotency guard (line ~140), with a comment explaining the hoist. This
fix was correct — the referenced functions (`quiesceOrphan`,
`rescanForNav`, `restoreFromBfcache`) are `function` declarations, hoisted,
so the arrow closures pointing at them resolve correctly at call time.

### Failure 2 — Page unresponsive under steady-state browsing

After the TDZ fix, the user reloaded the extension, opened YouTube, **left
the tab idle**, and the page became unresponsive. Even fresh new tabs on
unrelated URLs would hang on load.

This was the kill signal — fresh tabs hanging means the SW is doing
something wrong, not just the YouTube content script. The user couldn't
even type a URL into a new tab. Both commits reverted.

**Root cause: unknown.** Three plausible mechanisms, in order of suspicion:

1. **`AbortController` interaction with our own retry logic.** Some
   non-listener code path may still hold a stale closure that fires after
   the signal aborts, and the abort-error propagation isn't what we
   assumed. AbortError can be thrown from `addEventListener`'s callback
   path on some engines; if we don't catch it, it cascades.

2. **`safeSendMessage` interacting with the SW backpressure.** The pre-fix
   code threw synchronously when the SW was overwhelmed — backpressure was
   self-limiting because the throw bailed the caller out of further work.
   The new code returns a resolved `undefined`, so callers think the send
   succeeded and immediately schedule more. If that's true, every CS in
   every tab is hammering the SW with retries and the SW saturates.
   *Speculative — not measured.*

3. **An unobserved tight loop unrelated to my changes,** surfaced because
   the new code happened to keep something alive that the old code's
   throw would have killed. Pre-fix, sync throws from `sendMessage` were
   acting as an emergency brake on accidental loops; replacing them with
   a silent no-op removed the brake.

Cannot distinguish between these without an isolated repro. The user has
deadlines; we reverted instead of debugging in production.

## Constraints any future attempt must satisfy

Captured here so we don't re-discover them. The next attempt should be
designed against this list, not bolted-on past it.

1. **Ship one layer at a time, behind a guard.** AbortController-only,
   measure for 24h. Then cancelScheduled-only. Then safeSendMessage-only.
   The three-layer landing means we can't tell which one broke things — a
   bisect across the same commit is useless.

2. **Don't change the failure semantics of `sendMessage` until we've
   audited every call site for the assumption "this throws on orphan
   context."** Specifically check label-reservoir, label-sync, and
   anywhere else that uses the throw as a control-flow signal. The
   speculation in failure-2 hypothesis #2 — that the sync throw was load-
   bearing as backpressure — needs to be proven false before any drop-in
   replacement is safe.

3. **Construct `PageSession` (or whatever owns the AbortController) before
   anything references it.** The TDZ failure was a footgun the type system
   didn't catch because the references live in arrow closures evaluated
   later. Static check: a pre-commit grep for `pageSession.` calls that
   appear before the `const pageSession = ...` line.

4. **`quiesceOrphan` must remain idempotent and must not throw.** Every
   step needs its own `try/catch`. The current implementation has this
   shape; the new layers added did NOT consistently wrap their work.

5. **Verify on a fresh tab AND on the user's pre-existing tabs.** The TDZ
   failure only manifested on fresh page loads; the orphan-window failure
   only manifested after extension reload. Two separate test paths.

6. **Wedge guardrail (`scripts/_test-videos-tab-wedge.mjs`) must stay
   green.** The freeze-fix series invested heavily in not regressing it;
   any orphan-teardown work needs the same guard.

7. **Don't trust local "tests passing" or "snapshot looks fine."** Both
   commits passed all 486 tests and built clean on both browsers. The
   failure was steady-state-browsing-only, hours after page load. We need
   a long-running soak before declaring a fix shipped.

## Pieces worth keeping (NOT in current main; would be ported in a re-attempt)

- The `data-bk-pending` host attribute mirror in `hints.ts` — already
  shipped in `29f4329`, useful for tests, no relation to orphan teardown.
- The `hint.isVisible` + `hint.targetCssVisible` fields in the snapshot —
  also `29f4329`, useful, shipped.
- The `safe-send.ts` file structure (with adjusted return-value semantics
  per constraint 2) — the abstraction is right; the drop-in part needs
  more care.
- The `PageSession.cancelScheduled` method skeleton — the timer-clear
  logic is correct as far as it goes; the AbortController abort is the
  contentious part to revisit.

## Memory

Save as a project memory: any code change that touches the orphan teardown
arc has a high probability of breaking unrelated browsing behavior, even
when tests pass + builds clean. Run a steady-state soak (open YouTube,
leave 30 min, snap CPU + responsiveness) before merging.
