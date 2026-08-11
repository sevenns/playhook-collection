# Ported from playhook

The site is the launcher's UI, rebuilt as a static page. Rather than depend on
[sevenns/playhook](https://github.com/sevenns/playhook) — which is `private: true`, unpublished, and
whose renderer is wired to `window.api` (preload IPC), `shared/types` and an i18n layer that do not
exist in a browser — the relevant files were **vendored**: copied, with the game logic cut out.

Source: **playhook 0.7.0**, commit `4461c60e75e18d98d77e80e70b9394e0bd0731a5`.

| Here | There | How faithful |
|---|---|---|
| `src/dom.ts` | `src/renderer/dom.ts` | 1:1 |
| `src/dominant-color.ts` | `src/renderer/dominant-color.ts` | 1:1 |
| `src/gamepad.ts` | `src/renderer/gamepad.ts` | 1:1, hold-to-repeat on left/right included |
| `src/carousel-geometry.ts` | `src/renderer/carousel-geometry.ts` | 1:1 |
| `src/carousel.ts` | `src/renderer/carousel.ts` | ported; the artwork cache and `artRev` are gone (a cover is a plain URL here and the browser's cache is the cache), the dot's `.shows-dot`/`.is-busy` states are never entered, and a third screen value — `home`, the bare landing page — joins `carousel`/`detail` |
| `src/hero.ts` | `src/renderer/hero.ts` | rotation, palette cache, wallpaper fallback and the `#hero-pan` parallax all ported; the HeroDeps seam (game state + translator) is gone, and every image is preloaded because it arrives over the network rather than as a data URL |
| `src/index.html` | `src/renderer/index.html` | trimmed: Play but no gear/loader, no info/confirm/error/power views, no `data-i18n`; CSP and copy retargeted; Github added |
| `src/styles.css` | `src/renderer/styles.css` | trimmed + browser fixes, each marked `BROWSER:` in place; TextButton padding follows Figma (13) rather than the launcher (32) |
| `src/controls.ts` | `src/renderer/controls.ts` | rewritten by hand against it (1000-odd lines → ~570), including the routing of the six nav primitives across strip / bar / popup stack |
| `src/audio.ts` | `src/renderer/audio.ts` | SFX written fresh; the music crossfade engine ported 1:1 minus the ambience and browse source layers, plus an autoplay unlock the launcher does not need |
| `src/main.ts` | `src/renderer/app.ts` | only the wiring tail survives; every `window.api` subscription is replaced by one fetch of the collection feed |
| `src/preload.ts` | — | new; the launcher's heroes are data URLs and never need preloading |
| `src/router.ts` | — | new; the launcher has no routes |
| `src/collection.ts` | — | new; the launcher has no feed to read (yet — this is the address its Configure window will use) |
| `public/wallpaper.*` | `assets/playhook-wallpaper.jpg` | recompressed (webp q90 + a jpg fallback) |
| `public/favicon.png` | `assets/icon.png` | 1:1 |
| `public/sfx/*.ogg` | `audio/ui/winhanced/*.wav` | re-encoded to Vorbis, all four slots including `play` |
| `public/fonts/*.woff2` | `src/renderer/fonts/*.ttf` | **not** the same files — Google Fonts' latin woff2 subsets (96 KB total vs 13.7 MB of CJK TTF) |
| `eslint.config.mjs`, `.prettierrc.json`, `tsconfig.json` | same names | copied; `types: ["node"]` and the `release/**` ignore dropped |

## Keeping up with drift

The launcher will keep evolving and this copy will not follow automatically. That is fine — this is a
showcase, not a second launcher, and a stale button radius harms nobody. When the two do need to be
reconciled, diff against the commit above and then update it here.

Every deliberate divergence in the CSS carries a `BROWSER:` comment explaining what the launcher does
and why a public web page cannot.

## What the site does differently on purpose

- **Tab works.** DOM focus and the custom highlight are kept in sync in both directions, so a keyboard
  user who does not know about the arrow keys is not navigating blind. The launcher binds Tab to "back"
  and has no keyboard user to serve. Documented at the top of `src/controls.ts`.
- **The idle timeout dims the highlight but not `:focus-visible`.** After 5s the launcher's timeout is
  reproduced — cursor hidden, bar highlight dormant — but the browser's own focus ring stays, or a
  keyboard user would lose their place mid-read.
- **Play does nothing.** It is in the bar for the resemblance; there is no main process to launch
  anything. It plays the `play` sound and stops there. In the carousel it does have a second job, the
  same one as in the launcher: it is the selected card's invisible geometric stand-in for the morph.
- **The carousel lives OVER the landing page**, switched on by the Collection menu item (`#/collection`).
  In the launcher it is the top-level screen with the bar screen below it; here the landing page is the
  top level, so `data-screen` gains a third value that carries no attribute at all. It also means B on
  the strip is a real step back — in the launcher it does nothing there.
- **Collection stays a menu item.** It no longer opens a list, but removing it would leave the catalogue
  reachable only by typing `#/collection`: nothing else calls `setCollectionVisible(true)`.
- **`#more-button` is NOT hidden in the carousel.** The launcher hides it (`styles.css`) because More is
  one of several ways into its menus; here it is the only one, and hiding it would leave a mouse user
  with no menu at all. It simply cannot hold the bar highlight while the strip is up.
- **The card dot is ported in its "no dot" state.** `.card-dot` and its rules are here so a re-port shows
  no diff, but `.shows-dot` / `.is-busy` mean "on the inserted card" and "installing", and a showcase has
  neither.
- **`artRev` is not ported.** The launcher re-decodes a cover when Configure rewrites it; here covers are
  URLs and the browser handles staleness.
- **The title/status swap is unconditional**, on every screen including the landing page. The launcher
  keys it on `#app[data-status='shown']`, which here would mean introducing a "the status is empty" state
  — and it already exists, on every cold load of an entry while the feed is in flight, so the heading
  would hop each time. The visible cost is that the tagline sits ABOVE the product name on the landing
  page. Accepted deliberately.
- **The bar text is not cut on navigation.** The launcher adds `.is-swapping` while the browse answer is
  in flight; here the entry is already in hand and there is no stale-text window to cover.
- **Catalogue order is alphabetical by title**, fixed by the feed generator — not a play history.
- **Below 900px wide or 600px tall the carousel is NOT adapted.** The bar switches to flow layout there
  (`position: static`, no transforms), which leaves the morph nowhere to draw, and the strip's `x=50`
  anchor runs past the screen edge after a handful of covers. The site targets desktop from Full HD up;
  this is a known limitation, not a bug. The media block itself stays — it still serves the bar on the
  landing page and on an entry screen.
