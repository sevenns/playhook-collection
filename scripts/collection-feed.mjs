// Collection feed generator: walks `collection/` (the SOURCE) and emits `dist/api/v1/` (what GitHub
// Pages actually serves). See collection/README.md — that directory never reaches Pages on its own.
//
// Output:
//   dist/api/v1/index.json          the whole catalogue, one entry per game, sorted by title
//   dist/api/v1/<slug>.json         one entry (the contract the launcher's Configure window targets)
//   dist/api/v1/<slug>/game.json    the manifest itself
//   dist/api/v1/<slug>/assets/**    everything the entry ships (hero images, sounds, music)
//
// The site reads ONLY index.json — it carries the full preview payload per entry, so opening the list
// is one request. The per-slug files exist for the launcher, and are generated here so the two never
// drift apart.
//
// Failure policy is deliberately split: a malformed ENTRY (bad slug, invalid manifest) FAILS the build,
// because an entry that silently drops out of the feed is diagnosed painfully; a missing PREVIEW asset
// only warns and drops that one field, because a degraded preview is not worth a red build.
import { cp, mkdir, readdir, readFile, writeFile, access } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const SLUG_RE = /^[a-z0-9-]+$/;

/** The UI sound slots the site knows about. Anything else in a preview block is ignored. */
const SFX_SLOTS = ['navigate', 'button', 'back', 'play'];

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

/**
 * Compiles the launcher's own manifest schema. It is a `oneOf` of [single manifest, array of manifests];
 * the nested `$schema` on the first branch is what pins it to draft 2020-12, so Ajv2020 is the right
 * dialect. `strict: false` because that nested keyword is not where a 2020-12 resource root belongs and
 * strict mode rejects it — the schema is generated (see schema/SOURCE.md), so it is not ours to reshape.
 */
async function compileManifestValidator(root) {
  const schema = await readJson(join(root, 'schema', 'game.schema.json'));
  const ajv = new Ajv2020.default({ strict: false, allErrors: true });
  return ajv.compile(schema);
}

/**
 * Derives a preview block from the manifest when meta.json has none. A fallback for typical entries,
 * NOT a contract: manifest paths are card-relative, so this only guesses that the basename lives in
 * `assets/`. See collection/README.md.
 */
function previewFromManifest(manifest) {
  const heroes = Array.isArray(manifest.heroImage)
    ? manifest.heroImage
    : typeof manifest.heroImage === 'string'
      ? [manifest.heroImage]
      : [];
  const preview = {};
  if (heroes.length > 0) preview.hero = heroes.map((p) => `assets/${basename(p)}`);
  if (typeof manifest.sounds === 'object' && manifest.sounds !== null) {
    const sounds = {};
    for (const slot of SFX_SLOTS) {
      const value = manifest.sounds[slot];
      if (typeof value === 'string') sounds[slot] = `assets/${basename(value)}`;
    }
    if (Object.keys(sounds).length > 0) preview.sounds = sounds;
  }
  if (typeof manifest.backgroundMusic === 'string') {
    preview.music = `assets/${basename(manifest.backgroundMusic)}`;
  }
  return preview;
}

/** Keeps only the preview paths whose files actually exist; warns (never fails) about the rest. */
async function verifyPreview(preview, entryDir, slug) {
  const keep = async (path) => {
    if (typeof path !== 'string' || path.length === 0) return false;
    if (await exists(join(entryDir, path))) return true;
    console.warn(`  ! ${slug}: preview asset missing, dropped — ${path}`);
    return false;
  };

  const hero = [];
  for (const path of Array.isArray(preview.hero) ? preview.hero : []) {
    if (await keep(path)) hero.push(path);
  }

  const sounds = {};
  const declared =
    typeof preview.sounds === 'object' && preview.sounds !== null ? preview.sounds : {};
  for (const slot of SFX_SLOTS) {
    if (await keep(declared[slot])) sounds[slot] = declared[slot];
  }

  const music = (await keep(preview.music)) ? preview.music : null;

  return { hero, sounds, music };
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

  const validateManifest = await compileManifestValidator(root);

  const dirents = (await exists(source)) ? await readdir(source, { withFileTypes: true }) : [];
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
    if (!validateManifest(manifest)) {
      const detail = (validateManifest.errors ?? [])
        .map((e) => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message}`)
        .join('; ');
      throw new Error(`collection/${slug}/game.json fails schema/game.schema.json: ${detail}`);
    }

    const metaPath = join(entryDir, 'meta.json');
    if (!(await exists(metaPath))) {
      throw new Error(`collection/${slug}: meta.json is missing (title/verifiedAt live there)`);
    }
    const meta = await readJson(metaPath);
    if (typeof meta.title !== 'string' || meta.title.length === 0) {
      throw new Error(`collection/${slug}/meta.json: "title" is required`);
    }
    if (typeof meta.verifiedAt !== 'string' || meta.verifiedAt.length === 0) {
      throw new Error(`collection/${slug}/meta.json: "verifiedAt" is required`);
    }

    const declaredPreview =
      typeof meta.preview === 'object' && meta.preview !== null
        ? meta.preview
        : previewFromManifest(manifest);
    const preview = await verifyPreview(declaredPreview, entryDir, slug);

    // The WHOLE assets directory travels, not just what the preview names: this is also the directory a
    // human drops on their card, and the manifest references files the site never plays (the `play`
    // slot's source, save folders). Dot-files (.DS_Store and friends) stay behind.
    if (await exists(join(entryDir, 'assets'))) {
      await cp(join(entryDir, 'assets'), join(outDir, slug, 'assets'), {
        recursive: true,
        filter: (src) => !basename(src).startsWith('.'),
      });
    }
    await cp(manifestPath, join(outDir, slug, 'game.json'));

    // Feed URLs are relative TO THE FEED DIRECTORY (posix separators — these are URLs, not paths). The
    // client resolves them against the feed base; see FEED_BASE in src/collection.ts.
    const entry = {
      slug,
      title: meta.title,
      updatedAt: meta.verifiedAt,
      // Where the entry lives in THIS repository — the Github button links straight at it, so the path
      // is published rather than reassembled in the UI (a reshuffled collection/ would break that).
      sourcePath: posix.join('collection', slug),
      manifestUrl: posix.join(slug, 'game.json'),
      heroUrls: preview.hero.map((p) => posix.join(slug, p)),
      sounds: Object.fromEntries(
        Object.entries(preview.sounds).map(([slot, p]) => [slot, posix.join(slug, p)]),
      ),
    };
    if (typeof meta.steamAppId === 'number') entry.steamAppId = meta.steamAppId;
    if (preview.music !== null) entry.music = posix.join(slug, preview.music);

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
