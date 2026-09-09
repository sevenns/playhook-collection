// Build: bundle the entry point with esbuild, then copy the static files next to it. Output is dist/,
// which is what the Pages workflow uploads. Deliberately not a framework — the whole site is one HTML
// file, one stylesheet and one bundle.
//
// Not typechecked by tsconfig.json (it is a Node script, and this package has no @types/node); `npm run
// typecheck` covers src/ only.
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { buildCollectionFeed } from './collection-feed.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await esbuild.build({
  entryPoints: [join(root, 'src', 'main.ts')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  // index.html loads ./app.js — the name is inherited from the launcher's renderer bundle.
  outfile: join(dist, 'app.js'),
});

await cp(join(root, 'src', 'index.html'), join(dist, 'index.html'));
await cp(join(root, 'src', 'styles.css'), join(dist, 'styles.css'));
await cp(join(root, 'public'), dist, { recursive: true });

// The bundled sound sets and ambience tracks, enumerated from what was just copied rather than listed
// by hand — the launcher's main scans its own audio/ directory and pushes the result to the renderer as
// AudioOptions, and this is the same answer written out at build time. A set is added by dropping a
// folder in public/sfx; nothing else has to know.
async function audioOptions() {
  const sets = await readdir(join(dist, 'sfx'), { withFileTypes: true });
  const tracks = await readdir(join(dist, 'ambience'), { withFileTypes: true });
  return {
    soundSets: sets
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort(),
    // Without the extension: the name is what the settings store keeps, and audio.ts adds the .ogg.
    ambientTracks: tracks
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ogg'))
      .map((entry) => entry.name.slice(0, -'.ogg'.length))
      .sort(),
  };
}

const audio = await audioOptions();
await writeFile(join(dist, 'audio.json'), `${JSON.stringify(audio, null, 2)}\n`);

// The collection is the site's own first consumer: the feed it publishes for the launcher is the very
// data this page renders, so a broken generator is caught by every deploy rather than "later".
const feed = await buildCollectionFeed(root, dist);

console.log(
  `built → dist/ (${feed.entries.length} collection entries, ${audio.soundSets.length} sound sets, ${audio.ambientTracks.length} ambience tracks)`,
);
