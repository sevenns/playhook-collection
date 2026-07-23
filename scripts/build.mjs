// Build: bundle the entry point with esbuild, then copy the static files next to it. Output is dist/,
// which is what the Pages workflow uploads. Deliberately not a framework — the whole site is one HTML
// file, one stylesheet and one bundle.
//
// Not typechecked by tsconfig.json (it is a Node script, and this package has no @types/node); `npm run
// typecheck` covers src/ only.
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

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

console.log('built → dist/');
