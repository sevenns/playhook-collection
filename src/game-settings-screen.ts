// The Customize screen — the site's counterpart of playhook's per-game editor (c26fae7 :
// src/renderer/game-settings-screen.ts), in the one mode the site can honestly offer: ADD.
//
// The FORM is the launcher's, whole: every section, every row, its labels and its hints (see
// game-settings-model.ts). What this file owns is the navigation over it and the handful of rows that
// are live — the title and the id through the on-screen keyboard, the artwork and the soundtrack through
// the browser's own file dialog. Everything else is inert and answers with the dead-end sound.
//
// The entry it builds lives in memory: reloading the page re-fetches the feed and it is gone. That is the
// same promise "Remove from library" makes, and for the same reason — a published feed is not this
// page's to write.
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createEntrance } from './entrance.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex } from './index-math.js';
import type { NavSurface } from './nav-surface.js';
import type { OskMode, TextEntrySurface } from './osk.js';
import {
  buildCoreRow,
  isFocusable,
  isInert,
  patchCoreRow,
  type CoreRendered,
} from './row-view-core.js';
import {
  buildGameSettingsModel,
  isLiveRow,
  MAX_HERO_IMAGES,
  type GameForm,
  type GameRowId,
  type GameSectionId,
  type GameSettingsModel,
  type GameSettingsRow,
  type PickedFile,
} from './game-settings-model.js';
import { createScroller } from './screen-scroller.js';
import { createSidebar, type SidebarEntry } from './screen-sidebar.js';

/** How long the pane's staggered arrival runs before the marks come off (mirrors .is-entering). */
const ENTRANCE_MS = 700;
/** The stagger stops counting here: past a handful of rows the wave is a wait, not a wave. */
const ENTRANCE_STEPS = 8;
/**
 * How long the pane waits before showing the section the column moved onto — a held direction walks
 * through the column faster than that, so the pane is drawn once, when the movement stops.
 */
const PREVIEW_MS = 120;
/** Gamepad A doesn't trigger :active — the same press flash the rest of the UI uses (controls.ts). */
const PRESS_MS = 130;
/** The id the feed accepts — the collection's own rule (see isValidSlug in collection.ts). */
const SLUG_CHARS = /[^a-z0-9-]+/g;

/** What the screen collects. Every URL is a blob the browser made from a file the user picked. */
export interface GameDraft {
  readonly slug: string;
  readonly title: string;
  readonly gridUrl: string | null;
  readonly heroUrls: readonly string[];
  readonly music: string | null;
}

type SidebarAction = 'find-online' | 'save' | 'close';

