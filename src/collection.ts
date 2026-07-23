// The collection feed: the site's own data source, and the same JSON contract the launcher's Configure
// window will point at (see collection/README.md). Generated at build time by scripts/collection-feed.mjs
// from the `collection/` directory.
//
// ONE request, not two: index.json carries the full preview payload for every entry (hero images, per-game
// sounds, music), so opening the list needs nothing else. The per-slug files the generator also writes are
// for the launcher; the site never reads them. With entries in the dozens and a few hundred bytes each,
// lazy per-entry loading would only buy a cache, a loading state on the game screen and a second class of
// network error.

import { type SfxName } from './audio.js';

/** One catalogue entry, with every URL already resolved against the feed directory. */
export interface CollectionEntry {
  readonly slug: string;
  readonly title: string;
  readonly steamAppId?: number;
  /** The date a human last verified the manifest (meta.json's verifiedAt) — not an mtime. */
  readonly updatedAt: string;
  /** Where the entry lives in this repository, e.g. `collection/bloodborne` (the Github button's target). */
  readonly sourcePath: string;
  readonly manifestUrl: string;
  readonly heroUrls: readonly string[];
  /** Per-game overrides for the UI sound slots; missing slots fall back to the site's default set. */
  readonly sounds: Partial<Record<SfxName, string>>;
  readonly music: string | null;
}

/** Slugs reach us from the URL hash, i.e. from untrusted input — validate BEFORE building any URL. */
const SLUG_RE = /^[a-z0-9-]+$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

// The feed's own directory. Paths INSIDE the feed are relative to it, and that is NOT the same base a
// relative fetch() uses: `fetch('./api/v1/index.json')` resolves against the document (correct under any
// Pages path prefix), but a string like "bloodborne/assets/hero1.jpg" taken out of the JSON and handed to
// backgroundImage or new Audio() would ALSO resolve against the document — landing one directory short and
// 404-ing every asset with a perfectly clean console. So every path from the feed goes through assetUrl(),
// in exactly one place: the parser below.
const FEED_BASE = new URL('api/v1/', document.baseURI);
const FEED_INDEX = new URL('index.json', FEED_BASE);

const assetUrl = (path: string): string => new URL(path, FEED_BASE).href;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const SFX_SLOTS: readonly SfxName[] = ['navigate', 'button', 'back', 'play'];

/** Parses one raw entry, or returns null if it doesn't carry the fields the UI needs. */
function parseEntry(raw: unknown): CollectionEntry | null {
  if (!isRecord(raw)) return null;
  const slug = asString(raw['slug']);
  const title = asString(raw['title']);
  if (slug === null || title === null || !isValidSlug(slug)) return null;

  const heroUrls: string[] = [];
  if (Array.isArray(raw['heroUrls'])) {
    for (const item of raw['heroUrls']) {
      const path = asString(item);
      if (path !== null) heroUrls.push(assetUrl(path));
    }
  }

  const sounds: Partial<Record<SfxName, string>> = {};
  const rawSounds = raw['sounds'];
  if (isRecord(rawSounds)) {
    for (const slot of SFX_SLOTS) {
      const path = asString(rawSounds[slot]);
      if (path !== null) sounds[slot] = assetUrl(path);
    }
  }

  const music = asString(raw['music']);
  const steamAppId = raw['steamAppId'];

  return {
    slug,
    title,
    ...(typeof steamAppId === 'number' ? { steamAppId } : {}),
    updatedAt: asString(raw['updatedAt']) ?? '',
    sourcePath: asString(raw['sourcePath']) ?? `collection/${slug}`,
    manifestUrl: assetUrl(asString(raw['manifestUrl']) ?? `${slug}/game.json`),
    heroUrls,
    sounds,
    music: music !== null ? assetUrl(music) : null,
  };
}

/**
 * Fetches and parses the catalogue. Rejects on a network failure or unparseable JSON — the caller turns
 * that into the list's `Collection unavailable` state. An entry that fails to parse is dropped rather
 * than failing the whole load: the feed is generated and schema-checked at build time, so this branch is
 * purely defensive against a future shape change.
 */
export async function loadIndex(): Promise<readonly CollectionEntry[]> {
  const response = await fetch(FEED_INDEX.href, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`feed request failed: ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload) || !Array.isArray(payload['entries'])) {
    throw new Error('feed is missing an `entries` array');
  }
  const entries: CollectionEntry[] = [];
  for (const raw of payload['entries']) {
    const entry = parseEntry(raw);
    if (entry !== null) entries.push(entry);
  }
  return entries;
}
