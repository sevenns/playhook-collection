// Pure (DOM-free) declaration of the site's Settings screen: SiteSettings + the bundled audio options in,
// a list of sections and rows out. Ported from playhook @ c26fae7 (release/v0.8.0) :
// src/renderer/settings-form-model.ts, whose split between "what is on the screen" and "how it is drawn"
// is worth keeping even without the vitest suite that motivated it there — the screen controller is DOM
// code, and the row order is not.
//
// What is NOT here is most of the launcher's screen. Its Updates, Language and Game-metadata sections and
// four of its five General rows describe things a web page has none of; leaving them in, greyed, would be
// a form of five dead controls with one live one. See settings.ts for the field-by-field account.
import type { AudioOptions } from './audio.js';
import type { SiteSettings } from './settings.js';

/** Every toggle row, keyed by the SiteSettings field it writes. */
export type ToggleId = 'keepAwake' | 'onlyGlobalAmbient';

/** Every dropdown row. */
export type SelectId = 'soundSet' | 'ambientTrack';

/** Every slider row (both are volumes, 0..100 %). */
export type SliderId = 'sfxVolume' | 'musicVolume';

/** Every plain action row. They live in the sidebar here, as they do in the launcher's own column. */
export type ActionId = 'reset' | 'close';

/** One dropdown option: a bundled file's proper name, or a phrase of the site's own. */
export interface SettingsOption {
  readonly value: string;
  readonly label: string;
}

interface LabeledRow<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly hint?: string;
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

export type SettingsRow = ToggleRow | SelectRow | SliderRow;

export interface SettingsSection {
  readonly id: SectionId;
  readonly title: string;
  readonly rows: readonly SettingsRow[];
}

export type SectionId = 'general' | 'audio';

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
 * The whole screen as data. The row order is the screen order, and it follows the launcher's Audio
 * section exactly: the set, its volume, the ambience, its override, its volume.
 */
export function buildSettingsModel(settings: SiteSettings, options: AudioOptions): SettingsModel {
  return {
    sections: [
      {
        id: 'general',
        title: 'General',
        rows: [
          {
            kind: 'toggle',
            id: 'keepAwake',
            label: 'Keep the screen awake while this page is open',
            hint: 'Off by default, unlike in Playhook: a web page should ask before it stops your screen from sleeping. Some browsers refuse it outright.',
            value: settings.keepAwake,
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
            hint: 'Plays on the landing page, on a site card, and behind any entry that has no music of its own.',
            value: settings.ambientTrack ?? '',
            options: ambientOptions(options.ambientTracks),
          },
          {
            kind: 'toggle',
            id: 'onlyGlobalAmbient',
            label: 'Only global ambience',
            hint: "When on, only the global ambience plays — an entry's own background music is ignored.",
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
