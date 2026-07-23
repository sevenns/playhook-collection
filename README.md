# playhook-collection

Two things live here:

1. **The site** — [sevenns.github.io/playhook-collection](https://sevenns.github.io/playhook-collection/).
   It is [Playhook](https://github.com/sevenns/playhook)'s own UI, rebuilt as a static page: same hero,
   same bar, same menu, same sounds, same gamepad. Its Collection view browses the catalogue below, and
   picking an entry previews it the way the launcher would — that entry's hero images rotating, its own
   UI sounds, its own background music.
2. **The collection** — ready-made `game.json` manifests per game (sounds, hero, save paths, titles), so
   you don't have to write one from scratch. See [collection/README.md](collection/README.md).

The site is the first consumer of the collection's own JSON feed (`api/v1/index.json`), which is
generated on every build and is the same address the launcher's Configure window will point at. That way
the feed is exercised by every deploy instead of "later".

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

There are no tests. The launcher keeps the vitest suite for the parts that actually decide things; here
the gates are typecheck, lint, a build that validates every manifest, and looking at the five screens.

## Adding a collection entry

Read [collection/README.md](collection/README.md) first. In short: create `collection/<slug>/` with
`game.json`, `meta.json` and an `assets/` directory, keep the assets web-sized (they are downloaded by
anyone who opens the preview), and open the manifest in Playhook's Configure window before claiming it
works. `npm run build` validates every manifest against `schema/game.schema.json` and fails on a bad
one, so a broken entry never reaches the feed.

## Deploy

Pushing to `main` runs typecheck → lint → build and publishes `dist/` to GitHub Pages
(`.github/workflows/deploy.yml`). Pages must be set to "GitHub Actions" as its source in the repository
settings.

## Licence

MIT — see [LICENSE](LICENSE). The bundled font, M PLUS Rounded 1c, is under the SIL Open Font License
1.1: [public/fonts/OFL.txt](public/fonts/OFL.txt).
