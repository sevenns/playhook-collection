// The collection feed: the site's own data source, and the per-entry JSON contract the site publishes
// for whoever consumes it next (see collection/README.md — Playhook 0.8.0 itself takes metadata straight
// from the stores). Generated at build time by scripts/collection-feed.mjs from the `collection/`
// directory.
//
// ONE request, not two: index.json carries the full preview payload for every entry (hero images, the
// carousel cover, music), so opening the list needs nothing else. The per-slug files the generator also
// writes are for other consumers; the site never reads them. With entries in the dozens and a few hundred
// bytes each, lazy per-entry loading would only buy a cache, a loading state on the game screen and a
// second class of network error.

/** What the catalogue is currently able to show. `ready` still covers "the catalogue is empty". */
export type ListState = 'loading' | 'ready' | 'error';

/**
 * Where an entry came from: published in this repository's collection, or made in the browser through
 * the Library screen's "Add game". NOT a feed field — the parser stamps every entry it reads as
 * `collection`, and library-grid.ts splits the two into the screen's sections. An added entry lives in
 * memory only: reloading the page re-fetches the feed and it is gone (see the note in library-screen.ts).
 */
export type EntryOrigin = 'collection' | 'added';

/** The platforms a manifest may claim (the launcher's own enum, `manifest.ts`). */
export type Platform = 'windows' | 'mac' | 'linux';

/** A manifest's localized description, mirrored as-is: the feed carries both languages the launcher does. */
export interface EntryDescription {
  readonly en?: string;
  readonly ru?: string;
}

/** One catalogue entry, with every URL already resolved against the feed directory. */
export interface CollectionEntry {
  readonly slug: string;
  readonly title: string;
  readonly origin: EntryOrigin;
  readonly steamAppId?: number;
  /** The date a human last verified the manifest (meta.json's verifiedAt) — not an mtime. */
  readonly updatedAt: string;
  /** Where the entry lives in this repository, e.g. `collection/bloodborne` (the Github button's target). */
  readonly sourcePath: string;
  readonly manifestUrl: string;
  readonly heroUrls: readonly string[];
  /** The carousel cover (2:3 portrait). Optional: a card without one falls back to its first hero. */
  readonly gridUrl?: string;
  readonly music: string | null;
  /**
   * The manifest's own optional metadata (0.8.0: `genres`, `releaseDate`, `platforms`, `description`),
   * published when the game.json has it. Nothing on the site reads these yet — they are carried so the
   * feed is a faithful mirror of the manifest, not so the UI can show them.
   */
  readonly genres?: readonly string[];
  readonly releaseDate?: string;
  readonly platforms?: readonly Platform[];
  readonly description?: EntryDescription;
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

/** The non-empty strings of a list; null when there is no list or nothing usable in it. */
const asStringList = (value: unknown): readonly string[] | null => {
  if (!Array.isArray(value)) return null;
  const items: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text !== null) items.push(text);
  }
  return items.length > 0 ? items : null;
};

const PLATFORMS: readonly Platform[] = ['windows', 'mac', 'linux'];

const isPlatform = (value: string): value is Platform =>
  (PLATFORMS as readonly string[]).includes(value);

/** Narrows a list to the three platform literals; null when none survives. */
const asPlatforms = (value: unknown): readonly Platform[] | null => {
  const platforms = asStringList(value)?.filter(isPlatform) ?? [];
  return platforms.length > 0 ? platforms : null;
};

/** Only the string keys the launcher writes (`en` / `ru`); null when neither is there. */
const asDescription = (value: unknown): EntryDescription | null => {
  if (!isRecord(value)) return null;
  const en = asString(value['en']);
  const ru = asString(value['ru']);
  if (en === null && ru === null) return null;
  return {
    ...(en !== null ? { en } : {}),
    ...(ru !== null ? { ru } : {}),
  };
};

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

  const gridUrl = asString(raw['gridUrl']);
  const music = asString(raw['music']);
  const steamAppId = raw['steamAppId'];
  const genres = asStringList(raw['genres']);
  const releaseDate = asString(raw['releaseDate']);
  const platforms = asPlatforms(raw['platforms']);
  const description = asDescription(raw['description']);

  return {
    slug,
    title,
    origin: 'collection',
    ...(typeof steamAppId === 'number' ? { steamAppId } : {}),
    updatedAt: asString(raw['updatedAt']) ?? '',
    sourcePath: asString(raw['sourcePath']) ?? `collection/${slug}`,
    manifestUrl: assetUrl(asString(raw['manifestUrl']) ?? `${slug}/game.json`),
    heroUrls,
    ...(gridUrl !== null ? { gridUrl: assetUrl(gridUrl) } : {}),
    music: music !== null ? assetUrl(music) : null,
    ...(genres !== null ? { genres } : {}),
    ...(releaseDate !== null ? { releaseDate } : {}),
    ...(platforms !== null ? { platforms } : {}),
    ...(description !== null ? { description } : {}),
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
