import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log, logDir, logError, logFile, sanitizeFields } from "../src/log.ts";

const dir = mkdtempSync(join(tmpdir(), "just-usage-logs-"));
process.env.JUST_USAGE_LOG_DIR = dir;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("sanitizeFields", () => {
  test("drops secrets and callback URLs, keeps safe fields", () => {
    expect(
      sanitizeFields({
        account: "claude:work",
        status: "ok",
        token: "sk-secret",
        secret: "abc",
        apiKey: "key",
        url: "http://localhost:1455/callback?code=abc",
        authUrl: "https://example.com/oauth",
        message: "timed out",
        windows: 2,
      }),
    ).toEqual({
      account: "claude:work",
      status: "ok",
      message: "timed out",
      windows: 2,
    });
  });

  test("clips long strings", () => {
    const message = "x".repeat(500);
    expect((sanitizeFields({ message }) as { message: string }).message).toHaveLength(401);
  });
});

describe("log", () => {
  test("writes JSON lines under JUST_USAGE_LOG_DIR", () => {
    expect(logDir()).toBe(dir);
    log("info", "test.event", { account: "codex:default", token: "nope" });
    const raw = readFileSync(logFile(), "utf8").trim().split("\n").pop()!;
    const row = JSON.parse(raw) as Record<string, unknown>;
    expect(row.event).toBe("test.event");
    expect(row.level).toBe("info");
    expect(row.account).toBe("codex:default");
    expect(row.token).toBeUndefined();
    expect(typeof row.ts).toBe("string");
    expect(typeof row.pid).toBe("number");
    expect(typeof row.v).toBe("string");
  });

  test("logError records the message", () => {
    logError("test.fail", new Error("boom"), { command: "serve" });
    const raw = readFileSync(logFile(), "utf8").trim().split("\n").pop()!;
    const row = JSON.parse(raw) as Record<string, unknown>;
    expect(row.event).toBe("test.fail");
    expect(row.level).toBe("error");
    expect(row.message).toBe("boom");
    expect(row.command).toBe("serve");
  });
});
