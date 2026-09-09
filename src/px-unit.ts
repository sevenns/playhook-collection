// One design pixel in real px — what every canvas drawn in the 1920x1080 mockup grid needs to scale by
// (focus-jelly.ts takes it as a dependency).
//
// BROWSER: the launcher reads `--px` off <html> and multiplies the vh number out (screen-scroller.ts:
// `pxUnit`). That cannot work here: this site's `--px` is `min(0.0925926vh, 0.0520833vw)` with a media
// override on top, and an unregistered custom property is never computed — getComputedStyle hands the
// expression back as text, parseFloat makes NaN of it, and the canvas would be sized in design px. So
// the unit is MEASURED instead: a probe element a thousand design px wide, read back through the layout
// engine, which resolves the min() and the media query for free.
import { req } from './dom.js';

const PROBE_DESIGN_PX = 1000;

let probe: HTMLElement | null = null;

function ensureProbe(): HTMLElement {
  if (probe !== null) return probe;
  const element = document.createElement('div');
  element.setAttribute('aria-hidden', 'true');
  element.style.position = 'absolute';
  element.style.visibility = 'hidden';
  element.style.pointerEvents = 'none';
  element.style.height = '0';
  element.style.width = `calc(${PROBE_DESIGN_PX} * var(--px))`;
  req('app').append(element);
  probe = element;
  return element;
}

/** One design pixel in real px, measured off the live layout. Falls back to 1 before the first layout. */
export function pxUnit(): number {
  const width = ensureProbe().getBoundingClientRect().width;
  return width > 0 ? width / PROBE_DESIGN_PX : 1;
}
