// The Customize screen — the site's counterpart of playhook's per-game editor (c26fae7 :
// src/renderer/game-settings-screen.ts), in the one mode the site can honestly offer: ADD.
//
// The launcher's screen edits a `game.json` on a card: every row is a manifest field, the values are
// validated by the same zod schema the launcher loads games with, and Save writes the file. A web page
// has no card, no file and nothing to launch — so what is ported is the SCREEN: the same skeleton the
// Library uses (veil, column, sidebar, a pane of rows), the same rows that open the on-screen keyboard,
// the same bottom-anchored actions, the same discard question on the way out. What the rows collect is
// the site's own shape — the fields a catalogue ENTRY has (title, address, cover, backgrounds, music) —
// because that is the only thing an entry here is made of.
//
// The entry it builds lives in memory: reloading the page re-fetches the feed and it is gone. That is the
// same promise "Remove from library" makes, and for the same reason — a published feed is not this
// page's to write.
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createEntrance } from './entrance.js';
import { clampIndex } from './index-math.js';
import type { NavSurface } from './nav-surface.js';
import type { OskMode, TextEntrySurface } from './osk.js';
import { createScroller } from './screen-scroller.js';
import { createSidebar, type SidebarEntry } from './screen-sidebar.js';

/** How long the pane's staggered arrival runs before the marks come off (mirrors .is-entering). */
const ENTRANCE_MS = 700;
/** Playhook's own cap on hero backgrounds (MAX_HERO_IMAGES in its shared/types.ts). */
const MAX_HERO_IMAGES = 3;
/** The slug the address row accepts — the feed's own rule (see isValidSlug in collection.ts). */
const SLUG_CHARS = /[^a-z0-9-]+/g;

/** What the screen collects. Every URL is a blob the browser made from a file the user picked. */
export interface GameDraft {
  readonly slug: string;
  readonly title: string;
  readonly gridUrl: string | null;
  readonly heroUrls: readonly string[];
  readonly music: string | null;
}

type Section = 'game' | 'artwork' | 'sound';

export interface GameSettingsScreenDeps {
  readonly audio: AudioController;
  /** The on-screen keyboard — the gamepad's only way to type (see osk.ts). */
  readonly keyboard: TextEntrySurface;
  /** Whether the catalogue already holds this address. */
  slugTaken(slug: string): boolean;
  /** Save: the entry is main's to add, and main is what puts the user in front of it. */
  onAdd(draft: GameDraft): void;
  /** The screen closed itself (B / Close) — controls.ts restores the bar focus. */
  onClosed(): void;
  /** Leaving with unsaved edits asks first, through the popup controls.ts owns. */
  confirmDiscard(onYes: () => void): void;
}

export interface GameSettingsScreen extends NavSurface {
  /** Opens the screen on a blank draft — the launcher's "Add game". */
  openNew(): void;
  /** `silent` is a hand-over to another surface, which sounds and re-focuses for itself. */
  close(silent?: boolean): void;
  /** Whether there are unsaved edits — decides whether leaving asks first. */
  isDirty(): boolean;
}

/** One row of the pane. Two kinds: text (the keyboard) and files (the browser's own picker). */
type Row =
  | {
      readonly kind: 'text';
      readonly label: string;
      readonly hint: string;
      readonly value: string;
      readonly mode: OskMode;
      readonly onDone: (value: string) => void;
    }
  | {
      readonly kind: 'file';
      readonly label: string;
      readonly hint: string;
      readonly value: string;
      readonly accept: string;
      readonly multiple: boolean;
      readonly onFiles: (files: readonly File[]) => void;
    };

const SECTION_LABEL: Readonly<Record<Section, string>> = {
  game: 'Game',
  artwork: 'Artwork',
  sound: 'Sound',
};

/**
 * Whether the browser would honour a file dialog right now — i.e. whether a real user gesture is still
 * in effect. `navigator.userActivation` is not in the DOM types we compile against, hence the narrow
 * local shape rather than a cast to `any`; a browser without it is given the benefit of the doubt, and
 * the dialog simply does not open if it turns out there was no gesture.
 */
function hasUserActivation(): boolean {
  const nav = navigator as Navigator & {
    userActivation?: { readonly isActive: boolean };
  };
  return nav.userActivation?.isActive ?? true;
}

