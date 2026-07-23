// Interaction layer: the menu popup and its two views, the two focus groups (the bottom bar + the
// popup's vertical stack) and everything that drives them — clicks, hover, gamepad, keyboard, and the
// idle timeout.
//
// Written by hand against playhook @ c348f4246752286b594c8a8eddd2253ea88b0f12 : src/renderer/controls.ts
// rather than trimmed down from it: of its 994 lines only the parts with something left to do here
// survive, and a "reduced port" would have dragged along abstractions with nothing to abstract (the
// ControlsDeps state/translator seam, the confirm/error/power views, the multi-game card model). The
// behaviour it does keep — bottom-anchored default focus, cyclic vertical navigation and CLAMPED
// horizontal navigation, the press flash, back-steps-out, the 5s idle dormancy — is deliberately
// identical to the launcher's. The game list itself lives in game-list.ts.
//
// One deliberate departure remains, because this runs in a browser rather than a kiosk: DOM focus and
// the custom highlight are kept in sync (both directions), so Tab works like the arrow keys do and
// :focus-visible lands on the same control the highlight is on. The launcher suppresses Tab entirely —
// it has no keyboard user to serve. The idle timeout therefore dims ONLY the custom highlight: taking
// :focus-visible away too would leave a keyboard user with no marker of where they were mid-read.
import { createGamepadController } from './gamepad.js';
import { type AudioController } from './audio.js';
import { type Router, type Route } from './router.js';
import { type CollectionEntry } from './collection.js';
import { createGameList, type ListState, type StackItem } from './game-list.js';
import { req, reqQuery } from './dom.js';

// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;

// After this long with no input the cursor hides and the bar highlight goes dormant — the launcher's own
// timeout, restored here on purpose (the first port dropped it).
const IDLE_MS = 5_000;

const REPO_URL = 'https://github.com/sevenns/playhook';
// A bare `<repo>/<path>` is not a GitHub address: reaching a directory needs the `tree/<branch>` segment.
const ENTRY_URL_PREFIX = 'https://github.com/sevenns/playhook-collection/tree/main/';

/** Which view the popup is showing; 'none' means it is closed. */
type PopupView = 'none' | 'details' | 'select-game';

export interface ControlsDeps {
  readonly audio: AudioController;
  readonly router: Router;
}

export interface Controls {
  /** New catalogue data (or a load state) for the list and the Github link. */
  setCollection(state: ListState, entries: readonly CollectionEntry[]): void;
  /** The route changed: relabel Github, re-evaluate the bar group, honour the `#/collection` deep link. */
  onRoute(route: Route, wantsCollection: boolean): void;
  /** Starts the gamepad polling loop. */
  start(): void;
}

