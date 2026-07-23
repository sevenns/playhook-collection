# The collection

Ready-made Playhook manifests, one directory per game. **This directory is a skeleton right now — the
contract below is fixed, the entries are not written yet.** Filling it is its own task.

## Layout

```
collection/
└─ <slug>/                # [a-z0-9-]+, matching the game.json id where that is possible
   ├─ game.json           # the manifest itself: one object, schemaVersion: 1
   └─ meta.json           # everything about the entry that is not the manifest (see below)
```

`meta.json`:

```json
{
  "title": "Human-readable game name",
  "steamAppId": 220,
  "author": "github-handle",
  "verifiedAt": "2026-07-23",
  "tested": ["win32", "linux"],
  "notes": "Anything a user needs to know before dropping this on a card."
}
```

`steamAppId` and `notes` are optional; the rest are not. `verifiedAt` is the date somebody actually ran
the manifest — not the date the file was committed.

## Rules

**No hero images, no key art, no screenshots.** Publishing a commercial game's artwork in a public
repository is a copyright violation, and there is no version of it that is fine because the repo is
small. Manifests reference hero images by a **card-relative path**, so the user supplies their own
image on their own card. An entry that needs artwork to look right is still a valid entry — it just
ships the path, not the picture.

**Validate before you publish.** `../schema/game.schema.json` is the launcher's own schema, so a
mismatch is a real error. But passing it is not enough: the rules that matter most (steam/install/
executable exclusivity, path traversal, the `pcSavePath` prefix allowlist) cannot be expressed in JSON
Schema and are dropped in the conversion. See [../schema/SOURCE.md](../schema/SOURCE.md). Open the
manifest in Playhook's Configure window before calling it verified.

## The feed (reserved, not built yet)

The site will eventually publish this directory as a JSON feed at a versioned path:

```
https://sevenns.github.io/playhook-collection/api/v1/index.json      # the index
https://sevenns.github.io/playhook-collection/api/v1/<slug>.json     # one entry
```

Index entry shape: `{ slug, title, steamAppId?, updatedAt, manifestUrl, heroUrls? }`.

**Today those URLs 404**, deliberately: the collection is empty, so there is nothing to serve. The URL
contract is written down now only so the launcher's Configure window can be pointed at a stable address
later without breaking it.

One thing to keep in mind when that generator gets written: what is deployed is `dist/`, assembled by
`scripts/build.mjs` from `src/` and `public/`. This `collection/` directory is the **source**, and it
does not reach GitHub Pages on its own — the generator has to walk it and emit into `dist/api/v1/`.
