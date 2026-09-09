// Entry point. The counterpart of playhook's app.ts wiring section, minus everything it wires: there is
// no main process here, so all twenty-odd window.api subscriptions (state, hero payloads, audio assets,
// volumes, locale, window focus) are gone. What replaces them is one fetch of the site's own collection
// feed, and a single applyRoute() that hands the resulting entry to the four subsystems.
import { AUTO_CHAIN_MS, NAV_REPEAT_MS } from './auto-repeat.js';
import { ambientUrl, createAudioController } from './audio.js';
import { createCarousel } from './carousel.js';
import { createControls } from './controls.js';
import { createGameSettingsScreen, type GameDraft } from './game-settings-screen.js';
import { createHeroController } from './hero.js';
import { createLibraryScreen } from './library-screen.js';
import { createOsk } from './osk.js';
import { createRouter, type Route } from './router.js';
import { createSettingsScreen } from './settings-screen.js';
import { createSettingsStore, loadAudioOptions, type SiteSettings } from './settings.js';
import { loadIndex, type CollectionEntry, type ListState } from './collection.js';
import { busyKindOf, createSessionController, statusOf } from './session.js';
import { preload } from './preload.js';
import { req } from './dom.js';

// webp with a jpg fallback, both same-origin. The palette is read back off this image through a canvas,
// which only works because it is same-origin and loaded without crossOrigin — an external URL would
// taint the canvas and getImageData would throw (dominant-color.ts swallows that and keeps the CSS
// fallbacks, so the failure would be silent).
const WALLPAPER_WEBP = './wallpaper.webp';
const WALLPAPER_JPEG = './wallpaper.jpg';

/** The status line while the feed is still in flight or has failed outright. */
const FEED_ERROR_STATUS = 'Collection unavailable';

// Background parallax while flipping through the strip: design px per card, and the cap the total drift
// never exceeds. The budget is what the hero's Ken Burns pan leaves over: at its minimum scale (1.06)
// there are ~58 design px of overscan per side, and the pan itself already spends up to 1.5% (~29 px) of
// it — so the parallax may claim at most the remaining ~29, or a corner of the wallpaper shows through.
const HERO_PARALLAX_STEP = 8;
const HERO_PARALLAX_MAX = 24;

/**
 * How long after a release the run is still treated as GOING. Letting go for a beat and pressing again
 * is one continuous auto-move to the user (auto-repeat.ts chains the two), and everything that waits for
 * the flip to end is expensive: the hero swap is a cross-fade, the palette rides along with it, and the
 * carousel fetches the covers around wherever it stopped. Firing all of that into every gap of a rapid
 * press-release-press is exactly what made the background stutter.
 *
 * The window has to outlast the chain itself PLUS the first repeat of the new run — that is when the
 * flip is reported as started again — or a swap would slip through on the boundary.
 */
const FLIP_SETTLE_MS = AUTO_CHAIN_MS + NAV_REPEAT_MS;

const app = req('app');
const audio = createAudioController();
const settingsStore = createSettingsStore();
const router = createRouter();
const hero = createHeroController();
const session = createSessionController();

let feedState: ListState = 'loading';
let entries: readonly CollectionEntry[] = [];
let heroParallax = 0;
// A direction is being held. While it is, the bar keeps the name it had rather than being rewritten on
// every step: at the repeat cadence that is a name flashing nine times a second next to a row that is
// still moving, and nobody can read it anyway — and the hero holds its picture the same way, so the two
// never disagree. The end of the run brings both in, for the card the row came to rest on.
let stripFlipping = false;
/** Whether a browse title arrived during the hold and is waiting for the run to end. */
let titleHeld = false;
/** Pending "the run is really over" (see FLIP_SETTLE_MS); 0 when the strip is at rest or flipping. */
let flipSettleTimer = 0;

/** The name the strip is standing on — written at once, or held until the flip settles (see above). */
function setBrowseTitle(title: string): void {
  if (stripFlipping) {
    titleHeld = true;
    return;
  }
  router.setBrowseCopy(title);
}

