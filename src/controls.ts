// Interaction layer: the menu popup, the two focus groups (the bottom bar + the popup's vertical action
// stack) and everything that drives them — clicks, hover, gamepad, keyboard.
//
// Written by hand against playhook @ c348f4246752286b594c8a8eddd2253ea88b0f12 : src/renderer/controls.ts
// rather than trimmed down from it: of its 994 lines maybe 130 survive here, and a "reduced port" would
// have dragged along abstractions with nothing left to abstract (the ControlsDeps state/translator seam,
// the four-view popup machine, the game list with its marquee and custom scrollbar, the idle timer).
// The behaviour it does keep — bottom-anchored default focus, cyclic vertical navigation, the press
// flash, back-steps-out — is deliberately identical to the launcher's.
//
// Two deliberate departures from the launcher, both because this runs in a browser rather than a kiosk:
//   • the idle timer is gone. In the launcher it dims the focus ring and hides the cursor after 5s;
//     a web page that hides your pointer while you read is hostile. The gamepad still hides it, since
//     there the user has visibly switched input device. `focusRevealed` therefore collapses to a
//     constant — miss that when porting and the focus ring never appears at all.
//   • DOM focus and the custom highlight are kept in sync (both directions), so Tab works like the
//     arrow keys do and :focus-visible lands on the same button the highlight is on. The launcher
//     suppresses Tab entirely — it has no keyboard user to serve.
import { createGamepadController } from './gamepad.js';
import { type AudioController } from './audio.js';
import { type Router } from './router.js';
import { req, reqQuery } from './dom.js';

// Gamepad A doesn't trigger :active, so flash a press class to play the scale-down animation.
const PRESS_MS = 130;

export interface ControlsDeps {
  readonly audio: AudioController;
  readonly router: Router;
}

export interface Controls {
  /** Re-labels the menu's route button for the current route. */
  refresh(): void;
  /** Starts the gamepad polling loop. */
  start(): void;
}

