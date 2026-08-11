// Interaction layer: the menu popup, the three focus surfaces (the carousel strip, the bottom bar and
// the popup's vertical stack) and everything that drives them — clicks, hover, wheel, gamepad, keyboard,
// and the idle timeout.
//
// Written by hand against playhook @ 4461c60e75e18d98d77e80e70b9394e0bd0731a5 : src/renderer/controls.ts
// rather than trimmed down from it: of its 1000-odd lines only the parts with something left to do here
// survive, and a "reduced port" would have dragged along abstractions with nothing to abstract (the
// ControlsDeps state/translator seam, the confirm/error/power views, the multi-game card model). The
// behaviour it does keep — bottom-anchored default focus, cyclic vertical navigation and CLAMPED
// horizontal navigation, the press flash, back-steps-out, the 5s idle dormancy, and the routing of the
// six nav primitives across the three surfaces — is deliberately identical to the launcher's. The strip
// itself lives in carousel.ts.
//
// One deliberate departure remains, because this runs in a browser rather than a kiosk: DOM focus and
// the custom highlight are kept in sync (both directions), so Tab works like the arrow keys do and
// :focus-visible lands on the same control the highlight is on. The launcher suppresses Tab entirely —
// it has no keyboard user to serve. The idle timeout therefore dims ONLY the custom highlight: taking
// :focus-visible away too would leave a keyboard user with no marker of where they were mid-read.
import { NAV_REPEAT_MS, createGamepadController } from './gamepad.js';
import { type AudioController } from './audio.js';
import { type Router } from './router.js';
import { type CollectionEntry, type ListState } from './collection.js';
import { type Carousel } from './carousel.js';
import { formatDate, formatPlaytime, statsFor } from './stats.js';
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
type PopupView = 'none' | 'details';

/**
 * One entry in the popup's vertical focus stack. Two roles because they diverged for the search box the
 * launcher still has; kept as a pair so a future item with the same split needs no reshaping here.
 */
interface StackItem {
  readonly kind: 'button';
  /** Carries `.is-focused`. */
  readonly visual: HTMLElement;
  /** Where DOM focus goes. */
  readonly focusTarget: HTMLElement;
}

export interface ControlsDeps {
  readonly audio: AudioController;
  readonly router: Router;
  /** The carousel — the THIRD focus surface, above the bar and the popup stack (see navLeft…). */
  readonly carousel: Carousel;
}

export interface Controls {
  /** New catalogue data (or a load state) for the Github link and the Library item. */
  setCollection(state: ListState, entries: readonly CollectionEntry[]): void;
  /** The route changed: relabel Github, re-evaluate the bar group and the menu. */
  onRoute(): void;
  /** The carousel switched level: the bar highlight only exists off the strip. */
  onScreen(): void;
  /** Starts the gamepad polling loop. */
  start(): void;
}

