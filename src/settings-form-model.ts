// Pure (DOM-free) declaration of the Settings screen: the site's own settings + the bundled audio options
// in, a list of sections and rows out. Ported from playhook @ c26fae7 (release/v0.8.0) :
// src/renderer/settings-form-model.ts, whose split between "what is on the screen" and "how it is drawn"
// is worth keeping even without the vitest suite that motivated it there — the screen controller is DOM
// code, and the row order is not.
//
// The screen is the launcher's, WHOLE: every section, every row, in the launcher's order, with the
// launcher's own labels and hints. This is a showcase, and half a Settings screen shows half a launcher.
// What differs is which rows can be touched — only Audio, the one thing a web page actually owns; the
// rest carry `inert: true` and the launcher's out-of-the-box value, so the screen reads exactly as it
// does on a machine that has just installed Playhook.
import type { AudioOptions } from './audio.js';
import { LAUNCHER_DEFAULTS, type SiteSettings } from './settings.js';

/** Every toggle row, keyed by the AppSettings field it stands for. */
export type ToggleId =
  | 'prerelease'
  | 'summonHotkey'
  | 'preventScreensaver'
  | 'keepOpenWithoutCard'
  | 'disableSilentInstall'
  | 'steamAutoLaunch'
  | 'onlyGlobalAmbient';

/** Every dropdown row. */
export type SelectId = 'autoUpdate' | 'language' | 'soundSet' | 'ambientTrack';

/** Every free-text row. The SteamGridDB key is the only one this screen has. */
export type TextId = 'steamGridDbKey';

/** Every slider row (both are volumes, 0..100 %). */
export type SliderId = 'sfxVolume' | 'musicVolume';

/** Every plain action row. They live in the sidebar here, as they do in the launcher's own column. */
export type ActionId = 'reset' | 'close';

/** The screen's own note — one line, and the site's alone (see the section list at the bottom). */
export type NoteId = 'showcase';

/** One dropdown option: a bundled file's proper name, or a phrase of the launcher's own. */
export interface SettingsOption {
  readonly value: string;
  readonly label: string;
}

interface LabeledRow<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly hint?: string;
  /**
   * Shown with its value, but inert — the launcher's `disabled`, which it uses for a field that is real
   * and worth seeing while THIS screen has no business changing it. Here it means "this is the
   * launcher's, and a web page has nothing to change it with".
   */
  readonly inert?: boolean;
}

export interface ToggleRow extends LabeledRow<ToggleId> {
  readonly kind: 'toggle';
  readonly value: boolean;
}

export interface SelectRow extends LabeledRow<SelectId> {
  readonly kind: 'select';
  readonly value: string;
  readonly options: readonly SettingsOption[];
}

export interface SliderRow extends LabeledRow<SliderId> {
  readonly kind: 'slider';
  /** 0..100, rounded — the display unit; the controller divides by 100 before it stores. */
  readonly percent: number;
}

export interface TextRow extends LabeledRow<TextId> {
  readonly kind: 'text';
  readonly value: string;
  /** Shown greyed in place of an empty value. */
  readonly placeholder?: string;
}

/** The Updates row: a status line, a progress bar and a primary button. Settings' own kind upstream too. */
export interface StatusRow {
  readonly kind: 'update-status';
  readonly text: string;
  readonly action: string;
  readonly inert?: boolean;
}

/** A free-standing line inside the list. Not focusable — navigation steps over it. */
export interface NoteRow {
  readonly kind: 'note';
  readonly id: NoteId;
  readonly text: string;
  readonly tone: 'info' | 'warning' | 'error';
}

export type SettingsRow = ToggleRow | SelectRow | SliderRow | TextRow | StatusRow | NoteRow;

/** Whether a row can hold the focus at all (a note cannot; an inert row still can, so it can be read). */
export function isFocusable(row: SettingsRow): boolean {
  return row.kind !== 'note';
}

export type SectionId = 'updates' | 'language' | 'general' | 'metadata' | 'audio';

export interface SettingsSection {
  readonly id: SectionId;
  readonly title: string;
  readonly rows: readonly SettingsRow[];
}

export interface SettingsModel {
  readonly sections: readonly SettingsSection[];
}

/** The percent (0..100) a 0..1 volume is displayed and stepped in. */
export function volumePercent(volume: number): number {
  return Math.round(volume * 100);
}

/**
 * Cosmetic label for a raw set/track name: split on '-', capitalize each word, join with spaces
 * (`steam-big-picture` → `Steam Big Picture`). These are proper names of bundled files. Ported verbatim
 * from the launcher's own prettifyName.
 */
