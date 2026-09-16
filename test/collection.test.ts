// The feed parser. The feed is generated and schema-checked at build time, so most of this is the
// defensive branch — but it is also the branch that decides what the site shows when the feed changes
// shape underneath it, and "quietly parsed down to nothing" is the outcome it must never produce.
import { describe, expect, it } from 'vitest';
import { FEED_SCHEMA_VERSION, isValidSlug, parseEntry, parseIndex } from '../src/collection.js';

// Under a Pages path prefix, like the real one: every path in the feed must resolve against THIS, not
// against the document.
const base = new URL('https://example.test/playhook-collection/api/v1/');

describe('isValidSlug', () => {
  it('accepts lowercase letters, digits and hyphens only', () => {
    expect(isValidSlug('tunic')).toBe(true);
    expect(isValidSlug('nfs-mw-2005')).toBe(true);
    expect(isValidSlug('')).toBe(false);
    expect(isValidSlug('Tunic')).toBe(false);
    expect(isValidSlug('a/b')).toBe(false);
    expect(isValidSlug('..')).toBe(false);
    expect(isValidSlug('a b')).toBe(false);
  });
});

describe('parseEntry', () => {
  it('parses a minimal entry, resolving what it can and defaulting the rest', () => {
    expect(parseEntry({ slug: 'tunic', title: 'Tunic' }, base)).toEqual({
      slug: 'tunic',
      title: 'Tunic',
      origin: 'collection',
      updatedAt: '',
      sourcePath: 'collection/tunic',
      manifestUrl: 'https://example.test/playhook-collection/api/v1/tunic/game.json',
      heroUrls: [],
      music: null,
    });
  });

  it('resolves every feed path against the feed directory, not the document', () => {
    const entry = parseEntry(
      {
        slug: 'tunic',
        title: 'Tunic',
        manifestUrl: 'tunic/game.json',
        heroUrls: ['tunic/assets/hero-1.webp', 42, ''],
        gridUrl: 'tunic/assets/grid.webp',
        music: 'tunic/assets/theme.ogg',
      },
      base,
    );
    expect(entry?.manifestUrl).toBe(
      'https://example.test/playhook-collection/api/v1/tunic/game.json',
    );
    expect(entry?.heroUrls).toEqual([
      'https://example.test/playhook-collection/api/v1/tunic/assets/hero-1.webp',
    ]);
    expect(entry?.gridUrl).toBe(
      'https://example.test/playhook-collection/api/v1/tunic/assets/grid.webp',
    );
    expect(entry?.music).toBe(
      'https://example.test/playhook-collection/api/v1/tunic/assets/theme.ogg',
    );
  });

  it.each([
    ['not an object', 'tunic'],
    ['an array', []],
    ['null', null],
    ['no slug', { title: 'Tunic' }],
    ['no title', { slug: 'tunic' }],
    ['an empty title', { slug: 'tunic', title: '' }],
    ['a slug that is not one', { slug: '../x', title: 'X' }],
    ['a non-string slug', { slug: 5, title: 'X' }],
  ])('returns null for %s', (_label, raw) => {
    expect(parseEntry(raw, base)).toBeNull();
  });

  it('keeps the optional fields only when they carry something', () => {
    const entry = parseEntry(
      {
        slug: 'x',
        title: 'X',
        updatedAt: '2026-01-01',
        sourcePath: 'elsewhere/x',
        steamAppId: 220,
        genres: ['RPG', 7, ''],
        releaseDate: '2011',
        platforms: ['windows', 'amiga', 'linux'],
        description: { en: 'Hello', ru: 5, fr: 'Bonjour' },
      },
      base,
    );
    expect(entry).toMatchObject({
      updatedAt: '2026-01-01',
      sourcePath: 'elsewhere/x',
      steamAppId: 220,
      genres: ['RPG'],
      releaseDate: '2011',
      platforms: ['windows', 'linux'],
      description: { en: 'Hello' },
    });
  });

  it('drops the optional fields that are the wrong shape rather than failing the entry', () => {
    const entry = parseEntry(
      {
        slug: 'x',
        title: 'X',
        steamAppId: '220',
        genres: 'RPG',
        releaseDate: 2011,
        platforms: ['amiga'],
        description: { de: 'Hallo' },
      },
      base,
    );
    expect(entry).not.toBeNull();
    expect(entry).not.toHaveProperty('steamAppId');
    expect(entry).not.toHaveProperty('genres');
    expect(entry).not.toHaveProperty('releaseDate');
    expect(entry).not.toHaveProperty('platforms');
    expect(entry).not.toHaveProperty('description');
  });
});

describe('parseIndex', () => {
  const index = (entries: unknown, schemaVersion: unknown = FEED_SCHEMA_VERSION): unknown => ({
    schemaVersion,
    entries,
  });

  it('parses the entries and drops the ones that fail on their own', () => {
    const entries = parseIndex(
      index([
        { slug: 'a', title: 'A' },
        'junk',
        { slug: 'B', title: 'b' },
        { slug: 'c', title: 'C' },
      ]),
      base,
    );
    expect(entries.map((entry) => entry.slug)).toEqual(['a', 'c']);
  });

  it.each([
    ['not an object', 'feed'],
    ['null', null],
    ['no entries', { schemaVersion: 1 }],
    ['entries that are not a list', { schemaVersion: 1, entries: {} }],
  ])('throws on a payload with %s', (_label, payload) => {
    expect(() => parseIndex(payload, base)).toThrow(/missing an `entries` array/);
  });

  it.each([
    ['a newer', { schemaVersion: 2, entries: [{ slug: 'a', title: 'A' }] }],
    ['a missing', { entries: [{ slug: 'a', title: 'A' }] }],
    ['a string', { schemaVersion: '1', entries: [{ slug: 'a', title: 'A' }] }],
  ])('throws on %s schemaVersion rather than parsing down to nothing', (_label, payload) => {
    expect(() => parseIndex(payload, base)).toThrow(/schemaVersion/);
  });
});