export interface GameSettingsScreenDeps {
  readonly audio: AudioController;
  /** The on-screen keyboard — the gamepad's only way to type (see osk.ts). */
  readonly keyboard: TextEntrySurface;
  /** Whether the catalogue already holds this id. */
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

/** One rendered row: the model row it came from plus the nodes the controller updates. */
interface RenderedRow extends CoreRendered {
  row: GameSettingsRow;
}

/** Which file dialog a live artwork row opens. */
interface PickSpec {
  readonly accept: string;
  readonly multiple: boolean;
}

const PICK: Readonly<Partial<Record<GameRowId, PickSpec>>> = {
  heroImage: { accept: 'image/*', multiple: true },
  gridImage: { accept: 'image/*', multiple: false },
  backgroundMusic: { accept: 'audio/*', multiple: false },
};

/** Which on-screen keyboard mode a live text row opens in. */
const TYPING: Readonly<Partial<Record<GameRowId, OskMode>>> = {
  title: 'text',
  id: 'id',
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

/** The id the launcher would call an id, derived from the title the way a human would type it. */
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
  const hover = createHoverGuard();

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
  let sectionId: GameSectionId = 'basics';
  let paneId: GameSectionId | null = null;
  let previewTimer = 0;
  let rendered: readonly RenderedRow[] = [];
  let rowIndex = 0;
  let dirty = false;

  // The draft. Blob URLs, minted from the files the user picks and revoked as they are replaced: a URL
  // that outlives its draft is a file the tab holds open for nothing.
  let title = '';
  /** Written by hand once the user edits the id; until then it follows the title. */
  let idEdited = false;
  let id = '';
  let cover: PickedFile | null = null;
  let heroes: readonly PickedFile[] = [];
  let music: PickedFile | null = null;

  let model: GameSettingsModel = buildModel();

  const sidebar = createSidebar<GameSectionId, SidebarAction>(req('game-settings-nav'), {
    audio: deps.audio,
    onSection: (next, entered) => {
      sectionId = next;
      if (entered) {
        enterPane();
        return;
      }
      schedulePreview();
    },
    onAction: (action) => {
      if (action === 'save') save();
      else if (action === 'close') leave();
      else deps.audio.playLimit(); // Find online — see the note in game-settings-model.ts
    },
  });

  function effectiveId(): string {
    return idEdited ? id : slugify(title);
  }

  /** What stands between this draft and Add, per row — the launcher's own per-field errors. */
  function issues(): Readonly<Partial<Record<GameRowId, string>>> {
    const found: Partial<Record<GameRowId, string>> = {};
    if (title.trim() === '') found.title = 'A name is needed — the catalogue lists entries by it.';
    const address = effectiveId();
    if (address === '') found.id = 'Give the entry a name in latin letters, or type an id.';
    else if (deps.slugTaken(address)) found.id = `"${address}" is already taken by another entry.`;
    return found;
  }

  function buildModel(): GameSettingsModel {
    const problems = issues();
    const form: GameForm = { title, id: effectiveId(), heroes, cover, music };
    return buildGameSettingsModel(form, {
      issues: problems,
      dirty,
      canSave: Object.keys(problems).length === 0,
    });
  }

  function canSave(): boolean {
    return Object.keys(issues()).length === 0;
  }

  /** The rows the pane shows: one section's worth. */
  function rowsOf(section: GameSectionId): readonly GameSettingsRow[] {
    return model.sections.find((candidate) => candidate.id === section)?.rows ?? [];
  }

  function schedulePreview(): void {
    if (previewTimer !== 0) window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(() => {
      previewTimer = 0;
      renderPane();
    }, PREVIEW_MS);
  }

  /**
   * Brings the pane up to date with the selected section NOW, cancelling a pending preview. Anything
   * that reads the rendered rows has to call this first — a MOUSE click on a section activates it
   * without ever moving onto it.
   */
  function flushPreview(): void {
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
    if (paneId !== sectionId) renderPane();
  }

  /** Rebuilds the column and either patches the pane's values or redraws it outright. */
  function render(): void {
    flushPreview();
    model = buildModel();
    sidebar.render(sidebarEntries());
    // The status line is NOT where validation goes: every problem is already printed under the field it
    // belongs to (row-view-core), and saying it twice made the screen look angrier than it is. What is
    // left for it is the one message that has no row to sit in — see pickFiles.
    statusEl.textContent = '';
    const rows = rowsOf(sectionId);
    if (paneId === sectionId && rendered.length === rows.filter(isFocusable).length) {
      const focusable = rows.filter(isFocusable);
      rendered.forEach((row, at) => {
        const next = focusable[at];
        if (next === undefined) return;
        row.row = next;
        patchCoreRow(row, next);
      });
      return;
    }
    renderPane();
  }

  /** Draws the selected section into the pane. The column is rebuilt separately. */
  function renderPane(): void {
    paneId = sectionId;
    const rows = rowsOf(sectionId);
    const built = rows.map((row) => {
      const core = buildCoreRow(row);
      return { ...core, row };
    });
    built.forEach((row, at) =>
      row.el.style.setProperty('--row-index', String(Math.min(at, ENTRANCE_STEPS))),
    );
    listEl.replaceChildren(...built.map((row) => row.el));
    rendered = built.filter((row) => isFocusable(row.row));
    entrance.play();
    rowIndex = Math.min(Math.max(rowIndex, 0), Math.max(0, rendered.length - 1));
    applyFocus(true);
    scroller.to(0, true);
    // The rows were inserted THIS tick, so scrollHeight is still the pre-layout value — the fades would
    // be computed against a list that "doesn't scroll yet". Re-run them once the layout has settled.
    requestAnimationFrame(() => scroller.fades());
  }

  function applyFocus(instant = false): void {
    const active = !sidebar.hasFocus();
    listEl.classList.toggle('is-active', active);
    rendered.forEach((row, at) => row.el.classList.toggle('is-focused', active && at === rowIndex));
    if (!active) return;
    const node = rendered[rowIndex];
    if (node !== undefined) scroller.reveal(node.el, instant);
  }

  function sidebarEntries(): readonly SidebarEntry<GameSectionId, SidebarAction>[] {
    return [
      ...model.sections.map((section) => ({
        id: section.id,
        label: section.title,
        kind: 'section' as const,
      })),
      // Shown and inert, exactly as the form's own launcher-only rows are: the launcher searches from its
      // main process, and no provider lets a web page read its answers (game-settings-model.ts).
      { id: 'find-online' as const, label: 'Find online', kind: 'action' as const, disabled: true },
      {
        id: 'save' as const,
        label: 'Add',
        kind: 'action' as const,
        disabled: !canSave() || !dirty,
      },
      { id: 'close' as const, label: 'Close', kind: 'action' as const },
    ];
  }

  function enterPane(): void {
    flushPreview();
    if (rendered.length === 0) {
      deps.audio.playLimit();
      return;
    }
    sidebar.setFocused(false);
    rowIndex = 0;
    hover.arm();
    applyFocus();
  }

  function leavePane(): void {
    sidebar.setFocused(true);
    hover.arm();
    applyFocus();
  }

  function markDirty(): void {
    dirty = true;
    render();
  }

  function pressFlash(el: HTMLElement): void {
    el.classList.add('is-pressed');
    window.setTimeout(() => el.classList.remove('is-pressed'), PRESS_MS);
  }

  function revoke(url: string | null | undefined): void {
    if (url !== null && url !== undefined) URL.revokeObjectURL(url);
  }

  function dropDraftUrls(): void {
    revoke(cover?.url);
    for (const hero of heroes) revoke(hero.url);
    revoke(music?.url);
  }

  /** Applies the files a live artwork row just collected. */
  function applyFiles(rowId: GameRowId, files: readonly File[]): void {
    const first = files[0];
    if (first === undefined) return;
    if (rowId === 'heroImage') {
      for (const hero of heroes) revoke(hero.url);
      heroes = files.slice(0, MAX_HERO_IMAGES).map((file) => ({
        url: URL.createObjectURL(file),
        name: file.name,
      }));
    } else if (rowId === 'gridImage') {
      revoke(cover?.url);
      cover = { url: URL.createObjectURL(first), name: first.name };
    } else {
      revoke(music?.url);
      music = { url: URL.createObjectURL(first), name: first.name };
    }
    markDirty();
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
  function pickFiles(rowId: GameRowId, spec: PickSpec): void {
    if (!hasUserActivation()) {
      deps.audio.playLimit();
      statusEl.textContent =
        'Picking a file needs the mouse or the keyboard: a browser opens its file dialog only for those.';
      return;
    }
    deps.audio.play('button');
    fileInput.accept = spec.accept;
    fileInput.multiple = spec.multiple;
    fileInput.value = '';
    fileInput.onchange = (): void => {
      const files = [...(fileInput.files ?? [])];
      fileInput.onchange = null;
      if (files.length === 0) return;
      applyFiles(rowId, files);
    };
    fileInput.click();
  }

  function typeInto(rowId: GameRowId, mode: OskMode, label: string): void {
    deps.audio.play('button');
    deps.keyboard.open({
      value: rowId === 'title' ? title : effectiveId(),
      mode,
      title: label,
      onDone: (value) => {
        if (rowId === 'title') title = value;
        else {
          const cleaned = value
            .toLowerCase()
            .replace(SLUG_CHARS, '-')
            .replace(/^-+|-+$/g, '');
          idEdited = cleaned !== '';
          id = cleaned;
        }
        markDirty();
      },
    });
  }

  function activateRow(target: RenderedRow): void {
    const row = target.row;
    if (row.kind === 'note') return;
    if (isInert(row) || !isLiveRow(row.id)) {
      deps.audio.playLimit();
      return;
    }
    pressFlash(target.el);
    const spec = PICK[row.id];
    if (spec !== undefined) {
      pickFiles(row.id, spec);
      return;
    }
    const mode = TYPING[row.id];
    if (mode !== undefined) typeInto(row.id, mode, row.label);
  }

  function save(): void {
    if (!canSave()) {
      deps.audio.playLimit();
      return;
    }
    deps.audio.play('button');
    const draft: GameDraft = {
      slug: effectiveId(),
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
    if (previewTimer !== 0) {
      window.clearTimeout(previewTimer);
      previewTimer = 0;
    }
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

  function moveRowFocus(delta: number, repeat: boolean): void {
    if (rendered.length === 0) return;
    const next = clampIndex(rowIndex, delta, rendered.length);
    if (next === rowIndex) {
      if (!repeat) deps.audio.playLimit();
      return;
    }
    rowIndex = next;
    deps.audio.play('navigate');
    applyFocus();
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  listEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rowEl = target.closest<HTMLElement>('.setting-row');
    if (rowEl === null) return;
    const index = rendered.findIndex((row) => row.el === rowEl);
    if (index === -1) return;
    const entry = rendered[index];
    if (entry === undefined) return;
    sidebar.setFocused(false);
    rowIndex = index;
    applyFocus();
    activateRow(entry);
  });

  /**
   * Hover, for the row list. WHEN it is allowed to move the focus is the shared hover guard's job — it
   * keeps tracking the pointer while the screen is closed, so opening can arm it at wherever the cursor
   * happens to rest.
   */
  let pointerX = -1;
  let pointerY = -1;

  window.addEventListener(
    'mousemove',
    (event) => {
      const moved = event.clientX !== pointerX || event.clientY !== pointerY;
      pointerX = event.clientX;
      pointerY = event.clientY;
      hover.track(event.clientX, event.clientY);
      if (!moved || !open) return;
      if (document.documentElement.classList.contains('mouse-asleep')) return;
      if (!hover.awake(event.clientX, event.clientY)) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const rowEl = target.closest<HTMLElement>('.setting-row');
      if (rowEl === null) return;
      const index = rendered.findIndex((row) => row.el === rowEl);
      if (index === -1 || (index === rowIndex && !sidebar.hasFocus())) return;
      sidebar.setFocused(false);
      rowIndex = index;
      applyFocus();
    },
    { passive: true },
  );

  return {
    isOpen: () => open,
    isDirty: () => dirty,

    openNew: () => {
      if (open) return;
      title = '';
      id = '';
      idEdited = false;
      cover = null;
      heroes = [];
      music = null;
      dirty = false;
      sectionId = 'basics';
      paneId = null;
      rendered = [];
      rowIndex = 0;
      open = true;
      app.dataset['overlay'] = 'game-settings';
      screen.setAttribute('aria-hidden', 'false');
      deps.audio.play('popup-open');
      model = buildModel();
      sidebar.render(sidebarEntries());
      sidebar.reset();
      sidebar.setFocused(true);
      sidebar.animateIn();
      hover.arm();
      scroller.to(0, true);
      render();
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
      hover.arm();
      if (sidebar.hasFocus()) sidebar.move(-1);
      else moveRowFocus(-1, repeat);
    },

    navDown: (repeat = false) => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navDown(repeat);
        return;
      }
      hover.arm();
      if (sidebar.hasFocus()) sidebar.move(1);
      else moveRowFocus(1, repeat);
    },

    navLeft: (repeat = false) => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navLeft(repeat);
        return;
      }
      hover.arm();
      // The column is the edge of the screen: left off it leads nowhere, and inside the pane left belongs
      // to the rows that have a range to step along — none of this screen's do. Leaving is B.
      if (!repeat) deps.audio.playLimit();
    },

    navRight: (repeat = false) => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navRight(repeat);
        return;
      }
      hover.arm();
      if (!sidebar.hasFocus()) {
        if (!repeat) deps.audio.playLimit();
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
      hover.arm();
      if (sidebar.hasFocus()) {
        sidebar.activate();
        return;
      }
      const target = rendered[rowIndex];
      if (target !== undefined) activateRow(target);
    },

    navBack: () => {
      if (deps.keyboard.isOpen()) {
        deps.keyboard.navBack();
        return;
      }
      hover.arm();
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
      render();
    },
  };
}
