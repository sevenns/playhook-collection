# Ported from playhook

The site is the launcher's empty screen, rebuilt as a static page. Rather than depend on
[sevenns/playhook](https://github.com/sevenns/playhook) — which is `private: true`, unpublished, and
whose renderer is wired to `window.api` (preload IPC), `shared/types` and an i18n layer that do not
exist in a browser — the relevant files were **vendored**: copied, with the game logic cut out.

Source: **playhook 0.6.2**, commit `c348f4246752286b594c8a8eddd2253ea88b0f12`.

| Here | There | How faithful |
|---|---|---|
| `src/dom.ts` | `src/renderer/dom.ts` | 1:1 |
| `src/dominant-color.ts` | `src/renderer/dominant-color.ts` | 1:1 |
| `src/gamepad.ts` | `src/renderer/gamepad.ts` | 1:1 |
| `src/hero.ts` | `src/renderer/hero.ts` | trimmed to the empty screen: no per-card rotation, no palette cache, no deps seam |
| `src/index.html` | `src/renderer/index.html` | trimmed: no Play button, no info/confirm/error views, no `data-i18n`; CSP and copy retargeted |
| `src/styles.css` | `src/renderer/styles.css` | trimmed (~795 → ~390 lines) + browser fixes, each marked `BROWSER:` in place |
| `src/controls.ts` | `src/renderer/controls.ts` | rewritten by hand against it (994 → ~230 lines) |
| `src/audio.ts` | `src/renderer/audio.ts` | rewritten: SFX only, no music engine |
| `src/main.ts` | `src/renderer/app.ts` | only the wiring tail survives; every `window.api` subscription is gone |
| `src/router.ts` | — | new; the launcher has no routes |
| `public/wallpaper.*` | `assets/playhook-wallpaper.jpg` | recompressed (webp q90 + a jpg fallback) |
| `public/favicon.png` | `assets/icon.png` | 1:1 |
| `public/sfx/*.ogg` | `audio/ui/winhanced/*.wav` | re-encoded to Vorbis; `play.wav` not carried over (nothing triggers that slot here) |
| `public/fonts/*.woff2` | `src/renderer/fonts/*.ttf` | **not** the same files — Google Fonts' latin woff2 subsets (96 KB total vs 13.7 MB of CJK TTF) |
| `eslint.config.mjs`, `.prettierrc.json`, `tsconfig.json` | same names | copied; `types: ["node"]` and the `release/**` ignore dropped |

## Keeping up with drift

The launcher will keep evolving and this copy will not follow automatically. That is fine — this is a
showcase, not a second launcher, and a stale button radius harms nobody. When the two do need to be
reconciled, diff against the commit above and then update it here.

Every deliberate divergence in the CSS carries a `BROWSER:` comment explaining what the launcher does
and why a public web page cannot. The three in the TypeScript are documented at the top of
`src/controls.ts` (no idle timer, no Tab-as-back, DOM focus kept in sync with the custom highlight).
