import { describe, expect, test } from "bun:test";
import { snapshot } from "../src/adapters/common.ts";
import { parseRetryAfter } from "../src/adapters/common.ts";
import { CLAUDE_MAX_BACKOFF_MS, ClaudeRefreshGate, LastGoodCache, STALE_LIMIT_MS } from "../src/collect.ts";
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

describe("Claude 429 backoff", () => {
  const limited = (retryAfterMs: number | null = null) => async (account: ResolvedAccount) =>
    snapshot(account, "error", { message: "Rate limited by Anthropic (429).", transient: true, rateLimit: { retryAfterMs } });

  test("repeated 429s wait 20m, 40m, then 60m, and an ok resets the wait", async () => {
    let now = 0;
    let calls = 0;
    const gate = new ClaudeRefreshGate(CLAUDE_REFRESH_INTERVAL_MS, () => now);
    const counted = (f: (a: ResolvedAccount) => Promise<ReturnType<typeof snapshot>>) => async (a: ResolvedAccount) => {
      calls++;
      return f(a);
    };
    const min = 60_000;
    for (const expected of [20, 40, 60, 60]) {
      const before = calls;
      await gate.get(claude, counted(limited()), false);
      expect(calls).toBe(before + 1);
      now += expected * min - 1;
      await gate.get(claude, counted(limited()), false);
      expect(calls).toBe(before + 1);
      now += 1;
    }
    expect(60 * min).toBe(CLAUDE_MAX_BACKOFF_MS);

    await gate.get(claude, counted(async (a) => snapshot(a, "ok")), false);
    const afterOk = calls;
    now += CLAUDE_REFRESH_INTERVAL_MS;
    await gate.get(claude, counted(limited()), false);
    expect(calls).toBe(afterOk + 1);
    now += 20 * min - 1;
    await gate.get(claude, counted(limited()), false);
    expect(calls).toBe(afterOk + 1);
  });

  test("a longer Retry-After wins over the backoff", async () => {
    let now = 0;
    let calls = 0;
    const gate = new ClaudeRefreshGate(CLAUDE_REFRESH_INTERVAL_MS, () => now);
    const fetcher = async (a: ResolvedAccount) => {
      calls++;
      return limited(90 * 60_000)(a);
    };
    await gate.get(claude, fetcher, false);
    now = 89 * 60_000;
    await gate.get(claude, fetcher, false);
    expect(calls).toBe(1);
    now = 90 * 60_000;
    await gate.get(claude, fetcher, false);
    expect(calls).toBe(2);
  });

  test("Retry-After parses seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter(new Date(5_000).toUTCString(), 0)).toBe(5_000);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("last good snapshot", () => {
  const ok = (fetchedAt: string) => ({ ...snapshot(claude, "ok", { windows: [] }), fetchedAt });

  test("transient errors show the last ok result, marked stale", () => {
    const cache = new LastGoodCache(STALE_LIMIT_MS, () => Date.parse("2026-10-21T10:00:00Z"));
    const good = cache.apply(ok("2026-10-21T09:40:00Z"));
    const shown = cache.apply(snapshot({ ...claude, label: "Work" }, "error", { message: "codex fetch timed out after 30s", transient: true }));
    expect(shown.status).toBe("ok");
    expect(shown.fetchedAt).toBe(good.fetchedAt);
    expect(shown.stale).toEqual({ message: "codex fetch timed out after 30s" });
    expect(shown.account.label).toBe("Work");
  });

  test("errors that need the user, and sign-outs, replace the last ok result", () => {
    const cache = new LastGoodCache(STALE_LIMIT_MS, () => Date.parse("2026-10-21T10:00:00Z"));
    cache.apply(ok("2026-10-21T09:40:00Z"));
    expect(cache.apply(snapshot(claude, "error", { message: "Token rejected (401)." })).status).toBe("error");
    // The rejected result also cleared the cache, so a later timeout is shown as-is.
    expect(cache.apply(snapshot(claude, "error", { message: "timed out", transient: true })).status).toBe("error");

    cache.apply(ok("2026-10-21T09:50:00Z"));
    expect(cache.apply(snapshot(claude, "signed_out")).status).toBe("signed_out");
  });

  test("results older than the stale limit are not reused", () => {
    let now = Date.parse("2026-10-21T10:00:00Z");
    const cache = new LastGoodCache(STALE_LIMIT_MS, () => now);
    cache.apply(ok("2026-10-21T10:00:00Z"));
    now += STALE_LIMIT_MS + 1;
    expect(cache.apply(snapshot(claude, "error", { message: "timed out", transient: true })).status).toBe("error");
  });
});
