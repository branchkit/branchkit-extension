/**
 * URL-hierarchy navigation (Vimium goUp / goToRoot).
 *
 * `urlUp` climbs one meaningful level per call — drop the hash, then the query,
 * then the last path segment — so repeated presses walk up the tree. `urlRoot`
 * jumps straight to the site root. Both return null when there's nowhere to go
 * (already at the top / unparseable), so the caller can no-op or toast. Pure —
 * unit-tested.
 */

/** One level up, or null if already at the site root. */
export function urlUp(href: string): string | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }

  if (u.hash) { u.hash = ''; return u.href; }
  if (u.search) { u.search = ''; return u.href; }

  const path = u.pathname.replace(/\/+$/, '');
  if (path === '') return null; // already at "/"
  const parent = path.slice(0, path.lastIndexOf('/') + 1); // keep the parent's trailing slash
  u.pathname = parent === '' ? '/' : parent;
  return u.href;
}

/** The site root (scheme://host/), or null if already there / unparseable. */
export function urlRoot(href: string): string | null {
  try {
    const u = new URL(href);
    const root = u.origin + '/';
    return root === u.href ? null : root;
  } catch {
    return null;
  }
}
