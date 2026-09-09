// The Settings screen — the site's counterpart of playhook's fourth surface (c26fae7 :
// src/renderer/settings-screen.ts). It owns its own state (the current SiteSettings, the bundled audio
// options), the row focus, the expanded dropdown and the slider drag, and exposes the same six
// navigation primitives every other surface does, so controls.ts only has to route to it.
//
// Structurally it is the Library's and Customize's twin: the same veil + column + sidebar skeleton, with
// a pane of rows on the right. What decides WHAT is on screen lives in settings-form-model.ts; the row
// DOM in settings-form-view.ts. The launcher's split, kept.
//
// Where it diverges from the launcher is what a setting can BE here — see settings.ts. There is no IPC
// seam either: a change is applied to the audio controller directly and written to localStorage, which is
// the whole of "persisting" on a page.
import { type AudioController } from './audio.js';
import { req } from './dom.js';
import { createEntrance } from './entrance.js';
import { createHoverGuard } from './hover-guard.js';
import { clampIndex, wrapIndex } from './index-math.js';
import type { NavSurface } from './nav-surface.js';
import { pxUnit } from './px-unit.js';
import { createScroller } from './screen-scroller.js';
import { createSidebar } from './screen-sidebar.js';
import {
  buildSettingsModel,
  isFocusable,
  isInertRow,
  volumePercent,
  type ActionId,
  type SectionId,
  type SelectId,
  type SettingsModel,
  type SettingsOption,
  type SettingsRow,
  type SliderId,
  type ToggleId,
} from './settings-form-model.js';
import type { AudioOptions } from './audio.js';
import { LAUNCHER_VERSION, type SiteSettings } from './settings.js';
import { optionLabelNode, patchRow, renderRows, type RenderedRow } from './settings-form-view.js';

/** Gamepad A doesn't trigger :active — the same press flash the rest of the UI uses (controls.ts). */
const PRESS_MS = 130;
/** One keyboard/gamepad step of a volume slider, in percent. */
const VOLUME_STEP = 5;
/** The SFX preview plays at most this often while a volume is being dragged. */
const PREVIEW_THROTTLE_MS = 220;
/** Marquee speed for a clipped option label, in DESIGN px per second. */
const MARQUEE_SPEED_PX_PER_S = 60;
/** How long the pane's staggered arrival runs before the marks come off (mirrors .is-entering). */
const ENTRANCE_MS = 700;
/** The stagger stops counting here: past a handful of rows the wave is a wait, not a wave. */
const ENTRANCE_STEPS = 8;
/**
 * How long the pane waits before showing the section the column moved onto. A held direction walks
 * through the column faster than that, so the pane is drawn ONCE, when the movement stops.
 */
const PREVIEW_MS = 120;

export interface SettingsScreenDeps {
  readonly audio: AudioController;
  /** The current settings — read on every render, so the store stays the single source of truth. */
  getSettings(): SiteSettings;
  /** A field changed: the store persists it and pushes it back through applySettings. */
  onChange(change: Partial<SiteSettings>): void;
  /** The screen closed itself (B / Close / veil click) — controls.ts restores the bar focus. */
  onClosed(): void;
  /** "Reset to defaults" was activated — controls.ts asks the shared confirm popup. */
  onResetRequested(): void;
}

export interface SettingsScreen extends NavSurface {
  open(): void;
  /** `silent` is a hand-over to another surface, which sounds and re-focuses for itself. */
  close(silent?: boolean): void;
  /** A new settings snapshot — the single source of truth for every value on screen. */
  applySettings(settings: SiteSettings): void;
  /** The bundled sets and tracks, once the build's audio.json has answered. */
  applyAudioOptions(options: AudioOptions): void;
}

/**
 * Applies a toggle's new value to a settings snapshot. Only the Audio toggle can get here — every other
 * one is inert (settings-form-model.ts) and never reaches a writer — but the mapping is exhaustive over
 * the whole id union anyway, so a row that stops being inert cannot silently write nothing.
 */
