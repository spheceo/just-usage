import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
export const PACKAGE_NAME = "just-usage";
export const GITHUB_REPO = "spheceo/just-usage";
export const DEFAULT_PORT = 5757;
export const DEFAULT_HOST = "0.0.0.0";
/** How often the running server re-fetches quotas, even with no browser open. */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
/** Snapshots newer than this are served from cache unless the user hits Refresh. */
export const CACHE_TTL_MS = REFRESH_INTERVAL_MS;
/** Per-account fetch budget. */
export const FETCH_TIMEOUT_MS = 20_000;

export function configDir(): string {
  const override = process.env.JUST_USAGE_HOME;
  if (override) return override;
  const xdg = process.env.XDG_CONFIG_HOME;
  return join(xdg && xdg.trim() ? xdg : join(homedir(), ".config"), PACKAGE_NAME);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const paths = {
  registry: () => join(configDir(), "accounts.json"),
  secrets: () => join(configDir(), "secrets.json"),
  updateCache: () => join(configDir(), "update-check.json"),
  profiles: (provider: string) => join(configDir(), "profiles", provider),
  runDir: () => join(configDir(), "run"),
  runRecord: (port: number) => join(configDir(), "run", `${port}.json`),
};
