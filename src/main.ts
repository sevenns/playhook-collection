// Entry point. The counterpart of playhook's app.ts wiring section, minus everything it wires: there is
// no main process here, so all twenty-odd window.api subscriptions (state, hero payloads, audio assets,
// volumes, locale, window focus) are gone. What replaces them is one fetch of the site's own collection
// feed, and a single applyRoute() that hands the resulting entry to the four subsystems.
import { AUTO_CHAIN_MS, NAV_REPEAT_MS } from './auto-repeat.js';
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

/**
 * How long after a release the run is still treated as GOING. Letting go for a beat and pressing again
 * is one continuous auto-move to the user (auto-repeat.ts chains the two), and everything that waits for
 * the flip to end is expensive: the hero swap is a cross-fade, the palette rides along with it, and the
 * carousel fetches the covers around wherever it stopped. Firing all of that into every gap of a rapid
 * press-release-press is exactly what made the background stutter.
 *
 * The window has to outlast the chain itself PLUS the first repeat of the new run — that is when the
 * flip is reported as started again — or a swap would slip through on the boundary.
 */
const FLIP_SETTLE_MS = AUTO_CHAIN_MS + NAV_REPEAT_MS;

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
// A direction is being held. While it is, the bar keeps the name it had rather than being rewritten on
// every step: at the repeat cadence that is a name flashing nine times a second next to a row that is
// still moving, and nobody can read it anyway — and the hero holds its picture the same way, so the two
// never disagree. The end of the run brings both in, for the card the row came to rest on.
let stripFlipping = false;
/** Whether a browse title arrived during the hold and is waiting for the run to end. */
let titleHeld = false;
/** Pending "the run is really over" (see FLIP_SETTLE_MS); 0 when the strip is at rest or flipping. */
let flipSettleTimer = 0;

/** The name the strip is standing on — written at once, or held until the flip settles (see above). */
function setBrowseTitle(title: string): void {
  if (stripFlipping) {
    titleHeld = true;
    return;
  }
  router.setBrowseCopy(title);
}

/** Everything the entry on screen owns: the bar copy, the hero images and the music. */
function applyEntry(entry: CollectionEntry, onCarousel: boolean): void {
  if (onCarousel) setBrowseTitle(entry.title);
  else router.setGameCopy(entry.title, entry.title);
  hero.showGame(entry.slug, entry.heroUrls);
  audio.setGameMusic(entry.music);
}

/** The hold is over: release what waited for it — the covers, the hero and the bar title. */
function settleFlip(): void {
  stripFlipping = false;
  // In PARALLEL, not in sequence: the covers, the picture and the name all belong to the same card, and
  // arriving one after another would read as the screen assembling itself.
  hero.setFlipping(false);
  carousel.setFlipping(false);
  if (!titleHeld) return;
  titleHeld = false;
  // Re-read rather than replayed: the route may have moved on during the hold (A opens an entry, whose
  // own screen writes its own copy), and only a strip still on screen has a name to put in the bar.
  const selected = carousel.screen() === 'carousel' ? carousel.selected() : undefined;
  if (selected !== undefined) router.setBrowseCopy(selected.title);
}

function onFlipping(flipping: boolean): void {
  if (flipping) {
    if (flipSettleTimer !== 0) {
      window.clearTimeout(flipSettleTimer);
      flipSettleTimer = 0;
    }
    stripFlipping = true;
    hero.setFlipping(true);
    carousel.setFlipping(true);
    return;
  }
  if (flipSettleTimer !== 0) return;
  flipSettleTimer = window.setTimeout(() => {
    flipSettleTimer = 0;
    settleFlip();
  }, FLIP_SETTLE_MS);
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

const controls = createControls({
  audio,
  router,
  carousel,
  session,
  browsedSlug: () => browsedSlug(),
  onForget: (slug) => forgetEntry(slug),
  onFlipping,
});

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

/**
 * "Remove from history" (the More menu): drops one entry from the catalogue for THIS page view. The
 * launcher deletes a record it keeps on disk and the game stays gone; the equivalent of that record here
 * is the fetched feed held in memory, so the removal lasts until a reload re-fetches it — which is what
 * the question promises, and why it is the one place the site cannot use the launcher's wording.
 *
 * Re-applying the route is what moves the screen, and it needs no special case for "was I on that
 * entry's own screen or on its card": the slug is now unknown to applyRoute, which answers by showing
 * the catalogue, while the strip has already clamped its selection onto a card that still exists.
 */
function forgetEntry(slug: string): void {
  const remaining = entries.filter((entry) => entry.slug !== slug);
  if (remaining.length === entries.length) return;
  entries = remaining;
  carousel.setEntries(entries);
  controls.setCollection('ready', entries);
  applyRoute(router.current());
  applySession();
}

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
