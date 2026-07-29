/**
 * Highlighter yellow — the colour a found match wears.
 *
 * Anything that has to READ as "this is a search match" wears this, and a
 * second copy of the hex is a thing that drifts. Two layers need it: find
 * paints `::highlight(branchkit-find-current)` with it (scan/find.ts), and the
 * search-match badge tints itself from it (render/badge-variant.ts), so
 * retheming the highlight retints the badges with it.
 *
 * It lives in a leaf of its own rather than in either consumer, and that is
 * structural rather than tidiness. It used to live in scan/find, and
 * render/badge-variant importing it was — measured, not assumed — the ONLY
 * edge from anything under render/ to scan/find. Every other render module
 * reached find through it: badge-visibility -> hints -> badge-variant -> find.
 * That single hop is what made find unable to import render/badge-visibility,
 * which is why find's badge-borrow callbacks had to be injected from
 * content.ts. One hex string held a seam open.
 *
 * So: nothing here may grow an import. A relative import in this file
 * re-creates the path it exists to cut. If a second colour needs to be shared
 * the same way, it belongs beside this one — not in a module that also does
 * something.
 */
export const FIND_HIGHLIGHT = '#ffeb3b';
