// The Library screen: the whole catalogue as a grid of covers, where the carousel only ever shows a row
// of it — and the one place an entry can be added from.
//
// Ported from playhook @ c26fae7 (release/v0.8.0) : src/renderer/library-screen.ts. Structurally it is
// the launcher's screen entire: the same veil + column + sidebar skeleton, the same six primitives for
// controls.ts to route into, the same grid maths (library-grid.ts), the same focus body, the same
// staggered arrival of a section.
//
// What does NOT come across is its artwork machinery. There a cover is a data URL the main process
// generates on first sight, so the screen needs a bounded cache with a request queue and an eviction
// callback (card-art.ts); here a cover is an ordinary URL and the browser's cache IS that cache. The row
// window survives — a catalogue of hundreds must not put hundreds of requests in flight — but nothing is
// held, dropped or evicted by hand.
import { type AudioController } from './audio.js';
import { type CollectionEntry } from './collection.js';
import { req, reqCanvas } from './dom.js';
import { FALLBACK_COLOUR, createFocusJelly, jellyBoxOf, type JellyBox } from './focus-jelly.js';
import { clampIndex } from './index-math.js';
import {
  filterLibrary,
  LIB_CARD_SCALE,
  gridColumns,
  gridStep,
  isNearInGrid,
  type GridDir,
  type LibrarySection,
} from './library-grid.js';
import type { NavSurface } from './nav-surface.js';
import { pxUnit } from './px-unit.js';
import { createScroller } from './screen-scroller.js';
import { createSidebar, type SidebarEntry } from './screen-sidebar.js';

/**
 * How long the grid takes to scroll one row on a SINGLE press — the morph's own duration, so the glide
 * and the card's growth are one movement. A held direction overrides it with --flip-step (see step()).
 */
const SINGLE_STEP_MS = 240;
/** Fallback for --flip-step, should the property not be readable yet (controls.ts writes it at startup). */
const FLIP_STEP_FALLBACK_MS = 143;
/** How long a card that left the section fades for before its node goes (mirrors .is-leaving in CSS). */
const LEAVE_MS = 220;
/** How long the staggered arrival of a section runs before the marks come off (mirrors .is-entering). */
const ENTRANCE_MS = 700;
/** The stagger stops counting here: past a dozen cards the wave is a wait, not a wave. */
const ENTRANCE_STEPS = 11;
/** How long the grid waits before drawing the section the column moved onto (see previewTimer). */
const PREVIEW_MS = 120;

/** What an empty section says. Each one has its own line: "nothing here" alone explains nothing. */
const EMPTY_TEXT: Readonly<Record<LibrarySection, string>> = {
  all: 'The catalogue is empty. Add a game to see it here.',
  collection: 'No published entries — the collection feed is empty or failed to load.',
  added: 'Nothing added yet. "Add game" puts an entry here until the page is reloaded.',
};

const SECTION_LABEL: Readonly<Record<LibrarySection, string>> = {
  all: 'All',
  collection: 'Collection',
  added: 'Added here',
};

export interface LibraryScreenDeps {
  readonly audio: AudioController;
  /** The current catalogue, for the first paint (later ones arrive through setEntries). */
  getEntries(): readonly CollectionEntry[];
  /** An entry was activated — main opens its screen and remembers where it came from. */
  onOpenEntry(slug: string): void;
  /** The "Add game" entry — controls.ts hands over to the Customize screen in add mode. */
  onAddGame(): void;
  /** The screen closed itself (B / Close) — controls.ts restores the bar focus. */
  onClosed(): void;
}

export interface LibraryScreen extends NavSurface {
  /**
   * A fresh visit: the first section, the first entry, the top of the grid. `focusSlug` lands on one
   * entry instead — an entry just added, which is the one thing the user is looking for on arrival.
   */
  open(options?: { readonly focusSlug?: string }): void;
  /** Back from the entry screen (or from Add game): the screen returns exactly as it was left. */
  restore(): void;
  /** `silent` is a hand-over to another surface, which sounds and re-focuses for itself. */
  close(silent?: boolean): void;
  /** A new catalogue (an entry added or removed) — the grid re-flows, the selection stays put. */
  setEntries(entries: readonly CollectionEntry[]): void;
  /** The entry a session is running for, so its dot pulses here as it does on the carousel. */
  setBusyEntry(slug: string | null): void;
  /** A direction is HELD: cover loading waits it out, exactly as it does in the carousel. */
  setFlipping(flipping: boolean): void;
  /** The cover of one entry, for the play button's morph (see carousel.setDetailArt). */
  coverFor(slug: string): string | null;
}

