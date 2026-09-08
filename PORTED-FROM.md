# Ported from playhook

The site is the launcher's UI, rebuilt as a static page. Rather than depend on
[sevenns/playhook](https://github.com/sevenns/playhook) — which is `private: true`, unpublished, and
whose renderer is wired to `window.api` (preload IPC), `shared/types` and an i18n layer that do not
exist in a browser — the relevant files were **vendored**: copied, with the game logic cut out.

Source: **playhook 0.8.0**, commit `c26fae7` on `release/v0.8.0` (its PR was still open when this was
written; re-check against the merged HEAD or the `v0.8.0` tag before relying on the hash).

| Here | There | How faithful |
|---|---|---|
| `src/dom.ts` | `src/renderer/dom.ts` | 1:1 (`reqCanvas` included) |
| `src/dominant-color.ts` | `src/renderer/dominant-color.ts` | 1:1 |
| `src/auto-repeat.ts` | `src/renderer/auto-repeat.ts` | 1:1 — the hold tempo (175 / 110 / 200 ms) and the chain both input models share |
| `src/gamepad.ts` | `src/renderer/gamepad.ts` | 1:1: hold-to-repeat on all four directions, the stick's settle guard, `onDirectionsReleased`. Y, X, the shoulders and RT stay in the contract; on the site they are dead ends (the `limit` sound), since there is no keyboard or file picker for them to drive |
| `src/carousel-geometry.ts` | `src/renderer/carousel-geometry.ts` | 1:1 — the 8/24 gaps, `stripCanvas`, the window of nine (`VISIBLE_CARDS`), `MAX_STRIP_GAMES` (exported, not applied — see below) |
| `src/focus-jelly.ts` | `src/renderer/focus-jelly.ts` | 1:1 |
| `src/sfx-limit.ts` | `src/renderer/sfx-limit.ts` | 1:1 (its docblock still says `HOLD_DELAY_MS` is 350 — it is 175; the comment is stale upstream and is copied as-is) |
| `src/px-unit.ts` | `src/renderer/screen-scroller.ts` (`pxUnit`) | rewritten: the launcher multiplies the vh number out of `--px`; this site's `--px` is a `min()` with a media override, which an unregistered custom property never resolves, so the unit is measured off a probe element instead |
| `src/carousel.ts` | `src/renderer/carousel.ts` | ported; the artwork cache and `artRev` are gone (a cover is a plain URL here and the browser's cache is the cache), the launcher's own system cards are not there yet (phase C), the dot's `.shows-dot`/`.is-busy` states are only entered for a running session, and a third screen value — `home`, the bare landing page — joins `carousel`/`detail`. The focus body, `MoveResult`, `setFlipping`, the `.is-beyond` window and the `data-returning` fan are all in |
| `src/hero.ts` | `src/renderer/hero.ts` | rotation, palette cache, wallpaper fallback, the `#hero-pan` parallax and the SWAP SCHEDULER (settle 120 ms, no fade over a fade still burning, `setFlipping` holds the picture) all ported; the HeroDeps seam is gone, and every image is preloaded before it is handed to the scheduler, because it arrives over the network rather than as a data URL |
| `src/index.html` | `src/renderer/index.html` | trimmed: Play but no gear/loader, no info/confirm/error/power views, no `data-i18n`; CSP and copy retargeted; Github added; the popup's two-layer veil and the strip's jelly canvas are in |
| `src/styles.css` | `src/renderer/styles.css` | trimmed + browser fixes, each marked `BROWSER:` in place; TextButton padding follows Figma (13) rather than the launcher (32) |
| `src/controls.ts` | `src/renderer/controls.ts` | rewritten by hand against it (2000-odd lines → ~1000), including the routing of the six nav primitives across strip / bar / popup stack, the keyboard's timer-driven repeat on the shared chain, the flip spell with its watchdog, and the `limit` latch |
| `src/audio.ts` | `src/renderer/audio.ts` | SFX written fresh (the `limit` latch is the launcher's); the music crossfade engine ported 1:1 minus the ambience and browse source layers and the startup jingle, plus an autoplay unlock the launcher does not need |
| `src/stats.ts` | `src/renderer/app.ts` (`buildInfoPanel`) + `src/renderer/format.ts` | the panel's SHAPE and its formatters; the numbers themselves are invented (see below) |
| `src/session.ts` | `src/main/` game controller + `src/renderer/state-view.ts` | only the SHAPE: the phase names, the status strings and the busy-visual mapping. Nothing is launched — see below |
| `src/main.ts` | `src/renderer/app.ts` | only the wiring tail survives; every `window.api` subscription is replaced by one fetch of the collection feed. The flip settle window (`FLIP_SETTLE_MS`) and the deferred title swap are its |
| `src/preload.ts` | — | new; the launcher's heroes are data URLs and never need preloading |
| `src/router.ts` | — | new; the launcher has no routes |
| `src/collection.ts` | — | new; the launcher has no feed to read (0.8.0 takes its metadata straight from the stores — see README) |
| `public/wallpaper.*` | `assets/playhook-wallpaper.jpg` | recompressed (webp q90 + a jpg fallback) |
| `public/favicon.png` | `assets/icon.png` | 1:1 |
| `public/sfx/*.ogg` | `audio/ui/playhook-abyss/*.wav` | the launcher's 0.8.0 default set, re-encoded to Vorbis: `ffmpeg -i <slot>.wav -c:a libvorbis -q:a 2 -ar 48000 <slot>.ogg` for the seven slots the site plays (`play`, `move`, `button`, `back`, `limit`, `popup-open`, `popup-close`). `typing` and `notify` are not shipped — nothing here types or notifies |
| `public/fonts/*.woff2` | `src/renderer/fonts/*.ttf` | **not** the same files — Google Fonts' latin woff2 subsets (96 KB total vs 13.7 MB of CJK TTF); the four `.`/`…` overrides that hand those two glyphs to the fallback font are copied |
| `eslint.config.mjs`, `.prettierrc.json`, `tsconfig.json` | same names | copied; `types: ["node"]` and the `release/**` ignore dropped, the `test/**` block skipped (there are no tests here) |

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
  reproduced — mouse asleep, bar highlight dormant — but the browser's own focus ring stays, or a
  keyboard user would lose their place mid-read.
- **The mouse sleeps, but wakes on the first real move.** The class is the launcher's (`mouse-asleep`,
  which every `:hover` is gated on, so nothing stays lit under a parked cursor once the pad or the arrow
  keys take over), and it is set the same way: the idle timeout, and any gamepad/keyboard navigation.
  What is not ported is the launcher's `mouse-sleep.ts`: there the mouse opens asleep and only a
  deliberate shove (300 px of travel) wakes it, and every pointer gesture is swallowed until then. On a
  landing page that is dead hovers for the visitor who came with a mouse, so here one genuine `mousemove`
  is enough (synthetic ones — Chromium re-firing at the same coordinates when an element shifts under a
  still pointer — are still filtered).
- **No boot screen, no startup jingle.** The launcher holds its wallpaper for two seconds, plays a jingle
  and reveals the UI after both (deadline 5 s). On a web page that reads as "the page is hanging", and
  the jingle would fall to the autoplay policy until the first gesture anyway. Declined, not deferred —
  which is also why the site's music engine keeps its own gate rather than the launcher's `applyPlayback`
  (that one exists to hold the music behind the jingle).
- **No notifications, no Settings / Power cards, no Library grid (yet).** Nothing on a showcase can
  notify, there are no settings to open and no machine to power down. The Library screen — the grid of
  every game, which is what the word means in 0.8.0 — is a separate phase; until it exists the strip's
  cap of nine games (`MAX_STRIP_GAMES`) is deliberately NOT applied, because the games past it would have
  nowhere else to be reached from. The window of nine visible cards (`VISIBLE_CARDS`) IS applied: it only
  fades the far cards, it hides nothing.
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
- **The confirm view is the only one of the launcher's other views that is ported.** Force close asks
  first — same question, same wording, same safe default (No, the bottom button). The launcher's error,
  busy and power views have nothing to describe here, and its confirm also carries an install-path note
  that a site which installs nothing does not need.
- **The carousel lives OVER the landing page**, switched on by the Collection menu item (`#/collection`).
  In the launcher it is the top-level screen with the bar screen below it; here the landing page is the
  top level, so `data-screen` gains a third value that carries no attribute at all. It also means B on
  the strip is a real step back — in the launcher it does nothing there (it sounds the dead end).
- **One menu item is the door to the carousel, in and out — and it is called two things.** On an entry
  screen it is the launcher's own **Go back** (`launcher.menu.goBack`, the mouse counterpart of B). On
  the landing page the launcher has no such item — its strip IS the top level — so the site names the
  destination instead: **Collection**, which is the hash it writes (replaceState from the landing page,
  pushed when leaving an entry). **Library** is kept back for the grid screen.
- **Remove from history lasts until a reload.** The launcher's item deletes a record it keeps on disk
  (`library/index.json` plus the artwork copied for that game) and offers itself only for a game that is
  not available right now — one whose card is out and which is not a local game. Here the catalogue IS the
  fetched feed, so the removal can only live in memory, and the question says so instead of the launcher's
  promise about saves and cards. Of its "not available right now" rule what survives is that a RUNNING
  entry cannot be removed: dropping the game you are playing would leave a session pointing at a card that
  no longer exists. The item follows the BROWSED entry, so it works on an entry screen and on the strip
  alike — the launcher's does the same, its browse model being what the bar describes there too.
- **…and it keeps that name, not the launcher's "Remove from library".** Without a Library screen the
  0.8.0 wording would be wrong twice over: there is no library, and the removal lives in memory until the
  page is reloaded. Renaming it belongs with the grid.
- **Customize is not in the menu.** It is the launcher's per-game form over a file on a card; a feed
  entry has no file to edit.
- **The bar keeps a vertical gradient below 900px/600px.** The launcher's radial "pool" is measured
  against a 400-tall bar; in the mobile flow layout the box is only as tall as its copy, so most of the
  fill would land outside it and leave the text on bare hero. The launcher has no such layout.
- **The card dot carries only its second meaning.** In the launcher it marks a game that is on the
  inserted card, and pulses while that game is busy. There is no card here, so it marks the entry a
  session is running for — which is the launcher's other use for it: how "that one is still running"
  stays visible while you browse something else.
- **`artRev` is not ported.** The launcher re-decodes a cover when Customize rewrites it; here covers are
  URLs and the browser handles staleness.
- **Both bar lines follow the launcher, order included**: the status on top, the name dropping below it
  once there is a status to show (`#app[data-status='shown']`). The one place it costs something is the
  landing page, whose tagline therefore sits above "Playhook" — the price of a single rule on every
  screen. Outside a session there is no status at all: the entry's name is the whole bar copy.
- **Force close is bound to the entry it would close.** The launcher's `applyMenuKill` goes by state
  alone; it has one card and no per-entry screens to confuse (and clears the item on its empty screen
  separately). Here every entry has a screen of its own, so the item shows only on the running entry's —
  never on the landing page, never over a different entry, where it would read as closing THAT one.
- **The bar text is not cut on navigation, but it is HELD while a direction is held.** The launcher adds
  `.is-swapping` on every step because its browse answer is debounced and the old name would otherwise
  sit next to the new card; here the entry is already in hand and there is no stale-text window to
  cover. What the site does take from 0.8.0 is the hold: while left/right is down the name stays where
  it is (`main.ts`, the same `FLIP_SETTLE_MS` window the launcher uses) and lands together with the hero
  once the run ends, so the picture and the name never disagree mid-flip.
- **The hero waits for the network, then for the launcher's rules.** The launcher's swap scheduler
  (settle, fade gate, hold) is ported as-is; what sits in front of it is the site's preload, because a
  fade over a layer whose image has not arrived would show a second of flat `--bg`.
- **The design pixel is measured, not read.** `focus-jelly.ts` draws in real px and asks for `--px`;
  the launcher parses the vh number out of the custom property, which this site's `min()` expression
  does not allow (see `src/px-unit.ts`).
- **Catalogue order is alphabetical by title**, fixed by the feed generator — not a play history.
- **Below 900px wide or 600px tall the carousel is NOT adapted.** The bar switches to flow layout there
  (`position: static`, no transforms), which leaves the morph nowhere to draw, and the strip's `x=50`
  anchor runs past the screen edge after a handful of covers. The site targets desktop from Full HD up;
  this is a known limitation, not a bug. The media block itself stays — it still serves the bar on the
  landing page and on an entry screen.