/** The address the launcher would call an id, derived from the title the way a human would type it. */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function createGameSettingsScreen(deps: GameSettingsScreenDeps): GameSettingsScreen {
  const app = req('app');
  const screen = req('game-settings');
  const listEl = req('game-settings-list');
  const statusEl = req('game-settings-status');
  const scroller = createScroller(listEl);
  const entrance = createEntrance(listEl, '.setting-row', ENTRANCE_MS);

  /**
   * The file picker is the BROWSER's, not ours. The launcher ships its own file browser because a native
   * dialog cannot be driven with a gamepad over a fullscreen window; here the native one is all there is,
   * and it comes with the web's own rule attached — see `pickFiles`.
   */
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.hidden = true;
  app.append(fileInput);

  let open = false;
  let section: Section = 'game';
  let rows: readonly Row[] = [];
  let rowNodes: readonly HTMLElement[] = [];
  let rowIndex = 0;
  let dirty = false;

  // The draft. Blob URLs, minted from the files the user picks and revoked as they are replaced: a URL
  // that outlives its draft is a file the tab holds open for nothing.
  let title = '';
  /** Written by hand once the user edits the address; until then it follows the title. */
  let slugEdited = false;
  let slug = '';
  let cover: { readonly url: string; readonly name: string } | null = null;
  let heroes: readonly { readonly url: string; readonly name: string }[] = [];
  let music: { readonly url: string; readonly name: string } | null = null;

  const sidebar = createSidebar<Section, 'save' | 'discard'>(req('game-settings-nav'), {
    audio: deps.audio,
    onSection: (id, entered) => {
      if (section !== id) {
        section = id;
        rowIndex = 0;
        render(true);
      }
      if (entered) enterPane();
    },
    onAction: (id) => {
      if (id === 'save') save();
      else leave();
    },
  });

  function revoke(url: string | null | undefined): void {
    if (url !== null && url !== undefined) URL.revokeObjectURL(url);
  }

  function dropDraftUrls(): void {
    revoke(cover?.url);
    for (const hero of heroes) revoke(hero.url);
    revoke(music?.url);
  }

  function effectiveSlug(): string {
    return slugEdited ? slug : slugify(title);
  }

  /** What stands between this draft and Save. Shown under both columns, as the launcher's status is. */
  function problem(): string | null {
    if (title.trim() === '') return 'A name is needed — the catalogue lists entries by it.';
    const address = effectiveSlug();
    if (address === '')
      return 'The address is empty: give the entry a name in latin letters, or type one.';
    if (deps.slugTaken(address))
      return `The address "${address}" is already taken by another entry.`;
    return null;
  }

  function applyStatus(): void {
    const text = problem();
    statusEl.textContent = text ?? '';
  }

  function rowsOf(current: Section): readonly Row[] {
    if (current === 'game') {
      return [
        {
          kind: 'text',
          label: 'Name',
          hint: 'What the catalogue lists this entry by.',
          value: title,
          mode: 'text',
          onDone: (value) => {
            title = value;
            markDirty();
          },
        },
        {
          kind: 'text',
          label: 'Address',
          hint: 'The last part of this entry’s link — lower-case letters, digits and dashes.',
          value: effectiveSlug(),
          mode: 'id',
          onDone: (value) => {
            const cleaned = value
              .toLowerCase()
              .replace(SLUG_CHARS, '-')
              .replace(/^-+|-+$/g, '');
            slugEdited = cleaned !== '';
            slug = cleaned;
            markDirty();
          },
        },
      ];
    }
    if (current === 'artwork') {
      return [
        {
          kind: 'file',
          label: 'Cover',
          hint: 'The card in the strip and in the grid. Portrait 2:3, like the collection’s own.',
          value: cover?.name ?? 'Not set',
          accept: 'image/*',
          multiple: false,
          onFiles: (files) => {
            const file = files[0];
            if (file === undefined) return;
            revoke(cover?.url);
            cover = { url: URL.createObjectURL(file), name: file.name };
            markDirty();
          },
        },
        {
          kind: 'file',
          label: 'Backgrounds',
          hint: `The hero images the entry’s screen rotates through. Up to ${MAX_HERO_IMAGES}.`,
          value: heroes.length === 0 ? 'Not set' : heroes.map((hero) => hero.name).join(', '),
          accept: 'image/*',
          multiple: true,
          onFiles: (files) => {
            if (files.length === 0) return;
            for (const hero of heroes) revoke(hero.url);
            heroes = files.slice(0, MAX_HERO_IMAGES).map((file) => ({
              url: URL.createObjectURL(file),
              name: file.name,
            }));
            markDirty();
          },
        },
      ];
    }
    return [
      {
        kind: 'file',
        label: 'Music',
        hint: 'Plays while the entry is on screen, as a collection entry’s theme does.',
        value: music?.name ?? 'Not set',
        accept: 'audio/*',
        multiple: false,
        onFiles: (files) => {
          const file = files[0];
          if (file === undefined) return;
          revoke(music?.url);
          music = { url: URL.createObjectURL(file), name: file.name };
          markDirty();
        },
      },
    ];
  }

  function markDirty(): void {
    dirty = true;
    render(false);
  }

  function buildRow(row: Row, at: number): HTMLElement {
    const node = document.createElement('div');
    node.className = 'setting-row';
    node.style.setProperty('--row-index', String(at));
    const box = document.createElement('div');
    box.className = 'setting-label-box';
    const label = document.createElement('div');
    label.className = 'setting-label';
    label.textContent = row.label;
    const hint = document.createElement('div');
    hint.className = 'setting-hint';
    hint.textContent = row.hint;
    box.append(label, hint);
    const value = document.createElement('div');
    value.className = 'setting-value setting-value-wide';
    // A file's name comes from the user's own disk — textContent, never innerHTML.
    value.textContent = row.value;
    node.append(box, value);
    node.addEventListener('click', () => {
      sidebar.setFocused(false);
      rowIndex = at;
      applyFocus();
      activateRow();
    });
    return node;
  }

  /** Rebuilds the pane. `animate` is for a SECTION change — not for a value the user just typed. */
  function render(animate: boolean): void {
    rows = rowsOf(section);
    rowNodes = rows.map((row, at) => buildRow(row, at));
    listEl.replaceChildren(...rowNodes);
    rowIndex = clampIndex(rowIndex, 0, rows.length);
    applyFocus();
    applyStatus();
    sidebar.render(sidebarEntries());
    if (animate) entrance.play();
    requestAnimationFrame(() => scroller.fades());
  }

  function applyFocus(): void {
    const active = !sidebar.hasFocus();
    listEl.classList.toggle('is-active', active);
    rowNodes.forEach((node, at) => node.classList.toggle('is-focused', active && at === rowIndex));
    const node = rowNodes[rowIndex];
    if (active && node !== undefined) scroller.reveal(node);
  }

  function sidebarEntries(): readonly SidebarEntry<Section, 'save' | 'discard'>[] {
    return [
      { id: 'game', label: SECTION_LABEL.game, kind: 'section' },
      { id: 'artwork', label: SECTION_LABEL.artwork, kind: 'section' },
      { id: 'sound', label: SECTION_LABEL.sound, kind: 'section' },
      { id: 'save', label: 'Save', kind: 'action', disabled: problem() !== null },
      { id: 'discard', label: 'Close', kind: 'action' },
    ];
  }

  function enterPane(): void {
    if (rows.length === 0) {
      deps.audio.playLimit();
      return;
    }
    sidebar.setFocused(false);
    applyFocus();
  }

  function leavePane(): void {
    sidebar.setFocused(true);
    applyFocus();
  }

  /**
   * Opens the browser's file dialog.
   *
   * BROWSER: a dialog may only be opened from a real user gesture, and a GAMEPAD press is not one — the
   * pad is polled on a frame loop (gamepad.ts) and produces no DOM event at all. So this row answers a
   * click and a keyboard press, and refuses a pad with the dead-end sound rather than silently doing
   * nothing. It is the same wall the launcher ships its own file browser to get around, and the one part
   * of that screen a web page cannot have.
   */
  function pickFiles(row: Extract<Row, { kind: 'file' }>): void {
    if (!hasUserActivation()) {
      deps.audio.playLimit();
      statusEl.textContent =
        'Picking a file needs the mouse or the keyboard: a browser opens its file dialog only for those.';
      return;
    }
    deps.audio.play('button');
    fileInput.accept = row.accept;
    fileInput.multiple = row.multiple;
    fileInput.value = '';
    fileInput.onchange = (): void => {
      const files = [...(fileInput.files ?? [])];
      fileInput.onchange = null;
      if (files.length === 0) return;
      row.onFiles(files);
    };
    fileInput.click();
  }

  function activateRow(): void {
    const row = rows[rowIndex];
    if (row === undefined) return;
    if (row.kind === 'file') {
      pickFiles(row);
      return;
    }
    deps.keyboard.open({
      value: row.value,
      mode: row.mode,
      title: row.label,
      onDone: (value) => row.onDone(value),
    });
  }

  function save(): void {
    if (problem() !== null) {
      deps.audio.playLimit();
      return;
    }
    deps.audio.play('button');
    const draft: GameDraft = {
      slug: effectiveSlug(),
      title: title.trim(),
      gridUrl: cover?.url ?? null,
      heroUrls: heroes.map((hero) => hero.url),
      music: music?.url ?? null,
    };
    // The URLs travel WITH the entry now, so they must outlive the draft — hence no revoke here.
    cover = null;
    heroes = [];
    music = null;
    dirty = false;
    hide(true);
    deps.onAdd(draft);
  }

  /** B / Close: asks first when there is something to lose, exactly as the launcher's screen does. */
  function leave(): void {
    if (!dirty) {
      close();
      return;
    }
    deps.confirmDiscard(() => {
      dirty = false;
      close();
    });
  }

  function hide(silent: boolean): void {
    if (!open) return;
    open = false;
    deps.keyboard.close(); // it lives outside this screen and would otherwise stay up over the carousel
    entrance.cancel();
    delete app.dataset['overlay'];
    screen.setAttribute('aria-hidden', 'true');
    if (silent) return;
    deps.audio.play('back');
    deps.onClosed();
  }

  function close(): void {
    dropDraftUrls();
    cover = null;
    heroes = [];
    music = null;
    hide(false);
  }

  return {
    isOpen: () => open,
    isDirty: () => dirty,
    openNew: () => {
      if (open) return;
      title = '';
      slug = '';
      slugEdited = false;
      cover = null;
      heroes = [];
      music = null;
      dirty = false;
      section = 'game';
      rowIndex = 0;
      open = true;
      app.dataset['overlay'] = 'game-settings';
      screen.setAttribute('aria-hidden', 'false');
      deps.audio.play('popup-open');
      sidebar.render(sidebarEntries());
      sidebar.reset();
      sidebar.setFocused(true);
      sidebar.animateIn();
      render(true);
      scroller.to(0, true);
    },
    close: (silent = false) => {
      if (silent) {
        hide(true);
        return;
      }
      close();
    },
    navUp: (repeat = false) => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navUp(repeat);
        return;
      }
      if (sidebar.hasFocus()) {
        sidebar.move(-1);
        return;
      }
      const next = clampIndex(rowIndex, -1, rows.length);
      if (next === rowIndex) {
        if (!repeat) deps.audio.playLimit();
        return;
      }
      rowIndex = next;
      deps.audio.play('navigate');
      applyFocus();
    },
    navDown: (repeat = false) => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navDown(repeat);
        return;
      }
      if (sidebar.hasFocus()) {
        sidebar.move(1);
        return;
      }
      const next = clampIndex(rowIndex, 1, rows.length);
      if (next === rowIndex) {
        if (!repeat) deps.audio.playLimit();
        return;
      }
      rowIndex = next;
      deps.audio.play('navigate');
      applyFocus();
    },
    navLeft: (repeat = false) => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navLeft(repeat);
        return;
      }
      if (sidebar.hasFocus()) {
        if (!repeat) deps.audio.playLimit(); // the edge of the screen
        return;
      }
      if (repeat) return; // a hold must not walk out of the pane it is running through
      deps.audio.play('navigate');
      leavePane();
    },
    navRight: (repeat = false) => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navRight(repeat);
        return;
      }
      if (!sidebar.hasFocus()) {
        if (!repeat) deps.audio.playLimit(); // the rows have nothing to the right of them
        return;
      }
      if (sidebar.selected()?.kind === 'section') enterPane();
      else deps.audio.playLimit(); // the actions at its foot lead nowhere sideways
    },
    navActivate: () => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navActivate();
        return;
      }
      if (sidebar.hasFocus()) {
        sidebar.activate();
        return;
      }
      activateRow();
    },
    navBack: () => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navBack();
        return;
      }
      if (!sidebar.hasFocus()) {
        deps.audio.play('back');
        leavePane();
        return;
      }
      leave();
    },
    navSecondary: (repeat = false) => {
      if (deps.keyboard.isOpen()) deps.keyboard.navSecondary?.(repeat);
      else if (!repeat) deps.audio.playLimit();
    },
    navTertiary: () => {
      if (deps.keyboard.isOpen()) deps.keyboard.navTertiary?.();
      else deps.audio.playLimit();
    },
    navShoulder: (direction) => {
      if (deps.keyboard.isOpen()) deps.keyboard.navShoulder?.(direction);
      else deps.audio.playLimit();
    },
    navCommit: () => {
      if (deps.keyboard.isOpen()) deps.keyboard.navCommit?.();
      else deps.audio.playLimit();
    },
    relocalize: () => {
      // The site has no language to switch; the contract keeps the method (nav-surface.ts).
      if (!open) return;
      render(false);
    },
  };
}
