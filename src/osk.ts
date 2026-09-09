// The on-screen keyboard. Ported from playhook @ c26fae7 (release/v0.8.0) : src/renderer/osk.ts.
//
// In the launcher it is the ONLY way to type: its UI has no `<input>` anywhere, and the Steam Deck's own
// keyboard is reachable only from a game Steam itself launched. On a web page a physical keyboard is
// always at hand — but a GAMEPAD is not served by one, and this site answers a gamepad everywhere else
// (see gamepad.ts), so the surface comes across whole. Typing on the physical keyboard writes straight
// through it, exactly as it does in the launcher.
//
// Three modes and three layouts, and the pairing matters: `id` is constrained to what the manifest schema
// accepts (`[A-Za-z0-9._-]`) and therefore never offers Cyrillic, while `title` — the game's own visible
// name — must, because a Russian game has a Russian name. `number` is digits and nothing else.
//
// Every control (Shift, Backspace, Space, the layout switch, Done, Cancel) is a KEY on the grid as well
// as a button shortcut, so the keyboard is complete with the d-pad and A alone; the shortcuts (X, Y,
// LB/RB) are the faster path for someone who knows them.
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createEntrance } from './entrance.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex, wrapIndex } from './index-math.js';
import {
  caretFromOffset,
  charsOf,
  clampCaret,
  deleteAfter,
  deleteBefore,
  insertAt,
  moveCaret,
  sanitize,
  splitAtCaret,
  type TextState,
} from './osk-text.js';
import type { NavSurface } from './nav-surface.js';

const PRESS_MS = 130;
/** The most a single paste may bring in. A manifest field is a title or a path — never a document. */
const PASTE_MAX_CHARS = 512;

export type OskMode = 'text' | 'id' | 'number';
type Layout = 'en' | 'ru' | 'symbols';

/**
 * What a screen sees of the keyboard. In the launcher this contract lives in game-settings-screen.ts,
 * next to the other surfaces that screen opens; here the keyboard is the only one, so it declares it.
 */
export interface TextEntrySurface extends NavSurface {
  open(request: {
    readonly value: string;
    readonly mode: OskMode;
    readonly title: string;
    readonly onDone: (value: string) => void;
  }): void;
  /**
   * Dismisses the keyboard without committing. Called when a SCREEN closes under it: the keyboard is not
   * inside any screen (see #osk in index.html), so nothing else would take it off the display — it would
   * stay up over the carousel, still holding the focus of a screen that is gone.
   */
  close(): void;
}

/**
 * The keys' own labels. The launcher reads them from its i18n layer; the site has none, so they are its
 * English strings verbatim (`osk.*` in the launcher's en.ts).
 */
const LABEL = {
  shift: 'Shift',
  backspace: 'Delete',
  space: 'Space',
  done: 'Done',
  cancel: 'Cancel',
  paste: 'Paste',
  legendDelete: 'X - delete',
  legendShift: 'Y - shift',
  legendLayout: 'LB/RB - layout',
  legendDone: 'RT - done',
  legendCancel: 'B - cancel',
} as const;

type Key =
  | { readonly kind: 'char'; readonly value: string }
  | { readonly kind: 'shift' }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'space' }
  | { readonly kind: 'layout' }
  | { readonly kind: 'caret-left' }
  | { readonly kind: 'caret-right' }
  | { readonly kind: 'paste' }
  | { readonly kind: 'done' }
  | { readonly kind: 'cancel' };

const char = (value: string): Key => ({ kind: 'char', value });
const chars = (source: string): readonly Key[] => [...source].map(char);

const EN_ROWS: readonly (readonly Key[])[] = [
  chars('1234567890'),
  chars('qwertyuiop'),
  chars('asdfghjkl'),
  chars('zxcvbnm'),
];

const RU_ROWS: readonly (readonly Key[])[] = [
  chars('1234567890'),
  chars('йцукенгшщзхъ'),
  chars('фывапролджэ'),
  chars('ячсмитьбюё'),
];

const SYMBOL_ROWS: readonly (readonly Key[])[] = [
  chars('1234567890'),
  chars('-_.,:;/\\|'),
  chars('!?@#$%^&*~'),
  chars('()[]{}<>+='),
];

