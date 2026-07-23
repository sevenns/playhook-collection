// Image preloading, split out of main.ts because hero.ts needs it too and main.ts already imports
// hero.ts — importing it back would close a cycle.
//
// The launcher never needs this: its heroes are data URLs handed over by the main process, always
// instantly decodable. Here every image is a network fetch, and hero.ts starts its cross-fade the moment
// it is called — so without waiting first, the fade plays over an empty layer and the picture snaps in
// afterwards.

/**
 * Resolves with `url` once the image is usable, rejects when it cannot be loaded at all.
 *
 * Two signals, first one wins, and the order matters: `decode()` is the better one — it resolves only
 * once the frame is actually paintable — but in a HIDDEN document Chromium defers rasterization, so it
 * stays pending indefinitely. A tab opened in the background (⌘-click, a restored session) would then
 * never get a hero at all. `load` always fires, so it is the floor; decode() just tightens the timing
 * whenever the page is visible. A decode() rejection is ignored on purpose — `error` is what decides
 * that this URL is a dead end.
 */
export function preload(url: string): Promise<string> {
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
