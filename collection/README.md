# The collection

Ready-made Playhook manifests, one directory per game.

## Layout

```
collection/
└─ <slug>/                # [a-z0-9-]+, matching the game.json id where that is possible
   ├─ game.json           # the manifest itself: one object, schemaVersion: 1
   ├─ meta.json           # everything about the entry that is not the manifest (see below)
   └─ assets/             # hero images, UI sounds, background music - whatever game.json references
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
    "sounds": { "navigate": "assets/move.ogg", "button": "assets/button.ogg" },
    "music": "assets/theme.ogg"
  }
}
```

`steamAppId`, `notes` and `preview` are optional; the rest are not. `verifiedAt` is the date somebody
actually ran the manifest — not the date the file was committed, and it is what the feed publishes as
`updatedAt`.

**`preview` is what the site shows**, listed explicitly rather than read out of the manifest. The
manifest is a file for somebody's card: its paths are card-relative and it references things the site has
no use for. The preview is the shop window, and the two are allowed to differ. Paths are relative to the
entry directory. Slots come from Playhook's own vocabulary — `navigate` (the file is historically called
`move.*`), `button`, `back`, `play` — and any slot you leave out falls back to the site's default set.

Without a `preview` block the generator guesses one from the manifest (`heroImage` / `sounds` /
`backgroundMusic`, each mapped to `assets/<basename>`). That is a convenience for typical entries, not a
contract: write the block if you care what the preview shows. A file named in `preview` that does not
exist is a warning, not an error — the preview degrades, the build survives.

## Rules

**Entries ship their own assets.** An entry is not just a manifest: `assets/` carries the hero images,
the UI sounds and the background music it references. Those files are both what you drop on your own
card and what the site plays on the entry's preview screen, so they travel with the entry instead of
being left for the user to source. Manifest paths stay **card-relative** and resolve inside the entry
directory.

Keep them web-sized. Everything under `assets/` is served from GitHub Pages and downloaded by anyone
who opens the preview: prefer webp over jpg, ogg over wav, and don't ship a lossless soundtrack.

**Validate before you publish.** `../schema/game.schema.json` is the launcher's own schema, so a
mismatch is a real error. But passing it is not enough: the rules that matter most (steam/install/
executable exclusivity, path traversal, the `pcSavePath` prefix allowlist) cannot be expressed in JSON
Schema and are dropped in the conversion. See [../schema/SOURCE.md](../schema/SOURCE.md). Open the
manifest in Playhook's Configure window before calling it verified.

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
  "sounds": { "navigate": "bloodborne/assets/move.ogg" },
  "music": "bloodborne/assets/theme.ogg"  // optional
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
drops on their card, and the manifest points at files the site never plays.

What is deployed is `dist/`, assembled by `scripts/build.mjs` from `src/` and `public/`. This
`collection/` directory is the **source** and does not reach GitHub Pages on its own.
