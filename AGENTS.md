# just-usage

Local CLI that detects installed coding CLIs and serves a localhost page of their subscription quotas.

`package.json` `version` is the single source of truth. The CLI, page footer, health route, and release tags all read from it.

## Versioning

Increment the **patch** number (`0.0.X`) when pushing new changes, no matter how large the change is.

Do not bump minor or major unless the user explicitly says to. An explicit version from the user wins.

Release with `bun run release` (defaults to patch) or `bun run release patch`.

## Changelog

`CHANGELOG.md` is the source of truth for GitHub Releases. `bun run release` prepends a `## vX.Y.Z` section whose body is reused as the release notes:

```
## What's Changed
<commit subject> in [#sha](https://github.com/spheceo/just-usage/commit/sha)
```

Each line is a commit since the previous release tag. `#sha` links to that commit. The GitHub Release title is `vX.Y.Z`. Do not invent PR numbers or add a committer.
