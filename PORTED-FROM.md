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
| `src/stats.ts` | `src/renderer/app.ts` (`buildInfoPanel`) + `src/renderer/format.ts` | the panel's SHAPE and its formatters; the numbers themselves are invented (see below) |
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
- **The play statistics are made up.** Last played / Playtime / Launches come from StatsService in the
  launcher, which counts real sessions on the user's machine; a showcase has none to count. The three
  figures are derived from the entry's slug (`src/stats.ts`), so a card always shows the same numbers
  rather than re-rolling under the reader, and the date is an offset back from today so the demo does not
  age. They are there to show what the launcher's panel looks like — nobody's playtime is being reported.
- **Play does nothing.** It is in the bar for the resemblance; there is no main process to launch
  anything. It plays the `play` sound and stops there. In the carousel it does have a second job, the
  same one as in the launcher: it is the selected card's invisible geometric stand-in for the morph.
- **The carousel lives OVER the landing page**, switched on by the Collection menu item (`#/collection`).
  In the launcher it is the top-level screen with the bar screen below it; here the landing page is the
  top level, so `data-screen` gains a third value that carries no attribute at all. It also means B on
  the strip is a real step back — in the launcher it does nothing there.
- **Library is the only door to the carousel**, in and out — the launcher's item only leads back, because
  there the strip is where you start. There is no separate Collection item; `#/collection` is still the
  hash, written with replaceState from the landing page and pushed when leaving an entry.
- **The bar keeps a vertical gradient below 900px/600px.** The launcher's radial "pool" is measured
  against a 400-tall bar; in the mobile flow layout the box is only as tall as its copy, so most of the
  fill would land outside it and leave the text on bare hero. The launcher has no such layout.
- **The card dot is ported in its "no dot" state.** `.card-dot` and its rules are here so a re-port shows
  no diff, but `.shows-dot` / `.is-busy` mean "on the inserted card" and "installing", and a showcase has
  neither.
- **`artRev` is not ported.** The launcher re-decodes a cover when Configure rewrites it; here covers are
  URLs and the browser handles staleness.
- **Both bar lines are always on screen, and the NAME is the upper one.** The launcher shows the status
  only when there is one (`#app[data-status='shown']`) and drops the name below it, because its status
  reports transient work over a name that is always there. Here the second line is a constant caption
  ("Playhook - Collection") and the state would be "the feed has not landed yet" — which happens on every
  cold load, so the heading would hop each time. Written unconditionally instead, name on top.
- **The bar text is not cut on navigation.** The launcher adds `.is-swapping` while the browse answer is
  in flight; here the entry is already in hand and there is no stale-text window to cover.
- **Catalogue order is alphabetical by title**, fixed by the feed generator — not a play history.
- **Below 900px wide or 600px tall the carousel is NOT adapted.** The bar switches to flow layout there
  (`position: static`, no transforms), which leaves the morph nowhere to draw, and the strip's `x=50`
  anchor runs past the screen edge after a handful of covers. The site targets desktop from Full HD up;
  this is a known limitation, not a bug. The media block itself stays — it still serves the bar on the
  landing page and on an entry screen.
