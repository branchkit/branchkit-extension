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

/** Test-only: reset the per-boot cap counter. */
export function _resetUncaughtForTests(): void {
  emitted = 0;
}
