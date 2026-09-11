// The site's settings: the half of playhook's AppSettings a web page can actually act on — its audio.
//
// The SCREEN shows the launcher's settings whole (see settings-form-model.ts); this file is only about
// the ones that are live, because those are the only ones there is anything to store. The launcher
// persists seventeen fields to settings.json in its userData directory and pushes every change back to
// the renderer over IPC; a page has neither, so what stands in for both is `localStorage` — a
// first-party, strictly-functional preference store, which is also why there is no consent question
// attached to it.
import { DEFAULT_AMBIENT_TRACK, DEFAULT_SOUND_SET, type AudioOptions } from './audio.js';

/** What the site keeps, mirroring the fields of playhook's AppSettings it shares. */
export interface SiteSettings {
  /** The bundled UI sound set — every sound the page plays, on every screen. */
  readonly soundSet: string;
  /** 0..1. */
  readonly sfxVolume: number;
  /** The bundled ambience track, without its extension; null is "No ambience". */
  readonly ambientTrack: string | null;
  /** Ambience wins over an entry's own background music instead of falling back to it. */
  readonly onlyGlobalAmbient: boolean;
  /** 0..1, shared by the ambience and by an entry's music — as in the launcher. */
  readonly musicVolume: number;
}

/** The launcher's own defaults (app-settings.ts, DEFAULT_SETTINGS) for the fields the two share. */
export const DEFAULT_SETTINGS: SiteSettings = {
  soundSet: DEFAULT_SOUND_SET,
  sfxVolume: 1,
  ambientTrack: DEFAULT_AMBIENT_TRACK,
  onlyGlobalAmbient: false,
  musicVolume: 0.5,
};

/**
 * The launcher's defaults for the fields this page has no say over — what a freshly installed Playhook
 * shows in those rows. They are frozen VALUES, not settings: nothing here writes them, and the rows that
 * display them are inert (see settings-form-model.ts). Copied from playhook @ c26fae7 :
 * src/main/app-settings.ts, DEFAULT_SETTINGS.
 */
export const LAUNCHER_DEFAULTS = {
  autoUpdate: 'download-install',
  allowPrerelease: false,
  language: 'system',
  summonHotkeyEnabled: true,
  preventScreensaver: true,
  keepOpenWithoutCard: true,
  disableSilentInstall: false,
  steamAutoLaunch: true,
  steamGridDbApiKey: '',
} as const;

/** The Playhook release this UI matches — shown beside the screen title, as the launcher does. */
export const LAUNCHER_VERSION = '0.8.1';

const STORAGE_KEY = 'playhook-collection:settings';

export interface SettingsStore {
  read(): SiteSettings;
  /** Applies a partial change, persists it and notifies every subscriber. */
  patch(change: Partial<SiteSettings>): void;
  /** Back to DEFAULT_SETTINGS, stored copy included. */
  reset(): void;
  subscribe(listener: (settings: SiteSettings) => void): void;
}

function clampVolume(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

function asName(value: unknown, allowed: readonly string[] | null): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (allowed !== null && !allowed.includes(value)) return undefined;
  return value;
}

/**
 * A stored snapshot, field by field, with anything unreadable falling back to its default. The store is
 * the user's own browser profile rather than a file we wrote — a stale key from an older version of the
 * site, or a value edited by hand, must not take the screen down with it.
 *
 * The set and track names are NOT checked against the bundled lists here: those arrive from audio.json
 * on their own schedule (see AudioOptions), and rejecting a name before the list is known would quietly
 * reset a perfectly good choice on every load.
 */
function parseSettings(raw: unknown): SiteSettings {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_SETTINGS;
  const source = raw as Record<string, unknown>;
  return {
    soundSet: asName(source['soundSet'], null) ?? DEFAULT_SETTINGS.soundSet,
    sfxVolume: clampVolume(source['sfxVolume']) ?? DEFAULT_SETTINGS.sfxVolume,
    ambientTrack:
      source['ambientTrack'] === null
        ? null
        : (asName(source['ambientTrack'], null) ?? DEFAULT_SETTINGS.ambientTrack),
    onlyGlobalAmbient:
      typeof source['onlyGlobalAmbient'] === 'boolean'
        ? source['onlyGlobalAmbient']
        : DEFAULT_SETTINGS.onlyGlobalAmbient,
    musicVolume: clampVolume(source['musicVolume']) ?? DEFAULT_SETTINGS.musicVolume,
  };
}

/**
 * Reads the stored settings. Every access to `localStorage` is guarded: a browser in private mode, or
 * one told to block site data, throws on the PROPERTY, not just on the call — and a settings screen is
 * not worth a blank page.
 */
function load(): SiteSettings {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === null) return DEFAULT_SETTINGS;
    return parseSettings(JSON.parse(stored));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function save(settings: SiteSettings): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage refused (private mode, blocked site data): the settings still hold for this page view.
  }
}

export function createSettingsStore(): SettingsStore {
  let settings = load();
  const listeners: ((next: SiteSettings) => void)[] = [];

  function publish(next: SiteSettings): void {
    settings = next;
    save(next);
    for (const listener of listeners) listener(next);
  }

  return {
    read: () => settings,
    patch: (change) => publish({ ...settings, ...change }),
    reset: () => publish(DEFAULT_SETTINGS),
    subscribe: (listener) => {
      listeners.push(listener);
    },
  };
}

/** Where the build put the list of bundled sets and tracks (see scripts/build.mjs). */
const AUDIO_OPTIONS_URL = './audio.json';

function asStringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * The bundled sound sets and ambience tracks, as the build enumerated them. The launcher scans its own
 * `audio/` directory in main and pushes the result to the renderer (`AudioOptions`); the page fetches
 * the same answer, written out at build time — so a set is added by dropping a folder in `public/sfx`
 * and nothing else.
 *
 * Rejects rather than resolving empty: an empty list and a failed fetch mean different things to the
 * screen, and only the second one is worth saying out loud.
 */
export async function loadAudioOptions(): Promise<AudioOptions> {
  const response = await fetch(AUDIO_OPTIONS_URL, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`audio options: HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (typeof raw !== 'object' || raw === null) throw new Error('audio options: not an object');
  const source = raw as Record<string, unknown>;
  return {
    soundSets: asStringList(source['soundSets']),
    ambientTracks: asStringList(source['ambientTracks']),
  };
}
