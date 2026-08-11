// Entry point. The counterpart of playhook's app.ts wiring section, minus everything it wires: there is
// no main process here, so all twenty-odd window.api subscriptions (state, hero payloads, audio assets,
// volumes, locale, window focus) are gone. What replaces them is one fetch of the site's own collection
// feed, and a single applyRoute() that hands the resulting entry to the four subsystems.
import { createAudioController } from './audio.js';
import { createCarousel } from './carousel.js';
import { createControls } from './controls.js';
import { createHeroController } from './hero.js';
import { createRouter, type Route } from './router.js';
import { loadIndex, type CollectionEntry, type ListState } from './collection.js';
import { busyKindOf, createSessionController, statusOf } from './session.js';
import { preload } from './preload.js';
import { req } from './dom.js';

// webp with a jpg fallback, both same-origin. The palette is read back off this image through a canvas,
// which only works because it is same-origin and loaded without crossOrigin — an external URL would
// taint the canvas and getImageData would throw (dominant-color.ts swallows that and keeps the CSS
// fallbacks, so the failure would be silent).
const WALLPAPER_WEBP = './wallpaper.webp';
const WALLPAPER_JPEG = './wallpaper.jpg';

/** The status line while the feed is still in flight or has failed outright. */
const FEED_ERROR_STATUS = 'Collection unavailable';

// Background parallax while flipping through the strip: design px per card, and the cap the total drift
// never exceeds. The budget is what the hero's Ken Burns pan leaves over: at its minimum scale (1.06)
// there are ~58 design px of overscan per side, and the pan itself already spends up to 1.5% (~29 px) of
// it — so the parallax may claim at most the remaining ~29, or a corner of the wallpaper shows through.
const HERO_PARALLAX_STEP = 8;
const HERO_PARALLAX_MAX = 24;

const app = req('app');
const audio = createAudioController();
const router = createRouter();
const hero = createHeroController();
const session = createSessionController();

let feedState: ListState = 'loading';
let entries: readonly CollectionEntry[] = [];
/** Whether the hash asks for the carousel (`#/collection`). Mirrored from the router's own callback. */
let wantsCollection = false;
let heroParallax = 0;

/** Everything the entry on screen owns: the bar copy, the hero images and the music. */
function applyEntry(entry: CollectionEntry, onCarousel: boolean): void {
  if (onCarousel) router.setBrowseCopy(entry.title);
  else router.setGameCopy(entry.title, entry.title);
  hero.showGame(entry.slug, entry.heroUrls);
  audio.setGameMusic(entry.music);
}

/** Nothing (or nothing yet) on screen: back to the wallpaper and silence. */
function applyNothing(): void {
  hero.showWallpaper();
  audio.setGameMusic(null);
}

const carousel = createCarousel({
  // The selection moved: the bar copy, the background and the music follow it, exactly as they follow
  // the launcher's browse channel — except that here the entry is already in hand, with no round trip
  // to debounce around.
  onBrowse: (entry) => {
    applyEntry(entry, true);
    // The strip moved onto a different card: the session line follows what is browsed, not the screen.
    applySession();
  },
  onScreenChange: () => {
    controls.onScreen();
    applySession();
  },
  onActivate: (entry) => {
    // Entering a card is an ordinary button press — same cue as any other "open" action.
    audio.play('button');
    router.go({ kind: 'game', slug: entry.slug });
  },
  onNavigate: (delta) => {
    audio.play('navigate');
    // Parallax: the background drifts the same way the strip does, one notch per card, bounded so it
    // stays inside the pan's own headroom (see #hero-pan). Moving back unwinds it.
    heroParallax = Math.max(
      -HERO_PARALLAX_MAX,
      Math.min(HERO_PARALLAX_MAX, heroParallax - delta * HERO_PARALLAX_STEP),
    );
    hero.setParallax(heroParallax);
  },
});

const controls = createControls({ audio, router, carousel, session });

/** Which entry the bar is describing right now: its own screen, or the card the strip is standing on. */
function browsedSlug(): string | null {
  const route = router.current();
  if (route.kind === 'game') return route.slug;
  if (carousel.screen() === 'carousel') return carousel.selected()?.slug ?? null;
  return null;
}

/**
 * What a session in flight shows. The status belongs to the ENTRY, not to a screen, so it follows that
 * entry wherever it is on screen — its own screen AND its card in the carousel — and goes blank the
 * moment you look at a different one. That is the launcher's rule verbatim (`statusText` in its app.ts):
 * "Running..." under another game's cover would be a lie, and there the pulsing dot says it instead.
 */
function applySession(): void {
  const active = session.current();
  const onScreen = active !== null && active.slug === browsedSlug();
  if (active !== null && onScreen) app.dataset['busy'] = busyKindOf(active.phase);
  else delete app.dataset['busy'];
  router.setSessionStatus(active !== null && onScreen ? statusOf(active.phase) : '');
  carousel.setBusyEntry(active?.slug ?? null);
  controls.onSession();
}

session.subscribe(applySession);

// Called on every route change AND again when the feed lands, because the two arrive in either order.
function applyRoute(route: Route): void {
  if (route.kind === 'game') {
    carousel.setScreen('detail');
    // So that stepping back lands on the card you came from — and, on a cold deep link, on the right one.
    carousel.focusEntry(route.slug);
    if (feedState === 'loading') {
      // The wallpaper stays up and the status line stays empty: there is nothing truthful to put there yet.
      router.setGameCopy('', null);
      return;
    }
    if (feedState === 'error') {
      router.setGameCopy(FEED_ERROR_STATUS, null);
      return;
    }
    const entry = entries.find((candidate) => candidate.slug === route.slug);
    if (entry === undefined) {
      // A slug nobody publishes: show the catalogue rather than an empty screen that explains nothing.
      router.showCollection();
      return;
    }
    applyEntry(entry, false);
    return;
  }

  if (!wantsCollection) {
    carousel.setScreen('home');
    router.setBrowseCopy(null);
    heroParallax = 0;
    hero.setParallax(0);
    applyNothing();
    return;
  }

  carousel.setScreen('carousel');
  const selected = carousel.screen() === 'carousel' ? carousel.selected() : undefined;
  if (selected === undefined) {
    // Refused: fewer than two entries to flip through — the feed is still in flight, or it failed. The
    // landing page stays as it is; an outright failure at least says so where the entry name would be.
    router.setBrowseCopy(feedState === 'error' ? FEED_ERROR_STATUS : null);
    applyNothing();
    return;
  }
  applyEntry(selected, true);
}

router.start((route, collection) => {
  wantsCollection = collection;
  controls.onRoute();
  applyRoute(route);
  // A route change moves the session's status with it: onto the screen it belongs to, or off the bar.
  applySession();
});
controls.start();

// Music is gated on the tab being visible — a page playing a soundtrack in a background tab is exactly
// the behaviour that gets tabs muted.
function syncMusicGate(): void {
  audio.setMusicPlaying(document.visibilityState === 'visible');
}
document.addEventListener('visibilitychange', syncMusicGate);
syncMusicGate();

void loadIndex().then(
  (loaded) => {
    feedState = 'ready';
    entries = loaded;
    carousel.setEntries(loaded);
    controls.setCollection('ready', loaded);
    applyRoute(router.current());
  },
  () => {
    feedState = 'error';
    entries = [];
    carousel.setEntries([]);
    controls.setCollection('error', []);
    applyRoute(router.current());
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
  .then((url) => hero.setWallpaper(url))
  .catch(() => undefined);
