// The ledger's mechanics. PORTED-FROM.md and the `Ported 1:1 from playhook @ <sha> : <path>` headers
// are promises; this script is what checks them, so "1:1" stops being a matter of discipline.
//
// Two checks, both against a LOCAL checkout of the launcher named by PLAYHOOK_DIR — playhook is
// `private: true`, so CI has no access to it and this never runs there (see PORTED-FROM.md, "Keeping up
// with drift"). Run it by hand before reconciling with a newer launcher:
//
//   PLAYHOOK_DIR=../playhook npm run check:ported
//
//   1. Every src/**/*.ts whose first line is a `Ported 1:1` header is compared, byte for byte, with the
//      upstream file at the commit THAT HEADER names (`git show <sha>:<path>`) — not one shared commit:
//      dominant-color.ts is pinned to an older one than the rest, and sfx-limit.ts to a newer one. The
//      header itself is the only difference the site is allowed: the leading `//` lines the upstream
//      file does not have are dropped before the comparison, whatever their number. A file that diverges
//      fails the run; the fix is either to re-copy it or to demote its header to plain `Ported from`
//      and record the divergence in the ledger, as screen-sidebar.ts does.
//   2. schema/game.schema.json is compared with a fresh dump of `manifestJsonSchema()` from the
//      launcher's built main (`dist/main/manifest.js` — `npm run build:main` there first). That is the
//      recipe in schema/SOURCE.md, run rather than remembered.
//
// It also says, per file, whether the upstream file has moved since the pinned commit — informational
// only: drift is expected (this is a showcase, not a second launcher), and which files moved is exactly
// what a reconcile needs to know.
// @ts-check
import { execFileSync } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADER_RE = /^\/\/ Ported 1:1 from playhook @ ([0-9a-f]+)\b[^:\n]*: (\S+)$/m;

/**
 * @typedef {object} PortedFile
 * @property {string} file path relative to the repository root
 * @property {string} sha the upstream commit the header pins
 * @property {string} upstreamPath the path in the launcher's tree
 * @property {string} text the whole file
 */

/** @param {string} dir */
async function listTsFiles(dir) {
  /** @type {string[]} */
  const files = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) files.push(...(await listTsFiles(path)));
    else if (dirent.name.endsWith('.ts')) files.push(path);
  }
  return files.sort();
}

/**
 * The files that promise to be 1:1 — the ones whose FIRST line says so. A `Ported from` header lower in
 * a docblock is a different promise (see the ledger), and is not checked here.
 * @param {string} root
 * @returns {Promise<PortedFile[]>}
 */
export async function findPortedFiles(root) {
  const ported = [];
  for (const path of await listTsFiles(join(root, 'src'))) {
    const text = await readFile(path, 'utf8');
    const match = HEADER_RE.exec(text);
    const [, sha, upstreamPath] = match ?? [];
    if (match?.index !== 0 || sha === undefined || upstreamPath === undefined) continue;
    ported.push({ file: relative(root, path), sha, upstreamPath, text });
  }
  return ported;
}

/**
 * The site file minus its header: the leading run of `//` lines that the upstream file does not have.
 * Both files open with a comment block (upstream's own docblock follows the header directly, with no
 * blank line between), so the header's length is the difference in their lengths — two lines for most
 * files, more where the sentence ran on. Never less than one: the first line is the header by definition.
 * @param {string} site
 * @param {string} upstream
 */
export function stripHeader(site, upstream) {
  const leading = (/** @type {string} */ text) => {
    const lines = text.split('\n');
    let n = 0;
    while (n < lines.length && lines[n]?.startsWith('//') === true) n += 1;
    return n;
  };
  const headerLines = Math.max(1, leading(site) - leading(upstream));
  return site.split('\n').slice(headerLines).join('\n');
}

/**
 * Where two texts first part ways, as a line number (1-based) and both lines — enough to point at the
 * divergence without a diff library.
 * @param {string} a
 * @param {string} b
 * @returns {{ line: number; a: string | undefined; b: string | undefined } | null}
 */
export function firstDifference(a, b) {
  const as = a.split('\n');
  const bs = b.split('\n');
  const count = Math.max(as.length, bs.length);
  for (let i = 0; i < count; i += 1) {
    if (as[i] !== bs[i]) return { line: i + 1, a: as[i], b: bs[i] };
  }
  return null;
}

