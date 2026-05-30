/**
 * BranchKit Browser — Pure helpers for the options page.
 *
 * Kept separate from `options.ts` (which is DOM-bound) so the logic is
 * unit-testable without happy-dom standing in for chrome.tabs.
 */

/**
 * Suggest a pattern from a URL: subdomain hosts collapse to a wildcard
 * across the last two labels, two-label hosts use exact match. Returns
 * null if the URL has no parseable hostname (chrome://, file://, etc.).
 *
 * Examples:
 *   https://app.example.com/x   → "*.example.com"
 *   https://example.com/        → "example.com"
 *   https://a.b.example.com/    → "*.example.com"
 *
 * Known limitation: doesn't know about multi-part TLDs (.co.uk, .com.au).
 * On those, `app.example.co.uk` resolves to `*.co.uk` which is too broad.
 * Users editing the field can correct it. A public-suffix-list dep would
 * fix it but isn't worth the bundle weight for v1.
 */
export function suggestPattern(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Content scripts only run on http(s) — no point suggesting a pattern
  // for chrome://, about:, file:, view-source:, etc.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const host = parsed.hostname;
  if (!host || host.includes(':')) return null;          // IPv6/etc.
  if (/^[\d.]+$/.test(host)) return host;                // IPv4 — exact only.

  const parts = host.split('.');
  if (parts.length < 2) return host;
  if (parts.length === 2) return host;
  return '*.' + parts.slice(-2).join('.');
}

/**
 * Validate a CSS selector by handing it to `document.querySelector` in a
 * try/catch. The browser's parser is the source of truth — no point
 * reimplementing it.
 */
export function isValidSelector(selector: string): boolean {
  if (!selector.trim()) return false;
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a domain pattern. Accepts the three shapes documented in the
 * design doc:
 *   *.example.com       — subdomain wildcard
 *   example.com         — exact host
 *   example.com/path/*  — host + path prefix
 *
 * Returns null when valid, an error message string otherwise. Callers
 * surface the message inline in the form.
 */
export function validatePattern(pattern: string): string | null {
  const p = pattern.trim();
  if (!p) return 'Pattern is required.';
  if (p.includes(' ')) return 'Pattern cannot contain spaces.';

  let host: string;
  let path = '';
  const slashIdx = p.indexOf('/');
  if (slashIdx === -1) {
    host = p;
  } else {
    host = p.slice(0, slashIdx);
    path = p.slice(slashIdx);
  }

  if (host.startsWith('*.')) {
    host = host.slice(2);
    if (!host) return 'Wildcard must be followed by a domain.';
  }
  if (host.includes('*')) return 'Only leading "*." wildcards are supported.';
  if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(host)) {
    return 'Host must be a valid domain like "example.com".';
  }

  if (path && !path.startsWith('/')) return 'Path must start with "/".';
  if (path.length > 1 && path.indexOf('*') !== -1 && !path.endsWith('/*')) {
    return 'Path wildcard must be at the end (e.g., "/app/*").';
  }

  return null;
}
