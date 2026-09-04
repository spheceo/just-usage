import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GITHUB_REPO, PACKAGE_NAME, VERSION, ensureDir, paths } from "./config.ts";
import { semverGt } from "./format.ts";
import { log } from "./log.ts";
import { runInteractive } from "./proc.ts";
import type { UpdateInfo } from "./types.ts";

const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

interface CacheFile {
  checkedAt: string;
  latest: string;
}

function readCache(): CacheFile | null {
  const file = paths.updateCache();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CacheFile>;
    if (typeof parsed.checkedAt === "string" && typeof parsed.latest === "string") return parsed as CacheFile;
  } catch {
    // ignore
  }
  return null;
}

function writeCache(c: CacheFile) {
  try {
    ensureDir(dirname(paths.updateCache()));
    writeFileSync(paths.updateCache(), JSON.stringify(c) + "\n");
  } catch {
    // Cache is best-effort.
  }
}

async function latestFromGitHub(): Promise<string | null> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": `${PACKAGE_NAME}/${VERSION}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { tag_name?: string };
  const tag = body.tag_name?.replace(/^v/, "");
  return tag && /^\d+\.\d+\.\d+/.test(tag) ? tag : null;
}

async function latestFromNpm(): Promise<string | null> {
  const res = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    headers: { Accept: "application/json", "User-Agent": `${PACKAGE_NAME}/${VERSION}` },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { version?: string };
  return body.version && /^\d+\.\d+\.\d+/.test(body.version) ? body.version : null;
}

/** Resolve the newest published version. GitHub Releases first, npm as fallback. Cached for 12h. */
export async function checkForUpdate(force = false): Promise<UpdateInfo | null> {
  if (process.env.JUST_USAGE_NO_UPDATE_CHECK === "1" && !force) return null;
  const cached = readCache();
  if (!force && cached && Date.now() - Date.parse(cached.checkedAt) < CHECK_INTERVAL_MS) {
    return toInfo(cached);
  }
  let latest: string | null = null;
  try {
    latest = await latestFromGitHub();
  } catch {
    latest = null;
  }
  if (!latest) {
    try {
      latest = await latestFromNpm();
    } catch {
      latest = null;
    }
  }
  if (!latest) {
    log("warn", "update.check", { ok: false });
    return cached ? toInfo(cached) : null;
  }
  const entry = { checkedAt: new Date().toISOString(), latest };
  writeCache(entry);
  const info = toInfo(entry);
  log("info", "update.check", { latest: info.latest, available: info.available });
  return info;
}

function toInfo(c: CacheFile): UpdateInfo {
  return { current: VERSION, latest: c.latest, available: semverGt(c.latest, VERSION), checkedAt: c.checkedAt };
}

export type PackageManager = "npm" | "bun" | "pnpm" | "yarn";

/** Guess how this binary was installed by looking at where it lives. */
export function detectPackageManager(argv1: string = process.argv[1] ?? "", execPath: string = process.execPath): PackageManager {
  const p = argv1.replace(/\\/g, "/");
  if (/\/\.bun\//.test(p) || /bun/.test(execPath.replace(/\\/g, "/").split("/").pop() ?? "")) return "bun";
  if (/\/pnpm\//.test(p) || /\/\.pnpm\//.test(p)) return "pnpm";
  if (/\/\.yarn\//.test(p) || /\/yarn\//.test(p)) return "yarn";
  return "npm";
}

export function upgradeCommand(pm: PackageManager, version = "latest"): [string, string[]] {
  const spec = `${PACKAGE_NAME}@${version}`;
  switch (pm) {
    case "bun":
      return ["bun", ["add", "-g", spec]];
    case "pnpm":
      return ["pnpm", ["add", "-g", spec]];
    case "yarn":
      return ["yarn", ["global", "add", spec]];
    default:
      return ["npm", ["install", "-g", spec]];
  }
}

export async function runUpgrade(pm: PackageManager, version = "latest"): Promise<number | null> {
  const [cmd, args] = upgradeCommand(pm, version);
  console.log(`$ ${cmd} ${args.join(" ")}`);
  log("info", "update.upgrade", { pm, version });
  const code = await runInteractive(cmd, args);
  log(code === 0 ? "info" : "error", "update.upgrade.done", { pm, version, code: code ?? undefined });
  return code;
}
