// The catalogue list inside the popup's `select-game` view: the game buttons, their clipped/marquee
// titles, the custom scrollbar indicator and the search filter.
//
// Ported from playhook @ c348f4246752286b594c8a8eddd2253ea88b0f12 : src/renderer/controls.ts (the
// buildSelectGameButtons / updateSelectGameMarquee / updateSelectGameScrollbar trio) — but kept in its
// own module rather than folded into controls.ts, whose donor is 994 lines. The seam is clean:
// controls.ts owns focus and input, this owns the list's DOM and hands back a flat array of StackItems.

import { type CollectionEntry } from './collection.js';
import { req } from './dom.js';

/**
 * One entry in the popup's vertical focus stack. Two roles, because they diverge for the search box:
 * the highlight lives on the wrapper (it is the thing that looks like a button) while DOM focus has to
 * land on the <input> inside it.
 */
export interface StackItem {
  readonly kind: 'button' | 'game' | 'input';
  /** Carries `.is-focused`. */
  readonly visual: HTMLElement;
  /** Where DOM focus goes. For 'input' that is the <input>; otherwise the same element. */
  readonly focusTarget: HTMLElement;
}

/** What the list is currently able to show. `ready` still covers "the catalogue is empty". */
export type ListState = 'loading' | 'ready' | 'error';

const PLACEHOLDER_COPY: Readonly<Record<'loading' | 'error' | 'empty' | 'no-matches', string>> = {
  loading: 'Loading…',
  error: 'Collection unavailable',
  empty: 'Nothing here yet',
  'no-matches': 'No matches',
};

/** Constant scroll speed for the focused game title's marquee (design px per second). */
const MARQUEE_SPEED_PX_PER_S = 60;

/** How long the scrollbar indicator stays up after the last bit of input. */
const SCROLLBAR_IDLE_MS = 2000;

/**
 * Case-folds and unifies dashes. The one normalisation the filter does: several titles carry a real en
 * dash (U+2013) while every keyboard types a hyphen, so "vice city - the" would otherwise match nothing
 * and read as a broken search rather than as two different characters.
 */
const norm = (value: string): string => value.toLowerCase().replace(/[–—]/g, '-');

const matches = (title: string, query: string): boolean => norm(title).includes(norm(query.trim()));

export interface GameListDeps {
  /** A game was picked (click, Enter or gamepad A). */
  readonly onSelect: (slug: string) => void;
  /** This button should take the highlight: the pointer entered it, or Tab gave it DOM focus. Both
   *  models have to agree, or Enter would fire something other than what looks selected. */
  readonly onAdoptFocus: (visual: HTMLElement) => void;
  /** Whether this view is the one on screen: gates live measurements and the scrollbar. */
  readonly isVisible: () => boolean;
  /** The element currently carrying the stack highlight, if any. */
  readonly focusedVisual: () => HTMLElement | null;
}

export interface GameList {
  /** New feed data (or a load state). Rebuilds the buttons and re-applies the current filter. */
  setData(state: ListState, entries: readonly CollectionEntry[]): void;
  /** Applies a search query. Button elements are REUSED, so focus survives by identity. */
  setFilter(query: string): void;
  /** The game items currently in the list, top to bottom. Empty while a placeholder is shown. */
  items(): readonly StackItem[];
  /** Re-measures every title and (re)starts the marquee on the focused one. */
  updateMarquee(): void;
  /** Marks scrollbar activity and restarts its idle countdown. */
  noteActivity(): void;
  /** Repositions the thumb and re-evaluates its visibility, WITHOUT waking it. */
  updateScrollbar(): void;
}

/** A built game button, kept across filter changes so the focused element keeps its identity. */
interface GameButton {
  readonly slug: string;
  readonly title: string;
  readonly item: StackItem;
  readonly label: HTMLElement;
  readonly inner: HTMLElement;
}

