/**
 * The microphone glyph shown next to a command's voice phrase(s).
 *
 * Built node-by-node with `createElementNS` — DOM construction (no `innerHTML`,
 * so AMO's linter is happy) AND, unlike the previous `DOMParser` approach, it
 * produces a node in THIS document's SVG namespace that reliably lays out and
 * paints when appended to a shadow root (a parsed foreign-document element could
 * silently render at zero size). Kept in one place (help-overlay + keymap-options).
 */
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node as SVGElement;
}

export function micGlyph(): SVGElement {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  });
  svg.appendChild(svgEl('rect', { x: '9', y: '2', width: '6', height: '12', rx: '3' }));
  svg.appendChild(svgEl('path', { d: 'M5 11a7 7 0 0 0 14 0' }));
  svg.appendChild(svgEl('line', { x1: '12', y1: '18', x2: '12', y2: '22' }));
  return svg;
}
