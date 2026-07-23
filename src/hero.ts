// Hero background subsystem, ported from playhook @ c348f4246752286b594c8a8eddd2253ea88b0f12 :
// src/renderer/hero.ts. The launcher's HeroDeps seam (a game-state reader and a translator) is gone —
// here the caller simply says which entry is on screen — but everything that made the launcher's heroes
// feel alive is back: the per-entry image rotation, the positional palette cache, and the wallpaper
// fallback.
//
// What is kept 1:1: the two cross-fading layers with a randomized pan direction and the forced animation
// restart, and the two-color palette applied inline on #app.
import { computePalette, type Palette } from './dominant-color.js';
import { preload } from './preload.js';
import { req } from './dom.js';

const HERO_ROTATE_MS = 60_000;
/** How far ahead of a swap the next image is fetched. */
const PRELOAD_LEAD_MS = 5_000;

export interface HeroController {
  /** Stores the site wallpaper (home screen, and the fallback for an entry with no usable hero). */
  setWallpaper(url: string): void;
  /** Home: the wallpaper and its palette. */
  showWallpaper(): void;
  /** An entry's heroes. Empty — or all of them broken — leaves the wallpaper up. */
  showGame(slug: string, urls: readonly string[]): void;
}

export function createHeroController(): HeroController {
  const app = req('app');

  let wallpaperUrl: string | null = null;
  // `undefined` = not computed yet, `null` = computed and unusable. The wallpaper's palette is cached on
  // its own so returning home never re-runs the canvas read.
  let wallpaperPalette: Palette | null | undefined;
  // Keyed by POSITION (`${slug}#${index}`), which is why it is cleared whenever the entry changes: the
  // same key would otherwise map to a different picture and hand it the previous one's colors.
  const paletteCache = new Map<string, Palette | null>();

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

  // Applies a (possibly cached) palette, but only if that image is STILL the one on screen — a slow
  // compute for a rotated-away image must not clobber the current colors.
  function updatePaletteFor(url: string, cacheKey: string): void {
    const cached = paletteCache.get(cacheKey);
    if (cached !== undefined) {
      applyPalette(cached);
      return;
    }
    void computePalette(url).then((palette) => {
      paletteCache.set(cacheKey, palette);
      if (shownUrl === url) applyPalette(palette);
    });
  }

  function applyWallpaperPalette(): void {
    if (wallpaperPalette !== undefined) {
      applyPalette(wallpaperPalette);
      return;
    }
    if (wallpaperUrl === null) {
      applyPalette(null);
      return;
    }
    const url = wallpaperUrl;
    void computePalette(url).then((palette) => {
      wallpaperPalette = palette;
      if (shownUrl === url) applyPalette(palette);
    });
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

  // ── Rotation ────────────────────────────────────────────────────────────────

  /** '' means the home screen — no entry, no rotation. */
  let currentSlug = '';
  let heroUrls: readonly string[] = [];
  let heroIndex = 0;
  let heroTimer: number | null = null;
  let preloadTimer: number | null = null;

  function rotationEligible(): boolean {
    return heroUrls.length > 1 && document.visibilityState === 'visible' && currentSlug !== '';
  }

  function stopRotation(): void {
    if (heroTimer !== null) {
      window.clearInterval(heroTimer);
      heroTimer = null;
    }
    if (preloadTimer !== null) {
      window.clearTimeout(preloadTimer);
      preloadTimer = null;
    }
  }

  // Fetch the NEXT image shortly before it is due, rather than pulling the whole set up front: three
  // 1080p-to-1440p heroes are well over a megabyte, and the third one is not needed for two minutes.
  function armNextPreload(): void {
    if (preloadTimer !== null) window.clearTimeout(preloadTimer);
    preloadTimer = window.setTimeout(
      () => {
        preloadTimer = null;
        const next = heroUrls[(heroIndex + 1) % heroUrls.length];
        if (next !== undefined) void preload(next).catch(() => undefined);
      },
      Math.max(0, HERO_ROTATE_MS - PRELOAD_LEAD_MS),
    );
  }

  // Idempotent: an already-running eligible rotation is left alone, so repeated calls can't starve it by
  // resetting the interval and the image would never actually change.
  function startRotation(): void {
    if (!rotationEligible()) {
      stopRotation();
      return;
    }
    if (heroTimer !== null) return;
    armNextPreload();
    heroTimer = window.setInterval(() => {
      const index = (heroIndex + 1) % heroUrls.length;
      const url = heroUrls[index];
      armNextPreload();
      if (url === undefined) return;
      const slug = currentSlug;
      void preload(url).then(
        () => {
          // The entry may have changed while this was in flight.
          if (currentSlug !== slug) return;
          heroIndex = index;
          showImage(url);
          updatePaletteFor(url, `${slug}#${index}`);
        },
        // A broken URL mid-rotation: keep whatever is on screen and try the next one next minute.
        () => undefined,
      );
    }, HERO_ROTATE_MS);
  }

  document.addEventListener('visibilitychange', () => startRotation());

  function applyWallpaper(): void {
    if (wallpaperUrl === null) return;
    showImage(wallpaperUrl);
    applyWallpaperPalette();
  }

  // Paints the first hero that actually loads. Walking the list rather than trusting heroUrls[0] is the
  // browser-side replacement for the launcher's guarantee that the array is never empty (there, main
  // substitutes the bundled wallpaper before the renderer ever sees it — asset-reader.ts).
  async function showFirstUsable(slug: string, urls: readonly string[]): Promise<void> {
    for (const [index, url] of urls.entries()) {
      try {
        await preload(url);
      } catch {
        continue;
      }
      if (currentSlug !== slug) return;
      heroIndex = index;
      showImage(url);
      updatePaletteFor(url, `${slug}#${index}`);
      startRotation();
      return;
    }
    if (currentSlug === slug) applyWallpaper();
  }

  return {
    setWallpaper(url: string): void {
      wallpaperUrl = url;
      wallpaperPalette = undefined;
      // Nothing on screen yet: paint it. This is also what covers a cold deep link to a game — the
      // wallpaper fills the wait, then cross-fades into the entry's own hero when that arrives.
      if (shownUrl === null) applyWallpaper();
    },

    showWallpaper(): void {
      currentSlug = '';
      heroUrls = [];
      heroIndex = 0;
      paletteCache.clear();
      stopRotation();
      applyWallpaper();
    },

    showGame(slug: string, urls: readonly string[]): void {
      // Idempotent by content, not by slug: the route lands before the feed does, so the same entry
      // legitimately arrives twice — first with nothing, then with its images.
      const unchanged =
        slug === currentSlug &&
        urls.length === heroUrls.length &&
        urls.every((url, index) => url === heroUrls[index]);
      if (unchanged) return;
      currentSlug = slug;
      heroUrls = urls;
      heroIndex = 0;
      paletteCache.clear();
      stopRotation();
      if (urls.length === 0) {
        applyWallpaper();
        return;
      }
      void showFirstUsable(slug, urls);
    },
  };
}