/** Everything the entry on screen owns: the bar copy, the hero images and the music. */
function applyEntry(entry: CollectionEntry, onCarousel: boolean): void {
  if (onCarousel) setBrowseTitle(entry.title);
  else router.setGameCopy(entry.title, entry.title);
  hero.showGame(entry.slug, entry.heroUrls);
  // Not `idle`: there IS an entry on screen. One with no music of its own falls through to the ambience
  // by itself — see the source chain in audio.ts.
  audio.setBrowseMusic(entry.music, false);
}

/** The hold is over: release what waited for it — the covers, the hero and the bar title. */
function settleFlip(): void {
  stripFlipping = false;
  // In PARALLEL, not in sequence: the covers, the picture and the name all belong to the same card, and
  // arriving one after another would read as the screen assembling itself.
  hero.setFlipping(false);
  carousel.setFlipping(false);
  if (!titleHeld) return;
  titleHeld = false;
  // Re-read rather than replayed: the route may have moved on during the hold (A opens an entry, whose
  // own screen writes its own copy), and only a strip still on screen has a name to put in the bar. A
  // site card names itself there exactly as an entry does.
  const selected = carousel.screen() === 'carousel' ? carousel.selected() : undefined;
  if (selected === undefined) return;
  router.setBrowseCopy(
    selected.kind === 'game' ? selected.entry.title : (selected.card.title ?? ''),
  );
}

function onFlipping(flipping: boolean): void {
  if (flipping) {
    if (flipSettleTimer !== 0) {
      window.clearTimeout(flipSettleTimer);
      flipSettleTimer = 0;
    }
    stripFlipping = true;
    hero.setFlipping(true);
    carousel.setFlipping(true);
    return;
  }
  if (flipSettleTimer !== 0) return;
  flipSettleTimer = window.setTimeout(() => {
    flipSettleTimer = 0;
    settleFlip();
  }, FLIP_SETTLE_MS);
}

/**
 * Nothing (or nothing yet) on screen: back to the wallpaper, and to the ambience. `idle` is the
 * launcher's own word for it — the row is standing on a site card, or the landing page is up, and what
 * the page sounds like then is the ambience chosen in Settings (silence, if that is "No ambience").
 */
function applyNothing(): void {
  hero.showWallpaper();
  audio.setBrowseMusic(null, true);
}

/**
 * Where the screen ABOVE the carousel goes back to. An entry screen can be reached from the strip or
 * from the Library, and "back" has to mean the place it was actually entered from — the launcher's own
 * `returnTo`.
 */
type ReturnTo = 'carousel' | 'library';
let returnTo: ReturnTo = 'carousel';

/** Today, as the feed spells a date — what an entry made in the browser is stamped with. */
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Puts one entry into the catalogue for THIS page view: the mirror of forgetEntry, and the whole of what
 * "Add game" writes. Sorted in by title like the rest, because that is the order the feed publishes and
 * the order both the strip and the grid read.
 */
function addEntry(draft: GameDraft): void {
  const entry: CollectionEntry = {
    slug: draft.slug,
    title: draft.title,
    origin: 'added',
    updatedAt: today(),
    // Neither has anything to point at: this entry exists only in this tab. The Github item knows it
    // (see applyGithubHref in controls.ts) and links at the launcher's repository instead.
    sourcePath: '',
    manifestUrl: '',
    heroUrls: draft.heroUrls,
    ...(draft.gridUrl !== null ? { gridUrl: draft.gridUrl } : {}),
    music: draft.music,
  };
  entries = [...entries, entry].sort((a, b) =>
    a.title.toLowerCase().localeCompare(b.title.toLowerCase(), 'en'),
  );
  carousel.setEntries(entries);
  libraryScreen.setEntries(entries);
  controls.setCollection('ready', entries);
  showAddedEntry(entry.slug);
}

/**
 * An entry was just added: put the user in front of it — in the LIBRARY, standing on it. The strip is a
 * shortlist (MAX_STRIP_GAMES) ordered by title, so a new entry may have no card there at all; the grid
 * holds every entry by construction, so it can always show the one that was just made.
 */
function showAddedEntry(slug: string): void {
  returnTo = 'carousel';
  libraryScreen.open({ focusSlug: slug });
}

