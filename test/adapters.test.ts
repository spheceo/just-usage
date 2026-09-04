import { describe, expect, test } from "bun:test";
import { normalizeCodexRateLimits } from "../src/adapters/codex.ts";
import { normalizeClaudeUsage } from "../src/adapters/claude.ts";
import { normalizeCursorUsage, normalizeGrokBotUsage, planFromCursorPlanInfo, tokenFromAuthJson } from "../src/adapters/cursor.ts";
import { normalizeOpenCodeUsage } from "../src/adapters/opencode.ts";
import { claudeUsage, claudeUsageLimitsOnly, codexRateLimits, cursorUsage, openCodeUsage } from "./fixtures.ts";

describe("codex", () => {
  test("normalizes both windows, plan, multiple limits and reset credits", () => {
    const n = normalizeCodexRateLimits(codexRateLimits);
    expect(n.plan).toBe("plus");
    expect(n.windows.map((w) => w.id)).toEqual(["codex:primary", "codex:secondary", "spark:primary"]);
    expect(n.windows[0]).toMatchObject({ label: "5h Usage", usedPercent: 31, windowMinutes: 300, kind: "rolling" });
    expect(n.windows[0]!.resetsAt).toBe(new Date(1788537713 * 1000).toISOString());
    expect(n.windows[1]).toMatchObject({ label: "Weekly Usage", usedPercent: 19, windowMinutes: 10080 });
    expect(n.windows[2]!.label).toBe("GPT-5.3-Codex-Spark · 5h Usage");
    expect(n.resetCredits).toMatchObject({ availableCount: 1 });
    expect(n.resetCredits!.credits[0]).toMatchObject({ title: "Full reset (Weekly + 5 hr)", status: "available" });
  });

  test("falls back to rateLimits when rateLimitsByLimitId is absent", () => {
    const { rateLimitsByLimitId: _drop, ...rest } = codexRateLimits;
    const n = normalizeCodexRateLimits(rest);
    expect(n.windows).toHaveLength(2);
    expect(n.windows[0]!.label).toBe("5h Usage");
  });

  test("tolerates garbage", () => {
    expect(normalizeCodexRateLimits(null).windows).toEqual([]);
    expect(normalizeCodexRateLimits({ rateLimits: { primary: { usedPercent: "x" } } }).windows[0]!.usedPercent).toBeNull();
  });
});

describe("claude", () => {
  test("legacy buckets, null buckets skipped, extra usage as cycle", () => {
    const w = normalizeClaudeUsage(claudeUsage);
    expect(w.map((x) => x.id)).toEqual(["five_hour", "seven_day", "seven_day_opus", "extra_usage"]);
    expect(w[0]).toMatchObject({ label: "5h Usage", usedPercent: 6, resetsAt: "2026-04-08T18:59:59.000Z" });
    expect(w[3]).toMatchObject({ kind: "cycle", usedPercent: 12.5, note: "12.50 of 100 credits" });
  });

  test("uses limits[] only when legacy buckets are missing", () => {
    const w = normalizeClaudeUsage(claudeUsageLimitsOnly);
    expect(w).toHaveLength(2);
    expect(w[1]).toMatchObject({ label: "weekly all Usage", usedPercent: 88 });
  });

  test("returns nothing for unknown shapes", () => {
    expect(normalizeClaudeUsage({ hello: 1 })).toEqual([]);
    expect(normalizeClaudeUsage("nope")).toEqual([]);
  });
});

describe("cursor", () => {
  test("cursor models, other models, no total usage, on-demand last", () => {
    const w = normalizeCursorUsage(cursorUsage)!;
    expect(w.map((x) => x.id)).toEqual(["auto", "api", "on_demand"]);
    expect(w[0]).toMatchObject({ label: "Cursor Models", usedPercent: 0, kind: "cycle", resetsAt: "2026-02-14T14:02:14.000Z" });
    expect(w[1]).toMatchObject({ label: "Other Models", usedPercent: 46.4 });
    expect(w[2]).toMatchObject({ usedPercent: 25, note: "$25.00 of $100.00" });
  });

  test("maps Grok Bot as a weekly window and hides accounts with no allowance", () => {
    expect(normalizeGrokBotUsage({
      usagePercent: 12.3,
      hasNonZeroIncludedLimit: true,
      nextResetTimestampUtc: "2026-09-11T00:00:00Z",
    })).toMatchObject({
      id: "grok_bot",
      label: "Weekly Usage",
      group: "Grok Bot",
      usedPercent: 12.3,
      kind: "rolling",
      windowMinutes: 10080,
      resetsAt: "2026-09-11T00:00:00.000Z",
    });
    expect(normalizeGrokBotUsage({ usagePercent: 0, hasNonZeroIncludedLimit: false })).toBeNull();
    expect(normalizeGrokBotUsage({ includedLimitZero: true })).toBeNull();
  });

  test("returns null when there is nothing usable", () => {
    expect(normalizeCursorUsage({ planUsage: { totalPercentUsed: 58 } })).toBeNull();
    expect(normalizeCursorUsage({ planUsage: {} })).toBeNull();
    expect(normalizeCursorUsage(null)).toBeNull();
  });

  test("reads plan name from GetPlanInfo", () => {
    expect(planFromCursorPlanInfo({ planInfo: { planName: "Ultra" } })).toBe("Ultra");
    expect(planFromCursorPlanInfo({ planName: "pro" })).toBe("pro");
    expect(planFromCursorPlanInfo({ planInfo: { planName: 42 } })).toBeNull();
    expect(planFromCursorPlanInfo(null)).toBeNull();
  });

  test("reads accessToken from cursor-agent auth.json", () => {
    expect(tokenFromAuthJson({ accessToken: "tok", refreshToken: "ref" })).toBe("tok");
    expect(tokenFromAuthJson({ accessToken: "" })).toBeNull();
    expect(tokenFromAuthJson({ token: "tok" })).toBeNull();
    expect(tokenFromAuthJson(null)).toBeNull();
  });
});

describe("opencode go", () => {
  test("maps rolling/weekly/monthly and treats rate-limited as 100%", () => {
    const w = normalizeOpenCodeUsage(openCodeUsage);
    expect(w.map((x) => [x.label, x.usedPercent, x.kind])).toEqual([
      ["5h Usage", 4, "rolling"],
      ["Weekly Usage", 100, "rolling"],
      ["Monthly Usage", 1, "cycle"],
    ]);
  });

  test("accepts an unwrapped body", () => {
    expect(normalizeOpenCodeUsage(openCodeUsage.usage)).toHaveLength(3);
    expect(normalizeOpenCodeUsage({})).toEqual([]);
  });
});
