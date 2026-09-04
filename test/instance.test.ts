import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  fetchHealth,
  formatStopResults,
  isJustUsageHealth,
  looksLikeJustUsageCommand,
  parseHealth,
  parseRunRecord,
  readRunRecord,
  stopServers,
  writeRunRecord,
} from "../src/instance.ts";

const home = mkdtempSync(join(tmpdir(), "just-usage-"));
process.env.JUST_USAGE_HOME = home;
process.env.JUST_USAGE_LOG_DIR = join(home, "logs");

describe("instance helpers", () => {
  test("recognizes just-usage command lines", () => {
    expect(looksLikeJustUsageCommand("just-usage serve --port 5757")).toBe(true);
    expect(looksLikeJustUsageCommand("/usr/local/bin/just-usage")).toBe(true);
    expect(looksLikeJustUsageCommand("bun /Users/x/just-usage/src/cli.ts serve")).toBe(true);
    expect(looksLikeJustUsageCommand("node /opt/just-usage/dist/cli.js")).toBe(true);
    expect(looksLikeJustUsageCommand("bun run src/cli.ts serve")).toBe(false);
    expect(looksLikeJustUsageCommand("nginx")).toBe(false);
  });

  test("parses run records and health", () => {
    expect(parseRunRecord(JSON.stringify({ pid: 12, port: 5757, host: "127.0.0.1", startedAt: "t" }))).toEqual({
      pid: 12,
      port: 5757,
      host: "127.0.0.1",
      startedAt: "t",
    });
    expect(parseRunRecord("{}")).toBeNull();
    expect(parseHealth({ ok: true, name: "just-usage", version: "0.0.4", pid: 9 })).toEqual({
      ok: true,
      name: "just-usage",
      version: "0.0.4",
      pid: 9,
    });
    expect(isJustUsageHealth(parseHealth({ ok: true, name: "just-usage", version: "0.0.4" }))).toBe(true);
    expect(isJustUsageHealth(parseHealth({ ok: true, version: "0.0.4" }))).toBe(true);
    expect(isJustUsageHealth(parseHealth({ ok: true, name: "other" }))).toBe(false);
    expect(isJustUsageHealth(parseHealth({ ok: false }))).toBe(false);
  });

  test("writes and reads a run record", () => {
    writeRunRecord({ port: 59999, host: "127.0.0.1" });
    const rec = readRunRecord(59999);
    expect(rec?.pid).toBe(process.pid);
    expect(rec?.port).toBe(59999);
    expect(rec?.host).toBe("127.0.0.1");
  });

  test("formats stop results", () => {
    expect(formatStopResults([{ status: "idle", port: 5757 }])).toEqual({
      text: "No just-usage server is running on port 5757.",
      code: 1,
    });
    expect(formatStopResults([{ status: "stopped", port: 5757, pids: [11, 12] }])).toEqual({
      text: "Stopped just-usage on port 5757 (pid 11, 12).",
      code: 0,
    });
    expect(formatStopResults([{ status: "busy", port: 80 }]).code).toBe(1);
  });
});

describe("just-usage stop", () => {
  const port = 18757;

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("stops a spawned server on a dedicated port", async () => {
    const child = spawn("bun", ["run", "src/cli.ts", "serve", "--port", String(port), "--host", "127.0.0.1", "--no-open"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, JUST_USAGE_HOME: home, JUST_USAGE_LOG_DIR: join(home, "logs") },
      stdio: "ignore",
    });
    const deadline = Date.now() + 12_000;
    let healthy = false;
    while (Date.now() < deadline) {
      const info = await fetchHealth(port);
      if (isJustUsageHealth(info)) {
        healthy = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
    expect(healthy).toBe(true);
    const { text, code } = formatStopResults(await stopServers({ port }));
    expect(code).toBe(0);
    expect(text).toContain(`port ${port}`);
    const gone = Date.now() + 4000;
    while (Date.now() < gone && child.exitCode === null) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await fetchHealth(port)).toBeNull();
    child.kill("SIGKILL");
  }, 20_000);
});