/** Brings the Library back up if that is where the entry screen was entered from. Consumes the flag. */
function restoreOrigin(): void {
  if (returnTo !== 'library') return;
  returnTo = 'carousel';
  libraryScreen.restore();
  // …and undo what opening the entry did to everything AROUND the screen. The entry screen took the
  // hero, the palette and the music with it; the Library is a site surface and belongs over the site's
  // own. The strip goes back to the card the screen was opened from — the only way in.
  carousel.focusSystem('library');
  applyNothing();
}

/**
 * Opens one entry's screen. Reached from three places: a card in the strip, the Library's grid, and a
 * deep link — which is what `origin` records, so B and the browser's Back come back to the right one.
 */
function openEntry(slug: string, origin: ReturnTo = 'carousel'): void {
  returnTo = origin;
  if (origin === 'library') libraryScreen.close(true);
  router.go({ kind: 'game', slug });
}

// ── The Library screen (a full-screen surface, see library-screen.ts) ───────
// It owns its grid, its sections and its focus; everything it reaches back for is here. Read lazily
// where it points at `controls`, which is created below — the two point at each other.
// The on-screen keyboard: the gamepad's only way to type (osk.ts). It is built before the screen that
// uses it, and lives outside every screen — see the note on #osk in index.html.
const osk = createOsk({
  audio,
  // BROWSER: the launcher reads the clipboard through main; here the browser may simply refuse (no
  // permission, an insecure origin), and a Paste that answers with nothing is better than a rejection
  // nobody catches.
  readClipboard: () => navigator.clipboard.readText().catch(() => ''),
});

// ── Customize, in add mode (see game-settings-screen.ts) ────────────────────
const gameSettingsScreen = createGameSettingsScreen({
  audio,
  keyboard: osk,
  slugTaken: (slug) => entries.some((entry) => entry.slug === slug),
  onAdd: (draft) => addEntry(draft),
  onClosed: () => {
    controls.screenClosed();
    // Cancelled out of "Add game" — back to the Library it was started from. On a successful add this
    // still runs first (the screen closes before it reports the new entry), and showAddedEntry undoes it.
    libraryScreen.restore();
  },
  confirmDiscard: (onYes) => controls.confirmDiscard(onYes),
});

// ── Settings (see settings-screen.ts) ──────────────────────────────────────
// The store is the source of truth: every change goes through it, is persisted, and comes back out as one
// snapshot that the audio controller, the wake lock and the screen all read. That is the launcher's own
// shape — main owns settings.json and pushes `settings:update` — with localStorage standing in for the
// file and a callback for the IPC.
const settingsScreen = createSettingsScreen({
  audio,
  getSettings: () => settingsStore.read(),
  onChange: (change) => settingsStore.patch(change),
  onClosed: () => controls.screenClosed(),
  onResetRequested: () => controls.confirmReset(() => settingsStore.reset()),
});

/** Applies one settings snapshot to everything that acts on it. */
function applySettings(settings: SiteSettings): void {
  audio.setSounds(settings.soundSet);
  audio.setSfxVolume(settings.sfxVolume);
  audio.setMusicVolume(settings.musicVolume);
  audio.setAmbient(ambientUrl(settings.ambientTrack));
  audio.setOnlyGlobalAmbient(settings.onlyGlobalAmbient);
  settingsScreen.applySettings(settings);
}

settingsStore.subscribe(applySettings);

const libraryScreen = createLibraryScreen({
  audio,
  getEntries: () => entries,
  onOpenEntry: (slug) => openEntry(slug, 'library'),
  onAddGame: () => controls.openAddGame(),
  onClosed: () => {
    controls.screenClosed();
    // Opening the screen told the page that nothing is on screen (its card is a site card). Closing it
    // hands the carousel back, so the bar has to hear what the row is standing on.
    carousel.announce();
  },
});

