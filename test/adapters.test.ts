import { describe, expect, test } from "bun:test";
import { normalizeCodexRateLimits } from "../src/adapters/codex.ts";
import { normalizeClaudeUsage } from "../src/adapters/claude.ts";
import { normalizeCursorUsage, normalizeGrokBotUsage, planFromCursorPlanInfo, tokenFromAuthJson } from "../src/adapters/cursor.ts";
import { normalizeAntigravityQuota, parseAgyKeyringBlob, planFromCodeAssist } from "../src/adapters/antigravity.ts";
import { normalizeGrokCredits, planFromGrokSettings, sessionFromAuthJson } from "../src/adapters/grok.ts";
import { normalizeOpenCodeUsage } from "../src/adapters/opencode.ts";
import { normalizeDevinUserStatus, parseDevinCredentialsToml } from "../src/adapters/devin.ts";
import { normalizeCommandCodeQuota, planFromCommandCodeSub } from "../src/adapters/commandcode.ts";
import { antigravityQuota, claudeUsage, claudeUsageLimitsOnly, codexRateLimits, commandcodeUsage, cursorUsage, devinUserStatus, devinUserStatusAcu, grokCreditsFree, grokCreditsSubscribed, openCodeUsage } from "./fixtures.ts";

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

describe("antigravity", () => {
  test("turns remainingFraction into used windows grouped by family, 5h before weekly", () => {
    const w = normalizeAntigravityQuota(antigravityQuota);
    expect(w.map((x) => x.id)).toEqual(["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"]);
    expect(w[0]).toMatchObject({ label: "5h Usage", usedPercent: 75, windowMinutes: 300, kind: "rolling", resetsAt: "2026-09-04T23:40:30.000Z" });
    expect(w[0]!.group).toBeUndefined();
    expect(w[1]).toMatchObject({ label: "Weekly Usage", usedPercent: 20, windowMinutes: 10080 });
    expect(w[2]).toMatchObject({ usedPercent: 100, group: "Claude and GPT models" });
    expect(w[3]).toMatchObject({ usedPercent: 0 });
  });

  test("skips disabled buckets and unknown shapes", () => {
    expect(normalizeAntigravityQuota({ groups: [{ buckets: [{ remainingFraction: 0.5, disabled: true }] }] })).toEqual([]);
    expect(normalizeAntigravityQuota({})).toEqual([]);
    expect(normalizeAntigravityQuota(null)).toEqual([]);
  });

  test("reads Google AI plan from paidTier, not the Antigravity product name", () => {
    expect(planFromCodeAssist({
      currentTier: { id: "free-tier", name: "Antigravity" },
      paidTier: { id: "g1-pro-tier", name: "Google AI Pro" },
    })).toBe("Pro");
    expect(planFromCodeAssist({
      currentTier: { id: "free-tier", name: "Antigravity" },
      paidTier: { id: "g1-ultra-tier", name: "Google AI Ultra" },
    })).toBe("Ultra");
    expect(planFromCodeAssist({ currentTier: { id: "free-tier", name: "Antigravity" } })).toBe("Free");
    expect(planFromCodeAssist({ currentTier: { id: "g1-pro-tier", name: "Google AI Pro" } })).toBe("Pro");
  });

  test("reads go-keyring blobs", () => {
    const raw = "go-keyring-base64:" + Buffer.from(JSON.stringify({
      token: { access_token: "ya29.abc", refresh_token: "1//xyz", expiry: "2026-09-04T21:40:07.158017+02:00", token_type: "Bearer" },
      auth_method: "consumer",
    })).toString("base64");
    const parsed = parseAgyKeyringBlob(raw);
    expect(parsed?.accessToken).toBe("ya29.abc");
    expect(parsed?.refreshToken).toBe("1//xyz");
    expect(parsed?.expiry).toBe(Date.parse("2026-09-04T21:40:07.158017+02:00"));
  });

  test("reads the oauth token file agy writes on disk", () => {
    const parsed = parseAgyKeyringBlob(JSON.stringify({
      token: { access_token: "ya29.file", refresh_token: "1//file", expiry: "2026-09-04T21:40:07.158017+02:00", token_type: "Bearer" },
      auth_method: "consumer",
    }));
    expect(parsed?.accessToken).toBe("ya29.file");
    expect(parsed?.refreshToken).toBe("1//file");
  });
});

describe("grok", () => {
  test("maps weekly percent and on-demand when a pool exists", () => {
    const w = normalizeGrokCredits(grokCreditsSubscribed);
    expect(w.map((x) => x.id)).toEqual(["weekly", "on_demand"]);
    expect(w[0]).toMatchObject({
      label: "Weekly Usage",
      usedPercent: 37.5,
      windowMinutes: 10080,
      kind: "rolling",
      resetsAt: "2026-09-07T08:29:53.299Z",
    });
    expect(w[1]).toMatchObject({ usedPercent: 25, note: "$12.50 of $50" });
  });

  test("does not invent a 0% bar when signed in with no allowance", () => {
    expect(normalizeGrokCredits(grokCreditsFree)).toEqual([]);
    expect(normalizeGrokCredits({})).toEqual([]);
    expect(normalizeGrokCredits(null)).toEqual([]);
  });

  test("reads plan from remote settings and OIDC auth.json", () => {
    expect(planFromGrokSettings({ subscription_tier_display: "SuperGrok Heavy" })).toBe("SuperGrok Heavy");
    expect(planFromGrokSettings({ subscription_tier: "supergrok_plus" })).toBe("SuperGrok Plus");
    expect(planFromGrokSettings({ subscription_tier: "custom_tier" })).toBe("custom tier");
    expect(planFromGrokSettings({})).toBeNull();
    const session = sessionFromAuthJson({
      "https://auth.x.ai::client": {
        key: "access-token",
        refresh_token: "refresh-token",
        auth_mode: "oidc",
        email: "dev@example.com",
        oidc_client_id: "client",
        expires_at: "2026-09-05T01:00:00.000Z",
      },
    });
    expect(session).toMatchObject({ accessToken: "access-token", email: "dev@example.com", authMode: "oidc" });
    expect(sessionFromAuthJson({ auth_mode: "oidc" })).toBeNull();
  });
});

