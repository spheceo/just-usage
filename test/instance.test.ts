import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
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

  test("stops a confirmed server on a dedicated port", async () => {
    const script = `const http = require("node:http"); http.createServer((req, res) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ ok: true, name: "just-usage", version: "test", pid: process.pid })); }).listen(${port}, "127.0.0.1");`;
    const child = spawn("node", ["-e", script], {
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

  test("serve rejects an alternate port", () => {
    const result = spawnSync("bun", ["run", "src/cli.ts", "serve", "--port", "5758"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, JUST_USAGE_HOME: home, JUST_USAGE_LOG_DIR: join(home, "logs") },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("serves only on port 5757");
  });

  test("serve refuses an occupied default port even with a different host", async () => {
    const blocker = createServer();
    const listening = await new Promise<boolean>((resolve, reject) => {
      blocker.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") resolve(false);
        else reject(error);
      });
      blocker.listen(5757, "127.0.0.1", () => resolve(true));
    });
    try {
      const result = spawnSync("bun", ["run", "src/cli.ts", "serve", "--host", "127.0.0.1"], {
        cwd: join(import.meta.dir, ".."),
        env: { ...process.env, JUST_USAGE_HOME: home, JUST_USAGE_LOG_DIR: join(home, "logs") },
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Port 5757 is already in use");
      expect(result.stdout).not.toContain("serving on");
    } finally {
      if (listening) await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