const carousel = createCarousel({
  // The selection moved: the bar copy, the background and the music follow it, exactly as they follow
  // the launcher's browse channel — except that here the entry is already in hand, with no round trip
  // to debounce around.
  onBrowse: (entry) => {
    applyEntry(entry, true);
    // The strip moved onto a different card: the session line follows what is browsed, not the screen.
    applySession();
  },
  onScreenChange: () => {
    controls.onScreen();
    applySession();
  },
  onBrowseNone: (card) => {
    // A site card is selected: there is no entry on screen at all. It names itself in the bar, exactly
    // where an entry's name goes, and the background falls back to the site's own wallpaper.
    // An EMPTY string, not null: null is the router's "no card at all", which puts the landing page's
    // own two lines back in the bar. The System card has no caption in the launcher's mockup either —
    // there it writes '' into the title for exactly this card — so both lines go blank instead.
    setBrowseTitle(card.title ?? '');
    applyNothing();
    applySession();
  },
  onActivate: (item) => {
    // Entering a card is an ordinary button press — same cue as any other "open" action, and a site card
    // is no different (the surface it opens then plays its own sound on top).
    audio.play('button');
    if (item.kind === 'game') openEntry(item.entry.slug);
    else controls.openSystemCard(item.card.id);
  },
  onNavigate: (delta) => {
    audio.play('navigate');
    // Parallax: the background drifts the same way the strip does, one notch per card, bounded so it
    // stays inside the pan's own headroom (see #hero-pan). Moving back unwinds it.
    heroParallax = Math.max(
      -HERO_PARALLAX_MAX,
      Math.min(HERO_PARALLAX_MAX, heroParallax - delta * HERO_PARALLAX_STEP),
    );
    hero.setParallax(heroParallax);
  },
});

const controls = createControls({
  audio,
  router,
  carousel,
  library: libraryScreen,
  gameSettings: gameSettingsScreen,
  settings: settingsScreen,
  session,
  browsedSlug: () => browsedSlug(),
  onForget: (slug) => forgetEntry(slug),
  onFlipping,
});

/** Which entry the bar is describing right now: its own screen, or the card the strip is standing on. */
function browsedSlug(): string | null {
  const route = router.current();
  if (route.kind === 'game') return route.slug;
  if (carousel.screen() === 'carousel') return carousel.selectedEntry()?.slug ?? null;
  return null;
}

/**
 * What a session in flight shows. The status belongs to the ENTRY, not to a screen, so it follows that
 * entry wherever it is on screen — its own screen AND its card in the carousel — and goes blank the
 * moment you look at a different one. That is the launcher's rule verbatim (`statusText` in its app.ts):
 * "Running..." under another game's cover would be a lie, and there the pulsing dot says it instead.
 */
function applySession(): void {
  const active = session.current();
  const onScreen = active !== null && active.slug === browsedSlug();
  if (active !== null && onScreen) app.dataset['busy'] = busyKindOf(active.phase);
  else delete app.dataset['busy'];
  router.setSessionStatus(active !== null && onScreen ? statusOf(active.phase) : '');
  carousel.setBusyEntry(active?.slug ?? null);
  libraryScreen.setBusyEntry(active?.slug ?? null);
  controls.onSession();
}

session.subscribe(applySession);

/**
 * "Remove from library" (the More menu): drops one entry from the catalogue for THIS page view. The
 * launcher deletes a record it keeps on disk and the game stays gone; the equivalent of that record here
 * is the fetched feed held in memory, so the removal lasts until a reload re-fetches it — which is what
 * the question promises, and why it is the one place the site cannot use the launcher's wording.
 *
 * Re-applying the route is what moves the screen, and it needs no special case for "was I on that
 * entry's own screen or on its card": the slug is now unknown to applyRoute, which answers by showing
 * the catalogue, while the strip has already clamped its selection onto a card that still exists.
 */
function forgetEntry(slug: string): void {
  const remaining = entries.filter((entry) => entry.slug !== slug);
  if (remaining.length === entries.length) return;
  entries = remaining;
  carousel.setEntries(entries);
  libraryScreen.setEntries(entries);
  controls.setCollection('ready', entries);
  applyRoute(router.current());
  applySession();
}

