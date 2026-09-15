// The feed generator, run on a copy of test/fixtures/collection: one valid entry, mutated per case. It
// is the only code in this repository whose failure breaks a deploy, and its fail-gates are the contract
// collection/README.md promises — a bad slug, a manifest the schema refuses, a fourth hero, a `sounds`
// block, a `pc` block, a meta.json the schema refuses, an asset three times over its limit — so each one
// is exercised here rather than trusted.
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCollectionFeed, sizeLimitKb } from '../scripts/collection-feed.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(repoRoot, 'test', 'fixtures', 'collection');

/** A fresh repository-shaped root: the real schemas, the fixture collection, an empty dist. */
async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'phc-feed-'));
  await cp(join(repoRoot, 'schema'), join(root, 'schema'), { recursive: true });
  await cp(fixtures, join(root, 'collection'), { recursive: true });
  return root;
}

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, 'utf8')) as unknown;

const writeJson = (path: string, value: unknown): Promise<void> =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

interface Fixture {
  readonly root: string;
  readonly entryDir: string;
  readonly build: () => Promise<unknown>;
  readonly mutateManifest: (change: Record<string, unknown>) => Promise<void>;
  readonly mutateMeta: (change: Record<string, unknown>) => Promise<void>;
}

let fixture: Fixture;
let warnings: string[];

beforeEach(async () => {
  const root = await makeRoot();
  const entryDir = join(root, 'collection', 'valid-entry');
  const mutate =
    (file: string) =>
    async (change: Record<string, unknown>): Promise<void> => {
      const current = (await readJson(join(entryDir, file))) as Record<string, unknown>;
      await writeJson(join(entryDir, file), { ...current, ...change });
    };
  fixture = {
    root,
    entryDir,
    build: () => buildCollectionFeed(root, join(root, 'dist')),
    mutateManifest: mutate('game.json'),
    mutateMeta: mutate('meta.json'),
  };
  warnings = [];
  vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(fixture.root, { recursive: true, force: true });
});

