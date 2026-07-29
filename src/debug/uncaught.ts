/**
 * BranchKit Browser — uncaught-error capture (piece D of
 * notes/DESIGN_EXTENSION_LOG_RETRIEVAL.md).
 *
 * bkLog coverage is tag-by-tag manual, so an UNANTICIPATED failure — an
 * uncaught exception or unhandled rejection in the content script or the
 * service worker — used to vanish into a console nobody can reach (one
 * Playwright console read in 24 mined agent sessions). This forwards
 * exactly that class as BK_UNCAUGHT lines through the existing per-plugin
 * log path, and nothing else: `console.*` chatter stays out by design —
 * anything worth logging on purpose already has a bkLog tag.
 *
 * Isolated-world gotcha: `error` events from PAGE scripts are also
 * visible on the content script's `window`, so the CS filters to frames
 * whose filename starts with the extension origin — without it this
 * becomes a firehose of other people's bugs. `unhandledrejection` fires
 * per-world (our promises only) and needs no filter.
 *
 * Rejection-loop backstop: a per-boot cap; the cap line itself is
 * emitted once so the truncation is visible, never silent.
 */

const MAX_PER_BOOT = 20;
const STACK_FRAMES = 3;

let emitted = 0;

// The emitter this bundle was installed with, kept so `reportCaught` below can
// reach the same channel (and the same cap) as the listeners.
let installedEmit: UncaughtEmit | null = null;
let installedSource: 'sw' | 'cs' = 'cs';

function trimStack(stack: string | undefined): string[] {
  if (!stack) return [];
  return stack
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, STACK_FRAMES + 1); // message line + frames
}

export type UncaughtEmit = (tag: string, data: unknown, level: 'error') => void;

function guardedEmit(emit: UncaughtEmit, data: Record<string, unknown>): void {
  if (emitted >= MAX_PER_BOOT) return;
  emitted++;
  if (emitted === MAX_PER_BOOT) {
    emit('BK_UNCAUGHT', { ...data, capped: true, cap: MAX_PER_BOOT }, 'error');
    return;
  }
  emit('BK_UNCAUGHT', data, 'error');
}

/**
 * Install the two listeners. `source` is stamped on every line so a
 * browser.log grep can tell an SW crash from a CS crash; the CS variant
 * additionally applies the extension-origin filename filter described
 * above. Returns an uninstall closure (production never calls it; tests
 * sharing one window do).
 */
export function installUncaughtCapture(emit: UncaughtEmit, source: 'sw' | 'cs'): () => void {
  installedEmit = emit;
  installedSource = source;
  const target: EventTarget =
    source === 'sw' ? (globalThis as unknown as EventTarget) : window;

  // chrome.runtime.getURL('') is "<scheme>://<ext-id>/" — the prefix every
  // extension-owned filename carries in error events. Resolved once; if the
  // runtime is already gone there is also nothing to send to.
  let originPrefix = '';
  try {
    originPrefix = chrome.runtime.getURL('');
  } catch {
    return () => {};
  }

  const onError = (ev: Event) => {
    const e = ev as ErrorEvent;
    if (source === 'cs' && !(e.filename ?? '').startsWith(originPrefix)) {
      return; // a page script's error, not ours
    }
    guardedEmit(emit, {
      source,
      kind: 'error',
      message: e.message ?? String(e.error ?? 'unknown'),
      filename: e.filename || undefined,
      line: e.lineno || undefined,
      col: e.colno || undefined,
      stack: trimStack((e.error as Error | undefined)?.stack),
    });
  };

  const onRejection = (ev: Event) => {
    const reason = (ev as PromiseRejectionEvent).reason as unknown;
    const err = reason instanceof Error ? reason : undefined;
    guardedEmit(emit, {
      source,
      kind: 'unhandledrejection',
      message: err?.message ?? String(reason),
      stack: trimStack(err?.stack),
    });
  };

  target.addEventListener('error', onError);
  target.addEventListener('unhandledrejection', onRejection);
  return () => {
    target.removeEventListener('error', onError);
    target.removeEventListener('unhandledrejection', onRejection);
  };
}

/**
 * Report an error the code CAUGHT but that still means something broke.
 *
 * The two bundles emit differently — content.ts passes `bkLog`, background.ts
 * passes `forwardCoalesced` — so a caller that wants the BK_UNCAUGHT channel
 * cannot import an emitter directly. It comes through the one this module was
 * installed with, which also means it inherits the per-boot cap rather than
 * opening an uncapped second path to the log.
 *
 * Added for `core/message-router.ts`. Routing content.ts's onMessage chain
 * through a table put a try/catch around handlers that previously had none, so
 * a throw in (say) the voice-action dispatch stopped surfacing as an uncaught
 * error and became a console.warn — and console.* is kept out of browser.log by
 * design (header above). Catching the error is right; losing the only telemetry
 * for it is not.
 *
 * No-op before `installUncaughtCapture` has run, which mirrors the listeners:
 * there is nothing to send to yet.
 */
export function reportCaught(where: string, err: unknown, extra?: Record<string, unknown>): void {
  if (!installedEmit) return;
  const e = err instanceof Error ? err : undefined;
  guardedEmit(installedEmit, {
    source: installedSource,
    kind: 'caught',
    where,
    message: e?.message ?? String(err),
    stack: trimStack(e?.stack),
    ...extra,
  });
}

/** Test-only: reset the per-boot cap counter and the installed emitter. */
export function _resetUncaughtForTests(): void {
  emitted = 0;
  installedEmit = null;
}
