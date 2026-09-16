// Collection feed generator: walks `collection/` (the SOURCE) and emits `dist/api/v1/` (what GitHub
// Pages actually serves). See collection/README.md — that directory never reaches Pages on its own.
//
// Output:
//   dist/api/v1/index.json          the whole catalogue, one entry per game, sorted by title
//   dist/api/v1/<slug>.json         one entry, the same shape as its index row
//   dist/api/v1/<slug>/game.json    the manifest itself
//   dist/api/v1/<slug>/assets/**    everything the entry ships (hero images, the cover, music)
//
// The site reads ONLY index.json — it carries the full preview payload per entry, so opening the list
// is one request. The per-slug files are the feed's per-entry contract for whoever consumes it next
// (Playhook 0.8.0 does not: it takes metadata straight from the stores), and are generated here so the
// two shapes never drift apart.
//
// An entry also carries the manifest's own optional metadata — `genres`, `releaseDate`, `platforms`,
// `description` (both languages, the feed mirrors the manifest) — when the game.json has it. The site
// shows none of it yet; publishing it now is what keeps this generator from being touched twice.
//
// Failure policy is deliberately split: a malformed ENTRY (bad slug, invalid manifest) FAILS the build,
// because an entry that silently drops out of the feed is diagnosed painfully; a missing PREVIEW asset
// only warns and drops that one field, because a degraded preview is not worth a red build.
// @ts-check
import { cp, mkdir, readdir, readFile, stat, writeFile, access } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

/**
 * One game as the manifest schema admits it, with the fields the gates read left `unknown` — Ajv has
 * validated the whole manifest against schema/game.schema.json before any of this runs, and the gates
 * below still narrow every field they touch, because the schema is not strict.
 * @typedef {Record<string, unknown>} Game
 * @typedef {Game | Game[]} Manifest
 *
 * meta.json after schema/meta.schema.json has passed it (collection/README.md is the contract).
 * @typedef {object} Meta
 * @property {string} title
 * @property {string} author
 * @property {string} verifiedAt
 * @property {string[]} tested
 * @property {number} [steamAppId]
 * @property {string} [notes]
 * @property {DeclaredPreview} [preview]
 *
 * @typedef {{ hero?: string[]; grid?: string; music?: string }} DeclaredPreview
 * @typedef {{ hero: string[]; grid: string | null; music: string | null }} Preview
 *
 * One row of index.json — the per-entry contract (collection/README.md, "Index entry shape").
 * @typedef {object} FeedEntry
 * @property {string} slug
 * @property {string} title
 * @property {string} updatedAt
 * @property {string} sourcePath
 * @property {string} manifestUrl
 * @property {string[]} heroUrls
 * @property {string} [gridUrl]
 * @property {number} [steamAppId]
 * @property {string} [music]
 * @property {unknown[]} [genres]
 * @property {string} [releaseDate]
 * @property {unknown[]} [platforms]
 * @property {object} [description]
 */

const SLUG_RE = /^[a-z0-9-]+$/;

/**
 * Playhook's own cap on hero backgrounds (MAX_HERO_IMAGES in the launcher's shared/types.ts — unchanged
 * in 0.8.0). The zod schema carries no `.max`, so it never reaches schema/game.schema.json — see
 * schema/SOURCE.md.
 */
const MAX_HERO_IMAGES = 3;

/** @param {string} path */
const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {string} path
 * @returns {Promise<unknown>}
 */
const readJson = async (path) => {
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  return parsed;
};

/**
 * Compiles both schemas with one Ajv. The launcher's manifest schema is a `oneOf` of [single manifest,
 * array of manifests]; the nested `$schema` on the first branch is what pins it to draft 2020-12, so
 * Ajv2020 is the right dialect. `strict: false` because that nested keyword is not where a 2020-12
 * resource root belongs and strict mode rejects it — the schema is generated (see schema/SOURCE.md), so
 * it is not ours to reshape. meta.schema.json is hand-written (collection/README.md is its contract) and
 * needs no such allowance, but one instance with one setting is simpler than two.
 * @param {string} root
 */
