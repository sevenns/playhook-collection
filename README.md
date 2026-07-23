# playhook-collection

Two things live here:

1. **The site** — [sevenns.github.io/playhook-collection](https://sevenns.github.io/playhook-collection/).
   It is [Playhook](https://github.com/sevenns/playhook)'s own empty screen, rebuilt as a static page:
   same hero, same bar, same menu, same sounds, same gamepad.
2. **The collection** — ready-made `game.json` manifests per game (sounds, hero, save paths, titles), so
   you don't have to write one from scratch. See [collection/README.md](collection/README.md).
   It is empty for now; the data contract is fixed, the entries are not written yet.

No framework, no runtime dependencies: one HTML file, one stylesheet, one bundled script. The UI code is
vendored from the launcher — see [PORTED-FROM.md](PORTED-FROM.md) for what was copied, what was
rewritten, and why.

## Build

```bash
npm install
npm run build      # → dist/
```

```bash
npm run dev        # build, then serve dist/ on :8000 with a watcher
```

Note that the watcher rebuilds the bundle only; `index.html` and `styles.css` are copied by
`scripts/build.mjs`, so re-run the build after editing them.

Gates, both run in CI before deploy:

```bash
npm run typecheck && npm run lint
```

There are no tests. The site is static markup with no branching logic worth asserting on; the launcher
keeps the vitest suite for the parts that actually decide things.

## Adding a collection entry

Read [collection/README.md](collection/README.md) first — especially the part about **not** committing
hero images. In short: create `collection/<slug>/` with `game.json` and `meta.json`, validate against
`schema/game.schema.json`, and open the manifest in Playhook's Configure window before claiming it works.

## Deploy

Pushing to `main` runs typecheck → lint → build and publishes `dist/` to GitHub Pages
(`.github/workflows/deploy.yml`). Pages must be set to "GitHub Actions" as its source in the repository
settings.

## Licence

MIT — see [LICENSE](LICENSE). The bundled font, M PLUS Rounded 1c, is under the SIL Open Font License
1.1: [public/fonts/OFL.txt](public/fonts/OFL.txt).