/** The `id` schema accepts exactly these punctuation marks, so those are the only ones offered. */
const ID_SYMBOL_ROWS: readonly (readonly Key[])[] = [chars('1234567890'), chars('._-')];

const NUMBER_ROWS: readonly (readonly Key[])[] = [
  chars('123'),
  chars('456'),
  chars('789'),
  chars('0'),
];

export interface OskDeps {
  readonly audio: AudioController;
  /**
   * The system clipboard — the Paste key's only source. Read by the main process in the launcher; here
   * by the browser, which may refuse it outright (no permission, an insecure origin), so the caller
   * resolves to an empty string rather than rejecting.
   */
  readClipboard(): Promise<string>;
}

export function createOsk(deps: OskDeps): TextEntrySurface {
  const root = req('osk');
  const titleEl = req('osk-title');
  const fieldEl = req('osk-field');
  const valueEl = req('osk-value');
  const valueAfterEl = req('osk-value-after');
  const caretEl = req<HTMLElement>('osk-caret');
  const keysEl = req('osk-keys');
  const legendEl = req('osk-legend');

  let open = false;
  /**
   * Bumped on every open and every close. `paste` awaits main for the clipboard, and "still open" is not
   * enough to know the answer is still WANTED: closing this field and opening the next one inside that
   * await would land the clipboard in a field the user never asked to paste into.
   */
  let visit = 0;
  let mode: OskMode = 'text';
  let layout: Layout = 'en';
  let shifted = false;
  /** The value AND where in it the next character goes — every edit runs through osk-text.ts. */
  let text: TextState = { value: '', caret: 0 };
  let title = '';
  let onDone: (value: string) => void = () => undefined;

  let rows: readonly (readonly Key[])[] = [];
  let buttons: HTMLButtonElement[][] = [];
  let rowIndex = 0;
  let colIndex = 0;
  const hover = createHoverGuard();

  /** The layouts this mode offers, in the order LB/RB and the layout key cycle through them. */
  function layoutsFor(current: OskMode): readonly Layout[] {
    if (current === 'number') return ['symbols'];
    if (current === 'id') return ['en', 'symbols'];
    return ['en', 'ru', 'symbols'];
  }

  /** The character rows of the current mode + layout, before the control row is appended. */
  function letterRows(): readonly (readonly Key[])[] {
    if (mode === 'number') return NUMBER_ROWS;
    if (mode === 'id' && layout === 'symbols') return ID_SYMBOL_ROWS;
    if (layout === 'ru') return RU_ROWS;
    if (layout === 'symbols') return SYMBOL_ROWS;
    return EN_ROWS;
  }

  /**
   * Whether this mode + layout has a case to shift at all: the symbol rows and the digits have none, and
   * an id is lower-case by rule (see `insert`), so offering the key there would be offering a key that
   * lies. The legend asks the same question — one answer, two places that must agree.
   */
  function hasShift(): boolean {
    return mode !== 'number' && mode !== 'id' && layout !== 'symbols';
  }

  /**
   * The two control rows. Two, not one: with the caret keys and Paste on it the single row grew wider
   * than the panel, and a row that overflows is a key you cannot reach. The split is by SUBJECT — what
   * you type with above, what you do with the text below — rather than by where the overflow happened.
   */
  function controlRows(): readonly (readonly Key[])[] {
    const typing: Key[] = [];
    if (hasShift()) typing.push({ kind: 'shift' });
    if (layoutsFor(mode).length > 1) typing.push({ kind: 'layout' });
    if (mode !== 'number') typing.push({ kind: 'space' });
    typing.push({ kind: 'caret-left' }, { kind: 'caret-right' }, { kind: 'backspace' });
    return [typing, [{ kind: 'paste' }, { kind: 'cancel' }, { kind: 'done' }]];
  }

  function keyLabel(key: Key): string {
    switch (key.kind) {
      case 'char':
        return shifted ? key.value.toUpperCase() : key.value;
      case 'shift':
        return LABEL.shift;
      case 'backspace':
        return LABEL.backspace;
      case 'space':
        return LABEL.space;
      case 'layout':
        return layoutLabel(nextLayout());
      // Glyphs, not words: an arrow needs no translation and fits a narrow key.
      case 'caret-left':
        return '◀';
      case 'caret-right':
        return '▶';
      case 'paste':
        return LABEL.paste;
      case 'done':
        return LABEL.done;
      case 'cancel':
        return LABEL.cancel;
    }
  }

  function layoutLabel(which: Layout): string {
    if (which === 'en') return 'ABC';
    if (which === 'ru') return 'АБВ';
    return '#+=';
  }

  function nextLayout(): Layout {
    const list = layoutsFor(mode);
    const at = list.indexOf(layout);
    return list[wrapIndex(at === -1 ? 0 : at, 1, list.length)] ?? layout;
  }

  /** Whether a key takes the wide form. The caret arrows are glyphs — they stay the size of a letter. */
  function isWideKey(key: Key): boolean {
    return key.kind !== 'char' && key.kind !== 'caret-left' && key.kind !== 'caret-right';
  }

  function render(): void {
    rows = [...letterRows(), ...controlRows()];
    buttons = rows.map((row, r) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'osk-row';
      rowEl.style.setProperty('--osk-row', String(r));
      const rowButtons = row.map((key, c) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'osk-key';
        if (isWideKey(key)) button.classList.add('is-wide');
        if (key.kind === 'shift' && shifted) button.classList.add('is-active');
        button.textContent = keyLabel(key);
        button.addEventListener('click', () => {
          rowIndex = r;
          colIndex = c;
          applyFocus();
          press(key, button);
        });
        rowEl.append(button);
        return button;
      });
      keysEl.append(rowEl);
      return rowButtons;
    });
    applyFocus();
  }

  function rebuild(): void {
    keysEl.replaceChildren();
    render();
    updateLegend(); // the layout may have changed, and with it whether Shift exists
  }

  function applyFocus(): void {
    rowIndex = clampIndex(rowIndex, 0, rows.length);
    const row = buttons[rowIndex] ?? [];
    colIndex = clampIndex(colIndex, 0, row.length);
    buttons.forEach((rowButtons, r) =>
      rowButtons.forEach((button, c) =>
        button.classList.toggle('is-focused', r === rowIndex && c === colIndex),
      ),
    );
  }

  function paintValue(): void {
    const { before, after } = splitAtCaret(text);
    valueEl.textContent = before;
    valueAfterEl.textContent = after;
    // Restart the blink on every edit: the caret spends half of each second invisible, and landing in
    // that half right after a click or a keypress reads as "nothing happened".
    caretEl.style.setProperty('animation', 'none');
    void caretEl.offsetWidth;
    caretEl.style.removeProperty('animation');
  }

  /** Applies a new text state and repaints. The one door every edit goes through. */
  function setText(next: TextState): void {
    if (next === text) return;
    text = next;
    paintValue();
  }

  function pressFlash(el: HTMLElement): void {
    el.classList.add('is-pressed');
    window.setTimeout(() => el.classList.remove('is-pressed'), PRESS_MS);
  }

  /** Types text AT the caret. What each mode will accept lives in osk-text.ts, with its reasoning. */
  function insert(typed: string): void {
    const filtered = sanitize(mode, typed);
    if (filtered === '') return;
    setText(insertAt(text, filtered));
    // Shift is a one-shot, the way a phone keyboard treats it — a name is "Hades", not "HADES".
    if (shifted) {
      shifted = false;
      rebuild();
    }
  }

  function backspace(): void {
    setText(deleteBefore(text));
  }

  function moveCaretBy(delta: number): void {
    const next = moveCaret(text, delta);
    if (next === text) {
      deps.audio.playLimit(); // the caret is already at that end
      return;
    }
    // `button`, not `navigate`: these are the caret KEYS being pressed. `navigate` belongs to the
    // highlight walking the grid — the caret moving in the text is what the key does, not the walk.
    deps.audio.play('button');
    setText(next);
  }

  /**
   * Paste, the only edit whose text comes from outside the launcher. It is filtered exactly like typing:
   * a clipboard holding a newline, a tab or a character the field's schema rejects must not be able to
   * put into the manifest what the keys themselves cannot.
   */
  async function paste(): Promise<void> {
    const token = visit;
    const clipboard = await deps.readClipboard();
    if (token !== visit) return; // closed — or closed and reopened for another field — while main answered
    // Capped, and capped by CHARACTER so the cut can't land inside one: nothing this keyboard edits is
    // longer than a path, and a clipboard holding a whole file would otherwise be drawn into the field.
    const filtered = charsOf(sanitize(mode, clipboard)).slice(0, PASTE_MAX_CHARS).join('');
    if (filtered === '') return;
    setText(insertAt(text, filtered));
  }

  function press(key: Key, el?: HTMLElement): void {
    if (el !== undefined) pressFlash(el);
    switch (key.kind) {
      case 'char':
        // A character is a KEYSTROKE, not a move through the grid — the arrows already say `navigate`,
        // and typing a name with that sound reads as walking the keyboard rather than writing.
        deps.audio.play('typing');
        insert(shifted ? key.value.toUpperCase() : key.value);
        return;
      case 'shift':
        deps.audio.play('button');
        shifted = !shifted;
        rebuild();
        return;
      case 'backspace':
        deps.audio.play('typing'); // deleting is typing too — the field is being written either way
        backspace();
        return;
      case 'space':
        deps.audio.play('typing'); // a space is a character like any other
        insert(' ');
        return;
      case 'layout':
        deps.audio.play('button');
        switchLayout(1);
        return;
      case 'caret-left':
        moveCaretBy(-1);
        return;
      case 'caret-right':
        moveCaretBy(1);
        return;
      case 'paste':
        deps.audio.play('button');
        void paste();
        return;
      case 'done':
        deps.audio.play('button');
        confirm();
        return;
      case 'cancel':
        cancel();
        return;
    }
  }

  /** Cycles to the next layout of this mode. False when the mode has only one — nothing to switch to. */
  function switchLayout(direction: -1 | 1): boolean {
    const list = layoutsFor(mode);
    if (list.length < 2) return false;
    const at = list.indexOf(layout);
    layout = list[wrapIndex(at === -1 ? 0 : at, direction, list.length)] ?? layout;
    shifted = false;
    rebuild();
    focusKind('layout');
    return true;
  }

  /**
   * Puts the focus back on a CONTROL key by what it is, not by where it was. The control row is built
   * per layout — the symbol layouts have no Shift — so the same index means a different key after a
   * switch, and cycling en → ru → symbols would walk the focus off the layout key onto Space.
   */
  function focusKind(kind: Key['kind']): void {
    for (const [r, row] of rows.entries()) {
      const c = row.findIndex((key) => key.kind === kind);
      if (c === -1) continue;
      rowIndex = r;
      colIndex = c;
      applyFocus();
      return;
    }
  }

  function confirm(): void {
    const result = text.value;
    hide();
    onDone(result);
  }

  function cancel(): void {
    hide();
  }

  function hide(): void {
    if (!open) return;
    deps.audio.play('popup-close');
    open = false;
    visit += 1;
    entrance.cancel();
    root.classList.remove('is-open');
    root.setAttribute('aria-hidden', 'true');
  }

  /**
   * The rows' staggered arrival. Armed by the keyboard rather than inherited from `.is-open`, because the
   * rows are REBUILT far more often than the keyboard opens — every shift, and every shifted character
   * types one and rebuilds them back — and an animation the elements simply inherit on creation would
   * replay through all of that. entrance.ts is what keeps a rebuild DURING the arrival out of it too.
   */
  const ENTRANCE_MS = 600;
  const entrance = createEntrance(root, '.osk-row', ENTRANCE_MS);

  function move(rowDelta: number, colDelta: number): void {
    hover.arm();
    if (rowDelta !== 0) {
      const next = clampIndex(rowIndex, rowDelta, rows.length);
      if (next === rowIndex) {
        deps.audio.playLimit(); // the top / bottom row of the grid
        return;
      }
      // The column is kept PROPORTIONALLY, not by index: the rows are of different lengths, and jumping
      // from the middle of a ten-key row to the end of a four-key one reads as the focus teleporting.
      const from = buttons[rowIndex]?.length ?? 1;
      const to = buttons[next]?.length ?? 1;
      const ratio = from <= 1 ? 0 : colIndex / (from - 1);
      rowIndex = next;
      colIndex = Math.round(ratio * Math.max(0, to - 1));
    } else {
      const row = buttons[rowIndex] ?? [];
      const next = wrapIndex(colIndex, colDelta, row.length);
      if (next === colIndex) return;
      colIndex = next;
    }
    deps.audio.play('navigate');
    applyFocus();
  }

  function focusedKey(): Key | undefined {
    return rows[rowIndex]?.[colIndex];
  }

  /**
   * The legend names the buttons this keyboard ACTUALLY has right now — it is built from the same two
   * conditions the control row is (see controlRow), so it can never promise a key that is not there. A
   * number pad has neither a case to shift nor a second layout to switch to, and listing both was telling
   * the user to press buttons that do nothing.
   */
  function updateLegend(): void {
    const parts: string[] = [LABEL.legendDelete];
    if (hasShift()) parts.push(LABEL.legendShift);
    if (layoutsFor(mode).length > 1) parts.push(LABEL.legendLayout);
    parts.push(LABEL.legendDone, LABEL.legendCancel);
    const text = parts.join(', ');
    // Rewritten only when it changed: this runs on every rebuild, and a rebuild happens on every shift.
    if (legendEl.textContent !== text) legendEl.textContent = text;
  }

  /** What the DOM reports for a point: the node the caret would land in, and an offset inside it. */
  interface CaretHit {
    readonly node: Node;
    readonly offset: number;
  }

  /**
   * Where a click lands in the text. Both spellings of the same browser API are tried: the standard
   * `caretPositionFromPoint` and the older `caretRangeFromPoint` Chromium has always had. Neither is in
   * the DOM lib types we compile against, hence the narrow local shape rather than a cast to `any`.
   */
  function caretHitAt(x: number, y: number): CaretHit | null {
    const doc = document as unknown as {
      caretPositionFromPoint?: (
        x: number,
        y: number,
      ) => { offsetNode: Node; offset: number } | null;
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const position = doc.caretPositionFromPoint?.(x, y) ?? null;
    if (position !== null) return { node: position.offsetNode, offset: position.offset };
    const range = doc.caretRangeFromPoint?.(x, y) ?? null;
    if (range !== null) return { node: range.startContainer, offset: range.startOffset };
    return null;
  }

  /**
   * Click anywhere in the value to put the caret there. This is the mouse's whole answer to "I want to
   * fix the middle of this" — without it the only way back into typed text was to delete it.
   */
  fieldEl.addEventListener('click', (event) => {
    if (!open) return;
    const hit = caretHitAt(event.clientX, event.clientY);
    // A click on the padding around the text, or anywhere the DOM cannot resolve: treat it as "past the
    // end", which is where a click into empty space means.
    if (hit === null) {
      setCaret(clampCaret(text.value, Infinity));
      return;
    }
    if (valueEl.contains(hit.node)) {
      setCaret(caretFromOffset(text, 'before', hit.offset));
      return;
    }
    if (valueAfterEl.contains(hit.node)) {
      setCaret(caretFromOffset(text, 'after', hit.offset));
      return;
    }
    setCaret(clampCaret(text.value, Infinity));
  });

  /** Moves the caret without moving anything else — the mouse's own path into the text. */
  function setCaret(at: number): void {
    const next = { value: text.value, caret: clampCaret(text.value, at) };
    if (next.caret === text.caret) return;
    deps.audio.play('navigate');
    setText(next);
  }

  root.querySelector<HTMLElement>('.osk-veil')?.addEventListener('click', () => {
    cancel();
  });

  window.addEventListener(
    'mousemove',
    (event) => {
      hover.track(event.clientX, event.clientY);
      if (!open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('.osk-key');
      if (button === null) return;
      for (const [r, rowButtons] of buttons.entries()) {
        const c = rowButtons.indexOf(button);
        if (c === -1) continue;
        if (r === rowIndex && c === colIndex) return;
        rowIndex = r;
        colIndex = c;
        applyFocus();
        return;
      }
    },
    { passive: true },
  );

  /**
   * The physical keyboard writes straight through, which is the whole point of having one. It is a
   * CAPTURE listener that stops the event dead: controls.ts also listens on the window and would read
   * `a` as "move left" and Space as "activate", turning every typed letter into a navigation step.
   */
  window.addEventListener(
    'keydown',
    (event) => {
      if (!open) return;
      const key = event.key;
      // Ctrl/Cmd+V is the only modified combination the keyboard claims — everything else with a modifier
      // belongs to the OS (and a modified letter must not be typed as that letter).
      if (event.ctrlKey || event.metaKey) {
        if (key === 'v' || key === 'V' || key === 'м' || key === 'М') {
          event.preventDefault();
          event.stopImmediatePropagation();
          void paste();
        }
        return;
      }
      if (event.altKey) return;
      if (key === 'Enter') {
        event.preventDefault();
        event.stopImmediatePropagation();
        confirm();
        return;
      }
      if (key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
        return;
      }
      if (key === 'Backspace') {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) deps.audio.play('typing'); // silent while held, as the character keys are
        backspace(); // auto-repeat included: a held Backspace should keep deleting, like anywhere else
        return;
      }
      if (key === 'Delete') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setText(deleteAfter(text));
        return;
      }
      // The arrows move the CARET here, not the key highlight. The highlight is what a gamepad steers;
      // someone on a physical keyboard is typing straight through and means the text.
      if (key === 'ArrowLeft' || key === 'ArrowRight') {
        event.preventDefault();
        event.stopImmediatePropagation();
        // Through the same primitive as the on-screen caret keys, so a physical arrow sounds like one
        // and stops at the ends with the dead-end sound instead of silently doing nothing.
        moveCaretBy(key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (key === 'Home' || key === 'End') {
        event.preventDefault();
        event.stopImmediatePropagation();
        setText({
          value: text.value,
          caret: key === 'Home' ? 0 : clampCaret(text.value, Infinity),
        });
        return;
      }
      if ([...key].length === 1) {
        event.preventDefault();
        event.stopImmediatePropagation();
        // The same keystroke sound the on-screen keys make — it is the same field being typed into. A
        // HELD key is silent after the first: the OS repeats some 30 times a second, which is a rattle,
        // not typing.
        if (!event.repeat) deps.audio.play('typing');
        insert(key);
      }
    },
    { capture: true },
  );

  return {
    isOpen: () => open,
    open: (request) => {
      mode = request.mode;
      // The caret opens at the END of what is already there: the commonest edit is "add to this", and
      // anything else is one click or one arrow away.
      text = { value: request.value, caret: clampCaret(request.value, request.value.length) };
      title = request.title;
      onDone = request.onDone;
      layout = layoutsFor(mode)[0] ?? 'en';
      shifted = false;
      rowIndex = 0;
      colIndex = 0;
      open = true;
      visit += 1;
      deps.audio.play('popup-open');
      titleEl.textContent = title;
      paintValue();
      updateLegend();
      rebuild();
      hover.arm();
      root.classList.add('is-open');
      entrance.play();
      root.setAttribute('aria-hidden', 'false');
    },
    navUp: () => move(-1, 0),
    navDown: () => move(1, 0),
    navLeft: () => move(0, -1),
    navRight: () => move(0, 1),
    navActivate: () => {
      const key = focusedKey();
      if (key === undefined) return;
      press(key, buttons[rowIndex]?.[colIndex]);
    },
    navBack: () => {
      cancel();
    },
    close: () => {
      hide();
    },
    // X is Backspace and Y is Shift — the two things a typist reaches for constantly, off the grid.
    // A HELD X keeps deleting, one character at a time, the way a held Backspace does everywhere else.
    navSecondary: (repeat = false) => {
      if (text.caret === 0) {
        if (!repeat) deps.audio.playLimit(); // nothing left to delete; a hold stays quiet
        return;
      }
      if (!repeat) deps.audio.play('typing');
      backspace();
    },
    navTertiary: () => {
      // Shift has no meaning on the digits or the symbol layout — neither has a second case.
      if (mode === 'number' || layout === 'symbols') {
        deps.audio.playLimit();
        return;
      }
      deps.audio.play('button');
      shifted = !shifted;
      rebuild();
    },
    navShoulder: (direction) => {
      // The number mode offers a single layout, so the shoulders have nothing to switch to there — and
      // saying so is the point: they used to answer with `button`, sounding like an action that happened.
      if (switchLayout(direction)) deps.audio.play('button');
      else deps.audio.playLimit();
    },
    navCommit: () => {
      deps.audio.play('button');
      confirm();
    },
    relocalize: () => {
      // The site has no language to switch; the contract keeps the method (nav-surface.ts).
      if (!open) return;
      updateLegend();
      rebuild();
    },
  };
}
