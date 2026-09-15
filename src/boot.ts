// The boot sequence. Ported from playhook @ c26fae7 (app.ts). The page opens on the wallpaper alone and
// reveals its UI once two seeds are in — the catalogue, and a background that has settled — and never
// before BOOT_MIN_MS, so the reveal reads as an intro rather than as a stutter. The deadline covers a seed
// that never arrives.
//
// The launcher counts three seeds (state, hero, library); here the feed answers for two of them. This is
// the whole of what happens between page load and the UI being shown; the wiring of the subsystems to
// each other lives in main.ts, which calls boot() last.
import { type AudioController } from './audio.js';
import { type Carousel } from './carousel.js';
import { loadIndex, type CollectionEntry, type ListState } from './collection.js';
import { req } from './dom.js';
import { type HeroController } from './hero.js';
import { preload } from './preload.js';

// webp with a jpg fallback, both same-origin. The palette is read back off this image through a canvas,
// which only works because it is same-origin and loaded without crossOrigin — an external URL would
// taint the canvas and getImageData would throw (dominant-color.ts swallows that and keeps the CSS
// fallbacks, so the failure would be silent).
const WALLPAPER_WEBP = './wallpaper.webp';
const WALLPAPER_JPEG = './wallpaper.jpg';

/**
 * How long the wallpaper owns the screen. It is also the length of the startup jingle's FIRST half,
 * which is why the countdown runs from the moment that sound starts rather than from page load — the
 * swell belongs to the backdrop, the tail plays over the UI arriving.
 */
const BOOT_MIN_MS = 2000;
/** The backstop: a seed that never lands must not hold the UI hidden forever. */
const BOOT_DEADLINE_MS = 5000;
/** Matches the backdrop's fade in styles.css (#hero-boot.is-gone). */
const BOOT_FADE_MS = 1000;
const STARTUP_SOUND = './startup.ogg';

export interface BootDeps {
  readonly app: HTMLElement;
  readonly hero: Pick<HeroController, 'setWallpaper' | 'currentLayerTransform'>;
  readonly audio: Pick<AudioController, 'playStartup'>;
  readonly carousel: Pick<Carousel, 'playIntro'>;
  /**
   * The feed answered — with its entries, or with none and the state that says why. Called before the
   * feed seed is counted, so whatever it puts on screen is what the reveal uncovers.
   */
  readonly onFeed: (state: ListState, entries: readonly CollectionEntry[]) => void;
}

/** Starts the countdown, the jingle, the wallpaper and the feed; reveals the UI when they are in. */
export function boot({ app, hero, audio, carousel, onFeed }: BootDeps): void {
  const bootBackdrop = req('hero-boot');
  const bootStart = performance.now();
  let bootFeedReady = false;
  let bootHeroReady = false;
  let bootRevealed = false;
  let revealTimer = 0;
  /** When the jingle actually began; null until it does — or forever, when the browser refuses it. */
  let jingleStartedAt: number | null = null;

  /**
   * Hands the screen over to the hero underneath: the backdrop fades out and, over the same beat, travels
   * to where that hero layer currently sits. Converging rather than parting matters because the two are
   * usually the SAME image — with no entry on screen the background IS this wallpaper — and any offset
   * left between them shows up as a double image sliding apart. Then it leaves the page: it has nothing
   * left to show, and a full-screen composited layer is not free.
   */
  function dissolveBootBackdrop(): void {
    const settled = hero.currentLayerTransform();
    // 'none' means there is no image under it at all — then there is nothing to converge on, and pulling
    // the backdrop back to the identity transform would be the very lurch this arrangement avoids.
    if (settled !== 'none') bootBackdrop.style.transform = settled;
    bootBackdrop.classList.add('is-gone');
    window.setTimeout(() => {
      bootBackdrop.hidden = true;
    }, BOOT_FADE_MS);
  }

  function revealUi(): void {
    if (bootRevealed) return;
    bootRevealed = true;
    delete app.dataset['boot'];
    dissolveBootBackdrop();
    // The cards were held at zero behind the boot screen — let them fan in now, so the row's own entrance
    // is actually seen instead of having happened under the wallpaper.
    carousel.playIntro();
  }

  /**
   * When the boot image's turn is up: BOOT_MIN_MS after the jingle started, or — when there is no jingle
   * at all — after the page itself opened. Letting the hold slide with the sound is what keeps the swell
   * and the picture in step.
   */
  function bootHoldEndsAt(): number {
    return (jingleStartedAt ?? bootStart) + BOOT_MIN_MS;
  }

  /** Arms (or re-arms) the reveal for the end of the hold. No-op until every seed is in. */
  function scheduleReveal(): void {
    if (bootRevealed || !bootFeedReady || !bootHeroReady) return;
    if (revealTimer !== 0) window.clearTimeout(revealTimer);
    revealTimer = window.setTimeout(revealUi, Math.max(0, bootHoldEndsAt() - performance.now()));
  }

  window.setTimeout(revealUi, BOOT_DEADLINE_MS);

  /**
   * The startup jingle.
   *
   * BROWSER: this is the one part of the launcher's boot a page cannot promise. Audio may not play before
   * the visitor has interacted with the document, and a cold load has no such gesture — so the call is
   * usually refused and the hold falls back to the page's own clock, which is exactly what the launcher
   * does when its own jingle cannot play. A RELOAD often does sound: Chromium remembers that this origin
   * was allowed to make noise. Nothing else waits on it either way.
   */
  void audio.playStartup(STARTUP_SOUND).then((played) => {
    if (!played || bootRevealed) return;
    jingleStartedAt = performance.now();
    scheduleReveal();
  });

  /**
   * The backdrop's own push: wider and faster than the hero's perpetual pan, and it never unwinds — the
   * layer dissolves mid-travel instead. Two frames of delay because a transition needs its starting value
   * painted first. The direction is randomized, like the hero layers' pan, so the page does not always
   * open drifting the same way.
   */
  function startBootPan(url: string): void {
    bootBackdrop.style.backgroundImage = `url("${url}")`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (bootRevealed) return;
        bootBackdrop.style.setProperty('--boot-pan', Math.random() < 0.5 ? '4.5%' : '-4.5%');
        bootBackdrop.classList.add('is-panning');
      });
    });
  }

  void loadIndex().then(
    (loaded) => {
      onFeed('ready', loaded);
      bootFeedReady = true;
      scheduleReveal();
    },
    () => {
      onFeed('error', []);
      // A failed feed is an answer too: the row still has its site cards, and holding the UI back would
      // leave the reader staring at a wallpaper that never resolves.
      bootFeedReady = true;
      scheduleReveal();
    },
  );

  // hero.showImage() cross-fades the moment it is called, so it wants an image that is already there. Here
  // that is a network fetch: fading a still-empty layer would show a second of flat --bg and then snap the
  // wallpaper in. So wait for the image first (the <link rel=preload> in index.html means it is usually
  // already in flight). If webp is unsupported the same wait runs again against the jpg; if that fails too
  // the page simply keeps its background color. setWallpaper paints it if nothing else has yet — which is
  // also what fills a cold deep link to a game while its own heroes load.
  void preload(WALLPAPER_WEBP)
    .catch(() => preload(WALLPAPER_JPEG))
    .then((url) => {
      hero.setWallpaper(url);
      // The same image the hero is painting, on the layer above it — so the two converge rather than
      // cross-fade when the backdrop dissolves.
      startBootPan(url);
    })
    .catch(() => undefined)
    .finally(() => {
      bootHeroReady = true;
      scheduleReveal();
    });
}
