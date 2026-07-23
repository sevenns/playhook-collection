# Where `game.schema.json` comes from

`game.schema.json` is a **generated artifact**, not a hand-written schema. It is the JSON Schema that
Playhook's own Configure editor uses, produced by `manifestJsonSchema()` in
`src/main/manifest.ts`, which converts the zod schema (`manifestSchema`) with
`z.toJSONSchema(…, { unrepresentable: 'any', io: 'input' })` and wraps it in a `oneOf` so both a single
game object and a non-empty array of games validate.

| | |
|---|---|
| Source repo | [sevenns/playhook](https://github.com/sevenns/playhook) |
| Version | 0.6.2 |
| Commit | `c348f4246752286b594c8a8eddd2253ea88b0f12` |
| Dumped | 2026-07-23 |

## What the schema does NOT check

This matters more than it looks. Playhook validates a manifest in two stages, and only the first one is
expressible as JSON Schema. The `refine` / `superRefine` rules are **silently dropped** in the
conversion — the docblock on `manifestJsonSchema()` says so outright:

- **mode exclusivity** — `steam`, `install` and a bare `executable` are mutually exclusive ways to
  describe where the game lives; a manifest that sets two of them passes the schema and is rejected by
  the launcher.
- **path traversal** — `executable`, `heroImage` and `saveOnCard` must resolve inside the card root.
  `..` and absolute paths are refused.
- **`pcSavePath` prefix allowlist** — only `%DOCUMENTS%`, `%LOCALLOW%`, `%APPDATA%`, `%LOCALAPPDATA%`
  and `%USERPROFILE%` are accepted.
- **duplicate ids** inside a multi-game array.

So: **validating against this schema is necessary, not sufficient.** The authoritative verdict is
`validateManifestText()` in the launcher. Anything published here should be opened in Playhook's
Configure window at least once before it is called verified.

Note also `io: 'input'`: the schema describes what a human *types*, before zod fills defaults. Fields
with a default (`args`, `runAsAdmin`, `launchTimeoutSec`, `killTimeoutSec`) are therefore not `required`.

## Refreshing it

Re-dump whenever the manifest schema changes upstream, and update the version/commit above. There is no
automation yet — with the collection still empty there is nothing to drift against. A generator belongs
with the task that fills the collection.
