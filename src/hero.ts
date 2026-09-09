// Hero background subsystem, ported from playhook @ c26fae7 (release/v0.8.0) : src/renderer/hero.ts.
// The launcher's HeroDeps seam (a game-state reader and a translator) is gone — here the caller simply
// says which entry is on screen — but everything that made the launcher's heroes feel alive is back: the
// per-entry image rotation, the positional palette cache, and the wallpaper fallback.
//
// What is kept 1:1: the two cross-fading layers with a randomized pan direction and the forced animation
// restart, the two-color palette applied inline on #app, and the SWAP SCHEDULER — a request stands for
// SETTLE_MS before it is painted, never lands on a layer that is still fading, and waits out a held
// direction altogether (setFlipping). What is merged rather than copied: the launcher's images are data
// URLs and can be painted the moment they are asked for; here they arrive over the network, so every one
// is preloaded first and only THEN handed to the scheduler.
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
  /** Parallax offset in DESIGN px: the background drifts with the carousel (see #hero-pan in styles.css). */
  setParallax(designPx: number): void;
  /**
   * Whether a direction is being HELD, i.e. the strip is flipping on its own. While it is, the image on
   * screen stays exactly where it is — whatever heroes arrive meanwhile are remembered, not painted —
   * and the last one lands as soon as the key/stick is let go. Interruptible: the request that arrives
   * during the hold is the one that gets shown.
   */
  setFlipping(flipping: boolean): void;
  /**
   * The transform the visible layer is wearing right now — what the boot backdrop converges on as it
   * dissolves (see main.ts). Read off the computed style rather than tracked: the pan is a CSS
   * transition, so only the layout knows where it has got to.
   */
  currentLayerTransform(): string;
}

export function createHeroController(): HeroController {
  const app = req('app');
  const heroPanEl = req('hero-pan');

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

  /** Matches the .hero-layer opacity transition in styles.css — how long a cross-fade owns both layers. */
  const CROSSFADE_MS = 700;
  /**
   * How long the requested image must stand before it is painted. Deliberately longer than the nav
   * repeat (NAV_REPEAT_MS in auto-repeat.ts), so a HELD left/right never paints a background at all: the
   * strip flips, and the hero lands once, on wherever the user stopped.
   */
  const SETTLE_MS = 120;

  // What the page WANTS on screen, versus what is on it (shownUrl). They differ while a swap waits — see
  // requestImage. The palette travels with the image rather than being applied at request time: the
  // colors and the picture must never disagree, which is what a straight apply would do while flipping.
  let desiredUrl: string | null = null;
  let desiredPaint: (() => void) | null = null;
  let swapTimer: number | null = null;
  let lastSwapAt = Number.NEGATIVE_INFINITY;
  // A direction is being held (main.ts relays it). SETTLE_MS alone almost covers this — the repeat is
  // faster than it — but "almost" is not a rule. The held state says it outright: no swap at all until
  // the flip stops.
  let flipping = false;

  /**
   * Asks for an image (and the palette that goes with it). The swap is deferred twice over: until the
   * request has stood still for SETTLE_MS, and until the previous cross-fade has finished. Painting into
   * a layer that is still fading is what made a fast card change snap — the incoming layer is visible by
   * then, so swapping its background-image replaces the picture instantly, with no fade at all.
   * The url is expected to be loaded already (see showFirstUsable / the rotation): this schedules the
   * fade, it does not wait for the network.
   */
  function requestImage(url: string, paintPalette: () => void): void {
    if (url === desiredUrl) {
      // The same image asked for again (a repeated route, the feed landing twice). No cross-fade — but
      // the palette may still need re-applying, unless the swap to it hasn't happened yet, where it is
      // the swap's job.
      if (shownUrl === desiredUrl) paintPalette();
      else desiredPaint = paintPalette;
      return;
    }
    desiredUrl = url;
    desiredPaint = paintPalette;
    // The session's FIRST image has nothing to cross-fade with and nobody waiting to see it settle.
    if (shownUrl === null && swapTimer === null && !flipping) runSwap();
    else armSwap();
  }

  function armSwap(): void {
    if (swapTimer !== null) {
      window.clearTimeout(swapTimer);
      swapTimer = null;
    }
    // Held: the swap is re-armed by setFlipping when the direction is released, with whatever the last
    // request turned out to be.
    if (flipping) return;
    const waitForFade = lastSwapAt + CROSSFADE_MS - performance.now();
    swapTimer = window.setTimeout(runSwap, Math.max(SETTLE_MS, waitForFade));
  }

  function setFlipping(next: boolean): void {
    if (flipping === next) return;
    flipping = next;
    if (flipping) {
      if (swapTimer !== null) {
        window.clearTimeout(swapTimer);
        swapTimer = null;
      }
      return;
    }
    if (desiredUrl !== shownUrl) armSwap();
  }

  function runSwap(): void {
    if (swapTimer !== null) {
      window.clearTimeout(swapTimer);
      swapTimer = null;
    }
    const paint = desiredPaint;
    desiredPaint = null;
    if (desiredUrl !== null && desiredUrl !== shownUrl) {
      lastSwapAt = performance.now();
      swapLayers(desiredUrl);
    }
    paint?.();
  }

  // Cross-fades to a new image on the idle layer, then swaps roles. Only ever called from runSwap, which
  // owns the timing.
  function swapLayers(url: string): void {
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

  /** A loaded hero of the entry on screen: schedule its fade, with its own palette riding along. */
  function showHero(slug: string, index: number, url: string): void {
    heroIndex = index;
    requestImage(url, () => updatePaletteFor(url, `${slug}#${index}`));
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
          showHero(slug, index, url);
        },
        // A broken URL mid-rotation: keep whatever is on screen and try the next one next minute.
        () => undefined,
      );
    }, HERO_ROTATE_MS);
  }

  document.addEventListener('visibilitychange', () => startRotation());

  function applyWallpaper(): void {
    if (wallpaperUrl === null) return;
    requestImage(wallpaperUrl, applyWallpaperPalette);
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
      showHero(slug, index, url);
      startRotation();
      return;
    }
    if (currentSlug === slug) applyWallpaper();
  }

  return {
    currentLayerTransform: (): string => getComputedStyle(activeLayer).transform,

    setWallpaper(url: string): void {
      wallpaperUrl = url;
      wallpaperPalette = undefined;
      // Nothing on screen yet — and nothing asked for: paint it. This is also what covers a cold deep
      // link to a game — the wallpaper fills the wait, then cross-fades into the entry's own hero when
      // that arrives. A hero that got there first (or is already scheduled) is left alone.
      if (shownUrl === null && desiredUrl === null) applyWallpaper();
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

    setParallax(designPx: number): void {
      // On the pan wrapper, not on #hero: each layer's own transform is already spoken for by the bg-pan
      // animation, and one element can only transition its transform at one speed — see styles.css.
      heroPanEl.style.setProperty('--hero-parallax', `calc(${designPx} * var(--px))`);
    },

    setFlipping,
  };
}
