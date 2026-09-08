// The collection carousel, ported from playhook @ c26fae7 (release/v0.8.0) :
// src/renderer/carousel.ts — a strip of covers sliding under a fixed anchor while the selection stays
// put. In the launcher it is the top-level SCREEN, above the bar screen of whichever game is selected;
// here it is a layer over the landing page, switched on by the `#/collection` deep link (the Collection
// menu item writes it). Picking a card navigates to that entry — the site's own `detail`.
//
// The row holds two kinds of card, as the launcher's does: the catalogue's entries first, then the site's
// own cards at the tail (system-cards.ts — the launcher has four, the site has Library). Pressing A on an
// entry opens its screen; pressing A on a site card opens that surface instead, and the screen level does
// not change.
//
// What the launcher's version owns and this one does not: the artwork cache and `artRev`. There a cover
// is a data URL decoded by the main process and cached by id+revision; here it is an ordinary URL and the
// browser's cache is the cache. The lazy window (isNearViewport) survives — a long catalogue still must
// not pull every cover at once.
//
// Owns only the strip: the cards' DOM, the selection, and the `data-screen` / `data-card-morph`
// attributes. What is SHOWN for the selected entry (bar copy, hero, music) is main's answer to
// `onBrowse` — this module never derives it. The geometry lives in carousel-geometry.ts (pure).
import { type CollectionEntry } from './collection.js';
import {
  MAX_STRIP_GAMES,
  RETURN_FAN_MS,
  RETURN_LOCK_MS,
  clampIndex,
  fanIndex,
  isNearViewport,
  isWithinWindow,
  stripCanvas,
  stripOffset,
} from './carousel-geometry.js';
import { SYSTEM_CARDS, type SystemCard } from './system-cards.js';
import { systemCardIcon } from './system-card-icons.js';
import { req, reqCanvas } from './dom.js';
import { FALLBACK_COLOUR, JELLY, createFocusJelly, jellyBoxOf } from './focus-jelly.js';
import { pxUnit } from './px-unit.js';

/**
 * The screen level (mirrors `#app[data-screen]`). `home` is the site's own third value and carries NO
 * attribute: the launcher is always on one of its two levels, but the landing page is neither — and
 * labelling it `detail` would hand it the entry screen's hero zoom.
 */
export type Screen = 'home' | 'carousel' | 'detail';

/**
 * One place in the row: a catalogue entry, or one of the site's own cards. The row always holds the site
 * cards, which is why a catalogue that failed to load still has something in it.
 */
export type CarouselItem =
  | { readonly kind: 'game'; readonly entry: CollectionEntry }
  | { readonly kind: 'system'; readonly card: SystemCard };

/**
 * What a `move` did. `at-end` is the one the caller acts on: the strip is against a hard stop, so the
 * press has nowhere to go and says so (see controls.ts). It must stay distinct from `locked`, which is
 * the return-morph still running and means "this press does nothing at all" — treating the two alike
 * would sound a dead end on every press right after coming back.
 */
export type MoveResult = 'moved' | 'at-end' | 'locked';

export interface CarouselDeps {
  /** The selection landed on this entry: main repaints the bar copy, the hero and the music. */
  onBrowse(entry: CollectionEntry): void;
  /** …and landed on a site card instead: there is no entry on screen at all. */
  onBrowseNone(card: SystemCard): void;
  /** The screen level changed (controls.ts re-routes its focus model on it). */
  onScreenChange(screen: Screen): void;
  /** A card was activated (A / click on the selected card) — main decides what that means per kind. */
  onActivate(item: CarouselItem): void;
  /** The selection moved by `delta` cards (the nav sound and the background parallax belong to main). */
  onNavigate(delta: number): void;
}

