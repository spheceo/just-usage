import { describe, expect, test } from "bun:test";
import { clampPercent, epochToIso, formatDuration, formatResetIn, semverGt, severity, slugify, windowLabel } from "../src/format.ts";
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
    expect(clampPercent(null)).toBeNull();
  });
  test("windowLabel", () => {
    expect(windowLabel(300)).toBe("5h");
    expect(windowLabel(10080)).toBe("Weekly");
    expect(windowLabel(2880)).toBe("2d");
    expect(windowLabel(90)).toBe("90m");
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

describe("server urls", () => {
  test("explicit host yields a single url", () => {
    expect(reachableUrls("127.0.0.1", 5757)).toEqual(["http://127.0.0.1:5757"]);
  });
  test("wildcard host lists loopback, hostname and interfaces", () => {
    const urls = reachableUrls("0.0.0.0", 5757);
    expect(urls[0]).toBe("http://127.0.0.1:5757");
    expect(urls.length).toBeGreaterThanOrEqual(2);
  });
});