export function createControls(deps: ControlsDeps): Controls {
  const { audio, router, carousel } = deps;

  const playButton = req<HTMLButtonElement>('play-button');
  const moreButton = req<HTMLButtonElement>('more-button');
  const popup = req('popup');
  const popupVeil = reqQuery<HTMLElement>('#popup .popup-veil');
  const infoPanel = req('info-panel');
  const menuGithub = req<HTMLAnchorElement>('menu-github');
  const menuLibrary = req<HTMLButtonElement>('menu-library');
  const menuClose = req<HTMLButtonElement>('menu-close');

  const ALL_BAR_BUTTONS: readonly HTMLButtonElement[] = [playButton, moreButton];

  const githubItem: StackItem = { kind: 'button', visual: menuGithub, focusTarget: menuGithub };
  const libraryItem: StackItem = { kind: 'button', visual: menuLibrary, focusTarget: menuLibrary };
  const closeItem: StackItem = { kind: 'button', visual: menuClose, focusTarget: menuClose };

  const ALL_STATIC_ITEMS: readonly StackItem[] = [githubItem, libraryItem, closeItem];

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

  // ── Focus-ring modality ───────────────────────────────────────────────────────
  //
  // The browser's :focus-visible ring is the keyboard user's marker — it must survive the 5s idle
  // timeout (which only dims OUR .is-focused fill, never DOM focus), so it can't simply be switched off.
  // But it must NOT show for a mouse or gamepad user, whose selection the fill already marks. Chromium
  // decides :focus-visible from the last input MODALITY and gets two things wrong for us: our
  // programmatic focus() lands right after a nav key and reads as "keyboard", and after an alt-tab it
  // re-applies the ring to whatever it restores focus to. So we own the modality: only a real Tab arms
  // it (html.kbd-focus), and a pointer, a gamepad/arrow move, or a focus WE perform disarms it. One flag
  // as the source of truth is what stops switching browser tabs from resurrecting the ring — the earlier
  // per-element mark was cleared on focusout (tab-away) and never restored on the browser's focus-back.
  function setKeyboardMode(on: boolean): void {
    document.documentElement.classList.toggle('kbd-focus', on);
  }

  // A real Tab is the only thing that arms the ring. Capture phase so it wins regardless of target, and
  // never preventDefault — Tab must still move focus natively.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Tab') setKeyboardMode(true);
    },
    true,
  );
  // Any pointer press means a mouse user — drop the ring.
  window.addEventListener('pointerdown', () => setKeyboardMode(false), true);

  /** Focus an element WE chose (not the user Tabbing): the ring must not follow. */
  function focusQuietly(element: HTMLElement): void {
    setKeyboardMode(false);
    element.focus({ preventScroll: true });
  }

  // ── The popup's focus stack ──────────────────────────────────────────────────

  /**
   * Library is the only door to the carousel — in, from the landing page, and back, from an entry. It
   * hides only where there is nothing behind it: a catalogue too short to flip through. (The menu never
   * opens over the strip itself, so "already there" is not a case.)
   */
  function libraryVisible(): boolean {
    return carousel.exists();
  }

  function applyMenuLibrary(): void {
    menuLibrary.classList.toggle('is-hidden', !libraryVisible());
  }

  function stackItems(): readonly StackItem[] {
    if (popupView !== 'details') return [];
    return libraryVisible() ? [githubItem, libraryItem, closeItem] : [githubItem, closeItem];
  }

  function applyStackFocus(moveDomFocus = false): void {
    const items = stackItems();
    stackIndex = Math.min(items.length - 1, Math.max(0, stackIndex));
    const focused = popupView === 'none' ? undefined : items[stackIndex];
    for (const item of ALL_STATIC_ITEMS)
      item.visual.classList.toggle('is-focused', item === focused);
    if (focused !== undefined) {
      focused.visual.scrollIntoView({ block: 'nearest' });
      if (moveDomFocus) focusQuietly(focused.focusTarget);
    }
  }

  function focusStackBottom(): void {
    // The view defaults to the bottom item (Close), which is what the mockups draw as filled.
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
   * The Library item comes and goes with the route, i.e. it changes how many items sit above the
   * others — their INDEX. Restoring a remembered index instead of the remembered ELEMENT would slide the
   * highlight onto a different button. So: remember the item, find it again, and fall back to the
   * nearest valid position only if it left the stack.
   */
  function restoreFocus(previous: StackItem | undefined, moveDomFocus: boolean): void {
    const items = stackItems();
    const index = previous === undefined ? -1 : items.indexOf(previous);
    if (index !== -1) stackIndex = index;
    applyStackFocus(moveDomFocus);
  }

  // ── Info panel (the entry's play statistics) ─────────────────────────────────

  function infoItem(label: string, value: string): HTMLElement {
    const item = document.createElement('div');
    item.className = 'info-item';
    const labelEl = document.createElement('div');
    labelEl.className = 'info-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'info-value';
    valueEl.textContent = value;
    item.append(labelEl, valueEl);
    return item;
  }

  /**
   * Statistics belong to an ENTRY, so the panel is empty on the landing page — the same rule the launcher
   * follows on its "Insert a game card" screen, where stale numbers under a menu that no longer describes
   * a game would be worse than nothing.
   */
  function applyInfoPanel(): void {
    const route = router.current();
    const entry =
      route.kind === 'game'
        ? collectionEntries.find((candidate) => candidate.slug === route.slug)
        : undefined;
    if (entry === undefined) {
      infoPanel.replaceChildren();
      return;
    }
    const stats = statsFor(entry.slug);
    infoPanel.replaceChildren(
      infoItem('Last played', formatDate(stats.lastPlayedAt)),
      infoItem('Playtime', formatPlaytime(stats.totalPlaySeconds)),
      infoItem('Launches', String(stats.launchCount)),
    );
  }

  // ── Popup ────────────────────────────────────────────────────────────────────

  function openDetails(): void {
    popupView = 'details';
    popup.classList.add('is-open');
    popup.setAttribute('aria-hidden', 'false');
    // The closed popup only fades out via opacity, so without dropping `inert` its controls would be
    // unreachable now — and without setting it again on close they would stay in the tab order.
    popup.removeAttribute('inert');
    applyGithubHref();
    applyInfoPanel();
    applyMenuLibrary();
    focusStackBottom();
    applyFocus(); // the bar highlight clears while the popup is open
  }

  function closePopup(): void {
    if (popupView === 'none') return;
    popupView = 'none';
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    popup.setAttribute('inert', '');
    applyStackFocus(); // clear the stack highlight
    applyFocus(); // restore the bar highlight
    focusQuietly(moreButton); // `inert` would otherwise strand focus on <body>
  }

  /**
   * Library: to the carousel. From an entry that is a step BACK to a different place, so it pushes a
   * history entry; from the landing page the strip is a layer over where you already are, so the hash is
   * replaced instead — the same distinction `back()` relies on.
   */
  function openCarousel(): void {
    closePopup();
    if (router.current().kind === 'game') router.goCollection();
    else router.showCollection();
  }

  // Back is a stack, not a single step: the menu closes, then the carousel steps back to the bare landing
  // page, and an entry screen steps out to whatever it was opened from. In the launcher the carousel IS
  // the top level and B does nothing there; here it sits over home, so leaving it is a real step — and
  // without it a gamepad or keyboard user would be stuck on the strip (the bar buttons are unreachable
  // from it, exactly as in the launcher).
  function back(): void {
    if (popupView === 'details') {
      audio.play('back');
      closePopup();
      return;
    }
    if (carousel.screen() === 'carousel') {
      audio.play('back');
      router.setCollectionVisible(false);
      return;
    }
    if (router.current().kind === 'game') {
      audio.play('back');
      router.goHome();
    }
  }

  // ── Bar focus (horizontal) ───────────────────────────────────────────────────

  function barFocusables(): readonly HTMLButtonElement[] {
    // Play only exists on an entry screen — the landing page is the launcher's idle screen, and the
    // launcher hides Play there.
    return router.current().kind === 'game' ? [playButton, moreButton] : [moreButton];
  }

  /**
   * The bar highlight is meaningful everywhere the popup is closed EXCEPT on the carousel: there the
   * selection lives in the strip, left/right belong to it, and the bar buttons are hidden anyway (Play is
   * the card's stand-in, More is faded out — see styles.css), so the highlight has nothing to sit on.
   */
  function focusActive(): boolean {
    return popupView === 'none' && carousel.screen() !== 'carousel';
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

  function triggerStackItem(item: StackItem): void {
    if (item === githubItem) {
      // A real click on the anchor, so mouse, keyboard and gamepad all take the same path (and the
      // click listener below plays the sound exactly once).
      menuGithub.click();
      return;
    }
    if (item === libraryItem) {
      // Leaving an entry for the strip is a step back; opening the strip from the landing page is not.
      audio.play(router.current().kind === 'game' ? 'back' : 'button');
      openCarousel();
      return;
    }
    back(); // Close
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

  /** Gamepad or keyboard navigation: the user has visibly left the mouse alone, so hide the pointer.
   *  This is our OWN navigation (WASD/arrows/gamepad), which paints the .is-focused fill — so it also
   *  disarms the native ring, which is reserved for a plain Tab. */
  function noteNavActivity(): void {
    setCursorHidden(true);
    setKeyboardMode(false);
    armIdleTimer();
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
    if (item !== githubItem) {
      item.visual.addEventListener('click', () => {
        pressFlash(item.visual);
        triggerStackItem(item);
      });
    }
    item.visual.addEventListener('mouseenter', () => adoptFocus(item.visual));
    item.focusTarget.addEventListener('focus', () => adoptFocus(item.visual));
  }

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
  // model and can never diverge. Which SURFACE they drive is decided here, in one place: the popup stack
  // when it is open, then the carousel strip, then the bar.
  const onCarousel = (): boolean => popupView === 'none' && carousel.screen() === 'carousel';

  function navLeft(): void {
    if (onCarousel()) carousel.move(-1);
    else moveFocus(-1);
  }
  function navRight(): void {
    if (onCarousel()) carousel.move(1);
    else moveFocus(1);
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
    if (onCarousel()) {
      carousel.activate();
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

  // The wheel flips through the carousel. Throttled: one notch of a mouse wheel is one event, but a
  // trackpad emits a stream of them, which would fly past a dozen cards per gesture.
  const WHEEL_THROTTLE_MS = 120;
  let lastWheelAt = 0;
  window.addEventListener(
    'wheel',
    (event) => {
      if (!onCarousel()) return;
      noteMouseActivity();
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      const now = performance.now();
      if (now - lastWheelAt < WHEEL_THROTTLE_MS) return;
      lastWheelAt = now;
      carousel.move(delta > 0 ? 1 : -1);
    },
    { passive: true },
  );

  // Keyboard navigation: WASD + arrows move, Space/Enter activate, Backspace/Esc step back — the same
  // six primitives as the gamepad. Unlike the launcher, Tab is NOT bound to "back": on a public page it
  // has to keep doing what every keyboard user expects, and the focus sync above makes it agree with the
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
  // Left/right are the exception to the edge model: holding them flips through the carousel, matching the
  // gamepad's hold-to-repeat. The OS auto-repeat supplies the events (its own initial delay is close
  // enough to the pad's), but its rate is far too fast for a carousel, so it is throttled to the same
  // NAV_REPEAT_MS cadence. Every other key stays one action per press.
  const REPEATABLE_KEYS = new Set(['a', 'arrowleft', 'd', 'arrowright']);
  let lastKeyRepeatAt = 0;

  window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();
    const handler = KEY_NAV[key];
    if (handler === undefined) return;
    // Suppress the native default (arrow scroll, Space scroll, and the native click a focused button
    // would fire on Enter/Space — which would double-trigger alongside navActivate).
    event.preventDefault();
    if (event.repeat) {
      if (!REPEATABLE_KEYS.has(key)) return;
      const now = performance.now();
      if (now - lastKeyRepeatAt < NAV_REPEAT_MS) return;
      lastKeyRepeatAt = now;
    }
    noteNavActivity();
    handler();
  });

  applyMenuLibrary();
  applyFocus();
  armIdleTimer();

  return {
    setCollection(state: ListState, entries: readonly CollectionEntry[]): void {
      collectionEntries = state === 'ready' ? entries : [];
      const previous = stackItems()[stackIndex];
      applyMenuLibrary();
      restoreFocus(previous, false);
      applyGithubHref();
      // The feed can land with the menu already open on a cold deep link — fill the panel that was empty.
      applyInfoPanel();
    },

    onRoute(): void {
      // More is the one button on every screen, so keep the bar focus there across a route change
      // rather than letting a clamped index land on whichever button now occupies that slot.
      focusIndex = barFocusables().indexOf(moreButton);
      applyGithubHref();
      applyMenuLibrary();
      applyFocus();
    },

    onScreen(): void {
      applyMenuLibrary();
      applyFocus();
    },

    start: (): void => gamepad.start(),
  };
}
