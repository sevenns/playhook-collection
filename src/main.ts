// Entry point. The counterpart of playhook's app.ts wiring section, minus everything it wires: there is
// no main process here, so all twenty-odd window.api subscriptions (state, hero payloads, audio assets,
// volumes, locale, window focus) are gone. What is left is the three subsystems and the route.
import { createAudioController } from './audio.js';
import { createControls } from './controls.js';
import { createHeroController } from './hero.js';
import { createRouter } from './router.js';

// webp with a jpg fallback, both same-origin. The palette is read back off this image through a canvas,
// which only works because it is same-origin and loaded without crossOrigin — an external URL would
// taint the canvas and getImageData would throw (dominant-color.ts swallows that and keeps the CSS
// fallbacks, so the failure would be silent).
const WALLPAPER_WEBP = './wallpaper.webp';
const WALLPAPER_JPEG = './wallpaper.jpg';

const audio = createAudioController();
const router = createRouter();
const hero = createHeroController();
const controls = createControls({ audio, router });

router.start(() => controls.refresh());
controls.start();

// showImage() cross-fades the moment it is called, so it wants an image that is already there — in the
// launcher that is a data URL, always instant. Here it is a network fetch: fading a still-empty layer
// would show a second of flat --bg and then snap the wallpaper in. So wait for the image first (the
// <link rel=preload> in index.html means it is usually already in flight). If webp is unsupported the
// same wait runs again against the jpg; if that fails too the page simply keeps its background color.
//
// Two signals, first one wins, and the order matters: `decode()` is the better one — it resolves only
// once the frame is actually paintable — but in a HIDDEN document Chromium defers rasterization, so it
// stays pending indefinitely. A tab opened in the background (⌘-click, a restored session) would then
// never get a hero at all. `load` always fires, so it is the floor; decode() just tightens the timing
// whenever the page is visible. A decode() rejection is ignored on purpose — `error` is what decides
// that this URL is a dead end and the jpg fallback should be tried.
function preload(url: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(url));
    image.addEventListener('error', () => reject(new Error(`failed to load ${url}`)));
    image.src = url;
    void image.decode().then(
      () => resolve(url),
      () => undefined,
    );
  });
}

void preload(WALLPAPER_WEBP)
  .catch(() => preload(WALLPAPER_JPEG))
  .then((url) => hero.show(url))
  .catch(() => undefined);
