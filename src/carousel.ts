// The collection carousel, ported from playhook @ 4461c60e75e18d98d77e80e70b9394e0bd0731a5 :
// src/renderer/carousel.ts — a strip of covers sliding under a fixed anchor while the selection stays
// put. In the launcher it is the top-level SCREEN, above the bar screen of whichever game is selected;
// here it is a layer over the landing page, switched on by the `#/collection` deep link (the Collection
// menu item writes it). Picking a card navigates to that entry — the site's own `detail`.
//
// What the launcher's version owns and this one does not: the artwork cache and `artRev`. There a cover
// is a data URL decoded by the main process and cached by id+revision; here it is an ordinary same-origin
// URL and the browser's cache is the cache. The lazy window (isNearViewport) survives — a long catalogue
// still must not pull every cover at once.
//
// Owns only the strip: the cards' DOM, the selection, and the `data-screen` / `data-card-morph`
// attributes. What is SHOWN for the selected entry (bar copy, hero, music) is main's answer to
// `onBrowse` — this module never derives it. The geometry lives in carousel-geometry.ts (pure).
import { type CollectionEntry } from './collection.js';
import {
  RETURN_LOCK_MS,
  clampIndex,
  fanIndex,
  isNearViewport,
  stripOffset,
} from './carousel-geometry.js';
import { req } from './dom.js';

/**
 * The screen level (mirrors `#app[data-screen]`). `home` is the site's own third value and carries NO
 * attribute: the launcher is always on one of its two levels, but the landing page is neither — and
 * labelling it `detail` would hand it the entry screen's hero zoom.
 */
export type Screen = 'home' | 'carousel' | 'detail';

export interface CarouselDeps {
  /** The selection landed on this entry: main repaints the bar copy, the hero and the music. */
  onBrowse(entry: CollectionEntry): void;
  /** The screen level changed (controls.ts re-routes its focus model on it). */
  onScreenChange(screen: Screen): void;
  /** A card was activated (A / click on the selected card) — main turns it into a route change. */
  onActivate(entry: CollectionEntry): void;
  /** The selection moved by `delta` cards (the nav sound and the background parallax belong to main). */
  onNavigate(delta: number): void;
}

export interface Carousel {
  /** New catalogue from the feed. Keeps the selection BY SLUG. */
  setEntries(entries: readonly CollectionEntry[]): void;
  /** Moves the selection by `delta` cards (no wrap-around — the ends are hard stops). */
  move(delta: number): void;
  /**
   * Puts the selection on `slug` WITHOUT telling main about it — for the reverse direction, where the
   * route decided what is on screen and the strip has to follow. A no-op when the slug isn't in the list.
   */
  focusEntry(slug: string): void;
  /** Activates the selected card (A / a click on it). */
  activate(): void;
  /** The current screen level. */
  screen(): Screen;
  /** Switches level. A request for `carousel` with no carousel to show falls back to `home`. */
  setScreen(screen: Screen): void;
  /** Whether the carousel exists at all (>1 entry — with one there is nothing to flip through). */
  exists(): boolean;
  /** The selected entry, or undefined for an empty catalogue. */
  selected(): CollectionEntry | undefined;
  /** Marks the entry a session is running for, so its card can pulse wherever it sits in the strip. */
  setBusyEntry(slug: string | null): void;
}

