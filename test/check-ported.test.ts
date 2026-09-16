// The ledger's mechanics (scripts/check-ported.mjs) — the parts that decide whether a "Ported 1:1" file
// still is: which files carry the header, what the header is, and where two texts first part ways. The
// git and schema halves need a launcher checkout and are not driven here.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  HEADER_RE,
  findPortedFiles,
  firstDifference,
  stripHeader,
} from '../scripts/check-ported.mjs';

const PIN = '// Ported 1:1 from playhook @ c26fae7 (release/v0.8.0) : src/renderer/dom.ts';
const TAIL = '// Do not diverge without reason — see PORTED-FROM.md.';

describe('HEADER_RE', () => {
  it('reads the short and the full sha, with or without the branch note', () => {
    expect(HEADER_RE.exec(PIN)?.slice(1)).toEqual(['c26fae7', 'src/renderer/dom.ts']);
    const full =
      '// Ported 1:1 from playhook @ c348f4246752286b594c8a8eddd2253ea88b0f12 : src/x.ts';
    expect(HEADER_RE.exec(full)?.slice(1)).toEqual([
      'c348f4246752286b594c8a8eddd2253ea88b0f12',
      'src/x.ts',
    ]);
  });

  it('is not a plain "Ported from" (a demoted header is a different promise)', () => {
    expect(HEADER_RE.test('// Ported from playhook @ c26fae7 : src/x.ts; diverges')).toBe(false);
  });
});

describe('stripHeader', () => {
  const body = '// The upstream docblock.\nexport const x = 1;\n';

  it('drops the pin line and the "Do not diverge" line, whatever the upstream opens with', () => {
    expect(stripHeader(`${PIN}\n${TAIL}\n${body}`)).toBe(body);
    expect(stripHeader(`${PIN}\n${TAIL}\nexport const x = 1;\n`)).toBe('export const x = 1;\n');
  });

  it('drops a header whose tail ran on to a third line, and never less than the pin itself', () => {
    expect(stripHeader(`${PIN}\n${TAIL}\n${TAIL}\n${body}`)).toBe(body);
    expect(stripHeader(`${PIN}\n${body}`)).toBe(body);
  });

  it('keeps any other comment the site adds — that is a divergence, not a header', () => {
    const extra = '// The site says something of its own here.\n';
    expect(stripHeader(`${PIN}\n${TAIL}\n${extra}${body}`)).toBe(`${extra}${body}`);
  });
});

describe('firstDifference', () => {
  it('is null for equal texts and names the first line that differs', () => {
    expect(firstDifference('a\nb\n', 'a\nb\n')).toBeNull();
    expect(firstDifference('a\nb\nc', 'a\nB\nc')).toEqual({ line: 2, a: 'b', b: 'B' });
  });

  it('reports the end of the shorter text as the difference', () => {
    expect(firstDifference('a\nb', 'a')).toEqual({ line: 2, a: 'b', b: undefined });
    expect(firstDifference('a', 'a\nb')).toEqual({ line: 2, a: undefined, b: 'b' });
  });
});

describe('findPortedFiles', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'phc-ported-'));
    await mkdir(join(root, 'src', 'nested'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists the .ts files whose FIRST line is the header, with the sha and path it pins', async () => {
    await writeFile(join(root, 'src', 'a.ts'), `${PIN}\n${TAIL}\nexport {};\n`);
    await writeFile(
      join(root, 'src', 'nested', 'b.ts'),
      '// Ported 1:1 from playhook @ 070b279 (release/v0.9.0) : src/renderer/b.ts\nexport {};\n',
    );
    await writeFile(join(root, 'src', 'later.ts'), `// A docblock first.\n${PIN}\nexport {};\n`);
    await writeFile(join(root, 'src', 'plain.ts'), 'export {};\n');
    await writeFile(join(root, 'src', 'notes.md'), PIN);
    const ported = await findPortedFiles(root);
    expect(ported.map(({ file, sha, upstreamPath }) => ({ file, sha, upstreamPath }))).toEqual([
      { file: 'src/a.ts', sha: 'c26fae7', upstreamPath: 'src/renderer/dom.ts' },
      { file: 'src/nested/b.ts', sha: '070b279', upstreamPath: 'src/renderer/b.ts' },
    ]);
  });
});