export interface Carousel {
  /** New catalogue. Keeps the selection BY IDENTITY — a site card survives every update by construction. */
  setEntries(entries: readonly CollectionEntry[]): void;
  /** Moves the selection by `delta` cards; says whether it moved, hit an end, or was locked mid-morph. */
  move(delta: number): MoveResult;
  /**
   * Puts the selection on `slug` WITHOUT telling main about it — for the reverse direction, where the
   * route decided what is on screen and the strip has to follow. A no-op when the slug isn't in the row
   * (the row is a shortlist — see MAX_STRIP_GAMES).
   */
  focusEntry(slug: string): void;
  /**
   * Puts the selection on the FIRST site card, again without telling main. Where the strip goes when the
   * user comes back from a surface that card opened.
   */
  focusSystem(): void;
  /** Activates the selected card (A / a click on it). */
  activate(): void;
  /** The current screen level. */
  screen(): Screen;
  /** Switches level. A request for `carousel` with no carousel to show falls back to `home`. */
  setScreen(screen: Screen): void;
  /** Whether the row is worth showing at all (>1 card — with one there is nothing to flip through). */
  exists(): boolean;
  /** The selected item — an entry or a site card. */
  selected(): CarouselItem | undefined;
  /** The selected ENTRY, or undefined when the row stands on a site card. */
  selectedEntry(): CollectionEntry | undefined;
  /**
   * Tells main what the row is standing on right now. The strip normally does this itself, on every
   * move — this is for the times its selection changed while NOBODY was looking at it: a screen closing
   * over it, an entry removed out of the Library. Left unsaid, that entry's hero, palette and music
   * never arrive, and the row sits there under the site's idle background.
   */
  announce(): void;
  /** Marks the entry a session is running for, so its card can pulse wherever it sits in the strip. */
  setBusyEntry(slug: string | null): void;
  /**
   * A direction is being HELD, i.e. the row is flipping on its own. Cover loading pauses for the
   * duration and resumes on release: the cards the flip ends on are the only ones anyone actually looks
   * at, and a fetch per step is what makes a held flip stutter. The attribute it sets also switches the
   * strip onto the glide timing (see --flip-step in styles.css).
   */
  setFlipping(flipping: boolean): void;
  /**
   * The cover the play button morphs out of, for an entry screen the STRIP cannot speak for: the row
   * carries at most MAX_STRIP_GAMES entries, so an entry opened from the Library may have no card here at
   * all — and the morph would then wear whichever card happens to be selected, i.e. another game's cover.
   * Cleared on the way back to the carousel; `null` is "this entry has none", which is not the same as no
   * override.
   */
  setDetailArt(url: string | null): void;
}

/** The row's identity for one item — the key of the DOM node, and what a list update keeps the selection by. */
function itemKey(item: CarouselItem): string {
  return item.kind === 'game' ? `g:${item.entry.slug}` : `s:${item.card.id}`;
}

