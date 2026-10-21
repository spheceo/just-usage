import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fetchCodex } from "../src/adapters/codex.ts";
import { processAlive } from "../src/instance.ts";
import { stopAllChildren, trackedChildren } from "../src/proc.ts";
import type { ResolvedAccount } from "../src/types.ts";

const fakeBin = join(import.meta.dir, "fake-codex");
const account: ResolvedAccount = { id: "codex:default", provider: "codex", label: "Default", kind: "default" };
const saved = { PATH: process.env.PATH, pids: process.env.FAKE_CODEX_PIDS, mode: process.env.FAKE_CODEX_MODE };
let pidDir = "";

function recorded(): number[] {
  return readdirSync(pidDir).map((f) => Number(f.split("-")[1]));
}
function alive(): number[] {
  return recorded().filter(processAlive);
}
async function until(check: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for fake codex");
    await Bun.sleep(25);
  }
}

beforeEach(() => {
  pidDir = mkdtempSync(join(tmpdir(), "just-usage-codex-"));
  process.env.PATH = `${fakeBin}${delimiter}${saved.PATH}`;
  process.env.FAKE_CODEX_PIDS = pidDir;
});

afterEach(async () => {
  await stopAllChildren(100);
  for (const pid of alive()) process.kill(pid, "SIGKILL");
  process.env.PATH = saved.PATH;
  if (saved.pids === undefined) delete process.env.FAKE_CODEX_PIDS;
  else process.env.FAKE_CODEX_PIDS = saved.pids;
  if (saved.mode === undefined) delete process.env.FAKE_CODEX_MODE;
  else process.env.FAKE_CODEX_MODE = saved.mode;
  rmSync(pidDir, { recursive: true, force: true });
});

describe("codex app-server lifecycle", () => {
  test("healthy refreshes leave no app-server behind", async () => {
    delete process.env.FAKE_CODEX_MODE;
    for (let i = 0; i < 5; i++) {
      const snap = await fetchCodex(account, { timeoutMs: 5000, killGraceMs: 300 });
      expect(snap.status).toBe("ok");
      expect(alive()).toEqual([]);
    }
    expect(recorded().length).toBe(10); // wrapper + native per refresh
    expect(trackedChildren()).toBe(0);
  }, 30_000);

  test("wedged app-servers that ignore SIGTERM are killed with their native child", async () => {
    process.env.FAKE_CODEX_MODE = "hang";
    const refreshes = 4;
    for (let i = 0; i < refreshes; i++) {
      // Long enough for wrapper + native to come up even on a loaded machine.
      const pending = fetchCodex(account, { timeoutMs: 8000, killGraceMs: 200 });
      await until(() => recorded().length === (i + 1) * 2);
      expect(alive().length).toBe(2);
      const snap = await pending;
      expect(snap.status).toBe("error");
      expect(snap.message).toContain("timed out");
      expect(alive()).toEqual([]);
    }
    expect(recorded().length).toBe(refreshes * 2);
    expect(trackedChildren()).toBe(0);
  }, 60_000);

  test("SIGTERM exits serve and takes wedged app-servers with it", async () => {
    const harness = spawn(process.execPath, ["run", join(fakeBin, "serve-harness.ts")], {
      env: { ...process.env, FAKE_CODEX_MODE: "hang" },
      stdio: "ignore",
    });
    try {
      await until(() => alive().length === 2);
      const started = Date.now();
      harness.kill("SIGTERM");
      const code = await new Promise<number | null>((resolve) => harness.once("exit", (c) => resolve(c)));
      expect(code).toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(alive()).toEqual([]);
    } finally {
      harness.kill("SIGKILL");
    }
  }, 60_000);
});
