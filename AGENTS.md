# just-usage

Local CLI that detects installed coding CLIs and serves a localhost page of their subscription quotas.

`package.json` `version` is the single source of truth. The CLI, page footer, health route, and release tags all read from it.

## Versioning

Increment the **patch** number (`0.0.X`) when pushing new changes, no matter how large the change is.

Do not bump minor or major unless the user explicitly says to. An explicit version from the user wins.

Release with `bun run release` (defaults to patch) or `bun run release patch`.
