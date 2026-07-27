/**
 * BranchKit Browser — command-phrase override and alias messages.
 *
 * The keymap editor (keyboard-shortcuts page) can't reach the plugin directly,
 * so the SW forwards to the browser plugin's passthrough, which relays to the
 * actuator override layer. See notes/DESIGN_COMMAND_PHRASE_OVERRIDES.md.
 *
 * Overrides REPLACE a command's default spoken pattern; aliases ADD extra
 * spoken forms (the "+ voice" free list). Both are per-action and both round
 * trip through the same connect-then-write shape.
 *
 * Lifted verbatim out of background.ts's message chain
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md). Every handler answers a value rather
 * than a raw fetch result: a disconnected host is a normal state here, not an
 * error, and the editor renders the empty/failed case itself.
 */

import { ensureConnected, postToPlugin, getFromPlugin } from '../plugin/actuator-client';
import type { MessageHandler } from './message-router';

/**
 * Map a failed plugin phrase-write to an editor-friendly message. A 400 carries
 * the actuator's validation text (user-actionable — relay it); a 404 means the
 * running BranchKit predates these routes (needs a rebuild); anything else is a
 * transport/availability problem. Avoids surfacing raw "404 page not found".
 */
export async function phraseWriteError(resp: Response | null): Promise<string> {
  if (!resp) return 'BranchKit isn’t running.';
  if (resp.status === 400) {
    const detail = (await resp.text().catch(() => '')).trim();
    return detail || 'That phrase isn’t allowed.';
  }
  if (resp.status === 404) return 'Update BranchKit — this build can’t edit voice phrases yet.';
  return 'Couldn’t save — is BranchKit up to date and running?';
}

/** Read a list-shaped field off a plugin GET, tolerating any malformed body. */
function listFrom(data: unknown, key: string): unknown[] {
  const value = (data as Record<string, unknown> | null | undefined)?.[key];
  return Array.isArray(value) ? value : [];
}

/** A write that reports only success, with no error detail to surface. */
function writeOk(path: string, body: Record<string, unknown>): Promise<{ ok: boolean }> {
  return ensureConnected()
    .then(() => postToPlugin(path, body))
    .then((resp) => ({ ok: !!(resp && resp.ok) }))
    .catch(() => ({ ok: false }));
}

/** A write whose failure the editor renders inline, so it carries a message. */
function writeReporting(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  return ensureConnected()
    .then(() => postToPlugin(path, body))
    .then(async (resp) => {
      if (resp && resp.ok) return { ok: true };
      return { ok: false, error: await phraseWriteError(resp) };
    })
    .catch(() => ({ ok: false, error: 'Not connected to BranchKit.' }));
}

const patternBody = (message: any) => ({
  action: message.action,
  default_pattern: message.defaultPattern,
  new_pattern: message.newPattern,
});

export const commandOverrideMessageHandlers: Record<string, MessageHandler> = {
  GET_COMMAND_OVERRIDES: () =>
    ensureConnected()
      .then(() => getFromPlugin('/commands/overrides'))
      .then((data) => ({ overrides: listFrom(data, 'overrides') }))
      .catch(() => ({ overrides: [] })),

  SET_COMMAND_OVERRIDE: (message) =>
    writeReporting('/commands/override', patternBody(message)),

  RESET_COMMAND_OVERRIDE: (message) =>
    writeOk('/commands/override/reset', {
      action: message.action,
      default_pattern: message.defaultPattern,
    }),

  GET_COMMAND_ALIASES: () =>
    ensureConnected()
      .then(() => getFromPlugin('/commands/aliases'))
      .then((data) => ({ aliases: listFrom(data, 'aliases') }))
      .catch(() => ({ aliases: [] })),

  ADD_COMMAND_ALIAS: (message) =>
    writeReporting('/commands/alias', patternBody(message)),

  REMOVE_COMMAND_ALIAS: (message) =>
    writeOk('/commands/alias/remove', patternBody(message)),
};
