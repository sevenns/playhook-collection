// The glyph of the site's Library card, exported from the mockup and inlined as DOM. Ported from
// playhook @ c26fae7 (release/v0.8.0) : src/renderer/system-card-icons.ts, which carries four of them —
// the site has one card, so it carries one shape (see system-cards.ts).
//
// Inline SVG built with createElementNS, never innerHTML or a file reference: the CSP forbids external
// resources, and building the nodes is the project's rule for markup that isn't in index.html.
//
// The exported `fill` is dropped deliberately — the card paints its icon with `currentColor`, so the
// glyph follows the live palette the way the rest of the UI does.
import type { SystemCardId } from './system-cards.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

interface IconShape {
  readonly viewBox: string;
  readonly paths: readonly string[];
}

const GRID_PATHS = [
  'M11.52 31.625C13.1106 31.625 14.4 32.9122 14.4 34.5V43.125C14.4 44.7128 13.1106 46 11.52 46H2.88C1.28942 46 0 44.7128 0 43.125V34.5C0 32.9122 1.28942 31.625 2.88 31.625H11.52Z',
  'M19.4297 32.3026C19.8694 32.0443 20.4134 32.0375 20.8594 32.2848L29.4994 37.0765C29.9565 37.33 30.24 37.8113 30.24 38.3333C30.24 38.8554 29.9565 39.3367 29.4994 39.5902L20.8594 44.3819C20.4134 44.6292 19.8694 44.6224 19.4297 44.3641C18.9899 44.1058 18.72 43.6343 18.72 43.125V33.5417C18.72 33.0323 18.9899 32.5609 19.4297 32.3026Z',
  'M11.52 15.8125C13.1106 15.8125 14.4 17.0997 14.4 18.6875V27.3125C14.4 28.9003 13.1106 30.1875 11.52 30.1875H2.88C1.28942 30.1875 0 28.9003 0 27.3125V18.6875C0 17.0997 1.28942 15.8125 2.88 15.8125H11.52Z',
  'M28.32 15.8125C29.9106 15.8125 31.2 17.0997 31.2 18.6875V27.3125C31.2 28.9003 29.9106 30.1875 28.32 30.1875H19.68C18.0894 30.1875 16.8 28.9003 16.8 27.3125V18.6875C16.8 17.0997 18.0894 15.8125 19.68 15.8125H28.32Z',
  'M45.12 15.8125C46.7106 15.8125 48 17.0997 48 18.6875V27.3125C48 28.9003 46.7106 30.1875 45.12 30.1875H36.48C34.8894 30.1875 33.6 28.9003 33.6 27.3125V18.6875C33.6 17.0997 34.8894 15.8125 36.48 15.8125H45.12Z',
  'M11.52 0C13.1106 0 14.4 1.28718 14.4 2.875V11.5C14.4 13.0878 13.1106 14.375 11.52 14.375H2.88C1.28942 14.375 0 13.0878 0 11.5V2.875C0 1.28718 1.28942 0 2.88 0H11.52Z',
  'M28.32 0C29.9106 0 31.2 1.28718 31.2 2.875V11.5C31.2 13.0878 29.9106 14.375 28.32 14.375H19.68C18.0894 14.375 16.8 13.0878 16.8 11.5V2.875C16.8 1.28718 18.0894 0 19.68 0H28.32Z',
  'M45.12 0C46.7106 0 48 1.28718 48 2.875V11.5C48 13.0878 46.7106 14.375 45.12 14.375H36.48C34.8894 14.375 33.6 13.0878 33.6 11.5V2.875C33.6 1.28718 34.8894 0 36.48 0H45.12Z',
];

const SHAPES: Readonly<Record<SystemCardId, IconShape>> = {
  library: { viewBox: '0 0 48 46', paths: GRID_PATHS },
};

/** The glyph of one site card, as an inline SVG node painted with the current palette. */
export function systemCardIcon(id: SystemCardId): SVGSVGElement {
  const shape = SHAPES[id];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', shape.viewBox);
  svg.setAttribute('class', 'card-icon');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of shape.paths) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