export function createControls(deps: ControlsDeps): Controls {
  const { audio, router } = deps;

  const moreButton = req<HTMLButtonElement>('more-button');
  const popup = req('popup');
  const popupVeil = reqQuery<HTMLElement>('#popup .popup-veil');
  const menuRoute = req<HTMLButtonElement>('menu-route');
  const menuClose = req<HTMLButtonElement>('menu-close');

  const STACK_BUTTONS: readonly HTMLButtonElement[] = [menuRoute, menuClose];

  let popupOpen = false;
  let stackIndex = 0;

  // ── Popup ────────────────────────────────────────────────────────────────────

  function openPopup(): void {
    popupOpen = true;
    popup.classList.add('is-open');
    popup.setAttribute('aria-hidden', 'false');
    // The closed popup only fades out via opacity, so without dropping `inert` its buttons would be
    // unreachable now — and without setting it again on close they would stay in the tab order.
    popup.removeAttribute('inert');
    focusStackBottom(); // default focus: Close, the bottom button (the mockup draws it filled)
    applyFocus(); // the bar highlight clears while the popup is open
  }

  function closePopup(): void {
    if (!popupOpen) return;
    popupOpen = false;
    popup.classList.remove('is-open');
    popup.setAttribute('aria-hidden', 'true');
    popup.setAttribute('inert', '');
    applyStackFocus(); // clear the stack highlight
    applyFocus(); // restore the bar highlight
    moreButton.focus({ preventScroll: true }); // `inert` would otherwise strand focus on <body>
  }

  // B / Esc / Backspace / a click on the veil: step out. The launcher's back() walks a view stack;
  // here there is one level, so it is just a close (with the same sound).
  function back(): void {
    if (!popupOpen) return;
    audio.play('back');
    closePopup();
  }

  // ── Bar focus ────────────────────────────────────────────────────────────────
  // The launcher picks the focusable bar buttons from the game state; on the empty screen that set is
  // always [More], and the empty screen is all this site has.

  function applyFocus(): void {
    moreButton.classList.toggle('is-focused', !popupOpen);
  }

  // ── Popup stack focus (vertical) ─────────────────────────────────────────────

  function applyStackFocus(moveDomFocus = false): void {
    stackIndex = Math.min(STACK_BUTTONS.length - 1, Math.max(0, stackIndex));
    const focused = popupOpen ? STACK_BUTTONS[stackIndex] : undefined;
    for (const btn of STACK_BUTTONS) btn.classList.toggle('is-focused', btn === focused);
    if (moveDomFocus && focused !== undefined) focused.focus({ preventScroll: true });
  }

  function focusStackBottom(): void {
    stackIndex = STACK_BUTTONS.length - 1;
    applyStackFocus(true);
  }

  function moveStackFocus(delta: number): void {
    if (!popupOpen) return;
    // Cyclic navigation (wrap around), as in the launcher.
    const next = (stackIndex + delta + STACK_BUTTONS.length) % STACK_BUTTONS.length;
    if (next === stackIndex) return;
    stackIndex = next;
    audio.play('navigate');
    applyStackFocus(true);
  }

  function pressFlash(btn: HTMLElement): void {
    btn.classList.add('is-pressed');
    window.setTimeout(() => btn.classList.remove('is-pressed'), PRESS_MS);
  }

  // ── Actions ──────────────────────────────────────────────────────────────────

  function refresh(): void {
    menuRoute.textContent = router.other().label;
  }

  function triggerMore(): void {
    audio.play('button');
    openPopup();
  }

  function triggerStackButton(btn: HTMLButtonElement): void {
    if (btn === menuRoute) {
      audio.play('button');
      closePopup();
      router.go(router.other().route);
      return;
    }
    // Close. NOT window.close(): a tab the script didn't open can't be closed by script anyway, and the
    // launcher's Close means "close this menu" too.
    back();
  }

  // ── Cursor ───────────────────────────────────────────────────────────────────

  let cursorHidden = false;

  function setCursorHidden(hidden: boolean): void {
    if (cursorHidden === hidden) return;
    cursorHidden = hidden;
    document.documentElement.classList.toggle('cursor-hidden', hidden);
  }

  // ── Wiring ───────────────────────────────────────────────────────────────────

  moreButton.addEventListener('click', () => triggerMore());
  popupVeil.addEventListener('click', () => back());

  for (const btn of STACK_BUTTONS) {
    btn.addEventListener('click', () => {
      pressFlash(btn);
      triggerStackButton(btn);
    });
    // Hover moves the highlight, so a mouse click always fires the button that looks active.
    btn.addEventListener('mouseenter', () => {
      if (!popupOpen) return;
      stackIndex = STACK_BUTTONS.indexOf(btn);
      applyStackFocus();
    });
  }

  // DOM focus (Tab, or a click) adopts the highlight, so the two focus models can never point at
  // different buttons — which would make Enter fire something other than what looks focused.
  for (const btn of STACK_BUTTONS) {
    btn.addEventListener('focus', () => {
      if (!popupOpen) return;
      stackIndex = STACK_BUTTONS.indexOf(btn);
      applyStackFocus();
    });
  }

  // One window-level mouse handler, guarded against SYNTHETIC moves (Chromium fires mousemove with
  // unchanged coordinates when an element shifts under a still pointer) so they can't undo a gamepad
  // cursor-hide. A real move brings the cursor back.
  let lastMouseX = -1;
  let lastMouseY = -1;
  window.addEventListener('mousemove', (event) => {
    if (event.clientX === lastMouseX && event.clientY === lastMouseY) return; // synthetic — ignore
    lastMouseX = event.clientX;
    lastMouseY = event.clientY;
    setCursorHidden(false);
  });

  // The six navigation primitives, shared by the gamepad AND the keyboard so both drive the exact same
  // highlight model and can never diverge. Left/right move the bar — which holds a single button here,
  // so they have nothing to do; up/down move the popup stack; activate fires the highlighted control;
  // back steps out of the popup. Hiding the cursor is NOT part of them: only the gamepad does that (see
  // padNav below), because only there has the user actually put the mouse down.
  function navLeft(): void {
    /* The bar has one button — nothing to move between. Kept so both input models stay symmetric. */
  }
  function navRight(): void {
    /* See navLeft. */
  }
  function navUp(): void {
    moveStackFocus(-1);
  }
  function navDown(): void {
    moveStackFocus(1);
  }
  function navActivate(): void {
    if (popupOpen) {
      const btn = STACK_BUTTONS[stackIndex];
      if (btn === undefined) return;
      pressFlash(btn);
      triggerStackButton(btn);
      return;
    }
    pressFlash(moreButton);
    triggerMore();
  }
  function navBack(): void {
    back();
  }

  // Gamepad input means the user has left the mouse alone: hide the pointer, then run the primitive.
  const padNav =
    (nav: () => void): (() => void) =>
    (): void => {
      setCursorHidden(true);
      nav();
    };

  const gamepad = createGamepadController({
    onLeft: padNav(navLeft),
    onRight: padNav(navRight),
    onUp: padNav(navUp),
    onDown: padNav(navDown),
    onA: padNav(navActivate),
    onB: padNav(navBack),
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
  window.addEventListener('keydown', (event) => {
    const handler = KEY_NAV[event.key.toLowerCase()];
    if (handler === undefined) return;
    // Suppress the native default (arrow scroll, Space scroll, and the native click a focused button
    // would fire on Enter/Space — which would double-trigger alongside navActivate).
    event.preventDefault();
    if (event.repeat) return; // one action per press, like the gamepad edge model
    handler();
  });

  applyFocus();

  return {
    refresh,
    start: (): void => gamepad.start(),
  };
}
