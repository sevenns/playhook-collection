// The site's own settings: the small half of playhook's AppSettings that a web page can honestly keep.
//
// The launcher persists ~17 fields to settings.json in its userData directory and pushes every change
// back to the renderer over IPC. A page has neither, so what stands in for both is `localStorage` — a
// first-party, strictly-functional preference store, which is also why there is no consent question
// attached to it. The values that survive are the ones a showcase can act on at all: the audio ones
// (which are the whole point of the screen) and the one General row a browser can honour.
//
// Everything the launcher keeps that a page cannot has been left out rather than shown greyed: update
// mode and pre-release channel (nothing here self-updates), interface language (the site has no i18n
// layer), the summon hotkey, "keep open without a card", silent install, the Steam Deck auto-launch and
// the SteamGridDB key (no card, no installer, no store lookups). See PORTED-FROM.md.
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
  /** Hold a screen wake lock while the page is open (see wake-lock.ts). */
  readonly keepAwake: boolean;
}

/**
 * The launcher's own defaults (app-settings.ts, DEFAULT_SETTINGS), for every field the two share — the
 * showcase should behave like the product out of the box.
 *
 * BROWSER: `keepAwake` is the one that does NOT follow it. The launcher defaults preventScreensaver to
 * true, which is right for a fullscreen kiosk the user opened on purpose; a web page that stops the
 * screen from sleeping without being asked is simply a bad guest, so here it starts off.
 */
export const DEFAULT_SETTINGS: SiteSettings = {
  soundSet: DEFAULT_SOUND_SET,
  sfxVolume: 1,
  ambientTrack: DEFAULT_AMBIENT_TRACK,
  onlyGlobalAmbient: false,
  musicVolume: 0.5,
  keepAwake: false,
};

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
    keepAwake:
      typeof source['keepAwake'] === 'boolean' ? source['keepAwake'] : DEFAULT_SETTINGS.keepAwake,
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
