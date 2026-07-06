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

// Harness isolation (notes/DESIGN_EXTENSION_CONNECTION_HEALTH.md, piece B).
// Test harnesses copy dist/ and drop a `harness.json` marker into the copy;
// its presence makes this extension deterministically standalone — no
// discovery, no SSE, no live-session pollution. A packaged-resource fetch
// (not a storage flag) because it's readable BEFORE the boot-time discovery
// runs — a storage flag seeded via sw.evaluate loses that race. Memoized:
// the answer can't change within a SW lifetime. In production the marker
// doesn't exist and the single failed fetch at first discovery is free.
//
// The check requires the marker's CONTENT, not just a non-error response:
// Firefox answers a fetch of a MISSING packaged resource with a 200 (Chrome
// rejects it), so an `r.ok` check read as "harness present" in every real
// Firefox install and deterministically disabled discovery — the extension
// looked healthy (hints paint standalone) but could never connect
// (2026-07-03 incident, one day after this gate landed).
let discoveryDisabled: Promise<boolean> | null = null;

function isDiscoveryDisabled(): Promise<boolean> {
  if (!discoveryDisabled) {
    try {
      discoveryDisabled = fetch(chrome.runtime.getURL('harness.json'))
        .then(async (r) => {
          if (!r.ok) return false;
          try {
            // Only the real marker counts: the JSON launch.mjs writes,
            // carrying discovery:"disabled".
            const marker = await r.json();
            return marker?.discovery === 'disabled';
          } catch {
            return false;
          }
        })
        .catch(() => false);
    } catch {
      // No chrome.runtime (unit tests) or invalidated context — not a harness.
      discoveryDisabled = Promise.resolve(false);
    }
  }
  return discoveryDisabled;
}

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
  if (await isDiscoveryDisabled()) return false;
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

// Discover-on-miss throttling. ensureConnected is called per-POST by ~12
// forwarders; with the host down (or creds just cleared) every one of those
// would fire its own discovery fetch. Single-flight collapses concurrent
// callers onto one fetch, and a failed discovery is cached briefly so a
// burst of forwards can't turn into a discovery hammer. The SSE retry
// ladder calls discoverPlugin directly and is NOT throttled — reconnect
// pacing is its job (background.ts scheduleSSERetry).
const DISCOVERY_NEGATIVE_TTL_MS = 5_000;
let discoveryInFlight: Promise<boolean> | null = null;
let lastFailedDiscoveryAt = 0;

/** True if connected; discovers on miss (single-flight, negative-cached).
 * Use before a forward that should lazily reconnect. */
export async function ensureConnected(): Promise<boolean> {
  if (pluginPort && pluginToken) return true;
  if (discoveryInFlight) return discoveryInFlight;
  if (Date.now() - lastFailedDiscoveryAt < DISCOVERY_NEGATIVE_TTL_MS) return false;
  discoveryInFlight = discoverPlugin().then((found) => {
    if (!found) lastFailedDiscoveryAt = Date.now();
    discoveryInFlight = null;
    return found;
  });
  return discoveryInFlight;
}

/**
 * Authed POST to a plugin endpoint. Returns the Response, or null if not
 * currently connected or the request threw. Does NOT discover — callers that
 * want lazy reconnect call `ensureConnected()` first.
 */
/**
 * Authed GET to a plugin endpoint, parsed as JSON. Returns null if not
 * connected or the request failed. Does NOT discover — callers that want lazy
 * reconnect call `ensureConnected()` first.
 */
export async function getFromPlugin(endpoint: string): Promise<unknown | null> {
  if (!pluginPort || !pluginToken) return null;
  try {
    const resp = await fetch(`http://127.0.0.1:${pluginPort}${endpoint}`, {
      headers: { 'Authorization': `Bearer ${pluginToken}` },
    });
    if (resp.status === 401 || resp.status === 403) {
      pluginPort = null;
      pluginToken = null;
      return null;
    }
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    pluginPort = null;
    pluginToken = null;
    return null;
  }
}

export async function postToPlugin(endpoint: string, body: unknown): Promise<Response | null> {
  if (!pluginPort || !pluginToken) return null;
  try {
    const resp = await fetch(`http://127.0.0.1:${pluginPort}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(body),
    });
    if (resp.status === 401 || resp.status === 403) {
      // The host restarted with a fresh token while the SSE drop went
      // unnoticed: these creds are dead, and holding them wedges every POST
      // (ensureConnected keeps vouching for them). Clear so the next
      // ensureConnected/discover-on-miss rediscovers. App-level errors
      // (400s from validation etc.) keep the creds.
      pluginPort = null;
      pluginToken = null;
    }
    return resp;
  } catch {
    // Connection refused/reset — whatever owned this port is gone. Same
    // self-heal: drop the creds, rediscover on the next call.
    pluginPort = null;
    pluginToken = null;
    return null;
  }
}