function withToggle(id: ToggleId, value: boolean): Partial<SiteSettings> | null {
  switch (id) {
    case 'onlyGlobalAmbient':
      return { onlyGlobalAmbient: value };
    case 'prerelease':
    case 'summonHotkey':
    case 'preventScreensaver':
    case 'keepOpenWithoutCard':
    case 'disableSilentInstall':
    case 'steamAutoLaunch':
      return null;
  }
}

function withSelect(id: SelectId, value: string): Partial<SiteSettings> | null {
  switch (id) {
    case 'soundSet':
      return { soundSet: value };
    case 'ambientTrack':
      return { ambientTrack: value === '' ? null : value };
    case 'autoUpdate':
    case 'language':
      return null;
  }
}

function withVolume(id: SliderId, volume: number): Partial<SiteSettings> {
  switch (id) {
    case 'sfxVolume':
      return { sfxVolume: volume };
    case 'musicVolume':
      return { musicVolume: volume };
  }
}

function volumeOf(settings: SiteSettings, id: SliderId): number {
  return id === 'sfxVolume' ? settings.sfxVolume : settings.musicVolume;
}

function clampPercent(percent: number): number {
  return Math.min(100, Math.max(0, Math.round(percent)));
}

export function createSettingsScreen(deps: SettingsScreenDeps): SettingsScreen {
  const app = req('app');
  const screen = req('settings');
  const versionEl = req('settings-version');
  const veil = screen.querySelector<HTMLElement>('.settings-veil');
  const listEl = req('settings-list');
  const optionsEl = req('settings-options');
  const optionsListEl = req('settings-options-list');
  const optionsVeil = optionsEl.querySelector<HTMLElement>('.settings-options-veil');

  const listScroller = createScroller(listEl);
  const optionsScroller = createScroller(optionsListEl);
  const entrance = createEntrance(listEl, '.setting-row', ENTRANCE_MS);
  const hover = createHoverGuard();

  let open = false;
  let options: AudioOptions = { soundSets: [], ambientTracks: [] };
  let model: SettingsModel = buildSettingsModel(deps.getSettings(), options);
  /** The rows of the SELECTED section only — the pane shows one section at a time. */
  let rendered: readonly RenderedRow[] = [];
  let focusIndex = 0;
  /** The section a fresh visit opens on: the first one the model lists, whatever that turns out to be. */
  const firstSection = (): SectionId => model.sections[0]?.id ?? 'audio';

  /** Which section the column has SELECTED, and which one the pane is actually showing. */
  let sectionId: SectionId = firstSection();
  let paneId: SectionId | null = null;
  let previewTimer = 0;

  // The expanded dropdown: which row it belongs to, its option buttons and the focused option.
  let openSelect: {
    readonly rowIndex: number;
    readonly buttons: readonly HTMLButtonElement[];
  } | null = null;
  let optionIndex = 0;

  // Slider drag. The launcher has to freeze the dragged field while main echoes an older value back;
  // here the store answers synchronously, so there is no stale push to guard against and the row is
  // patched on every pointermove like any other change. What the flag is still for is the CSS class that
  // takes the knob's transition off while it follows the cursor.
  let dragging: {
    readonly rowIndex: number;
    readonly track: HTMLElement;
    readonly pointerId: number;
  } | null = null;
  let lastPreviewAt = 0;

  const sidebar = createSidebar<SectionId, ActionId>(req('settings-nav'), {
    audio: deps.audio,
    onSection: (id, entered) => {
      sectionId = id;
      if (entered) {
        enterPane();
        return;
      }
      schedulePreview();
    },
    onAction: (id) => {
      if (id === 'reset') {
        deps.audio.play('button');
        deps.onResetRequested();
        return;
      }
      // Closing is a LEAVING gesture, and close() plays `back` for it — one gesture, one sound.
      navBack();
    },
  });

  function focusedRow(): RenderedRow | undefined {
    return rendered[focusIndex];
  }

  function pressFlash(el: HTMLElement): void {
    el.classList.add('is-pressed');
    window.setTimeout(() => el.classList.remove('is-pressed'), PRESS_MS);
  }

  /** The rows the pane shows: one section's worth, empty for a section the model no longer carries. */
  function rowsOf(id: SectionId): readonly SettingsRow[] {
    return model.sections.find((section) => section.id === id)?.rows ?? [];
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
    model = buildSettingsModel(deps.getSettings(), options);
    renderColumn();
    const rows = rowsOf(sectionId).filter((row) => isFocusable(row));
    if (rendered.length === rows.length && paneId === sectionId) {
      rendered.forEach((row, index) => {
        const next = rows[index];
        if (next === undefined) return;
        patchRow(row, next);
      });
      return;
    }
    renderPane();
  }

  function renderColumn(): void {
    sidebar.render([
      ...model.sections.map((section) => ({
        id: section.id,
        label: section.title,
        kind: 'section' as const,
      })),
      { id: 'reset' as const, label: 'Reset to defaults', kind: 'action' as const },
      { id: 'close' as const, label: 'Close', kind: 'action' as const },
    ]);
  }

  /** Draws the selected section into the pane. The column is rebuilt separately. */
  function renderPane(): void {
    paneId = sectionId;
    rendered = renderRows(listEl, rowsOf(sectionId), ENTRANCE_STEPS);
    entrance.play();
    focusIndex = Math.min(Math.max(focusIndex, 0), Math.max(0, rendered.length - 1));
    applyRowFocus(true);
    listScroller.to(0, true);
    // The rows were inserted THIS tick, so scrollHeight is still the pre-layout value — the fades would
    // be computed against a list that "doesn't scroll yet". Re-run them once the layout has settled.
    requestAnimationFrame(() => listScroller.fades());
  }

  /** Paints the focus and keeps it on screen. */
  function applyRowFocus(instant = false): void {
    const active = !sidebar.hasFocus();
    listEl.classList.toggle('is-active', active);
    rendered.forEach((row, index) =>
      row.el.classList.toggle('is-focused', active && index === focusIndex),
    );
    if (!active) return;
    const target = focusedRow();
    if (target === undefined) return;
    listScroller.reveal(target.el, instant);
  }

  /** Hands the focus from the column to the pane, at its first row. */
  function enterPane(): void {
    flushPreview();
    if (rendered.length === 0) {
      deps.audio.playLimit();
      return;
    }
    sidebar.setFocused(false);
    focusIndex = 0;
    hover.arm();
    applyRowFocus();
  }

  /** …and back. The column is the only place the screen can be left from. */
  function leavePane(): void {
    closeOptions();
    sidebar.setFocused(true);
    hover.arm();
    applyRowFocus();
  }

  // ── Value changes ──────────────────────────────────────────────────────────

  function toggleRow(row: Extract<SettingsRow, { kind: 'toggle' }>): void {
    const change = withToggle(row.id, !row.value);
    if (change === null) return;
    deps.audio.play('button');
    deps.onChange(change);
  }

  /** Moves a dropdown to another value, animating the text in the direction of the press. */
  function setSelectValue(
    rowIndex: number,
    row: Extract<SettingsRow, { kind: 'select' }>,
    value: string,
    direction: 'prev' | 'next' | null,
  ): void {
    if (value === row.value) return;
    const valueEl = rendered[rowIndex]?.valueEl;
    const change = withSelect(row.id, value);
    if (change === null) return;
    if (valueEl !== undefined && direction !== null) {
      valueEl.classList.add(direction === 'prev' ? 'is-shift-prev' : 'is-shift-next');
      window.setTimeout(() => valueEl.classList.remove('is-shift-prev', 'is-shift-next'), 120);
    }
    deps.onChange(change);
    // The sound set is switched by that very change, so the cue is heard in the set that was just
    // chosen — which is the point of choosing one.
    deps.audio.play('navigate');
  }

  /** Cycles a dropdown by one step, wrapping — the fast gamepad path that never expands the list. */
  function cycleSelect(
    rowIndex: number,
    row: Extract<SettingsRow, { kind: 'select' }>,
    delta: number,
  ): void {
    if (row.options.length === 0) {
      deps.audio.playLimit(); // the bundled list has not arrived (or failed to)
      return;
    }
    const current = row.options.findIndex((option) => option.value === row.value);
    const base = current === -1 ? 0 : current;
    const next = (base + delta + row.options.length) % row.options.length;
    const option = row.options[next];
    if (option === undefined) return;
    setSelectValue(rowIndex, row, option.value, delta > 0 ? 'next' : 'prev');
  }

  /** Applies a volume and previews it. The store's push is what repaints the row. */
  function applyVolume(row: Extract<SettingsRow, { kind: 'slider' }>, percent: number): void {
    const clamped = clampPercent(percent);
    deps.onChange(withVolume(row.id, clamped / 100));
    // Only the SFX slider previews itself: the music volume is already audible on the running track.
    const now = performance.now();
    if (row.id === 'sfxVolume' && now - lastPreviewAt >= PREVIEW_THROTTLE_MS) {
      lastPreviewAt = now;
      deps.audio.play('navigate');
    }
  }

  function stepSlider(row: Extract<SettingsRow, { kind: 'slider' }>, delta: number): void {
    const current = volumePercent(volumeOf(deps.getSettings(), row.id));
    const next = clampPercent(current + delta * VOLUME_STEP);
    if (next === current) {
      deps.audio.playLimit(); // already at 0 % / 100 %
      return;
    }
    applyVolume(row, next);
  }

  // ── Expanded dropdown ──────────────────────────────────────────────────────

  function closeOptions(silent = false): void {
    if (openSelect === null) return;
    // `silent` for the cascade out of close(): the screen going away is one popup-close, not two.
    if (!silent) deps.audio.play('popup-close');
    openSelect = null;
    screen.classList.remove('is-options-open');
    optionsEl.classList.remove('is-open');
    optionsEl.setAttribute('aria-hidden', 'true');
    optionsListEl.replaceChildren();
  }

  function applyOptionFocus(instant = false): void {
    openSelect?.buttons.forEach((button, index) =>
      button.classList.toggle('is-focused', index === optionIndex),
    );
    const focused = openSelect?.buttons[optionIndex];
    if (focused !== undefined) optionsScroller.reveal(focused, instant);
    updateOptionMarquee(); // the marquee follows the focus — only the focused label moves
  }

  function chooseOption(rowIndex: number, option: SettingsOption): void {
    const row = rendered[rowIndex]?.row;
    if (row === undefined || row.kind !== 'select') return;
    closeOptions();
    setSelectValue(rowIndex, row, option.value, null);
  }

  function openOptions(rowIndex: number, row: Extract<SettingsRow, { kind: 'select' }>): void {
    if (row.options.length === 0) {
      deps.audio.playLimit();
      return;
    }
    const buttons = row.options.map((option) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'settings-option';
      button.append(optionLabelNode(option.label));
      button.classList.toggle('is-current', option.value === row.value);
      button.addEventListener('click', () => {
        pressFlash(button);
        chooseOption(rowIndex, option);
      });
      return button;
    });
    deps.audio.play('popup-open');
    optionsListEl.replaceChildren(...buttons);
    screen.classList.add('is-options-open');
    optionsEl.classList.add('is-open');
    // Measured synchronously: reading clientWidth flushes the layout for the nodes just inserted, which
    // a requestAnimationFrame callback would only get around to on the next frame.
    updateOptionMarquee();
    optionsEl.setAttribute('aria-hidden', 'false');
    const current = row.options.findIndex((option) => option.value === row.value);
    optionIndex = current === -1 ? 0 : current;
    openSelect = { rowIndex, buttons };
    hover.arm();
    applyOptionFocus(true);
  }

  /**
   * Marks every option whose label doesn't fit as clipped (→ a soft fade at the cut) and starts the
   * marquee on the FOCUSED one. Ported from the launcher's updateOptionMarquee: same measurement, same
   * constant speed, so a long label reads at one pace whatever its length.
   */
  function updateOptionMarquee(): void {
    if (openSelect === null) return;
    // A window that hasn't laid out yet reports zero widths — measuring against that would mark every
    // label as fitting. Try again on the next frame instead of guessing.
    const first = openSelect.buttons[0]?.querySelector<HTMLElement>('.settings-option-clip');
    if (first !== null && first !== undefined && first.clientWidth === 0) {
      requestAnimationFrame(() => updateOptionMarquee());
      return;
    }
    for (const button of openSelect.buttons) {
      const clip = button.querySelector<HTMLElement>('.settings-option-clip');
      const text = button.querySelector<HTMLElement>('.settings-option-text');
      if (clip === null || text === null) continue;
      const overflow = text.scrollWidth - clip.clientWidth;
      const clipped = overflow > 1;
      button.classList.toggle('is-clipped', clipped);
      if (clipped && button.classList.contains('is-focused')) {
        text.style.setProperty('--marquee-shift', `${-overflow}px`);
        text.style.setProperty(
          '--marquee-duration',
          `${Math.max(2, overflow / (MARQUEE_SPEED_PX_PER_S * pxUnit()))}s`,
        );
        button.classList.add('is-scrolling');
      } else {
        button.classList.remove('is-scrolling');
        text.style.removeProperty('--marquee-shift');
        text.style.removeProperty('--marquee-duration');
      }
    }
  }

  // ── The six primitives ─────────────────────────────────────────────────────

  function moveRowFocus(delta: number, repeat: boolean): void {
    if (rendered.length === 0) return;
    const next = clampIndex(focusIndex, delta, rendered.length);
    if (next === focusIndex) {
      if (!repeat) deps.audio.playLimit(); // the end of the list
      return;
    }
    focusIndex = next;
    deps.audio.play('navigate');
    applyRowFocus();
  }

  function moveOptionFocus(delta: number): void {
    if (openSelect === null || openSelect.buttons.length === 0) return;
    const next = wrapIndex(optionIndex, delta, openSelect.buttons.length);
    if (next === optionIndex) return;
    optionIndex = next;
    deps.audio.play('navigate');
    applyOptionFocus();
  }

  function navHorizontal(delta: number, repeat: boolean): void {
    hover.arm();
    // From the column, RIGHT steps into the pane — the direction the layout already suggests. Left is
    // NOT its mirror inside the pane: there it belongs to the sliders and the dropdowns, so leaving is B.
    if (sidebar.hasFocus()) {
      if (delta > 0 && sidebar.selected()?.kind === 'section') enterPane();
      else if (!repeat) deps.audio.playLimit();
      return;
    }
    const target = focusedRow();
    if (target === undefined) return;
    const row = target.row;
    if (isInertRow(row)) {
      if (!repeat) deps.audio.playLimit(); // shown to be read, not to be changed
      return;
    }
    // A checkbox is NOT stepped through: left/right belong to the rows that have a range to move along,
    // and a two-state row answering them by flipping means a walk across the form changes a setting on
    // the way past. A checkbox is switched with A, and only with A.
    if (row.kind === 'select') {
      cycleSelect(focusIndex, row, delta);
      return;
    }
    if (row.kind === 'slider') {
      stepSlider(row, delta);
      return;
    }
    if (!repeat) deps.audio.playLimit();
  }

  function activateRow(target: RenderedRow, index: number): void {
    const row = target.row;
    if (isInertRow(row)) {
      deps.audio.playLimit();
      return;
    }
    switch (row.kind) {
      case 'toggle':
        pressFlash(target.el);
        toggleRow(row);
        break;
      case 'select':
        // Two sounds, deliberately: `button` is the row being pressed, `popup-open` is the list
        // appearing — the same pair a site card plays when it opens its surface.
        deps.audio.play('button');
        pressFlash(target.el);
        openOptions(index, row);
        break;
      case 'slider':
        deps.audio.playLimit(); // a slider is moved with left/right, and A has nothing to press on it
        break;
      case 'text':
      case 'update-status':
      case 'note':
        // Only ever reached for a row that is not inert, which none of these three ever is here.
        deps.audio.playLimit();
        break;
    }
  }

  function hide(silent: boolean): void {
    if (!open) return;
    open = false;
    closeOptions(true); // leaving the screen takes the dropdown with it — one sound, not two
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

  function navBack(): void {
    hover.arm();
    if (openSelect !== null) {
      closeOptions();
      return;
    }
    // Out of the pane, back to the column; out of the column, off the screen. The screen can only be
    // left from the column, which is also where Reset and Close live.
    if (!sidebar.hasFocus()) {
      deps.audio.play('back');
      leavePane();
      return;
    }
    hide(false);
  }

  // ── Mouse ──────────────────────────────────────────────────────────────────

  /** A click inside a row: the chevrons and the slider track act on their own. */
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
    focusIndex = index;
    applyRowFocus();
    const chevronEl = target.closest<HTMLElement>('.setting-chevron');
    if (chevronEl !== null && entry.row.kind === 'select') {
      cycleSelect(index, entry.row, chevronEl.dataset['chevron'] === 'prev' ? -1 : 1);
      return;
    }
    // The track handles its own pointer events (jump + drag) — don't double-act on the click.
    if (target.closest('.setting-track') !== null) return;
    activateRow(entry, index);
  });

  /** The percent a pointer at `clientX` picks on `track`. */
  function percentAt(track: HTMLElement, clientX: number): number {
    const rect = track.getBoundingClientRect();
    if (rect.width === 0) return 0;
    return clampPercent(((clientX - rect.left) / rect.width) * 100);
  }

  listEl.addEventListener('pointerdown', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const track = target.closest<HTMLElement>('.setting-track');
    if (track === null) return;
    const rowEl = track.closest<HTMLElement>('.setting-row');
    if (rowEl === null) return;
    const index = rendered.findIndex((row) => row.el === rowEl);
    const entry = rendered[index];
    if (entry === undefined || entry.row.kind !== 'slider') return;
    sidebar.setFocused(false);
    focusIndex = index;
    applyRowFocus();
    // No transition while the knob follows the cursor — a transition there reads as lag.
    track.closest('.setting-slider')?.classList.add('is-dragging');
    dragging = { rowIndex: index, track, pointerId: event.pointerId };
    track.setPointerCapture(event.pointerId);
    applyVolume(entry.row, percentAt(track, event.clientX));
  });

  listEl.addEventListener('pointermove', (event) => {
    if (dragging === null || event.pointerId !== dragging.pointerId) return;
    const entry = rendered[dragging.rowIndex];
    if (entry === undefined || entry.row.kind !== 'slider') return;
    applyVolume(entry.row, percentAt(dragging.track, event.clientX));
  });

  function endDrag(): void {
    if (dragging === null) return;
    dragging.track.closest('.setting-slider')?.classList.remove('is-dragging');
    const held = dragging;
    dragging = null;
    if (held.track.hasPointerCapture(held.pointerId)) {
      held.track.releasePointerCapture(held.pointerId);
    }
  }

  listEl.addEventListener('pointerup', endDrag);
  listEl.addEventListener('pointercancel', endDrag);

  veil?.addEventListener('click', () => {
    if (!open) return;
    deps.audio.play('back');
    hide(false);
  });

  optionsVeil?.addEventListener('click', () => closeOptions());

  /**
   * Hover, for both the row list and the expanded dropdown. WHEN it is allowed to move the focus is the
   * shared hover guard's job — it keeps tracking the pointer while the screen is closed, so opening can
   * arm it at wherever the cursor happens to rest.
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
      if (openSelect !== null) {
        const button = target.closest<HTMLButtonElement>('.settings-option');
        if (button === null) return;
        const index = openSelect.buttons.indexOf(button);
        if (index === -1 || index === optionIndex) return;
        optionIndex = index;
        applyOptionFocus();
        return;
      }
      const rowEl = target.closest<HTMLElement>('.setting-row');
      if (rowEl === null) return;
      const index = rendered.findIndex((row) => row.el === rowEl);
      if (index === -1 || (index === focusIndex && !sidebar.hasFocus())) return;
      sidebar.setFocused(false);
      focusIndex = index;
      applyRowFocus();
    },
    { passive: true },
  );

  return {
    isOpen: () => open,

    open: () => {
      if (open) return;
      open = true;
      focusIndex = 0;
      versionEl.textContent = LAUNCHER_VERSION;
      app.dataset['overlay'] = 'settings';
      screen.setAttribute('aria-hidden', 'false');
      sidebar.reset(); // a re-opened screen starts at the first section, column and pane together
      sectionId = firstSection();
      // …and the pane is REBUILT rather than patched: the rows still in it belong to whichever section
      // the last visit ended on, and patching those with section one's values crosses the two.
      paneId = null;
      rendered = [];
      sidebar.setFocused(true); // the screen opens on its table of contents, not inside a section
      sidebar.animateIn();
      hover.arm();
      // Instant, not animated: a re-open must START at the top rather than glide there.
      listScroller.to(0, true);
      render();
      applyRowFocus(true);
    },

    close: (silent = false) => hide(silent),

    applySettings: () => {
      if (!open) return;
      render();
    },

    applyAudioOptions: (next: AudioOptions) => {
      options = next;
      if (!open) {
        model = buildSettingsModel(deps.getSettings(), options);
        return;
      }
      render();
    },

    navUp: (repeat = false) => {
      hover.arm();
      if (openSelect !== null) moveOptionFocus(-1);
      else if (sidebar.hasFocus()) sidebar.move(-1);
      else moveRowFocus(-1, repeat);
    },

    navDown: (repeat = false) => {
      hover.arm();
      if (openSelect !== null) moveOptionFocus(1);
      else if (sidebar.hasFocus()) sidebar.move(1);
      else moveRowFocus(1, repeat);
    },

    navLeft: (repeat = false) => {
      hover.arm();
      // Left leaves the expanded list, the same way it leaves a popup: its column sits on the right
      // edge. A HELD left is ignored, or the same press would close the list and then start cycling the
      // row's value behind it.
      if (openSelect !== null) {
        if (!repeat) closeOptions();
        return;
      }
      navHorizontal(-1, repeat);
    },

    navRight: (repeat = false) => {
      if (openSelect !== null) return; // the expanded list is vertical
      navHorizontal(1, repeat);
    },

    navActivate: () => {
      hover.arm();
      if (openSelect !== null) {
        const row = rendered[openSelect.rowIndex]?.row;
        if (row === undefined || row.kind !== 'select') return;
        const option = row.options[optionIndex];
        if (option === undefined) return;
        chooseOption(openSelect.rowIndex, option);
        return;
      }
      if (sidebar.hasFocus()) {
        sidebar.activate();
        return;
      }
      const target = focusedRow();
      if (target === undefined) return;
      activateRow(target, focusIndex);
    },

    navBack,

    // X / Y / the shoulders / RT belong to whatever surface is on top; nothing ever opens above this
    // screen (its one text field is the launcher's, and the site has none), so they all say the same
    // thing the launcher's do with the keyboard closed.
    navSecondary: (repeat = false) => {
      if (!repeat) deps.audio.playLimit();
    },
    navTertiary: () => deps.audio.playLimit(),
    navShoulder: () => deps.audio.playLimit(),
    navCommit: () => deps.audio.playLimit(),

    relocalize: () => {
      // The site has no language to switch; the contract keeps the method (nav-surface.ts).
      if (!open) return;
      render();
    },
  };
}