export function createGameList(deps: GameListDeps): GameList {
  const list = req('select-game-list');
  const thumb = req('select-game-thumb');
  const placeholder = document.createElement('div');
  placeholder.className = 'list-placeholder';

  let state: ListState = 'loading';
  let buttons: readonly GameButton[] = [];
  let visible: readonly GameButton[] = [];
  let query = '';

  let scrollbarAwake = false;
  let scrollbarIdleTimer = 0;

  // ── Building ───────────────────────────────────────────────────────────────

  // Three nested elements per title, as in the launcher: the button clips, .game-label carries the fade
  // mask, .game-label-inner is what actually moves.
  function build(entry: CollectionEntry): GameButton {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'text-button game-button';
    button.dataset['slug'] = entry.slug;
    const label = document.createElement('span');
    label.className = 'game-label';
    const inner = document.createElement('span');
    inner.className = 'game-label-inner';
    inner.textContent = entry.title;
    label.append(inner);
    button.append(label);
    button.addEventListener('click', () => deps.onSelect(entry.slug));
    button.addEventListener('mouseenter', () => deps.onAdoptFocus(button));
    button.addEventListener('focus', () => deps.onAdoptFocus(button));
    return {
      slug: entry.slug,
      title: entry.title,
      item: { kind: 'game', visual: button, focusTarget: button },
      label,
      inner,
    };
  }

  /** Decides what actually sits in the list right now: the matching buttons, or one placeholder line. */
  function render(): void {
    if (state !== 'ready') {
      visible = [];
      placeholder.textContent = PLACEHOLDER_COPY[state === 'error' ? 'error' : 'loading'];
      list.replaceChildren(placeholder);
      return;
    }
    if (buttons.length === 0) {
      visible = [];
      placeholder.textContent = PLACEHOLDER_COPY.empty;
      list.replaceChildren(placeholder);
      return;
    }
    const next = query.trim() === '' ? buttons : buttons.filter((b) => matches(b.title, query));
    visible = next;
    if (next.length === 0) {
      placeholder.textContent = PLACEHOLDER_COPY['no-matches'];
      list.replaceChildren(placeholder);
      return;
    }
    list.replaceChildren(...next.map((b) => b.item.visual));
  }

  // ── Marquee ────────────────────────────────────────────────────────────────

  // Overflow is measured live (the inner text's width against the visible clip box), because it depends
  // on --px, i.e. on the window size. Every overflowing title gets a soft right-edge fade; the FOCUSED
  // one additionally scrolls back and forth.
  function updateMarquee(): void {
    if (!deps.isVisible()) return;
    const focused = deps.focusedVisual();
    for (const button of visible) {
      const overflow = button.inner.scrollWidth - button.label.clientWidth;
      const clipped = overflow > 1;
      button.item.visual.classList.toggle('is-clipped', clipped);
      if (clipped && button.item.visual === focused) {
        button.inner.style.setProperty('--marquee-shift', `${-overflow}px`);
        button.inner.style.setProperty(
          '--marquee-duration',
          `${Math.max(2, overflow / MARQUEE_SPEED_PX_PER_S)}s`,
        );
        button.item.visual.classList.add('is-scrolling');
      } else {
        button.item.visual.classList.remove('is-scrolling');
        button.inner.style.removeProperty('--marquee-shift');
        button.inner.style.removeProperty('--marquee-duration');
      }
    }
  }

  // BROWSER: the launcher ships its font locally, so it never measures a title before the glyphs exist.
  // Here the woff2 arrives over the network with font-display: swap, and a scrollWidth read taken against
  // the fallback font is simply a different number — the symptom is titles that "sometimes" scroll.
  void document.fonts.ready.then(() => updateMarquee());
  // …and the same measurement depends on --px, which follows the viewport. The launcher lives in a fixed
  // fullscreen window and has no equivalent.
  window.addEventListener('resize', () => {
    updateMarquee();
    updateScrollbar();
  });

  // ── Scrollbar indicator ────────────────────────────────────────────────────

  function focusedIsGame(): boolean {
    const focused = deps.focusedVisual();
    return focused !== null && visible.some((b) => b.item.visual === focused);
  }

  function updateScrollbar(): void {
    if (!deps.isVisible()) {
      thumb.classList.remove('is-visible');
      return;
    }
    const { scrollHeight, clientHeight, scrollTop } = list;
    const scrollable = scrollHeight - clientHeight;
    const overflowing = scrollable > 1;
    thumb.classList.toggle('is-visible', overflowing && scrollbarAwake && focusedIsGame());
    if (!overflowing) return;
    // Travel = the track minus the (fixed-height) thumb. Guard a track shorter than the thumb itself.
    const track = Math.max(0, clientHeight - thumb.offsetHeight);
    thumb.style.transform = `translateY(${(scrollTop / scrollable) * track}px)`;
  }

  function noteActivity(): void {
    scrollbarAwake = true;
    if (scrollbarIdleTimer !== 0) window.clearTimeout(scrollbarIdleTimer);
    scrollbarIdleTimer = window.setTimeout(() => {
      scrollbarIdleTimer = 0;
      scrollbarAwake = false;
      updateScrollbar();
    }, SCROLLBAR_IDLE_MS);
    updateScrollbar();
  }

  // Scrolling (wheel, or scrollIntoView driven by navigation) counts as activity and moves the thumb.
  list.addEventListener('scroll', () => noteActivity());

  render();

  return {
    setData(next: ListState, entries: readonly CollectionEntry[]): void {
      state = next;
      buttons = next === 'ready' ? entries.map(build) : [];
      render();
      updateMarquee();
      updateScrollbar();
    },

    setFilter(next: string): void {
      if (next === query) return;
      query = next;
      render();
      updateMarquee();
      updateScrollbar();
    },

    items: (): readonly StackItem[] => visible.map((b) => b.item),

    updateMarquee,
    noteActivity,
    updateScrollbar,
  };
}
