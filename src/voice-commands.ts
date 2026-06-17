/**
 * BranchKit Browser — voice commands from the platform, for the keymap editor.
 *
 * Maps the browser plugin's spoken commands to this extension's command ids so
 * the editor can show "you can also say …" next to each command's keys. The
 * data comes from the browser plugin's authenticated GET /voice-commands
 * (fetched by the background SW, which holds the plugin port+token) — NOT the
 * actuator's open /inspector/matchable, which exposed every plugin's command
 * set to any local process. The plugin enumerates + filters to owner=="browser"
 * and returns the same {eligible, gated} shape this parser already expects; the
 * action field ("browser.show_hints") maps each phrase to a command id.
 */

import type { VoiceCommandsMessageResponse } from './types';

export interface VoicePhrase {
  phrase: string;
  /** Eligible right now vs gated behind a context tag (still a valid phrase). */
  eligible: boolean;
}

interface MatchableEntry {
  owner?: string;
  pattern?: string;
  action?: string;
}

const BROWSER_PREFIX = 'browser.';

/**
 * Map matchable commands to extension command ids: keep owner==='browser',
 * strip the "browser." action prefix → command id, collect spoken patterns
 * (eligible first, then gated, deduped per command).
 */
export function parseVoiceCommands(json: unknown): Map<string, VoicePhrase[]> {
  const out = new Map<string, VoicePhrase[]>();
  if (!json || typeof json !== 'object') return out;
  const obj = json as { eligible?: MatchableEntry[]; gated?: MatchableEntry[] };

  const add = (entries: MatchableEntry[] | undefined, eligible: boolean): void => {
    for (const e of entries ?? []) {
      if (e.owner !== 'browser') continue;
      if (typeof e.action !== 'string' || !e.action.startsWith(BROWSER_PREFIX)) continue;
      if (typeof e.pattern !== 'string' || e.pattern.length === 0) continue;
      const id = e.action.slice(BROWSER_PREFIX.length);
      const list = out.get(id) ?? [];
      if (!list.some((p) => p.phrase === e.pattern)) list.push({ phrase: e.pattern, eligible });
      out.set(id, list);
    }
  };
  add(obj.eligible, true);
  add(obj.gated, false);
  return out;
}

export interface VoiceCommandsResult {
  /** False when the actuator is unreachable (BranchKit not running). */
  connected: boolean;
  byCommand: Map<string, VoicePhrase[]>;
}

export async function loadVoiceCommands(): Promise<VoiceCommandsResult> {
  // The options page can't reach the plugin directly (no port+token), so it
  // asks the background SW, which fetches the authenticated /voice-commands.
  let resp: VoiceCommandsMessageResponse | undefined;
  try {
    resp = await chrome.runtime.sendMessage({ type: 'GET_VOICE_COMMANDS' });
  } catch {
    resp = undefined;
  }
  if (!resp || !resp.connected || resp.data == null) {
    return { connected: false, byCommand: new Map() };
  }
  return { connected: true, byCommand: parseVoiceCommands(resp.data) };
}
