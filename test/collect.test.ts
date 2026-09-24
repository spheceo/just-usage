import { describe, expect, test } from "bun:test";
import { snapshot } from "../src/adapters/common.ts";
import { ClaudeRefreshGate } from "../src/collect.ts";
import { CLAUDE_REFRESH_INTERVAL_MS } from "../src/config.ts";
import type { ResolvedAccount } from "../src/types.ts";

const claude: ResolvedAccount = { id: "claude:default", provider: "claude", label: "Default", kind: "default" };

describe("Claude refresh gate", () => {
  test("automatic checks wait ten minutes after an attempt, including a 429", async () => {
    let now = 0;
    let calls = 0;
    const gate = new ClaudeRefreshGate(CLAUDE_REFRESH_INTERVAL_MS, () => now);
    const fetcher = async (account: ResolvedAccount) => {
      calls++;
      return snapshot(account, calls === 1 ? "error" : "ok", { message: calls === 1 ? "Rate limited (429)." : null });
    };

    const first = await gate.get(claude, fetcher, false);
    now = CLAUDE_REFRESH_INTERVAL_MS - 1;
    expect(await gate.get(claude, fetcher, false)).toBe(first);
    expect(calls).toBe(1);

    now = CLAUDE_REFRESH_INTERVAL_MS;
    const second = await gate.get(claude, fetcher, false);
    expect(second.status).toBe("ok");
    expect(calls).toBe(2);
  });

  test("manual refresh never fetches Claude, even when due or not yet cached", async () => {
    let now = 0;
    let calls = 0;
    const gate = new ClaudeRefreshGate(CLAUDE_REFRESH_INTERVAL_MS, () => now);
    const fetcher = async (account: ResolvedAccount) => {
      calls++;
      return snapshot(account, "ok");
    };

    expect((await gate.get(claude, fetcher, true)).status).toBe("unsupported");
    const first = await gate.get(claude, fetcher, false);
    now = CLAUDE_REFRESH_INTERVAL_MS * 2;
    expect(await gate.get(claude, fetcher, true)).toBe(first);
    expect(calls).toBe(1);
    expect((await gate.get({ ...claude, id: "claude:second" }, fetcher, true)).status).toBe("unsupported");
    expect(calls).toBe(1);
  });

  test("cached accounts keep renamed labels and removed accounts lose their cache", async () => {
    let calls = 0;
    const gate = new ClaudeRefreshGate();
    const fetcher = async (account: ResolvedAccount) => {
      calls++;
      return snapshot(account, "ok");
    };
    await gate.get(claude, fetcher, false);
    const renamed = await gate.get({ ...claude, label: "Work" }, fetcher, true);
    expect(renamed.account.label).toBe("Work");
    expect(calls).toBe(1);
    gate.forget(claude.id);
    await gate.get({ ...claude, label: "Other" }, fetcher, false);
    expect(calls).toBe(2);
  });
});