export function prettifyName(raw: string): string {
  return raw
    .split('-')
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * How a stored API key is DISPLAYED: dots plus its last four characters. Ported with the row it belongs
 * to; the site never has a key, so it always renders the empty case.
 */
export function maskApiKey(key: string): string {
  if (key.length === 0) return '';
  const visible = key.length > 8 ? key.slice(-4) : '';
  return `••••••••${visible}`;
}

const AUTO_UPDATE_OPTIONS: readonly SettingsOption[] = [
  { value: 'download-install', label: 'Download and install automatically' },
  { value: 'download', label: 'Download automatically, install manually' },
  { value: 'off', label: 'Off (check manually)' },
];

const LANGUAGE_OPTIONS: readonly SettingsOption[] = [
  { value: 'system', label: 'Match system' },
  { value: 'en', label: 'English' },
  { value: 'ru', label: 'Русский' },
];

/** The ambience dropdown: "No ambience" (the empty value ⇄ `null`) plus one option per bundled track. */
function ambientOptions(tracks: readonly string[]): readonly SettingsOption[] {
  return [
    { value: '', label: 'No ambience' },
    ...tracks.map((track) => ({ value: track, label: prettifyName(track) })),
  ];
}

function soundSetOptions(sets: readonly string[]): readonly SettingsOption[] {
  return sets.map((name) => ({ value: name, label: prettifyName(name) }));
}

/**
 * The whole screen as data, in the launcher's section order: Updates, Language, General, Game metadata,
 * Audio. Only the last one is live.
 */
export function buildSettingsModel(settings: SiteSettings, options: AudioOptions): SettingsModel {
  return {
    sections: [
      {
        id: 'updates',
        title: 'Updates',
        rows: [
          {
            kind: 'note',
            id: 'showcase',
            tone: 'info',
            text: "Playhook's own Settings screen, shown whole. Audio is live — it is what this page plays. Everything else describes the launcher on your machine, and is here to be read.",
          },
          {
            kind: 'update-status',
            // The launcher's `idle` status, which is what it shows before the first check.
            text: 'Check for updates to see if a new version is available.',
            action: 'Check for updates',
            inert: true,
          },
          {
            kind: 'select',
            id: 'autoUpdate',
            label: 'Automatic updates',
            value: LAUNCHER_DEFAULTS.autoUpdate,
            options: AUTO_UPDATE_OPTIONS,
            inert: true,
          },
          {
            kind: 'toggle',
            id: 'prerelease',
            label: 'Receive pre-release (beta) updates',
            value: LAUNCHER_DEFAULTS.allowPrerelease,
            inert: true,
          },
        ],
      },
      {
        id: 'language',
        title: 'Language',
        rows: [
          {
            kind: 'select',
            id: 'language',
            label: 'Interface language',
            value: LAUNCHER_DEFAULTS.language,
            options: LANGUAGE_OPTIONS,
            inert: true,
          },
        ],
      },
      {
        id: 'general',
        title: 'General',
        rows: [
          {
            kind: 'toggle',
            id: 'summonHotkey',
            label: 'Show the launcher with a gamepad shortcut',
            hint: 'Hold Menu + View on your gamepad to bring the launcher to the front.',
            value: LAUNCHER_DEFAULTS.summonHotkeyEnabled,
            inert: true,
          },
          {
            kind: 'toggle',
            id: 'preventScreensaver',
            label: 'Keep the screen awake while the launcher is open',
            value: LAUNCHER_DEFAULTS.preventScreensaver,
            inert: true,
          },
          {
            kind: 'toggle',
            id: 'keepOpenWithoutCard',
            label: 'Keep the launcher open without a card',
            value: LAUNCHER_DEFAULTS.keepOpenWithoutCard,
            inert: true,
          },
          {
            kind: 'toggle',
            id: 'disableSilentInstall',
            label: 'Disable silent installer mode (show the installer wizard)',
            value: LAUNCHER_DEFAULTS.disableSilentInstall,
            inert: true,
          },
          {
            // Steam Deck only upstream — the launcher hides the row entirely elsewhere. A showcase has no
            // machine to hide it for, and the point here is to show what the screen can hold.
            kind: 'toggle',
            id: 'steamAutoLaunch',
            label: 'Open Playhook in Steam when a card is inserted (Game Mode only)',
            hint: 'Off frees about 120 MB of RAM: the background watcher stops running. The Steam tile stays — launch it from the library.',
            value: LAUNCHER_DEFAULTS.steamAutoLaunch,
            inert: true,
          },
        ],
      },
      {
        id: 'metadata',
        title: 'Game metadata',
        rows: [
          {
            kind: 'text',
            id: 'steamGridDbKey',
            label: 'SteamGridDB API key',
            placeholder: 'Not set',
            hint: 'Optional. With a key, "Find online" also offers covers and backgrounds from SteamGridDB. Get your own at steamgriddb.com, under Preferences → API.',
            value: maskApiKey(LAUNCHER_DEFAULTS.steamGridDbApiKey),
            inert: true,
          },
        ],
      },
      {
        id: 'audio',
        title: 'Audio',
        rows: [
          {
            kind: 'select',
            id: 'soundSet',
            label: 'Navigation sounds',
            value: settings.soundSet,
            options: soundSetOptions(options.soundSets),
          },
          {
            kind: 'slider',
            id: 'sfxVolume',
            label: 'Navigation sounds volume',
            percent: volumePercent(settings.sfxVolume),
          },
          {
            kind: 'select',
            id: 'ambientTrack',
            label: 'Background ambience',
            value: settings.ambientTrack ?? '',
            options: ambientOptions(options.ambientTracks),
          },
          {
            kind: 'toggle',
            id: 'onlyGlobalAmbient',
            label: 'Only global ambience',
            hint: "When on, only the global ambience plays — a game's own background music is ignored.",
            value: settings.onlyGlobalAmbient,
          },
          {
            kind: 'slider',
            id: 'musicVolume',
            label: 'Ambience volume',
            percent: volumePercent(settings.musicVolume),
          },
        ],
      },
    ],
  };
}
