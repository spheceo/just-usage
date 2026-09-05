import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { isProviderPresent, providerHomeMarkers } from "../src/collect.ts";
import { REFRESH_INTERVAL_MS } from "../src/config.ts";
import { extraBinDirs, spawnEnv, which } from "../src/proc.ts";

const logDir = mkdtempSync(join(tmpdir(), "just-usage-detect-"));
process.env.JUST_USAGE_LOG_DIR = logDir;

afterAll(() => {
  rmSync(logDir, { recursive: true, force: true });
});

describe("CLI discovery", () => {
  test("spawn PATH includes known CLI install dirs", () => {
    const path = spawnEnv().PATH ?? "";
    const local = join(homedir(), ".local", "bin");
    if (existsSync(local)) expect(extraBinDirs()).toContain(local);
    expect(path.length).toBeGreaterThan(0);
  });

  test("which({ fresh: true }) finds a real binary", async () => {
    const agy = join(homedir(), ".local", "bin", "agy");
    if (existsSync(agy)) expect(await which("agy", { fresh: true })).toBe(agy);
    else expect(await which("sh", { fresh: true })).toBeTruthy();
  });

  test("isProviderPresent treats a home/login marker as installed", () => {
    expect(isProviderPresent({ binPath: null, homeExists: false, provider: "antigravity" })).toBe(false);
    expect(isProviderPresent({ binPath: null, homeExists: true, provider: "antigravity" })).toBe(true);
    expect(isProviderPresent({ binPath: "/opt/agy", homeExists: false, provider: "antigravity" })).toBe(true);
    expect(isProviderPresent({ binPath: null, homeExists: false, provider: "opencode" })).toBe(true);
  });

  test("antigravity home markers include the oauth token file", () => {
    expect(providerHomeMarkers("antigravity").some((p) => p.endsWith("antigravity-oauth-token"))).toBe(true);
  });

  test("server refresh interval is five minutes", () => {
    expect(REFRESH_INTERVAL_MS).toBe(5 * 60 * 1000);
  });
});
