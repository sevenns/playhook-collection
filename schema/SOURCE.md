# Where `game.schema.json` comes from

`game.schema.json` is a **generated artifact**, not a hand-written schema. It is the JSON Schema that
Playhook's own Configure editor uses, produced by `manifestJsonSchema()` in
`src/main/manifest.ts`, which converts the zod schema (`manifestSchema`) with
`z.toJSONSchema(…, { unrepresentable: 'any', io: 'input' })` and wraps it in a `oneOf` so both a single
game object and a non-empty array of games validate.

| | |
|---|---|
| Source repo | [sevenns/playhook](https://github.com/sevenns/playhook) |
| Version | 0.7.0 |
| Commit | `4461c60e75e18d98d77e80e70b9394e0bd0731a5` |
| Dumped | 2026-08-11 |

## What the schema does NOT check

This matters more than it looks. Playhook validates a manifest in two stages, and only the first one is
expressible as JSON Schema. The `refine` / `superRefine` rules are **silently dropped** in the
conversion — the docblock on `manifestJsonSchema()` says so outright:

- **mode exclusivity** — `steam`, `install` and a bare `executable` are mutually exclusive ways to
  describe where the game lives; a manifest that sets two of them passes the schema and is rejected by
  the launcher.
- **path traversal** — `executable`, `heroImage`, `gridImage` and `saveOnCard` must resolve inside the
  card root. `..` and absolute paths are refused. `heroImage` and `gridImage` are equally strict: either
  one escaping the root REJECTS THE GAME, and in a single-game manifest — which is what every entry here
  is — rejecting the one game is fatal for the whole card.
- **`pcSavePath` prefix allowlist** — only `%DOCUMENTS%`, `%LOCALLOW%`, `%APPDATA%`, `%LOCALAPPDATA%`
  and `%USERPROFILE%` are accepted.
- **duplicate ids** inside a multi-game array.
- **the `heroImage` cap of 3** — the zod schema is a bare union with no `.max`, so no `maxItems` reaches
  the dump. The runtime keeps the first three and logs a warning; Configure refuses to save. Our own gate
  in `scripts/collection-feed.mjs` fails the build instead, so the collection never publishes a fourth
  background that the launcher would silently drop.
- **the removal of `sounds`** — the block left the card format in 0.7.0 (UI sounds now always come from
  the set chosen in Settings), and the schema is not strict, so a stale `sounds` block still passes Ajv
  and is then ignored by the launcher. The same feed gate rejects it, because an entry published here is
  a template other people copy.

So: **validating against this schema is necessary, not sufficient.** The authoritative verdict is
`validateManifestText()` in the launcher. Anything published here should be opened in Playhook's
Configure window at least once before it is called verified.

Note also `io: 'input'`: the schema describes what a human *types*, before zod fills defaults. Fields
with a default (`args`, `runAsAdmin`, `launchTimeoutSec`, `killTimeoutSec`) are therefore not `required`.

## Refreshing it

Re-dump whenever the manifest schema changes upstream, and update the version/commit above. There is no
automation yet — with the collection still empty there is nothing to drift against. A generator belongs
with the task that fills the collection.
