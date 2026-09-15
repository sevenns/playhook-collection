// The stored-settings parser. The store is the visitor's own localStorage — a key written by an older
// version of the site, or edited by hand — so every field falls back on its own and nothing takes the
// screen down.
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings.js';

describe('parseSettings', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'playhook-abyss'],
    ['a number', 1],
  ])('returns the defaults for %s', (_label, raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('returns the defaults for an empty object and ignores keys it does not know', () => {
    expect(parseSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ theme: 'dark', volume: 3 })).toEqual(DEFAULT_SETTINGS);
  });

  it('keeps a complete, well-formed snapshot as it is', () => {
    const stored = {
      soundSet: 'ps5',
      sfxVolume: 0.25,
      ambientTrack: 'xbox',
      onlyGlobalAmbient: true,
      musicVolume: 0.75,
    };
    expect(parseSettings(stored)).toEqual(stored);
  });

  it('keeps `ambientTrack: null` — "No ambience" is a choice, not a missing value', () => {
    expect(parseSettings({ ambientTrack: null }).ambientTrack).toBeNull();
  });

  it('falls back field by field, leaving the readable ones alone', () => {
    expect(
      parseSettings({
        soundSet: 42,
        sfxVolume: 'loud',
        ambientTrack: ['xbox'],
        onlyGlobalAmbient: 'yes',
        musicVolume: 0.1,
      }),
    ).toEqual({ ...DEFAULT_SETTINGS, musicVolume: 0.1 });
  });

  it('clamps a volume into 0..1 and refuses one that is not a finite number', () => {
    expect(parseSettings({ sfxVolume: 7 }).sfxVolume).toBe(1);
    expect(parseSettings({ sfxVolume: -2 }).sfxVolume).toBe(0);
    expect(parseSettings({ musicVolume: Number.NaN }).musicVolume).toBe(
      DEFAULT_SETTINGS.musicVolume,
    );
    expect(parseSettings({ musicVolume: Number.POSITIVE_INFINITY }).musicVolume).toBe(
      DEFAULT_SETTINGS.musicVolume,
    );
  });

  it('does not check a set or track name against the bundled lists — those arrive later', () => {
    expect(parseSettings({ soundSet: 'not-bundled' }).soundSet).toBe('not-bundled');
    expect(parseSettings({ ambientTrack: 'not-bundled' }).ambientTrack).toBe('not-bundled');
  });
});