describe("commandcode", () => {
  test("maps 5h/weekly window limits then the monthly pool", () => {
    const n = normalizeCommandCodeQuota(commandcodeUsage);
    expect(n.plan).toBe("GOAT");
    expect(n.windows.map((w) => w.id)).toEqual(["five_hour", "weekly", "monthly"]);
    expect(n.windows[0]).toMatchObject({ label: "5h Usage", usedPercent: 16, windowMinutes: 300, kind: "rolling", note: "$2.24 of $14" });
    expect(n.windows[0]!.resetsAt).toBe(new Date(1789653280343).toISOString());
    expect(n.windows[1]).toMatchObject({ label: "Weekly Usage", usedPercent: 6.4, windowMinutes: 10080, note: "$2.24 of $35" });
    expect(n.windows[2]).toMatchObject({
      label: "Monthly Usage",
      usedPercent: 3.2,
      kind: "cycle",
      resetsAt: "2026-10-17T08:45:42.000Z",
      note: "$2.24 of $70",
    });
  });

  test("skips window limits when the account is not limited", () => {
    const n = normalizeCommandCodeQuota({
      ...commandcodeUsage,
      credits: { ...commandcodeUsage.credits, windowLimits: { limited: false } },
    });
    expect(n.windows.map((w) => w.id)).toEqual(["monthly"]);
  });

  test("falls back to spent+remaining pool when the plan is unknown or inactive", () => {
    const n = normalizeCommandCodeQuota({
      ...commandcodeUsage,
      subscription: { success: true, data: { status: "canceled", planId: "mystery" } },
    });
    expect(n.plan).toBeNull();
    // pool = spent (1.51) + remaining (67.76) → 69.27; used = 1.51 → ~2.2%
    expect(n.windows.find((w) => w.id === "monthly")).toMatchObject({ usedPercent: 2.2, resetsAt: null });
  });

  test("reads plan names from the planId prefix table", () => {
    expect(planFromCommandCodeSub("individual-goat")).toMatchObject({ name: "GOAT", monthlyCredits: 70 });
    expect(planFromCommandCodeSub("individual_pro_v1")).toMatchObject({ name: "Pro", monthlyCredits: 80 });
    expect(planFromCommandCodeSub("teams-pro")).toMatchObject({ name: "Teams Pro", monthlyCredits: 40 });
    expect(planFromCommandCodeSub("mystery")).toBeNull();
    expect(planFromCommandCodeSub(null)).toBeNull();
  });

  test("returns nothing usable for garbage", () => {
    expect(normalizeCommandCodeQuota({ credits: null, subscription: null, summary: null }).windows).toEqual([]);
    expect(normalizeCommandCodeQuota({ credits: { credits: {} }, subscription: null, summary: null }).windows).toEqual([]);
  });
});

describe("devin", () => {
  test("maps daily/weekly remaining percents to used windows plus on-demand balance", () => {
    const n = normalizeDevinUserStatus(devinUserStatus);
    expect(n.email).toBe("dev@example.com");
    expect(n.plan).toBe("Pro");
    expect(n.windows.map((w) => w.id)).toEqual(["daily", "weekly", "overage"]);
    expect(n.windows[0]).toMatchObject({ label: "Daily Usage", usedPercent: 37.5, windowMinutes: 1440, kind: "rolling" });
    expect(n.windows[0]!.resetsAt).toBe(new Date(1789113600 * 1000).toISOString());
    expect(n.windows[1]).toMatchObject({ label: "Weekly Usage", usedPercent: 79, windowMinutes: 10080 });
    expect(n.windows[2]).toMatchObject({ label: "On-demand", usedPercent: null, note: "$7.46 balance" });
  });

  test("a missing remaining percent with a reset time means the window is exhausted", () => {
    const n = normalizeDevinUserStatus({
      userStatus: { planStatus: { dailyQuotaResetAtUnix: "1789113600" } },
    });
    expect(n.windows[0]).toMatchObject({ id: "daily", usedPercent: 100 });
  });

  test("falls back to the ACU window for credits-billed accounts", () => {
    const n = normalizeDevinUserStatus(devinUserStatusAcu);
    expect(n.email).toBe("credits@example.com");
    expect(n.plan).toBe("Team");
    expect(n.windows.map((w) => w.id)).toEqual(["acu"]);
    expect(n.windows[0]).toMatchObject({ usedPercent: 28, kind: "cycle", resetsAt: "2026-10-10T17:44:23.000Z", note: "140 of 500 ACUs" });
  });

  test("returns nothing usable for signed-out or unknown shapes", () => {
    expect(normalizeDevinUserStatus(null).windows).toEqual([]);
    expect(normalizeDevinUserStatus({}).windows).toEqual([]);
    expect(normalizeDevinUserStatus({ userStatus: { email: "a@b.c" } })).toMatchObject({ email: "a@b.c", windows: [] });
  });

  test("parses credentials.toml", () => {
    const parsed = parseDevinCredentialsToml(
      'windsurf_api_key = "devin-session-token$abc"\napi_server_url = "https://server.codeium.com"\n# comment\n',
    );
    expect(parsed.windsurf_api_key).toBe("devin-session-token$abc");
    expect(parsed.api_server_url).toBe("https://server.codeium.com");
    expect(parseDevinCredentialsToml("")).toEqual({});
  });
});
