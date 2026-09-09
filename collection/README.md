# The collection

Ready-made Playhook manifests, one directory per game.

## Layout

```
collection/
└─ <slug>/                # [a-z0-9-]+, matching the game.json id where that is possible
   ├─ game.json           # the manifest itself: one object, schemaVersion: 1
   ├─ meta.json           # everything about the entry that is not the manifest (see below)
   └─ assets/             # hero images, the carousel cover, background music - whatever game.json references
```

`meta.json`:

```json
{
  "title": "Human-readable game name",
  "steamAppId": 220,
  "author": "github-handle",
  "verifiedAt": "2026-07-23",
  "tested": ["win32", "linux"],
  "notes": "Anything a user needs to know before dropping this on a card.",
  "preview": {
    "hero": ["assets/hero-1.webp", "assets/hero-2.webp"],
    "grid": "assets/grid.webp",
    "music": "assets/theme.ogg"
  }
}
```

`steamAppId`, `notes` and `preview` are optional; the rest are not. `verifiedAt` is the date somebody
actually ran the manifest — not the date the file was committed, and it is what the feed publishes as
`updatedAt`.

`tested` names the systems the manifest was actually run on, and it takes Node's own `process.platform`
values — **`win32`**, **`linux`**, **`darwin`** (that last one is macOS). Not the words the launcher uses
internally for the same thing: `meta.json` never reaches it. The build fails on anything else, because
`tested` is not published to the feed — it is here for whoever reads the repository, so a typo would go
unnoticed until somebody opened the file.

**`preview` is what the site shows**, listed explicitly rather than read out of the manifest. The
manifest is a file for somebody's card: its paths are card-relative and it references things the site has
no use for. The preview is the shop window, and the two are allowed to differ. Paths are relative to the
entry directory. `hero` is capped at three, like the manifest: a longer list is trimmed with a warning
rather than failing the build.

Without a `preview` block the generator guesses one from the manifest (`heroImage` / `gridImage` /
`backgroundMusic`, each mapped to `assets/<basename>`). That is a convenience for typical entries, not a
contract: write the block if you care what the preview shows. A file named in `preview` that does not
exist is a warning, not an error — the preview degrades, the build survives.

Entries carry **no UI sounds**. The block left the card format in Playhook 0.7.0, and 0.8.0 is no
different: the launcher always plays the sound set chosen in its Settings, and the site plays the same
default set (`playhook-abyss`). A stale `sounds` block in a `game.json` still passes the schema — it is
not strict — so the feed generator fails the build on one instead, because what is published here is a
template other people copy.

Entries MAY carry the optional metadata 0.8.0 added to the manifest — `description` (`{ en, ru }`),
`genres`, `releaseDate` (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`) and `platforms` (`windows` / `mac` /
`linux`). The launcher's "Find online" flow writes them; nothing reads them yet, there or here. The feed
publishes them as they are when present.

## Rules

**Entries ship their own assets.** An entry is not just a manifest: `assets/` carries the hero images,
the carousel cover and the background music it references. Those files are both what you drop on your own
card and what the site shows on the entry's preview screen, so they travel with the entry instead of
being left for the user to source. Manifest paths stay **card-relative** and resolve inside the entry
directory.

Keep them web-sized. Everything under `assets/` is served from GitHub Pages and downloaded by anyone
who opens the preview: prefer webp over jpg, and don't ship a lossless soundtrack.

**At most three `heroImage` entries.** Playhook 0.8.0 caps them: the runtime keeps the first three and
logs a warning, the Customize screen refuses to save a fourth. The schema cannot express the cap, so the
feed generator fails the build on it.

**No `pc` block.** It arrived in 0.8.0 for a game installed on the PC itself (an absolute path to its
executable) and the launcher refuses it on a card outright — a card must never name an absolute path.
Every entry here is a card, so the generator fails the build on one. Use `executable`, `install` or
`steam`, as before.

**One `gridImage`, 600x900 webp, under 150 KB.** It is the carousel card's cover, portrait 2:3 to match
the card itself; without it the carousel crops the first hero instead, so it is optional but worth
having. The size limit is not caution, it is a requirement: Electron's `nativeImage` does not decode
webp, so the launcher builds **no thumbnail and re-encodes nothing** — it hands the file to Chromium as
it is, and a webp over 4 MiB is skipped outright, leaving the card blank. Nobody shrinks the cover for
you.

**Validate before you publish.** `../schema/game.schema.json` is the launcher's own schema, so a
mismatch is a real error. But passing it is not enough: the rules that matter most (steam/install/
executable/pc exclusivity, path traversal, the `pcSavePath` prefix allowlist) cannot be expressed in
JSON Schema and are dropped in the conversion. See [../schema/SOURCE.md](../schema/SOURCE.md). Drop the
entry on a card and insert it into Playhook 0.8.0 before calling it verified — a game the launcher
refuses is reported on its Customize screen.

## The feed

This directory is published as a JSON feed at a versioned path:

```
https://sevenns.github.io/playhook-collection/api/v1/index.json          # the whole catalogue
https://sevenns.github.io/playhook-collection/api/v1/<slug>.json         # one entry
https://sevenns.github.io/playhook-collection/api/v1/<slug>/game.json    # the manifest
https://sevenns.github.io/playhook-collection/api/v1/<slug>/assets/**    # everything the entry ships
```

Index entry shape:

```jsonc
{
  "slug": "bloodborne",
  "title": "Bloodborne",
  "steamAppId": 1245620,          // optional
  "updatedAt": "2026-07-23",      // meta.json's verifiedAt
  "sourcePath": "collection/bloodborne",
  "manifestUrl": "bloodborne/game.json",
  "heroUrls": ["bloodborne/assets/hero-1.webp"],
  "gridUrl": "bloodborne/assets/grid.webp", // optional
  "music": "bloodborne/assets/theme.ogg",  // optional
  // The manifest's own optional metadata (0.8.0), mirrored as-is when game.json has it:
  "genres": ["Action", "RPG"],            // optional, non-empty
  "releaseDate": "2015-03-24",            // optional
  "platforms": ["windows"],               // optional, non-empty; windows | mac | linux
  "description": { "en": "…", "ru": "…" } // optional, non-empty; both languages travel
}
```

`entries` is sorted by `title`, case-insensitively — never by whatever order the filesystem hands back.
There is no `generatedAt`: it would make every build byte-different and hide whether the feed actually
changed.

**URLs inside the feed are relative to the feed directory**, not to the document. A consumer must resolve
them against `…/api/v1/` explicitly; dropping such a string straight into an `<img src>` on a page served
from `/playhook-collection/` resolves one directory short and 404s with a clean console.

The generator is `scripts/collection-feed.mjs`, run from `scripts/build.mjs`. It validates every
`game.json` against `../schema/game.schema.json` and **fails the build** on a schema error or a
slug outside `[a-z0-9-]+` — an entry that silently vanishes from the feed is diagnosed painfully. The
whole `assets/` directory is copied, not just what `preview` names: that directory is also what a human
drops on their card, and the manifest points at files the site never opens. It also enforces what the
schema cannot: more than three `heroImage` entries, a leftover `sounds` block, or a `pc` block, fail
the build.

What is deployed is `dist/`, assembled by `scripts/build.mjs` from `src/` and `public/`. This
`collection/` directory is the **source** and does not reach GitHub Pages on its own.