// Called on every route change AND again when the feed lands, because the two arrive in either order.
function applyRoute(route: Route): void {
  if (route.kind === 'game') {
    carousel.setScreen('detail');
    // So that stepping back lands on the card you came from — and, on a cold deep link, on the right one.
    carousel.focusEntry(route.slug);
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
    // The row is a SHORTLIST (MAX_STRIP_GAMES), so an entry opened from the Library — or deep-linked
    // past the cap — may have no card in it, and the morph would then wear whichever card happens to be
    // selected, i.e. another entry's cover. Name the source explicitly in that case.
    const onStrip = carousel.selected();
    if (!(onStrip?.kind === 'game' && onStrip.entry.slug === entry.slug)) {
      carousel.setDetailArt(libraryScreen.coverFor(entry.slug));
    }
    applyEntry(entry, false);
    return;
  }

  // Leaving an entry screen: the Library comes back if that is where the entry was opened from.
  restoreOrigin();

  carousel.setScreen('carousel');
  const selected = carousel.screen() === 'carousel' ? carousel.selected() : undefined;
  if (selected !== undefined && selected.kind === 'system') {
    // The row is standing on a site card: it names itself and the wallpaper stays up (the System card
    // names nothing — see setBrowseTitle's caller in onBrowseNone).
    setBrowseTitle(selected.card.title ?? '');
    applyNothing();
    return;
  }
  const entry = selected?.kind === 'game' ? selected.entry : undefined;
  if (entry === undefined) {
    // Refused: fewer than two entries to flip through — the feed is still in flight, or it failed. The
    // landing page stays as it is; an outright failure at least says so where the entry name would be.
    router.setBrowseCopy(feedState === 'error' ? FEED_ERROR_STATUS : null);
    applyNothing();
    return;
  }
  applyEntry(entry, true);
}

// The stored settings are applied before anything else runs: the sound set decides which files the SFX
// elements load, and a press that arrives before that would sound in the default set.
applySettings(settingsStore.read());

// The bundled sets and tracks the build enumerated. Only the dropdowns need them — the sound set and the
// ambience are already playing off the stored names — so a failure costs two lists, not the page.
void loadAudioOptions().then(
  (options) => settingsScreen.applyAudioOptions(options),
  () => undefined,
);

router.start((route) => {
  controls.onRoute();
  applyRoute(route);
  // A route change moves the session's status with it: onto the screen it belongs to, or off the bar.
  applySession();
});
controls.start();

// Music is gated on the tab being visible — a page playing a soundtrack in a background tab is exactly
// the behaviour that gets tabs muted.
function syncMusicGate(): void {
  audio.setMusicPlaying(document.visibilityState === 'visible');
}
document.addEventListener('visibilitychange', syncMusicGate);
syncMusicGate();

// ── Boot ───────────────────────────────────────────────────────────────────
// Ported from playhook @ c26fae7 (app.ts). The page opens on the wallpaper alone and reveals its UI once
// two seeds are in — the catalogue, and a background that has settled — and never before BOOT_MIN_MS, so
// the reveal reads as an intro rather than as a stutter. The deadline covers a seed that never arrives.
//
// The launcher counts three seeds (state, hero, library); here the feed answers for two of them.

/**
 * How long the wallpaper owns the screen. It is also the length of the startup jingle's FIRST half,
 * which is why the countdown runs from the moment that sound starts rather than from page load — the
 * swell belongs to the backdrop, the tail plays over the UI arriving.
 */
const BOOT_MIN_MS = 2000;
/** The backstop: a seed that never lands must not hold the UI hidden forever. */
const BOOT_DEADLINE_MS = 5000;
/** Matches the backdrop's fade in styles.css (#hero-boot.is-gone). */
const BOOT_FADE_MS = 1000;
const STARTUP_SOUND = './startup.ogg';

const bootBackdrop = req('hero-boot');
const bootStart = performance.now();
let bootFeedReady = false;
let bootHeroReady = false;
let bootRevealed = false;
let revealTimer = 0;
/** When the jingle actually began; null until it does — or forever, when the browser refuses it. */
let jingleStartedAt: number | null = null;

/**
 * Hands the screen over to the hero underneath: the backdrop fades out and, over the same beat, travels
 * to where that hero layer currently sits. Converging rather than parting matters because the two are
 * usually the SAME image — with no entry on screen the background IS this wallpaper — and any offset
 * left between them shows up as a double image sliding apart. Then it leaves the page: it has nothing
 * left to show, and a full-screen composited layer is not free.
 */