export function createCarousel(deps: CarouselDeps): Carousel {
  const app = req('app');
  const strip = req('carousel-strip');
  const playButton = req('play-button');

  let entries: readonly CollectionEntry[] = [];
  let index = 0;
  let screen: Screen = 'home';
  let busySlug: string | null = null;
  // While the strip is coming back from an entry screen the selected card is still growing out of the
  // play square. Moving the selection through that resizes and reorders a card mid-morph, which shows.
  // Timestamp (performance.now) until which a move is refused; 0 = the card stands at full size.
  let lockedUntil = 0;
  const cards = new Map<string, HTMLElement>();

  /** The cover: the entry's own 2:3 art, or its first hero cropped to the card (see collection/README.md). */
  const coverOf = (entry: CollectionEntry): string | null => entry.gridUrl ?? entry.heroUrls[0] ?? null;

  function exists(): boolean {
    return entries.length > 1;
  }

  function selected(): CollectionEntry | undefined {
    return entries[index];
  }

  /** The strip's translation + the per-card selected state. Cheap; safe to call often. */
  function applyLayout(): void {
    strip.style.setProperty('--strip-offset', String(stripOffset(index)));
    const current = selected();
    entries.forEach((entry, position) => {
      const card = cards.get(entry.slug);
      if (card === undefined) return;
      card.classList.toggle('is-selected', entry.slug === current?.slug);
      // The dot marks "a session is running for this game" — the only meaning it can carry here, and the
      // launcher's second one for it: the pulse is how "game A is still running" stays visible while you
      // browse game B. Its first meaning there, "this game is on the inserted card", has no counterpart.
      const busy = entry.slug === busySlug;
      card.classList.toggle('is-busy', busy);
      card.classList.toggle('shows-dot', busy);
      // Its place in the fan the strip returns in (styles.css turns this into a transition-delay).
      card.style.setProperty('--fan', String(fanIndex(position, index)));
    });
    // The morph's source image: #play-button wears the selected card's cover so the swap into the entry
    // screen is invisible (see the morph block in styles.css).
    const cover = current === undefined ? null : coverOf(current);
    playButton.style.setProperty('--card-art', cover === null ? 'none' : `url("${cover}")`);
  }

  /** Paints the covers of the cards near the selection (a long catalogue must not fetch them all). */
  function loadNearbyArt(): void {
    entries.forEach((entry, position) => {
      const card = cards.get(entry.slug);
      if (card === undefined || card.classList.contains('has-art')) return;
      if (!isNearViewport(position, index)) return;
      const cover = coverOf(entry);
      if (cover === null) return;
      card.style.backgroundImage = `url("${cover}")`;
      card.classList.add('has-art');
    });
  }

  function buildCard(entry: CollectionEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset['slug'] = entry.slug;
    const label = document.createElement('span');
    label.className = 'card-label';
    // Feed data is untrusted (it comes from a JSON file) — textContent, never innerHTML.
    label.textContent = entry.title;
    // Whether this card wears the dot is decided per render by applyLayout — it depends on what is
    // running, not on this entry alone.
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    card.append(label, dot);
    card.addEventListener('click', () => {
      const position = entries.findIndex((candidate) => candidate.slug === entry.slug);
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
    const nodes = entries.map((entry) => {
      const card = buildCard(entry);
      cards.set(entry.slug, card);
      return card;
    });
    strip.replaceChildren(...nodes);
  }

  /** Tells main what is on screen now. */
  function announceSelection(): void {
    const current = selected();
    if (current === undefined) return;
    deps.onBrowse(current);
  }

  function setScreen(next: Screen): void {
    // With 0 or 1 entry there is nothing to flip through: the landing page stays as it is.
    const effective: Screen = next === 'carousel' && !exists() ? 'home' : next;
    if (effective === screen) return;
    const previous = screen;
    screen = effective;
    if (effective === 'home') delete app.dataset['screen'];
    else app.dataset['screen'] = effective;
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
    deps.onScreenChange(effective);
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

  function move(delta: number): void {
    if (isLocked()) return;
    const next = clampIndex(index + delta, entries.length);
    if (next === index) return; // at an end — no move, no sound
    const moved = next - index;
    index = next;
    deps.onNavigate(moved);
    applyLayout();
    loadNearbyArt();
    announceSelection();
  }

  return {
    focusEntry(slug: string): void {
      const position = entries.findIndex((entry) => entry.slug === slug);
      if (position === -1 || position === index) return;
      index = position;
      applyLayout();
      loadNearbyArt();
    },

    setEntries(list: readonly CollectionEntry[]): void {
      // The selection is remembered BY SLUG, not by position: the catalogue is sorted by title, and a
      // positional cursor would silently land on a different entry once one is added.
      const currentSlug = selected()?.slug;
      entries = list;
      index = clampIndex(
        currentSlug === undefined
          ? 0
          : Math.max(
              0,
              entries.findIndex((entry) => entry.slug === currentSlug),
            ),
        entries.length,
      );
      rebuild();
      applyLayout();
      loadNearbyArt();
      // A catalogue that shrank to a single entry has no carousel left to stand on.
      if (!exists() && screen === 'carousel') setScreen('home');
    },

    move,
    activate,
    screen: () => screen,
    setScreen,
    exists,
    selected,

    setBusyEntry(slug: string | null): void {
      if (slug === busySlug) return;
      busySlug = slug;
      applyLayout();
    },
  };
}
