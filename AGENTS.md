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

## Commits

Do not add a `Co-authored-by` trailer, or any other co-author. Cursor/T3 wrappers re-inject it on `git commit` — use `git commit-tree` so the message stays exactly what we wrote.

## Releases

After `bun run release` pushes the tag, stay with the GitHub Actions run until it finishes. Confirm the GitHub Release body and that `npm view just-usage version` matches the tag. Then `git pull --ff-only origin main` so the local tree matches the release commit and the next change does not diverge.
