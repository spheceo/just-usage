import { describe, expect, test } from "bun:test";
import { accountDisplayName, clampPercent, epochToIso, formatDuration, formatHostname, formatPercent, formatPlan, formatResetIn, isGenericAccountLabel, semverGt, severity, slugify, windowLabel } from "../src/format.ts";
import { detectPackageManager, upgradeCommand } from "../src/update.ts";
import { reachableUrls } from "../src/server.ts";

describe("semver", () => {
  test("compares releases and prereleases", () => {
    expect(semverGt("0.2.0", "0.1.9")).toBe(true);
    expect(semverGt("1.0.0", "1.0.0")).toBe(false);
    expect(semverGt("v1.0.1", "1.0.0")).toBe(true);
    expect(semverGt("1.0.0", "1.0.0-beta.1")).toBe(true);
    expect(semverGt("1.0.0-beta.1", "1.0.0")).toBe(false);
    expect(semverGt("garbage", "1.0.0")).toBe(false);
  });
});

describe("time + percent helpers", () => {
  test("epochToIso handles seconds, millis and strings", () => {
    expect(epochToIso(1788537713)).toBe("2026-09-04T16:01:53.000Z");
    expect(epochToIso("1771077734000")).toBe("2026-02-14T14:02:14.000Z");
    expect(epochToIso(0)).toBeNull();
    expect(epochToIso("soon")).toBeNull();
  });
  test("clampPercent", () => {
    expect(clampPercent(120)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent("42.26")).toBe(42.3);
    expect(clampPercent(0.04)).toBe(0.1);
    expect(clampPercent(99.96)).toBe(99.9);
    expect(clampPercent(null)).toBeNull();
  });
  test("formatPercent keeps tenths instead of rounding to 0 or 100", () => {
    expect(formatPercent(31)).toBe("31%");
    expect(formatPercent(1.3)).toBe("1.3%");
    expect(formatPercent(0.5)).toBe("0.5%");
    expect(formatPercent(99.4)).toBe("99.4%");
    expect(formatPercent(null)).toBe("—");
  });
  test("formatPlan capitalizes the first letter of each word", () => {
    expect(formatPlan("plus")).toBe("Plus");
    expect(formatPlan("go")).toBe("Go");
    expect(formatPlan("api key")).toBe("Api Key");
    expect(formatPlan(null)).toBeNull();
  });
  test("windowLabel", () => {
    expect(windowLabel(300)).toBe("5h Usage");
    expect(windowLabel(10080)).toBe("Weekly Usage");
    expect(windowLabel(2880)).toBe("2d Usage");
    expect(windowLabel(90)).toBe("90m Usage");
  });
  test("durations", () => {
    expect(formatDuration(65 * 60_000)).toBe("1h 5m");
    expect(formatDuration(3 * 86_400_000)).toBe("3d");
    expect(formatDuration(30_000)).toBe("1m");
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(formatResetIn("2026-01-01T02:30:00Z", now)).toBe("resets in 2h 30m");
    expect(formatResetIn("2025-12-31T00:00:00Z", now)).toBe("resetting");
    expect(formatResetIn(null, now)).toBeNull();
  });
  test("severity thresholds", () => {
    expect(severity(10)).toBe("ok");
    expect(severity(60)).toBe("warn");
    expect(severity(84.9)).toBe("warn");
    expect(severity(85)).toBe("crit");
    expect(severity(null)).toBeNull();
  });
  test("formatHostname", () => {
    expect(formatHostname("Siphesihles-MacBook-Air-M4.local")).toBe("Siphesihles MacBook Air M4");
    expect(formatHostname("desk_top")).toBe("desk top");
  });
  test("slugify", () => {
    expect(slugify("Work Account")).toBe("work-account");
    expect(slugify("sphe.g.personal@gmail.com")).toBe("sphe-g-personal");
    expect(slugify("!!!")).toBe("account");
  });
});

describe("upgrade", () => {
  test("detects package manager from install path", () => {
    expect(detectPackageManager("/Users/me/.bun/install/global/node_modules/just-usage/dist/cli.js", "/usr/bin/node")).toBe("bun");
    expect(detectPackageManager("/usr/local/lib/node_modules/just-usage/dist/cli.js", "/usr/local/bin/node")).toBe("npm");
    expect(detectPackageManager("/Users/me/Library/pnpm/global/5/.pnpm/just-usage/dist/cli.js", "/usr/bin/node")).toBe("pnpm");
  });
  test("builds the right command", () => {
    expect(upgradeCommand("npm", "1.2.3")).toEqual(["npm", ["install", "-g", "just-usage@1.2.3"]]);
    expect(upgradeCommand("bun")).toEqual(["bun", ["add", "-g", "just-usage@latest"]]);
  });
});

describe("account titles", () => {
  test("Default stays Default; first extra without a name is Account 2", () => {
    expect(isGenericAccountLabel("go")).toBe(true);
    expect(isGenericAccountLabel("alt")).toBe(false);
    expect(accountDisplayName({ kind: "default", label: "Default", email: "a@b.com", index: 0, showEmail: false })).toBe("Default");
    expect(accountDisplayName({ kind: "token", label: "go", email: null, index: 1, showEmail: false })).toBe("Account 2");
    expect(accountDisplayName({ kind: "token", label: "alt", email: null, index: 1, showEmail: false })).toBe("alt");
    expect(accountDisplayName({ kind: "default", label: "Default", email: "a@b.com", index: 0, showEmail: true })).toBe("a@b.com");
    expect(accountDisplayName({ kind: "default", label: "Default", email: "a@b.com", index: 0, showEmail: false, alias: "Home" })).toBe("Home");
  });
});

describe("server urls", () => {
  test("explicit host yields a single url", () => {
    expect(reachableUrls("127.0.0.1", 5757)).toEqual([{ kind: "local", url: "http://127.0.0.1:5757" }]);
  });
  test("wildcard host lists loopback, hostname and interfaces", () => {
    const urls = reachableUrls("0.0.0.0", 5757, null);
    expect(urls[0]).toEqual({ kind: "local", url: "http://127.0.0.1:5757" });
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.some((u) => u.kind === "tailscale")).toBe(false);
  });
  test("tailscale url is listed only when the CLI is authed", () => {
    const urls = reachableUrls("0.0.0.0", 5757, "100.65.58.114");
    expect(urls.some((u) => u.kind === "tailscale" && u.url === "http://100.65.58.114:5757")).toBe(true);
  });
});
