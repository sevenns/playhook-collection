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
| `src/index-math.ts`, `src/entrance.ts`, `src/nav-surface.ts`, `src/hover-guard.ts` | same names | 1:1 |
| `src/screen-scroller.ts` | `src/renderer/screen-scroller.ts` | 1:1 minus its `pxUnit` (see `src/px-unit.ts` below) |
| `src/screen-sidebar.ts` | `src/renderer/screen-sidebar.ts` | 1:1 — the column of sections + actions both screens are built around |
| `src/system-cards.ts`, `src/system-card-icons.ts` | same names | the launcher carries four cards (Library / Notifications / Settings / System); the site carries the two it has something behind — see below |
| `src/library-grid.ts` | `src/renderer/library-grid.ts` | geometry and stepping 1:1; the SECTIONS are the site's own (see below) |
| `src/library-screen.ts` | `src/renderer/library-screen.ts` | ported; its artwork machinery is not (there a cover is a data URL main generates on first sight, so the screen needs a bounded cache with a request queue and an eviction callback — here a cover is a URL and the browser's cache is that cache). The row window, the FLIP re-flow, the section arrival, the focus body, the sidebar and the six primitives all come across |
| `src/settings-screen.ts` | `src/renderer/settings-screen.ts` | ported: the column, the pane, the preview debounce, the expanded dropdown with its marquee, the slider drag, the hover guard and the six primitives all come across. Its IPC seam does not — a change is applied to the audio controller and written to `localStorage` in the same breath (see `src/settings.ts`) |
| `src/settings-form-model.ts` | same name | every section and every row, in the launcher's order, with its labels and hints. Only the Audio rows are live — see below |
| `src/settings-form-view.ts` | `src/renderer/row-view-core.ts` + the Settings half of `settings-form-view.ts` | the row kinds this screen uses (toggle / select / slider / text / note / update-status), i18n resolved away. The launcher shares the core with its Customize screen; here the site's Customize has row kinds of its own (text and a file picker), so there is nothing to share |
| `src/settings.ts` | `src/main/app-settings.ts` + its IPC | the fields the page can act on, and `localStorage` in place of `settings.json`; `LAUNCHER_DEFAULTS` carries the rest as frozen values for the rows that only display them. `DEFAULT_SETTINGS` is the launcher's own |
| `public/ambience/*.ogg` | `audio/ambience/*.mp3` | all eleven of the launcher's 0.8.0 tracks, re-encoded to Vorbis: `ffmpeg -i <track>.mp3 -c:a libvorbis -q:a 4 <track>.ogg`. The extension is dropped from the stored name (the launcher keeps `playhook-abyss.mp3`, the site keeps `playhook-abyss`) |
| `src/osk.ts`, `src/osk-text.ts` | `src/renderer/osk.ts`, `src/renderer/osk-text.ts` | 1:1, with the launcher's English labels inlined where it reads its i18n layer, and the clipboard read through the browser rather than main |
| `src/game-settings-screen.ts` | `src/renderer/game-settings-screen.ts` | the column, the pane, the preview debounce, the entrance, the hover guard, the discard question and the six primitives. Its manifest machinery does not come across: there is no file to serialize, no validator in another process and no list/number editing surface, because every row that would need one is inert here |
| `src/game-settings-model.ts` | same name | every section and every row of the launcher's form, in its order, with its labels, hints, placeholders and its untouched defaults. Only five rows are live — see below |
| `src/row-view-core.ts` | same name | the row vocabulary both list screens share (toggle / select / slider / text / number / path / list / note), i18n resolved away, and the launcher's `disabled` renamed `inert` — same treatment, and the site says why |
| `src/sfx-limit.ts` | `src/renderer/sfx-limit.ts` | 1:1 (its docblock still says `HOLD_DELAY_MS` is 350 — it is 175; the comment is stale upstream and is copied as-is) |
| `src/px-unit.ts` | `src/renderer/screen-scroller.ts` (`pxUnit`) | rewritten: the launcher multiplies the vh number out of `--px`; this site's `--px` is a `min()` with a media override, which an unregistered custom property never resolves, so the unit is measured off a probe element instead |
| `src/carousel.ts` | `src/renderer/carousel.ts` | ported; the artwork cache and `artRev` are gone (a cover is a plain URL here and the browser's cache is the cache), the launcher's own system cards are not there yet (phase C), the dot's `.shows-dot`/`.is-busy` states are only entered for a running session, and a third screen value — `home`, the bare landing page — joins `carousel`/`detail`. The focus body, `MoveResult`, `setFlipping`, the `.is-beyond` window and the `data-returning` fan are all in |
| `src/hero.ts` | `src/renderer/hero.ts` | rotation, palette cache, wallpaper fallback, the `#hero-pan` parallax and the SWAP SCHEDULER (settle 120 ms, no fade over a fade still burning, `setFlipping` holds the picture) all ported; the HeroDeps seam is gone, and every image is preloaded before it is handed to the scheduler, because it arrives over the network rather than as a data URL |
| `src/index.html` | `src/renderer/index.html` | trimmed: Play but no gear/loader, no info/confirm/error/power views, no `data-i18n`; CSP and copy retargeted; Github added; the popup's two-layer veil and the strip's jelly canvas are in |
| `src/styles.css` | `src/renderer/styles.css` | trimmed + browser fixes, each marked `BROWSER:` in place; TextButton padding follows Figma (13) rather than the launcher (32) |
| `src/controls.ts` | `src/renderer/controls.ts` | rewritten by hand against it (2000-odd lines → ~1000), including the routing of the six nav primitives across strip / bar / popup stack, the keyboard's timer-driven repeat on the shared chain, the flip spell with its watchdog, and the `limit` latch |
| `src/audio.ts` | `src/renderer/audio.ts` | SFX written fresh (the `limit` latch is the launcher's); the music crossfade engine ported 1:1 minus the CARD source layer and the startup jingle, plus an autoplay unlock the launcher does not need. `setBrowseMusic(url, idle)`, the ambience channel, the "only global ambience" override and the two volumes are all the launcher's |
| `src/stats.ts` | `src/renderer/app.ts` (`buildInfoPanel`) + `src/renderer/format.ts` | the panel's SHAPE and its formatters; the numbers themselves are invented (see below) |
| `src/session.ts` | `src/main/` game controller + `src/renderer/state-view.ts` | only the SHAPE: the phase names, the status strings and the busy-visual mapping. Nothing is launched — see below |
| `src/main.ts` | `src/renderer/app.ts` | only the wiring tail survives; every `window.api` subscription is replaced by one fetch of the collection feed. The flip settle window (`FLIP_SETTLE_MS`) and the deferred title swap are its |
| `src/preload.ts` | — | new; the launcher's heroes are data URLs and never need preloading |
| `src/router.ts` | — | new; the launcher has no routes |
| `src/collection.ts` | — | new; the launcher has no feed to read (0.8.0 takes its metadata straight from the stores — see README) |
| `public/wallpaper.*` | `assets/playhook-wallpaper.jpg` | recompressed (webp q90 + a jpg fallback) |
| `public/favicon.png` | `assets/icon.png` | 1:1 |
| `public/sfx/<set>/*.ogg` | `audio/ui/<set>/*.wav` | all eighteen of the launcher's 0.8.0 sets, re-encoded to Vorbis: `ffmpeg -i <slot>.wav -c:a libvorbis -q:a 2 -ar 48000 <slot>.ogg` for the eight slots the site plays (`play`, `move`, `button`, `back`, `limit`, `popup-open`, `popup-close`, `typing`). `notify` is not shipped — nothing here notifies |
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
- **The boot screen is ported; its jingle is a maybe.** The wallpaper owns the screen for two seconds on
  its own drifting backdrop, the UI is revealed once the catalogue and the first background have landed
  (deadline 5 s), the backdrop converges on the hero underneath it as it dissolves, and the cards fan in
  afterwards so their entrance is actually seen. The launcher waits on three seeds — state, hero,
  library — and the feed answers for two of them here.

  The jingle is the one part a page cannot promise. **Audio may not play before the visitor has
  interacted with the document**, and a cold load has no such gesture, so the call is normally refused
  and the hold falls back to the page's own clock — which is precisely what the launcher does when its
  own jingle cannot play (`jingleStartedAt ?? bootStart`). A RELOAD often does sound it: Chromium
  remembers that an origin was allowed to make noise. Nothing waits on it either way, and the music gate
  that holds the ambience behind it is the launcher's.
- **Three of the launcher's four cards are here.** The row carries **Library**, **Settings** and
  **System**, in that order; only **Notifications** stays behind, because a showcase has nothing to
  notify about and an inbox that can only ever be empty is not worth a card. With the grid in place the
  strip's cap of nine (`MAX_STRIP_GAMES`) is applied as the launcher applies it: everything past the
  ninth entry is reached through the Library, which holds every one of them.
- **The System card shows no caption**, exactly as the launcher's mockup has it (`titleKey: null` there,
  `title: null` here) — both bar lines go blank while the row stands on it, which is what the launcher
  writes there too (`titleEl.textContent = ''` for exactly this card). An empty string, not the site's
  `null`: null is the router's "no card at all", and that puts the landing page's own two lines back.
- **Its stack is the launcher's, and every power action in it is inert.** Shutdown, Reboot, Sleep,
  Minimize Playhook, Close Playhook — the launcher's own five, in its order and with its wording, shown
  at the same dimmed opacity the inert form rows use. A web page cannot turn a machine off, restart it,
  put it to sleep, or minimise and quit an application that is a browser tab. They still take the focus,
  so they can be read, and answer A with the dead-end sound.
- **One item in that stack is the site's own: Github**, just above Close — the same place the menu's own
  Github sits. It is the nearest thing a showcase has to "the product itself", which is the question the
  launcher's power stack answers with Quit. Like the menu's, it is a real `<a>` navigating in the SAME
  tab: gamepad polling is not a user activation, so a scripted click on `target="_blank"` would be
  blocked as a popup.
- **The System stack closes rather than stepping back.** It is opened straight from a card, so there is
  no menu underneath it — the level above is the carousel. The launcher draws the same distinction with
  its `popupRoot === 'direct'`.
- **Settings is the launcher's screen WHOLE, and only Audio is live.** Every section, every row, in the
  launcher's order, with its labels, its hints and the values a freshly installed Playhook shows —
  Updates (status line, mode, pre-release), Language, General (all five toggles, the Steam Deck one
  included, which upstream is hidden off a Deck), Game metadata, Audio. This is a showcase: half a
  Settings screen shows half a launcher, so nothing is left out. What differs is that everything outside
  Audio is INERT — shown to be read, at the launcher's `disabled` opacity, answering A and left/right with
  the dead-end sound. Nothing here self-updates, the site has no i18n layer, and there is no card, no
  installer and no store lookup to configure. One row the launcher does not have says so, in its own
  `note` row kind, at the top of the first section.
- **The header's version is the launcher's release, not the site's.** The launcher prints its own
  `app.getVersion()` beside the title; the site prints the Playhook release this UI was copied from
  (`LAUNCHER_VERSION`), which is the same question that number answers there.
- **…and it keeps the live ones in `localStorage`.** The launcher persists to `settings.json` in its userData
  directory and pushes every change back over IPC; the page writes the same snapshot to first-party
  storage and hands it straight to the audio controller. Every access is wrapped: a browser in private
  mode throws on the property, not just on the call, and a settings screen is not worth a blank page. It
  is strictly functional storage — a preference the user set on this page, read by nobody else — which is
  why no consent question hangs off it.
- **The ambience is the launcher's, `idle` rule included.** Its engine resolves `browseMusic ?? cardMusic
  ?? ambient`; the site has no card, so it resolves two sources instead of three. What is ported verbatim
  is the DISTINCTION the launcher draws with `setBrowseMusic(url, idle)`: standing on a site card is not
  the same as an entry with no music of its own. Both end up on the ambience, but a plain `null` would
  fall through the chain rather than say so. On the site the landing page counts as `idle` too — it is
  the level above the strip, and the launcher has no such level to have an opinion about.
- **All eighteen sound sets and all eleven ambience tracks are bundled**, and the build enumerates them
  into `audio.json` rather than a hand-written list, so a set is added by dropping a folder in
  `public/sfx`. That mirrors the launcher's own `asset-reader`, which scans its `audio/` directory in main
  and pushes the answer to the renderer as `AudioOptions`. Only the chosen set and the chosen track are
  ever fetched; the rest are files on a CDN nobody asks for.
- **The Library's sections are the site's own.** The launcher splits its games four ways — everything,
  playable right now, on this PC, on a card. Two of those questions have no answer here: nothing is
  installed, so nothing is unavailable, and a section that can never differ from "All" says less than no
  section at all. What survives is the launcher's OTHER question, where a game comes from: **Collection**
  (published in this repository) and **Added here** (made in the browser, see below).
- **"Add game" is the launcher's Customize form WHOLE, and five rows of it are live.** Every section in
  its order — Basics, Launch, Artwork, Saves, Audio, Advanced, Linux — every row with its own label, hint
  and placeholder, and the values an untouched launcher form holds (its default launch mode is "Run from
  the card", so the Launch section shows that mode's rows). Same rule as the Settings screen: a showcase
  that shows half a form shows half a launcher. What can be TOUCHED is what a catalogue entry is made
  of — **Title**, **Id**, **Backgrounds**, **Card artwork**, **Background music**. The rest is inert: a
  page has no card to add to, no executable to point at, no installer to run, no save directory and no
  Proton prefix. The artwork rows draw the launcher's own thumbnails, in the artwork's own shape (16:9 for
  a background, 2:3 for the cover).
- **The files are the user's own, and they become blob URLs** — which is why the page's CSP admits
  `blob:` on `img-src` and `media-src`, and nothing from the network (a blob URL can only name something
  this document itself made). The entry is sorted into the catalogue by title like any other and is gone
  on the next reload, exactly as a removal is.
- **"Find online" is shown and inert, and the reason is the web's, not the launcher's.** Its providers —
  Steam, GOG, SteamGridDB, Khinsider — are queried from the launcher's MAIN process, where the browser's
  same-origin rule does not exist. None of them authorises a page to read their answers: Steam's
  storefront sends no `Access-Control-Allow-Origin` at all (the request goes out and is answered — the
  browser simply refuses to hand the body to the script), GOG's catalogue names `www.gog.com` and nobody
  else, and SteamGridDB wants a key, which a public page cannot hold without publishing it. Nothing on
  the site's side can lift that; only a server of its own could, and a static site has none. What DOES
  cross an origin is a picture — `<img>` has never obeyed CORS — but a gallery with no search behind it
  is not the launcher's feature, so the row says what it is instead of pretending.
- **Per-field errors, not a status line.** The launcher prints a validation problem inside the row it
  belongs to, because a thirty-field form makes a list at the bottom useless — it names fields the reader
  cannot point at. That is ported, marker bar included; the site's status line is left for the one
  message that has no row to sit in (the file dialog's gesture rule, below).
- **The file dialog is the browser's, and a gamepad cannot open it.** The launcher ships its own file
  browser because a native dialog cannot be driven with a pad over a fullscreen window. Here the native
  one is all there is, and the web attaches its own rule to it: a dialog opens only from a real user
  gesture, and a pad press is not one — the pad is polled on a frame loop and fires no DOM event at all.
  So the artwork rows answer the mouse and the keyboard, and tell a pad user so rather than doing nothing
  (`navigator.userActivation` in `game-settings-screen.ts`).
- **The on-screen keyboard is ported even though the web has a real one.** In the launcher it is the only
  way to type; here it is the GAMEPAD's way to type, and the site answers a gamepad everywhere else. A
  physical keyboard writes straight through it, exactly as it does there.
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
- **The carousel IS the top level, as in the launcher.** The site used to open on a landing page with the
  strip as a layer over it — one level more than the launcher has — and `#/` now shows the row itself.
  `#/collection` still means the same thing, so old links keep working. B on the strip sounds the dead
  end rather than uncovering a page underneath, which is the launcher's own behaviour.
- **Up and down cross the screen boundary, as in the launcher.** Down on the strip opens the selected
  entry (what A does); up on an entry screen comes back out to the row it was picked from. A site card is
  not opened this way — it is a surface rather than an entry, and brushing the stick downwards mid-flip
  is how you end up in a screen nobody asked for. Held presses are dropped on both, so pausing a flip on
  a card never walks out of it a moment later.
- **Play has no pulse ring.** It had one, echoing an earlier mockup; 0.8.0 dropped it, and Play now says
  it is focused the way every other control does — the `--d2` fill — with nothing on the bar animating on
  its own.
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
- **…and it is called what the launcher calls it.** "Remove from library" was held back while the site
  had no library to remove from; with the grid in place it names exactly the catalogue that grid shows.
  The QUESTION is still the site's own — the launcher promises the saves and the playtime survive and the
  card brings the game back, which is true of a record on disk; here the honest promise is the reload.
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
