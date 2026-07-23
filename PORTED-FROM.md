# Ported from playhook

The site is the launcher's UI, rebuilt as a static page. Rather than depend on
[sevenns/playhook](https://github.com/sevenns/playhook) — which is `private: true`, unpublished, and
whose renderer is wired to `window.api` (preload IPC), `shared/types` and an i18n layer that do not
exist in a browser — the relevant files were **vendored**: copied, with the game logic cut out.

Source: **playhook 0.6.2**, commit `c348f4246752286b594c8a8eddd2253ea88b0f12`.

| Here | There | How faithful |
|---|---|---|
| `src/dom.ts` | `src/renderer/dom.ts` | 1:1 |
| `src/dominant-color.ts` | `src/renderer/dominant-color.ts` | 1:1 |
| `src/gamepad.ts` | `src/renderer/gamepad.ts` | 1:1 |
| `src/hero.ts` | `src/renderer/hero.ts` | rotation, palette cache and wallpaper fallback all ported; the HeroDeps seam (game state + translator) is gone, and every image is preloaded because it arrives over the network rather than as a data URL |
| `src/index.html` | `src/renderer/index.html` | trimmed: Play but no gear/loader, no info/confirm/error/power views, no `data-i18n`; CSP and copy retargeted; Github and Search added |
| `src/styles.css` | `src/renderer/styles.css` | trimmed + browser fixes, each marked `BROWSER:` in place; TextButton padding follows Figma (13) rather than the launcher (32) |
| `src/controls.ts` | `src/renderer/controls.ts` | rewritten by hand against it (994 lines → ~600); the game list moved to `src/game-list.ts` |
| `src/game-list.ts` | `src/renderer/controls.ts` (`buildSelectGameButtons` / marquee / scrollbar) | ported; thumb DRAG deliberately left behind |
| `src/audio.ts` | `src/renderer/audio.ts` | SFX written fresh; the music crossfade engine ported 1:1 minus the ambience source layer, plus an autoplay unlock the launcher does not need |
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
  anything. It plays the `play` sound and stops there.
- **The scrollbar thumb is an indicator, not a handle.** The launcher lets you drag it (pointer capture,
  ~35 lines in its `controls.ts`); here the list scrolls by wheel, keyboard and gamepad.
- **The current entry is not excluded from the list.** The launcher's picker is a switch between the
  games on one card; this is a catalogue you browse, and the mockups loop back through it.
