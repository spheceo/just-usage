/**
 * Cut a release without extra tooling:
 *   bun run release [patch|minor|major|<x.y.z>] [--dry]
 *
 * Defaults to patch (0.0.X). Do not use minor/major unless the user asks.
 *
 * 1. requires a clean tree on `main`
 * 2. bumps package.json, prepends CHANGELOG.md, runs typecheck + tests + build
 * 3. commits "vX.Y.Z", tags vX.Y.Z, pushes main + tag
 * The tag push triggers .github/workflows/release.yml, which publishes to npm
 * and creates the GitHub Release from the matching CHANGELOG.md section.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { formatReleaseNotes, githubRepoFromRemote, parseCommitLog, prependChangelog } from "./changelog.ts";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const bump = args.find((a) => !a.startsWith("--")) ?? "patch";

function sh(cmd: string, cmdArgs: string[], opts: { capture?: boolean; allowFail?: boolean } = {}): string {
  if (dry && !opts.capture) {
    console.log(`[dry] ${cmd} ${cmdArgs.join(" ")}`);
    return "";
  }
  const res = spawnSync(cmd, cmdArgs, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8" });
  if (res.status !== 0 && !opts.allowFail) {
    console.error(`${cmd} ${cmdArgs.join(" ")} failed`);
    process.exit(res.status ?? 1);
  }
  return (res.stdout ?? "").trim();
}

const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], { capture: true });
if (branch !== "main") {
  console.error(`releases are cut from main (currently on ${branch})`);
  process.exit(1);
}
if (sh("git", ["status", "--porcelain"], { capture: true })) {
  console.error("working tree is not clean");
  process.exit(1);
}

const pkgPath = "package.json";
const changelogPath = "CHANGELOG.md";
const pkgRaw = readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgRaw) as { version: string };
const [maj, min, pat] = pkg.version.split(".").map(Number) as [number, number, number];
let next: string;
switch (bump) {
  case "patch":
    next = `${maj}.${min}.${pat + 1}`;
    break;
  case "minor":
    next = `${maj}.${min + 1}.0`;
    break;
  case "major":
    next = `${maj + 1}.0.0`;
    break;
  default:
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(bump)) {
      console.error(`invalid version: ${bump}`);
      process.exit(1);
    }
    next = bump;
}

const tag = `v${next}`;
if (sh("git", ["tag", "-l", tag], { capture: true })) {
  console.error(`${tag} already exists`);
  process.exit(1);
}

const previousTag = sh("git", ["describe", "--tags", "--abbrev=0"], { capture: true, allowFail: true });
const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
const log = sh("git", ["log", "--no-merges", "--format=%H%x09%s", range], { capture: true });
const repo = githubRepoFromRemote(sh("git", ["remote", "get-url", "origin"], { capture: true }));
const notes = formatReleaseNotes(next, parseCommitLog(log), repo);

console.log(`${pkg.version} → ${next}`);
console.log(`\n${notes}`);
if (!dry) {
  writeFileSync(pkgPath, pkgRaw.replace(`"version": "${pkg.version}"`, `"version": "${next}"`));
  const existing = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "";
  writeFileSync(changelogPath, prependChangelog(existing, notes, next));
}

sh("bun", ["run", "typecheck"]);
sh("bun", ["test"]);
sh("bun", ["run", "build"]);

if (!dry) {
  sh("git", ["add", pkgPath, changelogPath]);
  const tree = sh("git", ["write-tree"], { capture: true });
  const parent = sh("git", ["rev-parse", "HEAD"], { capture: true });
  const sha = sh("git", ["commit-tree", tree, "-p", parent, "-m", tag], { capture: true });
  sh("git", ["reset", "--soft", sha]);
  const notesFile = join(tmpdir(), `just-usage-${tag}.md`);
  writeFileSync(notesFile, notes);
  sh("git", ["tag", "-a", tag, "-F", notesFile]);
  unlinkSync(notesFile);
  sh("git", ["push", "origin", "main"]);
  sh("git", ["push", "origin", tag]);
}
console.log(`\npushed ${tag}. GitHub Actions will publish to npm and create the release.`);