function dissolveBootBackdrop(): void {
  const settled = hero.currentLayerTransform();
  // 'none' means there is no image under it at all — then there is nothing to converge on, and pulling
  // the backdrop back to the identity transform would be the very lurch this arrangement avoids.
  if (settled !== 'none') bootBackdrop.style.transform = settled;
  bootBackdrop.classList.add('is-gone');
  window.setTimeout(() => {
    bootBackdrop.hidden = true;
  }, BOOT_FADE_MS);
}

function revealUi(): void {
  if (bootRevealed) return;
  bootRevealed = true;
  delete app.dataset['boot'];
  dissolveBootBackdrop();
  // The cards were held at zero behind the boot screen — let them fan in now, so the row's own entrance
  // is actually seen instead of having happened under the wallpaper.
  carousel.playIntro();
}

/**
 * When the boot image's turn is up: BOOT_MIN_MS after the jingle started, or — when there is no jingle
 * at all — after the page itself opened. Letting the hold slide with the sound is what keeps the swell
 * and the picture in step.
 */
function bootHoldEndsAt(): number {
  return (jingleStartedAt ?? bootStart) + BOOT_MIN_MS;
}

/** Arms (or re-arms) the reveal for the end of the hold. No-op until every seed is in. */
function scheduleReveal(): void {
  if (bootRevealed || !bootFeedReady || !bootHeroReady) return;
  if (revealTimer !== 0) window.clearTimeout(revealTimer);
  revealTimer = window.setTimeout(revealUi, Math.max(0, bootHoldEndsAt() - performance.now()));
}

window.setTimeout(revealUi, BOOT_DEADLINE_MS);

/**
 * The startup jingle.
 *
 * BROWSER: this is the one part of the launcher's boot a page cannot promise. Audio may not play before
 * the visitor has interacted with the document, and a cold load has no such gesture — so the call is
 * usually refused and the hold falls back to the page's own clock, which is exactly what the launcher
 * does when its own jingle cannot play. A RELOAD often does sound: Chromium remembers that this origin
 * was allowed to make noise. Nothing else waits on it either way.
 */
void audio.playStartup(STARTUP_SOUND).then((played) => {
  if (!played || bootRevealed) return;
  jingleStartedAt = performance.now();
  scheduleReveal();
});

/**
 * The backdrop's own push: wider and faster than the hero's perpetual pan, and it never unwinds — the
 * layer dissolves mid-travel instead. Two frames of delay because a transition needs its starting value
 * painted first. The direction is randomized, like the hero layers' pan, so the page does not always
 * open drifting the same way.
 */
function startBootPan(url: string): void {
  bootBackdrop.style.backgroundImage = `url("${url}")`;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (bootRevealed) return;
      bootBackdrop.style.setProperty('--boot-pan', Math.random() < 0.5 ? '4.5%' : '-4.5%');
      bootBackdrop.classList.add('is-panning');
    });
  });
}

void loadIndex().then(
  (loaded) => {
    feedState = 'ready';
    entries = loaded;
    carousel.setEntries(loaded);
    libraryScreen.setEntries(loaded);
    controls.setCollection('ready', loaded);
    applyRoute(router.current());
    bootFeedReady = true;
    scheduleReveal();
  },
  () => {
    feedState = 'error';
    entries = [];
    carousel.setEntries([]);
    libraryScreen.setEntries([]);
    controls.setCollection('error', []);
    applyRoute(router.current());
    // A failed feed is an answer too: the row still has its site cards, and holding the UI back would
    // leave the reader staring at a wallpaper that never resolves.
    bootFeedReady = true;
    scheduleReveal();
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
  .then((url) => {
    hero.setWallpaper(url);
    // The same image the hero is painting, on the layer above it — so the two converge rather than
    // cross-fade when the backdrop dissolves.
    startBootPan(url);
  })
  .catch(() => undefined)
  .finally(() => {
    bootHeroReady = true;
    scheduleReveal();
  });