export function createCarousel(deps: CarouselDeps): Carousel {
  const app = req('app');
  const strip = req('carousel-strip');
  const playButton = req('play-button');
  // Live style object: read per frame for the body's colour, so the palette crossfade (--d2 is a
  // registered property with its own transition) carries it without a single line of interpolation here.
  const appStyle = getComputedStyle(app);

  const systemItems: readonly CarouselItem[] = SYSTEM_CARDS.map((card) => ({
    kind: 'system',
    card,
  }));
  // The row: the catalogue's entries, then the site's own cards. Never empty, which is what lets the
  // Library be reachable even when the feed failed to load.
  let items: readonly CarouselItem[] = [...systemItems];
  let index = 0;
  let screen: Screen = 'home';
  let busySlug: string | null = null;
  // While the strip is coming back from an entry screen the selected card is still growing out of the
  // play square. Moving the selection through that resizes and reorders a card mid-morph, which shows.
  // Timestamp (performance.now) until which a move is refused; 0 = the card stands at full size.
  let lockedUntil = 0;
  // Pending clear of `data-returning` (see markReturning); null when the strip is not returning.
  let returnTimer: number | null = null;
  // A direction is being held (main relays it) — cover loading waits it out. See setFlipping.
  let flipping = false;
  // Whether a catalogue has ever arrived. The row starts as the site cards ALONE, so the seed leaves the
  // Library card selected — and keeping that selection by identity through the first real list would open
  // the strip standing on it. The launcher takes its opening cursor from main's browse channel; the
  // site's own default is "the first entry", which is what the first list lands on.
  let seeded = false;
  // The morph source set from outside for the current entry screen; undefined when the row speaks for
  // itself (see setDetailArt).
  let detailArt: string | null | undefined = undefined;
  const cards = new Map<string, HTMLElement>();
  // Where the body was last sent, so a repaint that did not move the selection (a dot, a busy entry)
  // does not make it squeeze. null until the first layout — the body is placed then, not moved.
  let jellyIndex: number | null = null;

  /** The cover: the entry's own 2:3 art, or its first hero cropped to the card (see collection/README.md). */
  const coverOf = (entry: CollectionEntry): string | null =>
    entry.gridUrl ?? entry.heroUrls[0] ?? null;

  function exists(): boolean {
    return items.length > 1;
  }

  function selected(): CarouselItem | undefined {
    return items[index];
  }

  function selectedEntry(): CollectionEntry | undefined {
    const current = selected();
    return current?.kind === 'game' ? current.entry : undefined;
  }

  /**
   * The box the focus body hugs: the SELECTED card's own rectangle, in the strip's coordinates.
   *
   * Measured off the node rather than derived from the index, and measured EVERY frame (focus-jelly.ts
   * asks for it), because the card is still growing from 90x135 to 136x204 while the row slides — a
   * box computed once would have the body wrapping a size the card no longer has.
   */
  function jellyTarget(): ReturnType<typeof jellyBoxOf> | null {
    const current = selected();
    const card = current === undefined ? undefined : cards.get(itemKey(current));
    if (card === undefined) return null;
    const unit = pxUnit();
    const parsed = Number.parseFloat(getComputedStyle(card).borderTopLeftRadius);
    const radius = Number.isFinite(parsed) ? parsed : 0;
    const pad = JELLY.margin * unit; // the canvas starts up and to the left of the strip's own origin
    return jellyBoxOf(
      card.offsetLeft + pad,
      card.offsetTop + pad,
      card.offsetWidth,
      card.offsetHeight,
      radius,
      unit,
    );
  }

  const jellyCanvas = reqCanvas('carousel-jelly');
  const jelly = createFocusJelly(jellyCanvas, {
    target: jellyTarget,
    // Read off #app, where hero.ts writes the palette; the :root fallback is inherited until it does.
    colour: () => {
      const value = appStyle.getPropertyValue('--d2').trim();
      return value.length > 0 ? value : FALLBACK_COLOUR;
    },
    unit: pxUnit,
  });

  /** Fits the canvas around the whole row — it must cover wherever the body may be, plus its overhang. */
  function sizeJelly(): void {
    const unit = pxUnit();
    const size = stripCanvas(items.length);
    jelly.resize(size.width * unit, size.height * unit);
  }

  /** Squeezes the body through its trip to a new card. A repaint that moved nothing leaves it alone. */
  function nudgeJelly(next: number): void {
    const previous = jellyIndex;
    jellyIndex = next;
    if (previous === null) {
      jelly.bump(true); // the first layout PLACES the body; nothing has travelled
      return;
    }
    if (previous !== next) jelly.bump();
  }

  /** The strip's translation + the per-card selected state. Cheap; safe to call often. */
  function applyLayout(): void {
    strip.style.setProperty('--strip-offset', String(stripOffset(index)));
    nudgeJelly(index);
    const current = selected();
    const currentKey = current === undefined ? null : itemKey(current);
    items.forEach((item, position) => {
      const key = itemKey(item);
      const card = cards.get(key);
      if (card === undefined) return;
      card.classList.toggle('is-selected', key === currentKey);
      // The dot marks "a session is running for this entry" — the only meaning it can carry here, and the
      // launcher's second one for it: the pulse is how "game A is still running" stays visible while you
      // browse game B. Its first meaning there, "this game is on the inserted card", has no counterpart.
      const busy = item.kind === 'game' && item.entry.slug === busySlug;
      card.classList.toggle('is-busy', busy);
      card.classList.toggle('shows-dot', busy);
      // Past the shown window (see VISIBLE_CARDS): still laid out — the strip's offset is positional and
      // a removed node would shift every card after it — but faded out, so it slides in softly when the
      // selection reaches it instead of popping into existence at the row's end.
      card.classList.toggle('is-beyond', !isWithinWindow(position, index));
      // Its place in the fan the strip returns in (styles.css turns this into a transition-delay).
      card.style.setProperty('--fan', String(fanIndex(position, index)));
    });
    // The morph's source image: #play-button wears the selected card's cover so the swap into the entry
    // screen is invisible (see the morph block in styles.css). A site card has none — and no entry screen
    // to morph into either.
    const entry = selectedEntry();
    const cover =
      detailArt !== undefined ? detailArt : entry === undefined ? null : coverOf(entry);
    playButton.style.setProperty('--card-art', cover === null ? 'none' : `url("${cover}")`);
  }

  /** Paints the covers of the cards near the selection (a long catalogue must not fetch them all). */
  function loadNearbyArt(): void {
    if (flipping) return; // see setFlipping — the row is mid-flight, nobody is reading these cards yet
    items.forEach((item, position) => {
      if (item.kind !== 'game') return;
      const card = cards.get(itemKey(item));
      if (card === undefined || card.classList.contains('has-art')) return;
      if (!isNearViewport(position, index)) return;
      const cover = coverOf(item.entry);
      if (cover === null) return;
      card.style.backgroundImage = `url("${cover}")`;
      card.classList.add('has-art');
    });
  }

  function buildCard(item: CarouselItem): HTMLElement {
    const card = document.createElement('div');
    card.className = item.kind === 'system' ? 'card is-system' : 'card';
    // Whether this card wears the dot is decided per render by applyLayout — it depends on what is
    // running, not on this item alone.
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    if (item.kind === 'system') {
      card.setAttribute('aria-label', item.card.aria);
      card.append(systemCardIcon(item.card.id), dot);
    } else {
      card.dataset['slug'] = item.entry.slug;
      const label = document.createElement('span');
      label.className = 'card-label';
      // Feed data is untrusted (it comes from a JSON file) — textContent, never innerHTML.
      label.textContent = item.entry.title;
      card.append(label, dot);
    }
    const key = itemKey(item);
    card.addEventListener('click', () => {
      const position = items.findIndex((candidate) => itemKey(candidate) === key);
      if (position === -1) return;
      // Click on the selected card = enter it; click on another = select it (two-step, like a d-pad).
      if (position === index) {
        activate();
        return;
      }
      if (isLocked()) return; // same lock the d-pad obeys — a click may not jump a half-drawn strip
      const delta = position - index;
      index = position;
      deps.onNavigate(delta);
      applyLayout();
      loadNearbyArt();
      announceSelection();
    });
    return card;
  }

  function rebuild(): void {
    cards.clear();
    const nodes = items.map((item) => {
      const card = buildCard(item);
      cards.set(itemKey(item), card);
      return card;
    });
    // The canvas goes back in FIRST: a rebuild replaces every child, and it is a child of the strip too.
    strip.replaceChildren(jellyCanvas, ...nodes);
    sizeJelly();
  }

  /** Tells main what is on screen now — an entry, or nothing at all on a site card. */
  function announceSelection(): void {
    const current = selected();
    if (current === undefined) return;
    if (current.kind === 'game') deps.onBrowse(current.entry);
    else deps.onBrowseNone(current.card);
  }

  function setScreen(next: Screen): void {
    // With a single card there is nothing to flip through: the landing page stays as it is.
    const effective: Screen = next === 'carousel' && !exists() ? 'home' : next;
    if (effective === screen) return;
    const previous = screen;
    screen = effective;
    if (effective === 'home') delete app.dataset['screen'];
    else app.dataset['screen'] = effective;
    // The override belongs to ONE entry screen (see setDetailArt); back on the row the strip speaks for
    // itself again.
    if (effective !== 'detail') detailArt = undefined;
    // Whether a Play button is part of this transition, i.e. whether the card has something to hand its
    // geometry to (and, coming back, something to take it back from). Every entry screen here has one —
    // the launcher's history and not-yet-installed games are what give it the other value — so what the
    // flag really distinguishes is opening the strip FROM an entry (wait for the button to grow) from
    // opening it from the landing page (nothing to wait for; the strip is up from frame one).
    const morphs = effective === 'detail' || previous === 'detail';
    app.dataset['cardMorph'] = morphs ? 'on' : 'off';
    // Coming back, the strip is unusable until the selected card is back at full size (RETURN_LOCK_MS);
    // leaving, nothing is locked — the entry screen has its own focus model.
    lockedUntil = effective === 'carousel' && morphs ? performance.now() + RETURN_LOCK_MS : 0;
    markReturning(effective === 'carousel');
    deps.onScreenChange(effective);
  }

  /**
   * Flags the staggered fan for as long as it runs (see RETURN_FAN_MS) — coming back from an entry AND
   * opening the strip from the landing page, which here is the same entrance. CSS keys the fan's
   * transition-delay on it, so a card that scrolls into the window while merely FLIPPING fades in
   * immediately: the stagger belongs to the entrance, not to every appearance.
   */
  function markReturning(returning: boolean): void {
    if (returnTimer !== null) {
      window.clearTimeout(returnTimer);
      returnTimer = null;
    }
    if (!returning) {
      delete app.dataset['returning'];
      return;
    }
    app.dataset['returning'] = 'true';
    returnTimer = window.setTimeout(() => {
      returnTimer = null;
      delete app.dataset['returning'];
    }, RETURN_FAN_MS);
  }

  /** Whether the selected card is still growing back to full size, i.e. must not be flipped through yet. */
  function isLocked(): boolean {
    return performance.now() < lockedUntil;
  }

  function activate(): void {
    const current = selected();
    if (current === undefined) return;
    deps.onActivate(current);
  }

  function move(delta: number): MoveResult {
    if (isLocked()) return 'locked';
    const next = clampIndex(index + delta, items.length);
    if (next === index) return 'at-end'; // no move — the caller decides what a stop means, sound included
    const moved = next - index;
    index = next;
    deps.onNavigate(moved);
    applyLayout();
    loadNearbyArt();
    announceSelection();
    return 'moved';
  }

  rebuild();
  applyLayout();
  jelly.setActive(true);
  // --px follows the window's size, so a resize moves the row in real px and the canvas has to follow.
  // The body's own coordinates are re-read every frame, so nothing else needs saying.
  new ResizeObserver(() => sizeJelly()).observe(app);

  return {
    focusEntry(slug: string): void {
      const position = items.findIndex(
        (item) => item.kind === 'game' && item.entry.slug === slug,
      );
      if (position === -1 || position === index) return;
      index = position;
      applyLayout();
      loadNearbyArt();
    },

    focusSystem(): void {
      const position = items.findIndex((item) => item.kind === 'system');
      if (position === -1 || position === index) return;
      index = position;
      applyLayout();
      loadNearbyArt();
    },

    setEntries(list: readonly CollectionEntry[]): void {
      // The row is a SHORTLIST: the rest of the catalogue has a screen of its own now (Library), which is
      // what makes the launcher's cap safe to apply here at last (see MAX_STRIP_GAMES).
      const shortlist = list.slice(0, MAX_STRIP_GAMES);
      // The selection is remembered BY IDENTITY, not by position: the catalogue is sorted by title, and a
      // positional cursor would silently land on a different entry once one is added. A site card survives
      // every update by construction — it is in every list this builds.
      const current = selected();
      const currentKey = seeded && current !== undefined ? itemKey(current) : undefined;
      if (list.length > 0) seeded = true;
      items = [
        ...shortlist.map((entry): CarouselItem => ({ kind: 'game', entry })),
        ...systemItems,
      ];
      index = clampIndex(
        currentKey === undefined
          ? 0
          : Math.max(
              0,
              items.findIndex((item) => itemKey(item) === currentKey),
            ),
        items.length,
      );
      rebuild();
      applyLayout();
      loadNearbyArt();
      // A row that shrank to a single card has no carousel left to stand on.
      if (!exists() && screen === 'carousel') setScreen('home');
    },

    move,
    activate,
    screen: () => screen,
    setScreen,
    exists,
    selected,
    selectedEntry,

    announce(): void {
      announceSelection();
    },

    setBusyEntry(slug: string | null): void {
      if (slug === busySlug) return;
      busySlug = slug;
      applyLayout();
    },

    setFlipping(next: boolean): void {
      if (flipping === next) return;
      flipping = next;
      // The attribute switches the strip and the cards onto the glide timing (see --flip-step in
      // styles.css): a held direction slides at one even speed instead of restarting an eased morph
      // three times a second.
      if (flipping) app.dataset['flipping'] = 'on';
      else delete app.dataset['flipping'];
      // Released: pick up the covers of wherever the row came to rest.
      if (!flipping) loadNearbyArt();
    },

    setDetailArt(url: string | null): void {
      detailArt = url;
      applyLayout();
    },
  };
}