describe('buildCollectionFeed', () => {
  it('publishes the fixture entry in the documented shape, and writes the per-slug files', async () => {
    const index = (await fixture.build()) as { schemaVersion: number; entries: unknown[] };
    expect(index.schemaVersion).toBe(1);
    expect(index.entries).toEqual([
      {
        slug: 'valid-entry',
        title: 'Valid Entry',
        updatedAt: '2026-01-01',
        sourcePath: 'collection/valid-entry',
        manifestUrl: 'valid-entry/game.json',
        heroUrls: ['valid-entry/assets/hero.webp'],
        gridUrl: 'valid-entry/assets/grid.webp',
        steamAppId: 1,
        music: 'valid-entry/assets/theme.ogg',
        genres: ['Test'],
        releaseDate: '2026-01-01',
        platforms: ['windows'],
        description: { en: 'A fixture.' },
      },
    ]);
    const out = join(fixture.root, 'dist', 'api', 'v1');
    expect(await readJson(join(out, 'index.json'))).toEqual(index);
    expect(await readJson(join(out, 'valid-entry.json'))).toEqual(index.entries[0]);
    expect(await readJson(join(out, 'valid-entry', 'game.json'))).toEqual(
      await readJson(join(fixture.entryDir, 'game.json')),
    );
    await expect(readFile(join(out, 'valid-entry', 'assets', 'grid.webp'))).resolves.toBeDefined();
    expect(warnings).toEqual([]);
  });

  it('sorts entries by title, case-insensitively, whatever the directory order', async () => {
    const more: readonly (readonly [slug: string, title: string])[] = [
      ['zeta', 'zeta'],
      ['alpha', 'Beta'],
      ['mid', 'alpha'],
    ];
    for (const [slug, title] of more) {
      await cp(fixture.entryDir, join(fixture.root, 'collection', slug), { recursive: true });
      await writeJson(join(fixture.root, 'collection', slug, 'meta.json'), {
        ...((await readJson(join(fixture.entryDir, 'meta.json'))) as object),
        title,
      });
    }
    const index = (await fixture.build()) as { entries: { title: string }[] };
    expect(index.entries.map((entry) => entry.title)).toEqual([
      'alpha',
      'Beta',
      'Valid Entry',
      'zeta',
    ]);
  });

  it('fails on a slug that could not be a URL segment', async () => {
    await rename(fixture.entryDir, join(fixture.root, 'collection', 'Bad_Slug'));
    await expect(fixture.build()).rejects.toThrow(/slug must match/);
  });

  it('fails on a manifest the launcher schema refuses', async () => {
    await fixture.mutateManifest({ schemaVersion: 'one' });
    await expect(fixture.build()).rejects.toThrow(/fails schema\/game\.schema\.json/);
  });

  it('fails on a fourth heroImage — the launcher would drop it silently', async () => {
    await fixture.mutateManifest({ heroImage: ['a.webp', 'b.webp', 'c.webp', 'd.webp'] });
    await expect(fixture.build()).rejects.toThrow(/4 heroImage entries/);
  });

  it('fails on a leftover `sounds` block', async () => {
    await fixture.mutateManifest({ sounds: { move: 'x.wav' } });
    await expect(fixture.build()).rejects.toThrow(/"sounds" was removed/);
  });

  it('fails on a `pc` block — a card must never name an absolute path', async () => {
    await fixture.mutateManifest({ pc: { executable: 'C:\\\\Games\\\\x.exe' } });
    await expect(fixture.build()).rejects.toThrow(/"pc" describes a game installed on the PC/);
  });

  it('runs the gates per game of a multi-game manifest', async () => {
    const game = (await readJson(join(fixture.entryDir, 'game.json'))) as Record<string, unknown>;
    await writeJson(join(fixture.entryDir, 'game.json'), [
      game,
      { ...game, id: 'second', sounds: {} },
    ]);
    await expect(fixture.build()).rejects.toThrow(/\(id=second\): "sounds"/);
  });

  it('fails when meta.json is missing', async () => {
    await rm(join(fixture.entryDir, 'meta.json'));
    await expect(fixture.build()).rejects.toThrow(/meta\.json is missing/);
  });

  it('fails on a meta.json the schema refuses: no author, a date that is not one, a bad platform', async () => {
    await fixture.mutateMeta({ author: undefined, verifiedAt: 'yesterday', tested: ['macos'] });
    await expect(fixture.build()).rejects.toThrow(
      /fails schema\/meta\.schema\.json:.*author.*verifiedAt.*tested/,
    );
  });

  it('fails on a key meta.json does not know — a typo would otherwise sit there unnoticed', async () => {
    await fixture.mutateMeta({ verfiedAt: '2026-01-01' });
    await expect(fixture.build()).rejects.toThrow(/must NOT have additional properties/);
  });

  it('drops a preview asset that does not exist, with a warning rather than a failure', async () => {
    await fixture.mutateMeta({
      preview: { hero: ['assets/hero.webp', 'assets/gone.webp'], grid: 'assets/no-grid.webp' },
    });
    const index = (await fixture.build()) as { entries: Record<string, unknown>[] };
    expect(index.entries[0]?.['heroUrls']).toEqual(['valid-entry/assets/hero.webp']);
    expect(index.entries[0]).not.toHaveProperty('gridUrl');
    expect(index.entries[0]).not.toHaveProperty('music');
    expect(warnings).toEqual([
      expect.stringContaining('preview asset missing, dropped — assets/gone.webp'),
      expect.stringContaining('preview asset missing, dropped — assets/no-grid.webp'),
    ]);
  });

  it('guesses the preview from the manifest when meta.json declares none', async () => {
    await fixture.mutateMeta({ preview: undefined });
    const index = (await fixture.build()) as { entries: Record<string, unknown>[] };
    expect(index.entries[0]?.['heroUrls']).toEqual(['valid-entry/assets/hero.webp']);
    expect(index.entries[0]?.['gridUrl']).toBe('valid-entry/assets/grid.webp');
    expect(index.entries[0]?.['music']).toBe('valid-entry/assets/theme.ogg');
  });

  it('trims a declared preview to three heroes with a warning, like the launcher', async () => {
    await fixture.mutateMeta({
      preview: {
        hero: ['assets/hero.webp', 'assets/hero.webp', 'assets/hero.webp', 'assets/hero.webp'],
      },
    });
    const index = (await fixture.build()) as { entries: { heroUrls: string[] }[] };
    expect(index.entries[0]?.heroUrls).toHaveLength(3);
    expect(warnings).toEqual([expect.stringContaining('preview declares 4 hero images')]);
  });

  it('warns about a file the manifest names that is not in the entry — a card would miss it', async () => {
    await fixture.mutateManifest({ gridImage: 'assets/elsewhere.webp' });
    await fixture.build();
    expect(warnings).toEqual([
      expect.stringContaining(
        'game.json names gridImage "assets/elsewhere.webp", which is not in the entry',
      ),
    ]);
  });

  describe('size gates', () => {
    const env = { ...process.env };
    afterEach(() => {
      process.env = { ...env };
    });

    it('warns above the limit and fails above three times it', async () => {
      await writeFile(join(fixture.entryDir, 'assets', 'grid.webp'), Buffer.alloc(2 * 1024 + 1));
      process.env['PHC_MAX_GRID_KB'] = '1';
      await fixture.build();
      expect(warnings).toEqual([
        expect.stringContaining(
          'grid assets/grid.webp is 2 KB — keep it under 1 KB (PHC_MAX_GRID_KB',
        ),
      ]);

      await writeFile(join(fixture.entryDir, 'assets', 'grid.webp'), Buffer.alloc(4 * 1024));
      await expect(fixture.build()).rejects.toThrow(
        /grid assets\/grid\.webp is 4 KB — over 3× the 1 KB limit/,
      );
    });

    it('reads its limits from the environment, falling back to the defaults on garbage', () => {
      expect(sizeLimitKb('hero', {})).toBe(1500);
      expect(sizeLimitKb('music', {})).toBe(3000);
      expect(sizeLimitKb('grid', {})).toBe(150);
      expect(sizeLimitKb('grid', { PHC_MAX_GRID_KB: '600' })).toBe(600);
      expect(sizeLimitKb('grid', { PHC_MAX_GRID_KB: 'lots' })).toBe(150);
      expect(sizeLimitKb('grid', { PHC_MAX_GRID_KB: '-5' })).toBe(150);
      expect(sizeLimitKb('grid', { PHC_MAX_GRID_KB: '1.5' })).toBe(150);
    });
  });
});
