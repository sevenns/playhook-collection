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
| `src/session.ts` | `src/main/` game controller + `src/renderer/state-view.ts` | only the SHAPE: the phase names, the status strings and the busy-visual mapping. Nothing is launched — see below |
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
- **Play launches nothing — it starts a PRETEND session** (`src/session.ts`). There is no main process
  here, so the button walks the launcher's own phases on a timer instead of on real work:
  `Launching...` → `Running...` → (Force close) → `Force closing...` → `Saving progress...` → ready. The
  status strings, the phase names and the busy visuals are the launcher's; the durations are constants.
  A session survives moving around the site, as the launcher's survives flipping through the strip, but
  not a reload — there is nothing here to outlive the page. What the launcher does that this cannot: its
  Play during `running` returns you to the game, so here that press is a no-op. While a session holds it,
  every OTHER entry loses its Play entirely (`data-layout='no-play'`, and it leaves the focus ring with
  it) — the launcher says the same thing in its own terms: "you can browse game B while game A is busy,
  B is not actionable". It only un-focuses the button there and hides it for a history game; with no
  history/card split here, hiding it is the honest version.
  In the carousel Play has a second job, the same one as in the launcher: it is the selected card's
  invisible geometric stand-in for the morph.
- **A finished session is booked against the entry**, the way StatsService books a real one: +1 launch,
  + the seconds it ran, and Last played becomes now. On top of the invented baseline, in memory only.
- **The confirm view is the only one of the launcher's other three that is ported.** Force close asks
  first — same question, same wording, same safe default (No, the bottom button). The launcher's error
  and power views have nothing to describe here, and its confirm also carries an install-path note that
  a site which installs nothing does not need.
- **Remove from history lasts until a reload.** The launcher's item deletes a record it keeps on disk
  (`library/index.json` plus the artwork copied for that game) and offers itself only for a game that is
  not available right now — one whose card is out and which is not a local game. Here the catalogue IS the
  fetched feed, so the removal can only live in memory, and the question says so instead of the launcher's
  promise about saves and cards. Of its "not available right now" rule what survives is that a RUNNING
  entry cannot be removed: dropping the game you are playing would leave a session pointing at a card that
  no longer exists. The item follows the BROWSED entry, so it works on an entry screen and on the strip
  alike — the launcher's does the same, its browse model being what the bar describes there too.
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
- **The card dot carries only its second meaning.** In the launcher it marks a game that is on the
  inserted card, and pulses while that game is busy. There is no card here, so it marks the entry a
  session is running for — which is the launcher's other use for it: how "that one is still running"
  stays visible while you browse something else.
- **`artRev` is not ported.** The launcher re-decodes a cover when Configure rewrites it; here covers are
  URLs and the browser handles staleness.
- **Both bar lines follow the launcher, order included**: the status on top, the name dropping below it
  once there is a status to show (`#app[data-status='shown']`). The one place it costs something is the
  landing page, whose tagline therefore sits above "Playhook" — the price of a single rule on every
  screen. Outside a session there is no status at all: the entry's name is the whole bar copy.
- **Force close is bound to the entry it would close.** The launcher's `applyMenuKill` goes by state
  alone; it has one card and no per-entry screens to confuse (and clears the item on its empty screen
  separately). Here every entry has a screen of its own, so the item shows only on the running entry's —
  never on the landing page, never over a different entry, where it would read as closing THAT one.
- **The bar text is not cut on navigation.** The launcher adds `.is-swapping` while the browse answer is
  in flight; here the entry is already in hand and there is no stale-text window to cover.
- **Catalogue order is alphabetical by title**, fixed by the feed generator — not a play history.
- **Below 900px wide or 600px tall the carousel is NOT adapted.** The bar switches to flow layout there
  (`position: static`, no transforms), which leaves the morph nowhere to draw, and the strip's `x=50`
  anchor runs past the screen edge after a handful of covers. The site targets desktop from Full HD up;
  this is a known limitation, not a bug. The media block itself stays — it still serves the bar on the
  landing page and on an entry screen.