async function compileValidators(root) {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  /** @param {string} name */
  const schema = async (name) =>
    /** @type {import('ajv').AnySchema} */ (await readJson(join(root, 'schema', name)));
  return {
    manifest: /** @type {import('ajv').ValidateFunction<Manifest>} */ (
      ajv.compile(await schema('game.schema.json'))
    ),
    meta: /** @type {import('ajv').ValidateFunction<Meta>} */ (
      ajv.compile(await schema('meta.schema.json'))
    ),
  };
}

/**
 * Ajv's errors as one line: `/path message; /path message`.
 * @param {import('ajv').ValidateFunction<unknown>} validate
 */
const describeErrors = (validate) =>
  (validate.errors ?? [])
    .map((e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message}`)
    .join('; ');

/**
 * A manifest is `oneOf` [one game, an array of games] — the schema says so, and every gate below has to
 * run per GAME or a multi-game card would sail past all of them. Normalising once, here, is what keeps
 * the rest of this file from re-deciding the question in five places.
 * @param {Manifest} manifest
 * @returns {Game[]}
 */
const gamesOf = (manifest) => (Array.isArray(manifest) ? manifest : [manifest]);

/**
 * `heroImage` is a string OR an array. A naive `.length` on the string form counts CHARACTERS.
 * @param {Game} game
 * @returns {string[]}
 */
const heroesOf = (game) =>
  Array.isArray(game.heroImage)
    ? game.heroImage.filter((p) => typeof p === 'string')
    : typeof game.heroImage === 'string'
      ? [game.heroImage]
      : [];

/**
 * Derives a preview block from the manifest when meta.json has none. A fallback for typical entries,
 * NOT a contract: manifest paths are card-relative, so this only guesses that the basename lives in
 * `assets/`. See collection/README.md. Takes ONE game — a multi-game card previews as its first.
 * @param {Game} game
 * @returns {DeclaredPreview}
 */
function previewFromManifest(game) {
  const heroes = heroesOf(game);
  /** @type {DeclaredPreview} */
  const preview = {};
  if (heroes.length > 0) preview.hero = heroes.map((p) => `assets/${basename(p)}`);
  if (typeof game.gridImage === 'string') preview.grid = `assets/${basename(game.gridImage)}`;
  if (typeof game.backgroundMusic === 'string') {
    preview.music = `assets/${basename(game.backgroundMusic)}`;
  }
  return preview;
}

/**
 * Keeps only the preview paths whose files actually exist; warns (never fails) about the rest.
 * @param {DeclaredPreview} preview
 * @param {string} entryDir
 * @param {string} slug
 * @returns {Promise<Preview>}
 */
async function verifyPreview(preview, entryDir, slug) {
  /** @param {string | undefined} path */
  const keep = async (path) => {
    if (typeof path !== 'string' || path.length === 0) return false;
    if (await exists(join(entryDir, path))) return true;
    console.warn(`  ! ${slug}: preview asset missing, dropped — ${path}`);
    return false;
  };

  /** @type {string[]} */
  const hero = [];
  for (const path of Array.isArray(preview.hero) ? preview.hero : []) {
    if (await keep(path)) hero.push(path);
  }

  const grid = typeof preview.grid === 'string' && (await keep(preview.grid)) ? preview.grid : null;
  const music =
    typeof preview.music === 'string' && (await keep(preview.music)) ? preview.music : null;

  return { hero, grid, music };
}

/**
 * How big a preview asset may be before the build says something. "Keep them web-sized" in
 * collection/README.md is the rule; these are its numbers, in KB, overridable per run through the
 * environment (a one-off entry that needs more can be built with a higher limit rather than a lower
 * standard). Over the limit is a warning; over three times the limit the build fails — that is no longer
 * a heavy asset, it is the wrong file.
 *
 * The cover's limit is not caution but a requirement: a webp cover is served to the launcher AS IS
 * (nativeImage cannot decode webp, so the launcher builds no thumbnail and re-encodes nothing), and a
 * webp over its 4 MiB cap is skipped outright, leaving the carousel card blank. Keeping the file small
 * is OUR job.
 */
const SIZE_LIMITS = {
  hero: { env: 'PHC_MAX_HERO_KB', defaultKb: 1500 },
  music: { env: 'PHC_MAX_MUSIC_KB', defaultKb: 3000 },
  grid: { env: 'PHC_MAX_GRID_KB', defaultKb: 150 },
};
const SIZE_FAIL_FACTOR = 3;

/**
 * The limit for one kind of asset, in KB: the environment's number when it is a positive integer, the
 * default otherwise (an unset variable and a garbled one both mean "the usual").
 * @param {keyof typeof SIZE_LIMITS} kind
 * @param {NodeJS.ProcessEnv} env
 */
export function sizeLimitKb(kind, env = process.env) {
  const { env: name, defaultKb } = SIZE_LIMITS[kind];
  const raw = env[name];
  if (raw === undefined) return defaultKb;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultKb;
}

/**
 * Warns above the limit and fails above three times it, for every asset the preview names — those are
 * the files everybody who opens the entry downloads.
 * @param {Preview} preview
 * @param {string} entryDir
 * @param {string} slug
 * @param {NodeJS.ProcessEnv} env
 */
async function gatePreviewSizes(preview, entryDir, slug, env = process.env) {
  /**
   * @param {keyof typeof SIZE_LIMITS} kind
   * @param {string} path
   */
  const check = async (kind, path) => {
    const limitKb = sizeLimitKb(kind, env);
    const { size } = await stat(join(entryDir, path));
    const sizeKb = Math.round(size / 1024);
    if (sizeKb <= limitKb) return;
    const label = `${slug}: ${kind} ${path} is ${sizeKb} KB`;
    if (sizeKb > limitKb * SIZE_FAIL_FACTOR) {
      throw new Error(
        `collection/${label} — over ${SIZE_FAIL_FACTOR}× the ${limitKb} KB limit (${SIZE_LIMITS[kind].env}); that is not a heavy asset, it is the wrong file. See collection/README.md`,
      );
    }
    console.warn(
      `  ! ${label} — keep it under ${limitKb} KB (${SIZE_LIMITS[kind].env}, see collection/README.md)`,
    );
  };
  for (const path of preview.hero) await check('hero', path);
  if (preview.grid !== null) await check('grid', preview.grid);
  if (preview.music !== null) await check('music', preview.music);
}

/**
 * The files the MANIFEST names — `heroImage`, `gridImage`, `backgroundMusic`, card-relative — should be
 * in the entry too, since the whole entry is what somebody drops on their card. A warning, not a
 * failure: the preview and the manifest "are allowed to differ" (collection/README.md), and the site
 * itself never opens these paths.
 * @param {Manifest} manifest
 * @param {string} entryDir
 * @param {string} slug
 */
async function warnMissingManifestAssets(manifest, entryDir, slug) {
  for (const game of gamesOf(manifest)) {
    /** @type {[string, string][]} */
    const named = heroesOf(game).map((path) => ['heroImage', path]);
    if (typeof game.gridImage === 'string') named.push(['gridImage', game.gridImage]);
    if (typeof game.backgroundMusic === 'string') {
      named.push(['backgroundMusic', game.backgroundMusic]);
    }
    for (const [field, path] of named) {
      if (await exists(join(entryDir, path))) continue;
      console.warn(
        `  ! ${slug}: game.json names ${field} "${path}", which is not in the entry — a card made from it would miss the file`,
      );
    }
  }
}

/**
 * The rules Playhook enforces at runtime but `schema/game.schema.json` cannot express. They fail the
 * build rather than warn: a manifest published here is a template other people copy, so an entry the
 * launcher would quietly degrade is worse than a red build. See schema/SOURCE.md.
 * @param {Manifest} manifest
 * @param {string} slug
 */
function gateManifest(manifest, slug) {
  for (const game of gamesOf(manifest)) {
    const where = `collection/${slug}/game.json${typeof game.id === 'string' ? ` (id=${game.id})` : ''}`;

    const heroes = heroesOf(game);
    if (heroes.length > MAX_HERO_IMAGES) {
      throw new Error(
        `${where}: ${heroes.length} heroImage entries — Playhook uses the first ${MAX_HERO_IMAGES} and drops the rest`,
      );
    }

    if (game.sounds !== undefined) {
      throw new Error(
        `${where}: "sounds" was removed from the card format in 0.7.0 — UI sounds now come from the set chosen in Settings. Drop the block (backgroundMusic stays)`,
      );
    }

    if (game.pc !== undefined) {
      throw new Error(
        `${where}: "pc" describes a game installed on the PC itself and is refused on a card (Playhook 0.8.0, manifest.pcOnCard). Every entry here is a card — drop the block`,
      );
    }
  }
}

/**
 * The manifest's own optional metadata, published as it is. Only fields that are present AND non-empty
 * travel: an empty list or an empty object says nothing, and an absent key is easier to consume than an
 * empty one. Takes ONE game — a multi-game card is described by its first, like its preview.
 * @param {Game} game
 * @returns {Pick<FeedEntry, 'genres' | 'releaseDate' | 'platforms' | 'description'>}
 */
function metadataOf(game) {
  /** @type {Pick<FeedEntry, 'genres' | 'releaseDate' | 'platforms' | 'description'>} */
  const metadata = {};
  if (Array.isArray(game.genres) && game.genres.length > 0) metadata.genres = game.genres;
  if (typeof game.releaseDate === 'string' && game.releaseDate.length > 0) {
    metadata.releaseDate = game.releaseDate;
  }
  if (Array.isArray(game.platforms) && game.platforms.length > 0) {
    metadata.platforms = game.platforms;
  }
  if (
    typeof game.description === 'object' &&
    game.description !== null &&
    Object.keys(game.description).length > 0
  ) {
    metadata.description = game.description;
  }
  return metadata;
}

/**
 * Builds the feed. Returns the index object (also written to disk) so a caller can inspect it.
 * @param {string} root repository root
 * @param {string} dist output directory (the deployed one)
 */
export async function buildCollectionFeed(root, dist) {
  const source = join(root, 'collection');
  const outDir = join(dist, 'api', 'v1');
  await mkdir(outDir, { recursive: true });

  const validate = await compileValidators(root);

  const dirents = (await exists(source)) ? await readdir(source, { withFileTypes: true }) : [];
  /** @type {FeedEntry[]} */
  const entries = [];

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const slug = dirent.name;
    if (slug.startsWith('.')) continue;
    const entryDir = join(source, slug);
    const manifestPath = join(entryDir, 'game.json');
    // No manifest → not an entry (README assets, scratch directories). Silent by design.
    if (!(await exists(manifestPath))) continue;

    // A bad slug is fatal: it would become a URL segment, and an entry that quietly vanishes from the
    // feed is far harder to notice than a failed build.
    if (!SLUG_RE.test(slug)) {
      throw new Error(
        `collection/${slug}: slug must match ${SLUG_RE} (it becomes a feed URL segment)`,
      );
    }

    const manifest = await readJson(manifestPath);
    if (!validate.manifest(manifest)) {
      throw new Error(
        `collection/${slug}/game.json fails schema/game.schema.json: ${describeErrors(validate.manifest)}`,
      );
    }
    gateManifest(manifest, slug);

    const metaPath = join(entryDir, 'meta.json');
    if (!(await exists(metaPath))) {
      throw new Error(`collection/${slug}: meta.json is missing (title/verifiedAt live there)`);
    }
    // The whole of meta.json is held to schema/meta.schema.json, and a red build on a typo is the point:
    // most of what it says (`author`, `tested`, a misspelled key) is for the people reading this
    // repository, never published, so nothing downstream would ever notice a stray "macos" or a
    // `verifiedAt` that is not a date — it would sit there being quietly wrong for as long as nobody
    // opened the file.
    const meta = await readJson(metaPath);
    if (!validate.meta(meta)) {
      throw new Error(
        `collection/${slug}/meta.json fails schema/meta.schema.json: ${describeErrors(validate.meta)}`,
      );
    }

    const firstGame = gamesOf(manifest)[0] ?? {};
    const declaredPreview =
      typeof meta.preview === 'object' && meta.preview !== null
        ? meta.preview
        : previewFromManifest(firstGame);

    // Warn, don't fail: the preview and the manifest "are allowed to differ" (collection/README.md), and
    // a degraded preview is not worth a red build. Checked on what meta.json DECLARES — verifyPreview
    // drops missing files below and would hide a fourth entry that simply isn't there.
    const heroCount = Array.isArray(declaredPreview.hero) ? declaredPreview.hero.length : 0;
    if (heroCount > MAX_HERO_IMAGES) {
      console.warn(
        `  ! ${slug}: preview declares ${heroCount} hero images — showing the first ${MAX_HERO_IMAGES}, like the launcher`,
      );
    }
    const shownPreview =
      Array.isArray(declaredPreview.hero) && heroCount > MAX_HERO_IMAGES
        ? { ...declaredPreview, hero: declaredPreview.hero.slice(0, MAX_HERO_IMAGES) }
        : declaredPreview;

    const preview = await verifyPreview(shownPreview, entryDir, slug);
    await gatePreviewSizes(preview, entryDir, slug);
    await warnMissingManifestAssets(manifest, entryDir, slug);

    // The WHOLE assets directory travels, not just what the preview names: this is also the directory a
    // human drops on their card, and the manifest references files the site never opens (save folders).
    // Dot-files (.DS_Store and friends) stay behind.
    if (await exists(join(entryDir, 'assets'))) {
      await cp(join(entryDir, 'assets'), join(outDir, slug, 'assets'), {
        recursive: true,
        filter: (src) => !basename(src).startsWith('.'),
      });
    }
    await cp(manifestPath, join(outDir, slug, 'game.json'));

    // Feed URLs are relative TO THE FEED DIRECTORY (posix separators — these are URLs, not paths). The
    // client resolves them against the feed base; see FEED_BASE in src/collection.ts.
    /** @type {FeedEntry} */
    const entry = {
      slug,
      title: meta.title,
      updatedAt: meta.verifiedAt,
      // Where the entry lives in THIS repository — the Github button links straight at it, so the path
      // is published rather than reassembled in the UI (a reshuffled collection/ would break that).
      sourcePath: posix.join('collection', slug),
      manifestUrl: posix.join(slug, 'game.json'),
      heroUrls: preview.hero.map((p) => posix.join(slug, p)),
    };
    if (preview.grid !== null) entry.gridUrl = posix.join(slug, preview.grid);
    if (typeof meta.steamAppId === 'number') entry.steamAppId = meta.steamAppId;
    if (preview.music !== null) entry.music = posix.join(slug, preview.music);
    Object.assign(entry, metadataOf(firstGame));

    entries.push(entry);
  }

  // Explicit, locale-independent sort: without it the order is whatever readdir returns, i.e. the
  // filesystem's. The mockup's order is a sketch, not a spec.
  entries.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase(), 'en'));

  // No `generatedAt`: it would make every build byte-different and hide whether the feed actually changed.
  const index = { schemaVersion: 1, entries };
  await writeFile(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  for (const entry of entries) {
    await writeFile(join(outDir, `${entry.slug}.json`), `${JSON.stringify(entry, null, 2)}\n`);
  }

  return index;
}
