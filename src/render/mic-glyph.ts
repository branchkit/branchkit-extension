/**
 * The microphone glyph shown next to a command's voice phrase(s).
 *
 * Built as a real SVG node rather than assigned via `innerHTML`. The markup is
 * a static extension constant (no page/user input), so it is safe either way —
 * but DOM construction is the form AMO's linter accepts without an
 * UNSAFE_VAR_ASSIGNMENT warning, and it keeps the glyph defined in one place
 * (previously duplicated in help-overlay.ts and keymap-options.ts).
 *
 * Parsed once into a template; each call returns a fresh clone.
 */
const MIC_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
  '<path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';

let template: SVGElement | null = null;

export function micGlyph(): SVGElement {
  if (!template) {
    const doc = new DOMParser().parseFromString(MIC_SVG, 'image/svg+xml');
    template = doc.documentElement as unknown as SVGElement;
  }
  return template.cloneNode(true) as SVGElement;
}
