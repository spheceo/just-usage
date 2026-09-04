import { describe, expect, test } from "bun:test";
import { normalizeCodexRateLimits } from "../src/adapters/codex.ts";
import { normalizeClaudeUsage } from "../src/adapters/claude.ts";
import { normalizeCursorUsage } from "../src/adapters/cursor.ts";
import { normalizeOpenCodeUsage } from "../src/adapters/opencode.ts";
import { claudeUsage, claudeUsageLimitsOnly, codexRateLimits, cursorUsage, openCodeUsage } from "./fixtures.ts";

describe("codex", () => {
  test("normalizes both windows, plan, multiple limits and reset credits", () => {
    const n = normalizeCodexRateLimits(codexRateLimits);
    expect(n.plan).toBe("plus");
    expect(n.windows.map((w) => w.id)).toEqual(["codex:primary", "codex:secondary", "spark:primary"]);
    expect(n.windows[0]).toMatchObject({ label: "5h", usedPercent: 31, windowMinutes: 300, kind: "rolling" });
    expect(n.windows[0]!.resetsAt).toBe(new Date(1788537713 * 1000).toISOString());
    expect(n.windows[1]).toMatchObject({ label: "Weekly", usedPercent: 19, windowMinutes: 10080 });
    expect(n.windows[2]!.label).toBe("GPT-5.3-Codex-Spark · 5h");
    expect(n.resetCredits).toMatchObject({ availableCount: 1 });
    expect(n.resetCredits!.credits[0]).toMatchObject({ title: "Full reset (Weekly + 5 hr)", status: "available" });
  });

  test("falls back to rateLimits when rateLimitsByLimitId is absent", () => {
    const { rateLimitsByLimitId: _drop, ...rest } = codexRateLimits;
    const n = normalizeCodexRateLimits(rest);
    expect(n.windows).toHaveLength(2);
    expect(n.windows[0]!.label).toBe("5h");
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
    expect(w[0]).toMatchObject({ label: "5h", usedPercent: 6, resetsAt: "2026-04-08T18:59:59.000Z" });
    expect(w[3]).toMatchObject({ kind: "cycle", usedPercent: 12.5, note: "12.50 of 100 credits" });
  });

  test("uses limits[] only when legacy buckets are missing", () => {
    const w = normalizeClaudeUsage(claudeUsageLimitsOnly);
    expect(w).toHaveLength(2);
    expect(w[1]).toMatchObject({ label: "weekly all", usedPercent: 88 });
  });

  test("returns nothing for unknown shapes", () => {
    expect(normalizeClaudeUsage({ hello: 1 })).toEqual([]);
    expect(normalizeClaudeUsage("nope")).toEqual([]);
  });
});

describe("cursor", () => {
  test("included allowance, per-bucket meters and on-demand as billing-cycle windows", () => {
    const w = normalizeCursorUsage(cursorUsage)!;
    expect(w.map((x) => x.id)).toEqual(["included", "api", "auto", "on_demand"]);
    expect(w[0]).toMatchObject({ kind: "cycle", usedPercent: 58.1, resetsAt: "2026-02-14T14:02:14.000Z" });
    expect(w[0]!.note).toBe("$232.22 of $400.00 included");
    expect(w[1]).toMatchObject({ label: "Named models", usedPercent: 46.4 });
    expect(w[2]).toMatchObject({ label: "Auto models", usedPercent: 0 });
    expect(w[3]).toMatchObject({ usedPercent: 25, note: "$25.00 of $100.00" });
  });

  test("exhausted allowance reads 100% and surfaces Cursor's message and bonus", () => {
    const w = normalizeCursorUsage({
      ...cursorUsage,
      displayMessage: "You've hit your usage limit",
      planUsage: { ...cursorUsage.planUsage, includedSpend: 40000, bonusSpend: 33655, totalPercentUsed: 21 },
    })!;
    expect(w[0]!.usedPercent).toBe(100);
    expect(w[0]!.note).toBe("$400.00 of $400.00 included · $336.55 bonus usage · You've hit your usage limit");
  });

  test("falls back to totalPercentUsed when there is no limit", () => {
    const { limit: _drop, ...plan } = cursorUsage.planUsage;
    const w = normalizeCursorUsage({ ...cursorUsage, planUsage: plan, spendLimitUsage: undefined })!;
    expect(w[0]!.usedPercent).toBe(58.1);
    expect(w[0]!.note).toBeUndefined();
  });

  test("returns null when there is nothing usable", () => {
    expect(normalizeCursorUsage({ planUsage: {} })).toBeNull();
    expect(normalizeCursorUsage(null)).toBeNull();
  });
});

describe("opencode go", () => {
  test("maps rolling/weekly/monthly and treats rate-limited as 100%", () => {
    const w = normalizeOpenCodeUsage(openCodeUsage);
    expect(w.map((x) => [x.label, x.usedPercent, x.kind])).toEqual([
      ["5h", 4, "rolling"],
      ["Weekly", 100, "rolling"],
      ["Monthly", 1, "cycle"],
    ]);
  });

  test("accepts an unwrapped body", () => {
    expect(normalizeOpenCodeUsage(openCodeUsage.usage)).toHaveLength(3);
    expect(normalizeOpenCodeUsage({})).toEqual([]);
  });
});
