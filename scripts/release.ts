/**
 * Cut a release without extra tooling:
 *   bun run release patch|minor|major|<x.y.z> [--dry]
 *
 * 1. requires a clean tree on `main`
 * 2. bumps package.json, runs typecheck + tests + build
 * 3. commits "vX.Y.Z", tags vX.Y.Z, pushes main + tag
 * The tag push triggers .github/workflows/release.yml, which publishes to npm and creates the GitHub Release.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const dry = args.includes("--dry");
const bump = args.find((a) => !a.startsWith("--"));
if (!bump) {
  console.error("usage: bun run release patch|minor|major|<x.y.z> [--dry]");
  process.exit(1);
}

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

console.log(`${pkg.version} → ${next}`);
if (!dry) writeFileSync(pkgPath, pkgRaw.replace(`"version": "${pkg.version}"`, `"version": "${next}"`));

sh("bun", ["run", "typecheck"]);
sh("bun", ["test"]);
sh("bun", ["run", "build"]);

sh("git", ["add", "package.json"]);
sh("git", ["commit", "-m", tag]);
sh("git", ["tag", "-a", tag, "-m", tag]);
sh("git", ["push", "origin", "main"]);
sh("git", ["push", "origin", tag]);
console.log(`\npushed ${tag}. GitHub Actions will publish to npm and create the release.`);
