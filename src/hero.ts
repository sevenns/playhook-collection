// Hero background subsystem, ported from playhook @ c348f4246752286b594c8a8eddd2253ea88b0f12 :
// src/renderer/hero.ts, reduced to the empty screen. The launcher's per-card hero rotation
// (applyAssets / startRotation / repaint / the per-hero palette cache) and its HeroDeps seam are gone —
// there is exactly one image here, and no game state to read.
//
// What is kept 1:1: the two cross-fading layers with a randomized pan direction and the forced
// animation restart, and the two-color palette applied inline on #app.
import { computePalette, type Palette } from './dominant-color.js';
import { req } from './dom.js';

export interface HeroController {
  /** Cross-fades the wallpaper in and applies its palette. */
  show(url: string): void;
}

export function createHeroController(): HeroController {
  const app = req('app');

  // ── Palette (two dominant colors) ─────────────────────────────────────────

  function applyPalette(palette: Palette | null): void {
    if (palette === null) {
      app.style.removeProperty('--d1');
      app.style.removeProperty('--d2');
      return;
    }
    app.style.setProperty('--d1', palette.d1);
    app.style.setProperty('--d2', palette.d2);
  }

  // ── Hero background (two cross-fading layers, GTA-5-style) ──────────────────

  // Two stacked layers we cross-fade between: activeLayer shows the current image, idleLayer receives the
  // next one; then the roles swap. Both run bg-pan perpetually (see styles.css).
  const heroLayers = Array.from(document.querySelectorAll<HTMLElement>('#hero .hero-layer'));
  const [heroLayerA, heroLayerB] = heroLayers;
  if (heroLayerA === undefined || heroLayerB === undefined) {
    throw new Error('#hero must contain two .hero-layer elements');
  }
  let activeLayer: HTMLElement = heroLayerA;
  let idleLayer: HTMLElement = heroLayerB;
  // The url the active layer currently shows — a gate so a repeated call doesn't trigger a needless
  // cross-fade / pan re-randomize when the image hasn't actually changed.
  let shownUrl: string | null = null;

  // Cross-fades to a new image on the idle layer, then swaps roles. No-op when the url is unchanged
  // (keeps the running pan going).
  function showImage(url: string): void {
    if (url === shownUrl) return;
    shownUrl = url;
    // The incoming (idle) layer gets the new image + a fresh random pan direction (drift left vs right).
    idleLayer.style.backgroundImage = `url("${url}")`;
    idleLayer.style.setProperty('--pan-x', Math.random() < 0.5 ? '1.5%' : '-1.5%');
    // Force-restart bg-pan so the incoming image starts its drift from zero: opacity:0 does NOT pause the
    // animation, so without this the layer would fade in mid-drift. Toggling animation + a reflow retriggers
    // it — and the same reflow flushes styles so the opacity transition below actually animates.
    idleLayer.style.animation = 'none';
    void idleLayer.offsetWidth;
    idleLayer.style.animation = '';
    // Cross-fade: incoming layer in, outgoing out, then swap the roles.
    idleLayer.classList.add('is-active');
    activeLayer.classList.remove('is-active');
    const previousActive = activeLayer;
    activeLayer = idleLayer;
    idleLayer = previousActive;
  }

  return {
    show(url: string): void {
      showImage(url);
      // The palette is a canvas read of the same (same-origin, already-decoded) image, so it lands a
      // frame or two later; getImageData failures resolve to null and leave the CSS fallbacks — which,
      // unlike in the launcher, are this very wallpaper's colors, so nothing visibly shifts.
      void computePalette(url).then((palette) => {
        if (shownUrl === url) applyPalette(palette);
      });
    },
  };
}
