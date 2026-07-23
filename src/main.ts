// Entry point. The counterpart of playhook's app.ts wiring section, minus everything it wires: there is
// no main process here, so all twenty-odd window.api subscriptions (state, hero payloads, audio assets,
// volumes, locale, window focus) are gone. What replaces them is one fetch of the site's own collection
// feed, and a single applyRoute() that hands the resulting entry to the three subsystems.
import { createAudioController } from './audio.js';
import { createControls } from './controls.js';
import { createHeroController } from './hero.js';
import { createRouter, type Route } from './router.js';
import { loadIndex, type CollectionEntry } from './collection.js';
import { type ListState } from './game-list.js';
import { preload } from './preload.js';

// webp with a jpg fallback, both same-origin. The palette is read back off this image through a canvas,
// which only works because it is same-origin and loaded without crossOrigin — an external URL would
// taint the canvas and getImageData would throw (dominant-color.ts swallows that and keeps the CSS
// fallbacks, so the failure would be silent).
const WALLPAPER_WEBP = './wallpaper.webp';
const WALLPAPER_JPEG = './wallpaper.jpg';

/** The status line on a game screen while the feed is still in flight or has failed outright. */
const FEED_ERROR_STATUS = 'Collection unavailable';

const audio = createAudioController();
const router = createRouter();
const hero = createHeroController();
const controls = createControls({ audio, router });

let feedState: ListState = 'loading';
let entries: readonly CollectionEntry[] = [];

// Everything the entry on screen owns: the bar copy, the hero images, the sounds and the music. Called on
// every route change AND again when the feed lands, because the two arrive in either order.
function applyRoute(route: Route): void {
  if (route.kind === 'home') {
    hero.showWallpaper();
    audio.setGameAssets(null);
    return;
  }
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
  router.setGameCopy(entry.title, entry.title);
  hero.showGame(entry.slug, entry.heroUrls);
  audio.setGameAssets({ sounds: entry.sounds, music: entry.music });
}

router.start((route, wantsCollection) => {
  controls.onRoute(route, wantsCollection);
  applyRoute(route);
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
    controls.setCollection('ready', loaded);
    applyRoute(router.current());
  },
  () => {
    feedState = 'error';
    entries = [];
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