export function createControls(deps: ControlsDeps): Controls {
  const { audio, router } = deps;

  const playButton = req<HTMLButtonElement>('play-button');
  const moreButton = req<HTMLButtonElement>('more-button');
  const popup = req('popup');
  const popupVeil = reqQuery<HTMLElement>('#popup .popup-veil');
  const menuGithub = req<HTMLAnchorElement>('menu-github');
  const menuCollection = req<HTMLButtonElement>('menu-collection');
  const menuClose = req<HTMLButtonElement>('menu-close');
  const menuSelectClose = req<HTMLButtonElement>('menu-select-close');
  const searchBox = req('menu-search');
  const searchField = req<HTMLInputElement>('search-field');
  const searchMirror = reqQuery<HTMLElement>('#menu-search .input-mirror');

  const ALL_BAR_BUTTONS: readonly HTMLButtonElement[] = [playButton, moreButton];

  const githubItem: StackItem = { kind: 'button', visual: menuGithub, focusTarget: menuGithub };
  const collectionItem: StackItem = {
    kind: 'button',
    visual: menuCollection,
    focusTarget: menuCollection,
  };
  const closeItem: StackItem = { kind: 'button', visual: menuClose, focusTarget: menuClose };
  const selectCloseItem: StackItem = {
    kind: 'button',
    visual: menuSelectClose,
    focusTarget: menuSelectClose,
  };
  // The one item whose two roles differ: the highlight belongs on the box, DOM focus on the field.
  const searchItem: StackItem = { kind: 'input', visual: searchBox, focusTarget: searchField };

  const ALL_STATIC_ITEMS: readonly StackItem[] = [
    githubItem,
    collectionItem,
    closeItem,
    selectCloseItem,
    searchItem,
  ];

  let popupView: PopupView = 'none';
  let stackIndex = 0;
  let focusIndex = 0;
  // Whether the bar's highlight is "awake". The idle timeout puts it to sleep so a page left alone stops
  // pointing at a button nobody chose; a nav press or a real mouse move brings it back. Read in exactly
  // three places — the paint (applyFocus), the wake (moveFocus / noteMouseActivity) and the activation
  // gate (navActivate). Miss the first and the ring never appears at all.
  let focusRevealed = true;
  let cursorHidden = false;
  let idleTimer = 0;
  let collectionEntries: readonly CollectionEntry[] = [];

  const gameList = createGameList({
    onSelect: (slug) => selectGame(slug),
    onAdoptFocus: (visual) => adoptFocus(visual),
    isVisible: () => popupView === 'select-game',
    focusedVisual: () => stackItems()[stackIndex]?.visual ?? null,
  });

  // ── Moving DOM focus ourselves ───────────────────────────────────────────────

  // Every focus move WE make — an arrow key, the gamepad, closing the popup — must not draw the
  // browser's own focus ring, because `.is-focused` is already painting one indicator and two rings
  // around the same button is just noise. Chromium decides :focus-visible from the last input
  // MODALITY, not from who called focus(): our programmatic focus() lands right after a key press, so
  // it matches. Marking the element lets the CSS opt out; the mark is dropped again on blur, so a
  // genuine Tab back onto the same control still rings — which is the whole reason the ring exists
  // here (see the :focus-visible rule in styles.css).
  const QUIET_FOCUS_CLASS = 'no-focus-ring';

  function focusQuietly(element: HTMLElement): void {
    element.classList.add(QUIET_FOCUS_CLASS);
    element.focus({ preventScroll: true });
  }

  document.addEventListener('focusout', (event) => {
    if (event.target instanceof HTMLElement) event.target.classList.remove(QUIET_FOCUS_CLASS);
  });

  // ── The popup's focus stack ──────────────────────────────────────────────────

  function stackItems(): readonly StackItem[] {
    if (popupView === 'details') return [githubItem, collectionItem, closeItem];
    if (popupView === 'select-game') return [...gameList.items(), searchItem, selectCloseItem];
    return [];
  }

  function applyStackFocus(moveDomFocus = false): void {
    const items = stackItems();
    stackIndex = Math.min(items.length - 1, Math.max(0, stackIndex));
    const focused = popupView === 'none' ? undefined : items[stackIndex];
    for (const item of ALL_STATIC_ITEMS)
      item.visual.classList.toggle('is-focused', item === focused);
    for (const item of gameList.items())
      item.visual.classList.toggle('is-focused', item === focused);
    if (focused !== undefined) {
      focused.visual.scrollIntoView({ block: 'nearest' });
      if (moveDomFocus) focusQuietly(focused.focusTarget);
    }
    gameList.updateMarquee();
    // Reflect the new focus on the scrollbar (it hides when focus leaves the list). NOT an activity
    // ping: applyStackFocus also runs on ordinary rebuilds, which must not keep the thumb awake.
    gameList.updateScrollbar();
  }

  function focusStackBottom(): void {
    // Both views default to the bottom item (Close), which is what the mockups draw as filled. The
    // launcher tops out its own select-game view, but that view has neither an input nor a second
    // button below the list — its rule does not transfer, and the mockup disagrees with it.
    stackIndex = Math.max(0, stackItems().length - 1);
    applyStackFocus(true);
  }

  function moveStackFocus(delta: number): void {
    if (popupView === 'none') return;
    const items = stackItems();
    if (items.length === 0) return;
    // Cyclic (wrap around), as in the launcher. The early return keeps a one-item stack from playing
    // `navigate` without moving: at length 1 the wrap formula returns the same index.
    const next = (stackIndex + delta + items.length) % items.length;
    if (next === stackIndex) return;
    stackIndex = next;
    audio.play('navigate');
    applyStackFocus(true);
  }

  /** Hover or Tab landed on a stack element: move the highlight there, without touching DOM focus. */
  function adoptFocus(visual: HTMLElement): void {
    if (popupView === 'none') return;
    const index = stackItems().findIndex((item) => item.visual === visual);
    if (index === -1) return;
    stackIndex = index;
    applyStackFocus();
  }

  /**
   * Rebuilding the list changes how many items sit above the search box — i.e. its INDEX. Restoring a
   * remembered index instead of the remembered ELEMENT would slide the focus off the field onto a game
   * button, and the second character of a query would never be typed. So: remember the item, find it
   * again, and fall back to the nearest valid position only if it filtered itself away.
   */
  function restoreFocus(previous: StackItem | undefined, moveDomFocus: boolean): void {
    const items = stackItems();
    const index = previous === undefined ? -1 : items.indexOf(previous);
    if (index !== -1) stackIndex = index;
    applyStackFocus(moveDomFocus);
  }

  // ── Popup ────────────────────────────────────────────────────────────────────

  function showPopup(): void {
    popup.classList.add('is-open');
    popup.setAttribute('aria-hidden', 'false');
    // The closed popup only fades out via opacity, so without dropping `inert` its controls would be
    // unreachable now — and without setting it again on close they would stay in the tab order.
    popup.removeAttribute('inert');
  }

  function setView(view: 'details' | 'select-game'): void {
    popupView = view;
    popup.dataset['view'] = view;
  }

  function openDetails(): void {
    showPopup();
    setView('details');
    applyGithubHref();
    focusStackBottom();
    applyFocus(); // the bar highlight clears while the popup is open
  }

  function openGameList(): void {
    showPopup();
    resetSearch();
    setView('select-game');
    // Keep the address bar honest: this IS `#/collection`. replaceState, so opening and closing the
    // menu doesn't fill history with entries and turn the browser's Back button into a toggle.
    router.setCollectionVisible(true);
    focusStackBottom();
    applyFocus();
    gameList.noteActivity();
  }

  function closePopup(): void {
    if (popupView === 'none') return;
    popupView = 'none';
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    popup.setAttribute('inert', '');
    router.setCollectionVisible(false);
    applyStackFocus(); // clear the stack highlight
    applyFocus(); // restore the bar highlight
    focusQuietly(moreButton); // `inert` would otherwise strand focus on <body>
  }

  // Back is a stack, not a single step: the game list falls back to the menu, the menu closes, and a
  // closed popup on a game screen steps out to home (there is no Home item — no mockup draws one).
  function back(): void {
    if (popupView === 'select-game') {
      audio.play('back');
      setView('details');
      router.setCollectionVisible(false);
      focusStackBottom();
      return;
    }
    if (popupView === 'details') {
      audio.play('back');
      closePopup();
      return;
    }
    if (router.current().kind === 'game') {
      audio.play('back');
      router.goHome();
    }
  }

  // ── Bar focus (horizontal) ───────────────────────────────────────────────────

  function barFocusables(): readonly HTMLButtonElement[] {
    // Play only exists on a game screen — the home screen is the launcher's idle screen, and the
    // launcher hides Play there.
    return router.current().kind === 'game' ? [playButton, moreButton] : [moreButton];
  }

  function focusActive(): boolean {
    return popupView === 'none';
  }

  function applyFocus(): void {
    const items = barFocusables();
    focusIndex = Math.min(items.length - 1, Math.max(0, focusIndex));
    const active = focusActive() && focusRevealed;
    for (const btn of ALL_BAR_BUTTONS) {
      const index = items.indexOf(btn);
      btn.classList.toggle('is-focused', active && index !== -1 && index === focusIndex);
    }
  }

  function moveFocus(delta: number): void {
    if (!focusActive()) return;
    // Dormant (the idle timeout cleared the highlight): the first press only WAKES it at the current
    // button — it doesn't move — so control comes back without a jump.
    if (!focusRevealed) {
      focusRevealed = true;
      audio.play('navigate');
      applyFocus();
      return;
    }
    // Clamped, NOT cyclic: the launcher wraps its vertical stacks but stops at the ends of the bar.
    // Hitting the edge is silent — no move, no sound.
    const items = barFocusables();
    const next = Math.min(items.length - 1, Math.max(0, focusIndex + delta));
    if (next === focusIndex) return;
    focusIndex = next;
    audio.play('navigate');
    applyFocus();
  }

  function pressFlash(element: HTMLElement): void {
    element.classList.add('is-pressed');
    window.setTimeout(() => element.classList.remove('is-pressed'), PRESS_MS);
  }

  // ── Search ───────────────────────────────────────────────────────────────────

  /** Mirrors the value into the hidden twin and sizes the field to it (+1px for the caret itself). */
  function syncSearchBox(): void {
    const value = searchField.value;
    searchBox.classList.toggle('is-filled', value !== '');
    searchMirror.textContent = value;
    searchField.style.width = `${searchMirror.offsetWidth + 1}px`;
  }

  function applySearch(): void {
    const previous = stackItems()[stackIndex];
    syncSearchBox();
    gameList.setFilter(searchField.value);
    // Never move DOM focus here: the user is mid-word, and stealing the caret would eat the next key.
    restoreFocus(previous, false);
    gameList.noteActivity();
  }

  function resetSearch(): void {
    searchField.value = '';
    syncSearchBox();
    gameList.setFilter('');
  }

  /** Enter in the field: jump to the first result. Not in the mockups — but leaving Enter inert would
   *  make ArrowUp the only way from a typed query to its result, which is odd for a keyboard user. */
  function focusFirstResult(): void {
    const index = stackItems().findIndex((item) => item.kind === 'game');
    if (index === -1) return;
    stackIndex = index;
    applyStackFocus(true);
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  function applyGithubHref(): void {
    const route = router.current();
    if (route.kind === 'game') {
      // The path comes from the feed, not from a template built here: a reshuffled collection/ would
      // otherwise rot every link silently.
      const entry = collectionEntries.find((candidate) => candidate.slug === route.slug);
      if (entry !== undefined) {
        menuGithub.href = `${ENTRY_URL_PREFIX}${entry.sourcePath}`;
        return;
      }
    }
    menuGithub.href = REPO_URL;
  }

  function triggerPlay(): void {
    // Sound and nothing else. There is no window.api here and no game to launch — the button is in the
    // bar so the page looks like the launcher it advertises. This IS the whole handler.
    audio.play('play');
  }

  function triggerMore(): void {
    audio.play('button');
    openDetails();
  }

  function selectGame(slug: string): void {
    audio.play('button');
    // Explicit, not a side effect of navigating: picking the game you are already on leaves the hash
    // unchanged, so hashchange never fires and nothing else would close the popup.
    closePopup();
    router.go({ kind: 'game', slug });
  }

  function triggerStackItem(item: StackItem): void {
    if (item.kind === 'game') {
      const slug = item.visual.dataset['slug'];
      if (slug === undefined) return;
      selectGame(slug);
      return;
    }
    if (item === searchItem) {
      // There is no on-screen keyboard and there will not be one: a gamepad browses, a keyboard types.
      // A on the field just puts the caret in it.
      focusQuietly(searchField);
      return;
    }
    if (item === githubItem) {
      // A real click on the anchor, so mouse, keyboard and gamepad all take the same path (and the
      // click listener below plays the sound exactly once).
      menuGithub.click();
      return;
    }
    if (item === collectionItem) {
      audio.play('button');
      openGameList();
      return;
    }
    back(); // Close, in either view
  }

  // ── Cursor & the idle timeout ────────────────────────────────────────────────

  function setCursorHidden(hidden: boolean): void {
    if (cursorHidden === hidden) return;
    cursorHidden = hidden;
    document.documentElement.classList.toggle('cursor-hidden', hidden);
  }

  function armIdleTimer(): void {
    if (idleTimer !== 0) window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      idleTimer = 0;
      setCursorHidden(true);
      if (focusRevealed && focusActive()) {
        focusRevealed = false;
        // No sleep class of its own: the highlight simply stops being painted, and the Play ring goes
        // with it. Both already transition over 0.2s, so the fade costs no extra CSS.
        applyFocus();
      }
    }, IDLE_MS);
  }

  /** Gamepad or keyboard navigation: the user has visibly left the mouse alone, so hide the pointer. */
  function noteNavActivity(): void {
    setCursorHidden(true);
    armIdleTimer();
    gameList.noteActivity();
  }

  /** Real mouse movement: show the pointer, and bring the dormant highlight back with it (silently —
   *  moving a mouse is not a navigation press and should not sound like one). */
  function noteMouseActivity(): void {
    setCursorHidden(false);
    armIdleTimer();
    if (!focusRevealed) {
      focusRevealed = true;
      applyFocus();
    }
    gameList.noteActivity();
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────

  playButton.addEventListener('click', () => triggerPlay());
  moreButton.addEventListener('click', () => triggerMore());
  popupVeil.addEventListener('click', () => back());

  for (const btn of ALL_BAR_BUTTONS) {
    // Hover moves the highlight, so a mouse click always fires the button that looks active.
    btn.addEventListener('mouseenter', () => {
      if (!focusActive()) return;
      const index = barFocusables().indexOf(btn);
      if (index === -1) return;
      focusIndex = index;
      focusRevealed = true;
      applyFocus();
    });
    // DOM focus (Tab, or a click) adopts the highlight too, so the two focus models can never point at
    // different buttons — which would make Enter fire something other than what looks focused.
    btn.addEventListener('focus', () => {
      if (!focusActive()) return;
      const index = barFocusables().indexOf(btn);
      if (index === -1) return;
      focusIndex = index;
      applyFocus();
    });
  }

  // The static stack controls. Github is an <a>: its click listener only plays the sound and lets the
  // navigation happen, so the scripted .click() above needs no second code path.
  menuGithub.addEventListener('click', () => audio.play('button'));
  for (const item of ALL_STATIC_ITEMS) {
    if (item !== searchItem && item !== githubItem) {
      item.visual.addEventListener('click', () => {
        pressFlash(item.visual);
        triggerStackItem(item);
      });
    }
    item.visual.addEventListener('mouseenter', () => adoptFocus(item.visual));
    item.focusTarget.addEventListener('focus', () => adoptFocus(item.visual));
  }

  // Clicking anywhere in the search box means "put the caret here", including the "Search" label — which
  // is not the field, so the browser would not do it for us.
  searchBox.addEventListener('mousedown', (event) => {
    if (event.target === searchField) return;
    event.preventDefault();
    focusQuietly(searchField);
  });
  searchField.addEventListener('input', () => applySearch());

  // One window-level mouse handler, guarded against SYNTHETIC moves (Chromium fires mousemove with
  // unchanged coordinates when an element shifts under a still pointer) so they can't undo a gamepad
  // cursor-hide — or, now, silently reset the idle countdown. A real move brings the cursor back.
  let lastMouseX = -1;
  let lastMouseY = -1;
  window.addEventListener('mousemove', (event) => {
    if (event.clientX === lastMouseX && event.clientY === lastMouseY) return; // synthetic — ignore
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    noteMouseActivity();
  });

  // The six navigation primitives, shared by the gamepad AND the keyboard so both drive the exact same
  // highlight model and can never diverge. Left/right move the bar; up/down move the popup stack;
  // activate fires the highlighted control; back walks the view stack out.
  function navLeft(): void {
    moveFocus(-1);
  }
  function navRight(): void {
    moveFocus(1);
  }
  function navUp(): void {
    moveStackFocus(-1);
  }
  function navDown(): void {
    moveStackFocus(1);
  }
  function navActivate(): void {
    if (popupView !== 'none') {
      const item = stackItems()[stackIndex];
      if (item === undefined) return;
      pressFlash(item.visual);
      triggerStackItem(item);
      return;
    }
    // Nothing is selected while the highlight is dormant — the user must wake it first. A mouse CLICK
    // still works: it goes nowhere near this gate.
    if (!focusRevealed) return;
    const btn = barFocusables()[focusIndex];
    if (btn === undefined) return;
    pressFlash(btn);
    if (btn === moreButton) triggerMore();
    else triggerPlay();
  }
  function navBack(): void {
    back();
  }

  // Both input models count as activity (and hide the cursor: the user has switched device).
  const withActivity =
    (nav: () => void): (() => void) =>
    (): void => {
      noteNavActivity();
      nav();
    };

  const gamepad = createGamepadController({
    onLeft: withActivity(navLeft),
    onRight: withActivity(navRight),
    onUp: withActivity(navUp),
    onDown: withActivity(navDown),
    onA: withActivity(navActivate),
    onB: withActivity(navBack),
  });

  // Keyboard navigation: WASD + arrows move, Space/Enter activate, Backspace/Esc step back — the same
  // six primitives as the gamepad. Edge-only (event.repeat ignored) to match the gamepad's
  // one-move-per-press feel. Unlike the launcher, Tab is NOT bound to "back": on a public page it has to
  // keep doing what every keyboard user expects, and the focus sync above makes it agree with the
  // highlight.
  const KEY_NAV: Readonly<Record<string, () => void>> = {
    a: navLeft,
    arrowleft: navLeft,
    d: navRight,
    arrowright: navRight,
    w: navUp,
    arrowup: navUp,
    s: navDown,
    arrowdown: navDown,
    ' ': navActivate,
    enter: navActivate,
    backspace: navBack,
    escape: navBack,
  };

  /**
   * Keys while the caret is in the search field. The table above claims w/a/s/d, Space, Enter and
   * Backspace and preventDefault()s all of them — so without this branch "Dark Souls" could not be typed
   * and Backspace would never delete anything. Here only four keys stay navigation; everything else,
   * including the arrows for caret movement, goes to the field untouched.
   */
  function handleTypingKey(event: KeyboardEvent): void {
    const key = event.key.toLowerCase();
    if (key === 'arrowup' || key === 'arrowdown') {
      event.preventDefault();
      if (event.repeat) return;
      noteNavActivity();
      moveStackFocus(key === 'arrowup' ? -1 : 1);
      return;
    }
    if (key === 'escape') {
      event.preventDefault();
      if (event.repeat) return;
      noteNavActivity();
      // A typed query is what Escape clears first; only an already-empty field steps out.
      if (searchField.value !== '') {
        resetSearch();
        applyStackFocus();
        return;
      }
      back();
      return;
    }
    if (key === 'enter') {
      event.preventDefault();
      if (event.repeat) return;
      noteNavActivity();
      focusFirstResult();
      return;
    }
    // Typing is activity too — otherwise the highlight would doze off mid-query.
    armIdleTimer();
  }

  window.addEventListener('keydown', (event) => {
    if (event.target === searchField) {
      handleTypingKey(event);
      return;
    }
    const handler = KEY_NAV[event.key.toLowerCase()];
    if (handler === undefined) return;
    // Suppress the native default (arrow scroll, Space scroll, and the native click a focused button
    // would fire on Enter/Space — which would double-trigger alongside navActivate).
    event.preventDefault();
    if (event.repeat) return; // one action per press, like the gamepad edge model
    noteNavActivity();
    handler();
  });

  syncSearchBox();
  applyFocus();
  armIdleTimer();

  return {
    setCollection(state: ListState, entries: readonly CollectionEntry[]): void {
      collectionEntries = entries;
      const previous = stackItems()[stackIndex];
      gameList.setData(state, entries);
      restoreFocus(previous, false);
      applyGithubHref();
    },

    onRoute(_route: Route, wantsCollection: boolean): void {
      // More is the one button on every screen, so keep the bar focus there across a route change
      // rather than letting a clamped index land on whichever button now occupies that slot.
      focusIndex = barFocusables().indexOf(moreButton);
      applyGithubHref();
      applyFocus();
      if (wantsCollection && popupView !== 'select-game') openGameList();
    },

    start: (): void => gamepad.start(),
  };
}