/**
 * @param {string} playhookDir
 * @param {string[]} args
 */
function git(playhookDir, args) {
  return execFileSync('git', ['-C', playhookDir, ...args], { encoding: 'utf8' });
}

/**
 * @param {string} playhookDir
 * @param {PortedFile} ported
 */
function upstreamText(playhookDir, ported) {
  return git(playhookDir, ['show', `${ported.sha}:${ported.upstreamPath}`]);
}

/**
 * Whether the upstream file changed between the pinned commit and the launcher checkout's HEAD.
 * @param {string} playhookDir
 * @param {PortedFile} ported
 */
function movedUpstream(playhookDir, ported) {
  const out = git(playhookDir, ['diff', '--stat', ported.sha, 'HEAD', '--', ported.upstreamPath]);
  return out.trim().length > 0;
}

/**
 * The schema the launcher would dump today, as the file would be written (the `console.log` in the
 * SOURCE.md recipe ends it with a newline).
 * @param {string} playhookDir
 */
function dumpSchema(playhookDir) {
  const manifest = join(playhookDir, 'dist', 'main', 'manifest.js');
  const require = createRequire(import.meta.url);
  /** @type {{ manifestJsonSchema: () => unknown }} */
  let module;
  try {
    module = require(manifest);
  } catch (error) {
    throw new Error(
      `cannot load ${manifest} (run \`npm run build:main\` in ${playhookDir} first): ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return `${JSON.stringify(module.manifestJsonSchema(), null, 2)}\n`;
}

/**
 * Runs both checks and reports. Resolves to the number of failures.
 * @param {string} root the repository root
 * @param {string} playhookDir a checkout of the launcher, with its main built
 */
export async function checkPorted(root, playhookDir) {
  let failures = 0;

  const ported = await findPortedFiles(root);
  for (const file of ported) {
    let upstream;
    try {
      upstream = upstreamText(playhookDir, file);
    } catch {
      failures += 1;
      console.error(`✗ ${file.file}: ${file.upstreamPath} is not at ${file.sha} in ${playhookDir}`);
      continue;
    }
    const site = stripHeader(file.text, upstream);
    const difference = firstDifference(site, upstream);
    const moved = movedUpstream(playhookDir, file) ? ' (upstream has moved since — drift)' : '';
    if (difference === null) {
      console.log(`✓ ${file.file} = playhook @ ${file.sha}${moved}`);
      continue;
    }
    failures += 1;
    console.error(`✗ ${file.file} ≠ playhook @ ${file.sha} : ${file.upstreamPath}${moved}`);
    console.error(
      `    first difference at line ${difference.line} of the body (after the header):`,
    );
    console.error(`    here:  ${difference.a ?? '<end of file>'}`);
    console.error(`    there: ${difference.b ?? '<end of file>'}`);
  }
  console.log(`${ported.length} file(s) carry a "Ported 1:1" header`);

  const schemaPath = join(root, 'schema', 'game.schema.json');
  const committed = await readFile(schemaPath, 'utf8');
  const dumped = dumpSchema(playhookDir);
  if (dumped === committed) {
    console.log(`✓ schema/game.schema.json = manifestJsonSchema() from ${playhookDir}`);
  } else {
    failures += 1;
    const difference = firstDifference(committed, dumped);
    console.error(`✗ schema/game.schema.json ≠ manifestJsonSchema() from ${playhookDir}`);
    console.error(
      `    first difference at line ${difference?.line ?? '?'} — re-dump it (schema/SOURCE.md)`,
    );
  }

  return failures;
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const playhookDir = process.env['PLAYHOOK_DIR'];
  if (playhookDir === undefined || playhookDir.length === 0) {
    console.error('PLAYHOOK_DIR is not set — point it at a local checkout of sevenns/playhook');
    process.exit(2);
  }
  const dir = resolve(root, playhookDir);
  const isDir = await stat(dir)
    .then((s) => s.isDirectory())
    .catch(() => false);
  if (!isDir) {
    console.error(`PLAYHOOK_DIR=${playhookDir} is not a directory (resolved to ${dir})`);
    process.exit(2);
  }
  const failures = await checkPorted(root, dir);
  process.exit(failures === 0 ? 0 : 1);
}
