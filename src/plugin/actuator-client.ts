/**
 * BranchKit Browser — actuator/plugin HTTP client (service worker side).
 *
 * Owns the plugin connection (port + token, discovered via the actuator status
 * endpoint) and the authed-POST boilerplate that ~12 background.ts forwarders
 * duplicated. Extracted from background.ts module scope (Tier 3 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md).
 *
 * Two connection postures are preserved from the originals:
 *   - discover-on-miss: call `ensureConnected()` before posting (the diagnostic
 *     forwarders + grammar/reference pushes lazily reconnect).
 *   - bail-on-miss: just call `postToPlugin()` (focus / active-tab posts must NOT
 *     trigger discovery; they no-op when not already connected).
 */

const ACTUATOR_URL = 'http://127.0.0.1:21551';

let pluginPort: number | null = null;
let pluginToken: string | null = null;

export function getPluginPort(): number | null {
  return pluginPort;
}

export function getPluginToken(): string | null {
  return pluginToken;
}

/**
 * Discover the browser plugin's listen port + token via the actuator status
 * endpoint. Caches the connection and returns true on success.
 */
export async function discoverPlugin(): Promise<boolean> {
  try {
    const resp = await fetch(`${ACTUATOR_URL}/v1/plugins/browser/status`);
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data.enabled || !data.listen) return false;
    pluginPort = data.listen.port;
    pluginToken = data.listen.token;
    return true;
  } catch {
    return false;
  }
}

/**
 * GET an open (unauthenticated) actuator endpoint and parse JSON. The
 * `/inspector/*` endpoints are open-GET. Used by the one-shot debug reconcile
 * to read `/inspector/matchable`. Returns null on any failure (never throws).
 */
export async function getActuatorJson(endpoint: string): Promise<unknown | null> {
  try {
    const resp = await fetch(`${ACTUATOR_URL}${endpoint}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

/** True if connected; discovers on miss. Use before a forward that should
 * lazily reconnect. */
export async function ensureConnected(): Promise<boolean> {
  if (pluginPort && pluginToken) return true;
  return discoverPlugin();
}

/**
 * Authed POST to a plugin endpoint. Returns the Response, or null if not
 * currently connected or the request threw. Does NOT discover — callers that
 * want lazy reconnect call `ensureConnected()` first.
 */
export async function postToPlugin(endpoint: string, body: unknown): Promise<Response | null> {
  if (!pluginPort || !pluginToken) return null;
  try {
    return await fetch(`http://127.0.0.1:${pluginPort}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    return null;
  }
}
