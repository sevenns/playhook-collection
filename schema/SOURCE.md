# Where `game.schema.json` comes from

`game.schema.json` is a **generated artifact**, not a hand-written schema. It is the JSON Schema
produced by `manifestJsonSchema()` in Playhook's `src/main/manifest.ts`, which converts the zod schema
(`manifestSchema`) with `z.toJSONSchema(…, { unrepresentable: 'any', io: 'input' })` and wraps it in a
`oneOf` so both a single game object and a non-empty array of games validate.

Nothing in the launcher consumes it any more. Its Configure window — a CodeMirror editor that used the
schema for completion and hover docs — became the Customize screen in 0.8.0, a form that validates
through zod directly. The function stays in the launcher **for this repository**: it is the published
contract the collection dumps its schema from, and its docblock says so outright (`manifest.ts`,
`manifestJsonSchema`). Changing the manifest schema upstream means re-dumping here; deleting the
function there means the collection has no schema at all.

| | |
|---|---|
| Source repo | [sevenns/playhook](https://github.com/sevenns/playhook) |
| Version | 0.8.0 |
| Commit | `c26fae7` (branch `release/v0.8.0`) |
| Dumped | 2026-09-08 |

## What the schema does NOT check

This matters more than it looks. Playhook validates a manifest in two stages, and only the first one is
expressible as JSON Schema. The `refine` / `superRefine` rules are **silently dropped** in the
conversion — the docblock on `manifestJsonSchema()` says so outright:

- **mode exclusivity** — `steam`, `install`, a bare `executable` and the 0.8.0 `pc` block are mutually
  exclusive ways to describe where the game lives; a manifest that sets two of them passes the schema
  and is rejected by the launcher.
- **the `pc` block** — new in 0.8.0, it describes a game installed on the PC itself (an absolute path
  to its executable) and is mutually exclusive with `steam`, `install`, `executable` and `saveOnCard`.
  A card may never carry it: the launcher refuses a `game.json` read from a card that names one
  (`manifest.pcOnCard` in `manifest.ts`), because a card must never name an absolute path. Every entry
  in this collection is a card, so the feed generator fails the build on `pc` rather than publishing a
  template the launcher would reject.
- **path traversal** — `executable`, `heroImage`, `gridImage` and `saveOnCard` must resolve inside the
  card root. `..` and absolute paths are refused. `heroImage` and `gridImage` are equally strict: either
  one escaping the root REJECTS THE GAME, and in a single-game manifest — which is what every entry here
  is — rejecting the one game is fatal for the whole card.
- **`pcSavePath` prefix allowlist** — only `%DOCUMENTS%`, `%LOCALLOW%`, `%APPDATA%`, `%LOCALAPPDATA%`
  and `%USERPROFILE%` are accepted.
- **duplicate ids** inside a multi-game array.
- **the `heroImage` cap of 3** — the zod schema is a bare union with no `.max`, so no `maxItems` reaches
  the dump. The runtime keeps the first three and logs a warning; Customize refuses to save. Our own gate
  in `scripts/collection-feed.mjs` fails the build instead, so the collection never publishes a fourth
  background that the launcher would silently drop.
- **the removal of `sounds`** — the block left the card format in 0.7.0 (UI sounds now always come from
  the set chosen in Settings), and the schema is not strict, so a stale `sounds` block still passes Ajv
  and is then ignored by the launcher. The same feed gate rejects it, because an entry published here is
  a template other people copy.

And one place where the dump is **stricter** than the launcher, not looser:

- **the `.catch(undefined)` fields** — `description`, `genres`, `releaseDate` and `platforms` are
  declared lenient in zod: a malformed value is dropped and the game still loads, because nothing in
  the launcher reads them yet. `z.toJSONSchema` cannot express "ignore if wrong" and dumps them as plain,
  strict fields (checked on zod 4.4.3), so a `releaseDate` like `2005-3` fails this schema while the
  launcher would merely ignore it. That is accepted on purpose: the collection is a template, and a
  malformed field in a template is worse than a red build. Fix the entry, don't loosen the schema.

So: **validating against this schema is necessary, not sufficient.** The authoritative verdict is
`validateManifestText()` in the launcher. Anything published here should be dropped on a card and opened
in Playhook 0.8.0 at least once before it is called verified — the Customize screen shows the errors per
game.

Note also `io: 'input'`: the schema describes what a human *types*, before zod fills defaults. Fields
with a default (`args`, `runAsAdmin`, `launchTimeoutSec`, `killTimeoutSec`) are therefore not `required`.

## Refreshing it

Re-dump whenever the manifest schema changes upstream, and update the version/commit above. From a
checkout of the launcher at the commit you want:

```bash
npm run build:main
node -e "console.log(JSON.stringify(require('./dist/main/manifest.js').manifestJsonSchema(), null, 2))" > ../playhook-collection/schema/game.schema.json
```

(`tsconfig.main.json` emits CommonJS, so plain `node` reads it — no `tsx` needed.) There is no
automation yet; a generator belongs with the task that makes the collection large enough to drift.