const nodeKey = (slug: string): string => `g:${slug}`;

/** The cover: the entry's own 2:3 art, or its first hero cropped to the card. The carousel's rule. */
const coverOf = (entry: CollectionEntry): string | null =>
  entry.gridUrl ?? entry.heroUrls[0] ?? null;

export function createLibraryScreen(deps: LibraryScreenDeps): LibraryScreen {
  const app = req('app');
  const appStyle = getComputedStyle(app);
  const screen = req('library');
  const gridEl = req('library-grid');
  // The grid's focus body: ONE soft shape that travels from cover to cover, the strip's twin (see
  // carousel.ts). Its canvas covers the PANE, not the scrolling content — see #library-jelly.
  const jellyCanvas = reqCanvas('library-jelly');
  const scrollEl = req('library-scroll');
  const emptyEl = req('library-empty');
  const scroller = createScroller(scrollEl);

  let open = false;
  let section: LibrarySection = 'all';
  let entries: readonly CollectionEntry[] = [];
  let shown: readonly CollectionEntry[] = [];
  let index = 0;
  let cols = 1;
  let busySlug: string | null = null;
  let flipping = false;
  // A list arrived while the screen was away. The grid is NOT re-flowed then: it is still on screen,
  // fading out under the entry screen, and cards moving during that fade is what read as a twitch.
  // The next open/restore rebuilds it instead.
  let stale = false;
  /** An entry the screen was opened ON that the list does not hold YET — one added a moment ago. */
  let pendingFocusSlug: string | null = null;
  // A held direction walks the column faster than the grid can be rebuilt, so the section the column
  // moved onto is drawn ONCE, when the movement stops. Short enough that a single press reads as instant.
  let previewTimer = 0;
  let previewSection: LibrarySection | null = null;
  /** Pending end of the arrival wave — the marks come off every POOLED node, see playEntrance. */
  let entranceTimer = 0;
  // Every card node ever built, by slug — a POOL, not "what the grid holds right now". A section switch
  // only takes nodes out of the grid: their covers are painted on them, and rebuilding a card on the way
  // back to "All" would show its title again while the cover was re-fetched. Entries go only when the
  // catalogue drops one.
  const nodes = new Map<string, HTMLElement>();
  // The slug the body currently wraps, so a repaint that did not move the selection (a dot, a busy entry,
  // a scroll) does not make it squeeze. null while it has nowhere to be.
  let jellySlug: string | null = null;

  const sidebar = createSidebar(req('library-nav'), {
    audio: deps.audio,
    onSection: (id, entered) => selectSection(id, entered),
    onAction: (id) => runAction(id),
  });

  /** The glide pace: one morph per press, or exactly one repeat interval — linear — while held. */
  function pace(): { readonly durationMs: number; readonly linear: boolean } {
    if (!flipping) return { durationMs: SINGLE_STEP_MS, linear: false };
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--flip-step');
    const parsed = Number.parseFloat(raw);
    return {
      durationMs: Number.isFinite(parsed) && parsed > 0 ? parsed : FLIP_STEP_FALLBACK_MS,
      linear: true,
    };
  }

  function selectedEntry(): CollectionEntry | undefined {
    return shown[index];
  }

  function nodeOf(entry: CollectionEntry): HTMLElement | undefined {
    return nodes.get(nodeKey(entry.slug));
  }

  /**
   * Puts the focus on the entry the screen was opened for, if the list holds it by now. Naming one means
   * the user is here to see it, so the focus leaves the sidebar and lands in the grid.
   */
  function focusPending(): void {
    const wanted = pendingFocusSlug;
    if (wanted === null) return;
    const at = shown.findIndex((entry) => entry.slug === wanted);
    if (at === -1) return;
    pendingFocusSlug = null;
    index = at;
    sidebar.setFocused(false);
    applyLayout(true);
    const entry = shown[at];
    const node = entry === undefined ? undefined : nodeOf(entry);
    if (node !== undefined) scroller.reveal(node, true);
  }

  /** How many columns fit right now. Measured, not assumed: the width follows the screen's aspect ratio. */
  function measureColumns(): void {
    const unit = pxUnit();
    const inner = unit > 0 ? gridEl.clientWidth / unit : 0;
    const next = gridColumns(inner);
    if (next === cols) return;
    cols = next;
    gridEl.style.setProperty('--cols', String(cols));
  }

  function buildCard(entry: CollectionEntry): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card';
    const label = document.createElement('span');
    label.className = 'card-label';
    // Feed data is untrusted (it comes from a JSON file) — textContent, never innerHTML.
    label.textContent = entry.title;
    const dot = document.createElement('span');
    dot.className = 'card-dot';
    card.append(label, dot);
    card.setAttribute('aria-label', entry.title);
    // Two-step, like the carousel's cards: a click on another card selects it, a click on the selected
    // one opens it. The position is resolved at click time — the node outlives the list that made it.
    card.addEventListener('click', () => {
      const at = shown.findIndex((candidate) => candidate.slug === entry.slug);
      if (at === -1) return;
      if (!sidebar.hasFocus() && at === index) {
        activateSelected();
        return;
      }
      sidebar.setFocused(false);
      index = at;
      deps.audio.play('navigate');
      applyLayout();
    });
    return card;
  }

  /**
   * Paints the covers of the rows around the selection. Bounded for the reason the carousel's window is:
   * a catalogue of hundreds must not put hundreds of image requests in flight at once.
   */
  function loadWindowArt(): void {
    if (!open || flipping) return;
    shown.forEach((entry, at) => {
      if (!isNearInGrid(at, index, cols)) return;
      const node = nodeOf(entry);
      if (node === undefined || node.classList.contains('has-art')) return;
      const cover = coverOf(entry);
      if (cover === null) return;
      node.style.backgroundImage = `url("${cover}")`;
      node.classList.add('has-art');
    });
  }

  /**
   * The box the focus body hugs, in the PANE's coordinates.
   *
   * Three systems meet here: the card's offset inside the grid, the grid's own offset inside the
   * scroller (its padding), and how far that scroller has scrolled. The last one is why the canvas can
   * stay viewport-sized instead of growing with the catalogue — see #library-jelly in styles.css.
   *
   * Asked once per frame, so the body follows a grid that is still scrolling and a card that is still
   * growing into its 1.06.
   */
  function jellyTarget(): JellyBox | null {
    const current = selectedEntry();
    const node = current === undefined ? undefined : nodeOf(current);
    if (node === undefined || !node.isConnected) return null;
    const unit = pxUnit();
    const parsed = Number.parseFloat(getComputedStyle(node).borderTopLeftRadius);
    const radius = Number.isFinite(parsed) ? parsed : 0;
    // The card grows in place by --card-scale, which leaves offsetWidth alone — so the grown size has
    // to be worked out rather than read, or the body would hug the card's resting box.
    const grown = node.classList.contains('is-selected');
    const scale = grown ? LIB_CARD_SCALE : 1;
    const w = node.offsetWidth * scale;
    const h = node.offsetHeight * scale;
    return jellyBoxOf(
      gridEl.offsetLeft + node.offsetLeft - scrollEl.scrollLeft - (w - node.offsetWidth) / 2,
      gridEl.offsetTop + node.offsetTop - scrollEl.scrollTop - (h - node.offsetHeight) / 2,
      w,
      h,
      radius * scale,
      unit,
    );
  }

  const jelly = createFocusJelly(jellyCanvas, {
    target: jellyTarget,
    colour: () => {
      const value = appStyle.getPropertyValue('--d2').trim();
      return value.length > 0 ? value : FALLBACK_COLOUR;
    },
    unit: pxUnit,
  });

  /** Fits the canvas to the pane. The body never leaves it: the scroller keeps the selection in view. */
  function sizeJelly(): void {
    jelly.resize(scrollEl.clientWidth, scrollEl.clientHeight);
  }

  /**
   * Points the body at the selected cover — or fades it out when there is nothing to wrap (the focus is
   * in the column, the section is empty). `instant` is for the frames it has no business travelling
   * through: a fresh open, a section switch, a restore, a resize.
   */
  function placeJelly(instant: boolean): void {
    const current = !sidebar.hasFocus() ? selectedEntry() : undefined;
    const slug = current?.slug ?? null;
    jellyCanvas.classList.toggle('is-hidden', slug === null);
    if (slug === null) {
      jellySlug = null;
      return;
    }
    const moved = jellySlug !== null && jellySlug !== slug;
    const first = jellySlug === null;
    jellySlug = slug;
    // Only a real move squeezes. applyLayout also runs for a dot, a busy entry and every scroll frame,
    // and a squeeze on those would have the body pulsing at nothing.
    if (instant || first) jelly.bump(true);
    else if (moved) jelly.bump();
  }

  /** The selection, the dots, and the scroll that keeps the selected card in view. */
  function applyLayout(instant = false): void {
    const active = !sidebar.hasFocus();
    const current = selectedEntry();
    shown.forEach((entry, at) => {
      const node = nodeOf(entry);
      if (node === undefined) return;
      node.classList.toggle('is-selected', active && at === index);
      node.classList.toggle('shows-dot', entry.slug === busySlug);
      node.classList.toggle('is-busy', entry.slug === busySlug);
    });
    placeJelly(instant);
    const selectedNode = active && current !== undefined ? nodeOf(current) : undefined;
    // Only while the screen is actually up: scrolling a grid that is fading out under the screen above
    // it moves cards nobody asked to move, right in the user's eye line.
    if (open && selectedNode !== undefined) {
      if (instant) scroller.reveal(selectedNode, true);
      else scroller.revealGlide(selectedNode, pace());
    }
    loadWindowArt();
  }

  /** Whether a sidebar entry names one of the sections (the rest are actions — Add game, Close). */
  function isSectionId(id: string): id is LibrarySection {
    return id === 'all' || id === 'collection' || id === 'added';
  }

  function applyEmpty(): void {
    emptyEl.textContent = EMPTY_TEXT[section];
    emptyEl.setAttribute('aria-hidden', shown.length === 0 ? 'false' : 'true');
  }

  /**
   * Re-flows the grid WITHOUT the cards jumping into place: FLIP, the carousel's trick in two dimensions.
   * The inline transform composes translate WITH the scale, or the selected card would collapse to 1 for
   * the length of the animation — the literal would replace `scale(var(--card-scale))` from the stylesheet.
   */
  function reorderSmoothly(apply: () => void): void {
    const before = new Map<string, { readonly left: number; readonly top: number }>();
    for (const [key, node] of nodes) before.set(key, { left: node.offsetLeft, top: node.offsetTop });
    apply();
    const shifted: HTMLElement[] = [];
    for (const [key, node] of nodes) {
      const from = before.get(key);
      if (from === undefined) continue; // new to the grid: it belongs where it is
      const dx = from.left - node.offsetLeft;
      const dy = from.top - node.offsetTop;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      node.style.transition = 'none';
      node.style.transform = `translate(${dx}px, ${dy}px) scale(var(--card-scale, 1))`;
      shifted.push(node);
    }
    if (shifted.length === 0) return;
    void gridEl.offsetWidth; // ONE reflow for the whole grid, so every card starts together
    for (const node of shifted) {
      node.style.transition = '';
      node.style.transform = '';
    }
  }

  /**
   * Takes cards OUT of the grid without letting them vanish: each is frozen at the place it currently
   * occupies, out of the flow (so the ones behind close the gap straight away) and faded by the
   * stylesheet. Switching sections otherwise looked like `display: none` — half the grid blinking out.
   *
   * Measured in FULL before anything is moved. Freezing one card re-flows the grid, so measuring and
   * pinning them one at a time read every card's position after its predecessors had already left.
   */
  function dismissAll(leaving: readonly HTMLElement[]): void {
    const places = leaving.map((node) => ({ left: node.offsetLeft, top: node.offsetTop }));
    leaving.forEach((node, at) => {
      const place = places[at];
      if (place === undefined) return;
      node.style.position = 'absolute';
      node.style.left = `${place.left}px`;
      node.style.top = `${place.top}px`;
      node.classList.remove('is-selected');
      node.classList.remove('is-entering'); // it is leaving; the arrival it was mid-way through is moot
      node.classList.add('is-leaving');
      // Checked again on the way out: a fast switch back puts this very node in the grid again (it lives
      // in the pool), and the timer must not then pull it out from under the section that took it.
      window.setTimeout(() => {
        if (node.classList.contains('is-leaving')) node.remove();
      }, LEAVE_MS);
    });
  }

  /** Builds the nodes of the current section and puts them in order, reusing whatever is still there. */
  function syncNodes(animate: boolean): void {
    shown = filterLibrary(entries, section);
    const fresh: HTMLElement[] = [];
    const wanted = shown.map((entry, at) => {
      const key = nodeKey(entry.slug);
      const existing = nodes.get(key);
      // The stagger is positional, so it is written on every pass — a card that moved forward in the
      // list must arrive earlier than it did last time, not keep its old place in the wave.
      const stagger = String(Math.min(at, ENTRANCE_STEPS));
      if (existing !== undefined) {
        // It may be coming back from a section that dismissed it — undo the freeze before it is re-laid.
        existing.classList.remove('is-leaving');
        existing.style.removeProperty('position');
        existing.style.removeProperty('left');
        existing.style.removeProperty('top');
        existing.style.setProperty('--card-index', stagger);
        const label = existing.querySelector('.card-label');
        if (label !== null && label.textContent !== entry.title) label.textContent = entry.title;
        existing.setAttribute('aria-label', entry.title);
        return existing;
      }
      const node = buildCard(entry);
      node.style.setProperty('--card-index', stagger);
      nodes.set(key, node);
      fresh.push(node);
      return node;
    });
    const leaving: HTMLElement[] = [];
    for (const [key, node] of nodes) {
      const entry = entries.find((candidate) => nodeKey(candidate.slug) === key);
      // Gone from the catalogue entirely: the node has nothing left to show, so it leaves the pool too.
      if (entry === undefined) nodes.delete(key);
      if (shown.some((candidate) => nodeKey(candidate.slug) === key)) continue;
      if (!node.isConnected) continue; // already out of the grid — another section left it there
      if (animate) leaving.push(node);
      else node.remove();
    }
    if (leaving.length > 0) dismissAll(leaving);
    // In-order sync rather than replaceChildren: re-inserting a node the grid already holds would drop
    // its transition state, which is exactly what the FLIP above is measuring.
    wanted.forEach((node, at) => {
      const current = gridEl.children[at];
      if (current !== node) gridEl.insertBefore(node, current ?? null);
    });
    if (animate && fresh.length > 0) playEntrance(fresh);
    applyEmpty();
  }

  /**
   * Plays the arrival on `cards` and takes the marks off again when it is over.
   *
   * The clean-up walks the POOL, not the grid: a card can step out of the grid and live on in the pool,
   * and a mark left on it that way is permanent. It matters because the mark drives an ANIMATION: while
   * it is there the animation owns `transform`, so the card stops growing on selection and starts
   * snapping instead.
   */
  function playEntrance(cards: readonly HTMLElement[]): void {
    for (const node of cards) node.classList.remove('is-entering');
    void gridEl.offsetWidth; // re-adding a class the node already carries plays nothing at all
    for (const node of cards) node.classList.add('is-entering');
    if (entranceTimer !== 0) window.clearTimeout(entranceTimer);
    entranceTimer = window.setTimeout(() => {
      entranceTimer = 0;
      for (const node of nodes.values()) node.classList.remove('is-entering');
    }, ENTRANCE_MS);
  }

  /**
   * Puts a whole section on screen (a section switch, a fresh open, a list that arrived while away).
   *
   * Deliberately NOT the FLIP that a live re-flow uses. A section switch also sends the scroll back to
   * the top, and a card sliding to its new place while the whole grid is scrolling under it moves twice
   * at once. Here the scroll snaps and the section ARRIVES instead, in the launcher's staggered wave.
   */
  function renderSection(animate: boolean): void {
    syncNodes(animate);
    stale = false;
    index = clampIndex(index, 0, shown.length);
    measureColumns();
    scroller.to(0, true);
    applyLayout(true);
    if (animate) playEntrance([...nodes.values()].filter((node) => node.isConnected));
    requestAnimationFrame(() => scroller.fades());
  }

  /** Draws whatever section the column last landed on, if the debounce has not done it yet. */
  function flushPreview(): void {
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    const next = previewSection;
    previewSection = null;
    if (next === null || next === section) return;
    section = next;
    index = 0;
    renderSection(true);
  }

  function selectSection(id: string, entered: boolean): void {
    previewSection = isSectionId(id) ? id : 'all';
    if (entered) {
      // Stepping INTO a section is a commitment — it must be on screen before the focus lands in it.
      flushPreview();
      enterGrid();
      return;
    }
    if (previewTimer !== 0) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      flushPreview();
    }, PREVIEW_MS);
  }

  /** Hands the focus from the column to the grid. An empty section has nothing to hand it to. */
  function enterGrid(): void {
    if (shown.length === 0) {
      deps.audio.playLimit();
      return;
    }
    sidebar.setFocused(false);
    index = clampIndex(index, 0, shown.length);
    applyLayout();
  }

  /** …and back. The column is the only place the screen can be left from. */
  function leaveGrid(): void {
    sidebar.setFocused(true);
    applyLayout();
  }

  function runAction(id: string): void {
    if (id === 'add') {
      // Silent on purpose: the Customize screen sounds its OWN opening. Sounding it here too is what
      // made "Add game" click twice in the launcher.
      deps.onAddGame();
      return;
    }
    close();
  }

  function activateSelected(): void {
    const entry = selectedEntry();
    if (entry === undefined) return;
    deps.audio.play('button');
    deps.onOpenEntry(entry.slug);
  }

  /** One press in the grid: the maths says where it lands, this says what it sounds like. */
  function step(dir: GridDir, repeat: boolean): void {
    const move = gridStep(index, dir, shown.length, cols);
    if (move.result === 'to-sidebar') {
      // Leaving the grid takes a press of its OWN. A hold walks the row, and letting it carry on into the
      // column would cross a surface boundary the user was not aiming at.
      if (repeat) return; // silent while held, exactly as `at-end` below treats the other three walls
      deps.audio.play('navigate');
      leaveGrid();
      return;
    }
    if (move.result === 'at-end') {
      if (!repeat) deps.audio.playLimit();
      return;
    }
    index = move.index;
    deps.audio.play('navigate');
    applyLayout();
  }

  function sidebarEntries(): readonly SidebarEntry[] {
    return [
      { id: 'all', label: SECTION_LABEL.all, kind: 'section' },
      { id: 'collection', label: SECTION_LABEL.collection, kind: 'section' },
      { id: 'added', label: SECTION_LABEL.added, kind: 'section' },
      { id: 'add', label: 'Add game', kind: 'action' },
      { id: 'close', label: 'Close', kind: 'action' },
    ];
  }

  /**
   * Drops the screen's fade for one frame. A hand-over to the entry screen (and the way back) must be a
   * CUT: through a 0.35s fade the carousel underneath is seen re-assembling itself — the strip fanning
   * back in, the title swapping — and that reads as the site glitching, not as a screen changing.
   */
  function withoutTransition(swap: () => void): void {
    screen.classList.add('is-instant');
    swap();
    void screen.offsetWidth; // land the swapped state in this frame, before the class comes off
    requestAnimationFrame(() => screen.classList.remove('is-instant'));
  }

  function close(silent = false): void {
    if (!open) return;
    open = false;
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    previewSection = null;
    const hide = (): void => {
      delete app.dataset['overlay'];
      screen.setAttribute('aria-hidden', 'true');
      jelly.setActive(false);
    };
    // A silent close is a hand-over to another surface (the entry screen, Add game): it sounds and
    // re-focuses for itself, and announcing this one would fight it.
    if (silent) {
      withoutTransition(hide);
      return;
    }
    hide();
    deps.audio.play('back');
    deps.onClosed();
  }

  function show(): void {
    open = true;
    app.dataset['overlay'] = 'library';
    screen.setAttribute('aria-hidden', 'false');
    sizeJelly();
    jelly.setActive(true);
  }

  // The column count follows the pane's width, which follows the window — and the pane is the only thing
  // that can tell us it changed (--px is tied to the height, so a resize moves both).
  new ResizeObserver(() => {
    if (!open) return;
    measureColumns();
    sizeJelly();
    // Unconditionally, not only when the column count changed: --px is tied to the HEIGHT, so a resize
    // that keeps the columns still moves every card in real px, and the body would otherwise stay
    // wrapped around where the card used to be.
    applyLayout(true);
  }).observe(scrollEl);

  // The wheel drives the SELECTION, not the scrollbar. Left native, the grid would slide out from under
  // a selection that stayed where it was — the one thing this layout must never do.
  scrollEl.addEventListener(
    'wheel',
    (event) => {
      if (!open) return;
      event.preventDefault();
      if (sidebar.hasFocus()) return;
      step(event.deltaY > 0 ? 'down' : 'up', false);
    },
    { passive: false },
  );

  return {
    isOpen: () => open,
    open: (options) => {
      if (open) return;
      show();
      section = 'all';
      previewSection = null;
      index = 0;
      pendingFocusSlug = null;
      entries = deps.getEntries();
      sidebar.render(sidebarEntries());
      sidebar.reset();
      sidebar.setFocused(true);
      sidebar.animateIn();
      renderSection(false);
      // A named entry takes the focus off the sidebar and onto the grid: naming one means the user is
      // here to see it, not to pick a section.
      const wanted = options?.focusSlug;
      if (wanted === undefined) return;
      pendingFocusSlug = wanted;
      focusPending();
    },
    restore: () => {
      if (open) return;
      // With its own entrance, unlike the hand-over OUT of here (see withoutTransition): coming back is
      // the screen arriving, and it should look like it.
      show();
      // The nodes and the scroll position survived the trip, so the screen comes back exactly as it was
      // left — unless a list arrived while it was away, which is where that update finally lands.
      if (stale) {
        stale = false;
        const previousSlug = selectedEntry()?.slug ?? null;
        const previousIndex = index;
        syncNodes(false);
        const restored =
          previousSlug === null ? -1 : shown.findIndex((entry) => entry.slug === previousSlug);
        index = restored === -1 ? clampIndex(previousIndex, 0, shown.length) : restored;
        measureColumns();
      }
      applyLayout(true);
    },
    close,
    setEntries: (list) => {
      entries = list;
      // While the screen is away the grid is left alone entirely — see `stale`.
      if (!open) {
        stale = true;
        return;
      }
      const previousSlug = selectedEntry()?.slug ?? null;
      const previousIndex = index;
      reorderSmoothly(() => syncNodes(true));
      const restored =
        previousSlug === null ? -1 : shown.findIndex((entry) => entry.slug === previousSlug);
      // Held BY IDENTITY: an entry added or removed re-orders the whole list, and a positional cursor
      // would silently land on a different one. When the entry itself is gone, its old place is the
      // nearest thing to where the user was looking.
      index = restored === -1 ? clampIndex(previousIndex, 0, shown.length) : restored;
      if (shown.length === 0) sidebar.setFocused(true);
      measureColumns();
      applyLayout();
      // …unless this list is the one carrying the entry the screen was opened for.
      focusPending();
    },
    setBusyEntry: (slug) => {
      if (slug === busySlug) return;
      busySlug = slug;
      if (open) applyLayout();
    },
    setFlipping: (next) => {
      if (next === flipping) return;
      flipping = next;
      if (!flipping) loadWindowArt();
    },
    coverFor: (slug) => {
      const entry = entries.find((candidate) => candidate.slug === slug);
      return entry === undefined ? null : coverOf(entry);
    },
    // The column repeats on a hold, exactly as the launcher's does — it is a list like any other.
    navUp: (repeat = false) => {
      if (sidebar.hasFocus()) {
        sidebar.move(-1);
        return;
      }
      step('up', repeat);
    },
    navDown: (repeat = false) => {
      if (sidebar.hasFocus()) {
        sidebar.move(1);
        return;
      }
      step('down', repeat);
    },
    navLeft: (repeat = false) => {
      // Left off the column is the edge of the screen.
      if (sidebar.hasFocus()) {
        if (!repeat) deps.audio.playLimit();
        return;
      }
      step('left', repeat);
    },
    navRight: (repeat = false) => {
      if (sidebar.hasFocus()) {
        if (sidebar.selected()?.kind === 'section') enterGrid();
        else deps.audio.playLimit(); // the actions at its foot lead nowhere sideways
        return;
      }
      step('right', repeat);
    },
    navActivate: () => {
      if (sidebar.hasFocus()) {
        sidebar.activate();
        return;
      }
      activateSelected();
    },
    navBack: () => {
      // Out of the grid, back to the column; out of the column, off the screen.
      if (!sidebar.hasFocus()) {
        deps.audio.play('back');
        leaveGrid();
        return;
      }
      close();
    },
    relocalize: () => {
      // The site has no language to switch, so this is only the shape of the contract (nav-surface.ts).
      sidebar.render(sidebarEntries());
      applyEmpty();
    },
  };
}
