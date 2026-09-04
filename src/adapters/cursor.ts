/**
 * Cursor adapter. Single account: whatever `cursor-agent` is logged in as.
 * Quota comes from the dashboard RPC the Cursor app itself uses:
 *   POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 * Cursor plans are dollar budgets per billing cycle, so this yields "cycle" windows, not 5h/7d.
 *
 * `cursor-agent login` stores the session in the macOS Keychain (service
 * `cursor-access-token`). The file store (`~/.cursor/auth.json` and the Linux /
 * Windows equivalents) is a fallback for non-macOS and older installs.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, epochToIso, isoOrNull } from "../format.ts";
import { run } from "../proc.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";
const GROK_BOT_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetSandUsageStatus";
const PLAN_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo";
const KEYCHAIN_ACCOUNT = "cursor-user";
const KEYCHAIN_SERVICE = "cursor-access-token";

/** Pull `accessToken` out of a cursor-agent auth.json body. */
export function tokenFromAuthJson(parsed: unknown): string | null {
  if (!isObject(parsed)) return null;
  return typeof parsed.accessToken === "string" && parsed.accessToken ? parsed.accessToken : null;
}

function tokenFromAuthFile(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return tokenFromAuthJson(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function authFiles(): string[] {
  const home = homedir();
  const out: string[] = [];
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || join(home, "AppData", "Roaming");
    out.push(join(roaming, "Cursor", "auth.json"));
  } else if (process.platform !== "darwin") {
    const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
    out.push(join(xdg, "cursor", "auth.json"));
  }
  out.push(join(home, ".cursor", "auth.json"));
  return out;
}

async function tokenFromKeychain(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  const res = await run("security", ["find-generic-password", "-a", KEYCHAIN_ACCOUNT, "-s", KEYCHAIN_SERVICE, "-w"], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  const v = res.stdout.replace(/\r?\n$/, "");
  return v || null;
}

/** Session token `cursor-agent` is currently using. Never logged or written back. */
export async function readCursorAccessToken(): Promise<string | null> {
  const env = process.env.CURSOR_AUTH_TOKEN?.trim();
  if (env) return env;
  if (process.env.CURSOR_AUTH_FILE) {
    const fromFile = tokenFromAuthFile(process.env.CURSOR_AUTH_FILE);
    if (fromFile) return fromFile;
  }
  const fromKeychain = await tokenFromKeychain();
  if (fromKeychain) return fromKeychain;
  if (process.env.CURSOR_AUTH_FILE) return null;
  for (const file of authFiles()) {
    const fromFile = tokenFromAuthFile(file);
    if (fromFile) return fromFile;
  }
  return null;
}

function jwtExpiry(token: string): number | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as JsonObject;
    return typeof claims.exp === "number" ? claims.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ---- normalization -------------------------------------------------------

function cents(v: unknown): number | null {
  if (typeof v === "string" && v.trim()) v = Number(v);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function money(c: number): string {
  return `$${(c / 100).toFixed(2)}`;
}

/** Normalize `GetCurrentPeriodUsage`. Returns null when the payload has no usable plan usage. */
export function normalizeCursorUsage(body: unknown): QuotaWindow[] | null {
  if (!isObject(body)) return null;
  const cycleEnd = epochToIso(body.billingCycleEnd);
  const out: QuotaWindow[] = [];

  const plan = isObject(body.planUsage) ? body.planUsage : null;
  if (plan) {
    const auto = clampPercent(plan.autoPercentUsed);
    if (auto !== null) out.push({ id: "auto", label: "Cursor Models", usedPercent: auto, resetsAt: cycleEnd, windowMinutes: null, kind: "cycle" });
    const api = clampPercent(plan.apiPercentUsed);
    if (api !== null) out.push({ id: "api", label: "Other Models", usedPercent: api, resetsAt: cycleEnd, windowMinutes: null, kind: "cycle" });
  }

  const spend = isObject(body.spendLimitUsage) ? body.spendLimitUsage : null;
  if (spend) {
    const indLimit = cents(spend.individualLimit);
    const indUsed = cents(spend.individualUsed);
    if (indLimit && indUsed !== null) {
      out.push({
        id: "on_demand",
        label: "On-demand",
        usedPercent: clampPercent((indUsed / indLimit) * 100),
        resetsAt: cycleEnd,
        windowMinutes: null,
        kind: "cycle",
        note: `${money(indUsed)} of ${money(indLimit)}`,
      });
    }
    const poolLimit = cents(spend.pooledLimit);
    const poolUsed = cents(spend.pooledUsed);
    if (poolLimit && poolUsed !== null) {
      out.push({
        id: "pooled",
        label: "Team pool",
        usedPercent: clampPercent((poolUsed / poolLimit) * 100),
        resetsAt: cycleEnd,
        windowMinutes: null,
        kind: "cycle",
        note: `${money(poolUsed)} of ${money(poolLimit)}`,
      });
    }
  }
  return out.length ? out : null;
}

/** Normalize `GetSandUsageStatus`. Hidden when the account has no personal Grok Bot allowance. */
export function normalizeGrokBotUsage(body: unknown): QuotaWindow | null {
  if (!isObject(body)) return null;
  const src = isObject(body.usage) ? body.usage : body;
  if (src.usesPooledEnterpriseAllowance === true) return null;
  if (src.hasNonZeroIncludedLimit === false) return null;
  if (src.includedLimitZero === true) return null;
  const used = clampPercent(src.usagePercent);
  if (used === null) return null;
  return {
    id: "grok_bot",
    label: "Weekly Usage",
    group: "Grok Bot",
    usedPercent: used,
    resetsAt: isoOrNull(src.nextResetTimestampUtc) ?? epochToIso(src.nextResetTimestampUtc),
    windowMinutes: 10080,
    kind: "rolling",
  };
}

function insertGrokBot(windows: QuotaWindow[], grok: QuotaWindow): QuotaWindow[] {
  const extra = windows.findIndex((w) => w.id === "on_demand" || w.id === "pooled");
  if (extra === -1) return [...windows, grok];
  return [...windows.slice(0, extra), grok, ...windows.slice(extra)];
}

/** Plan name from `GetPlanInfo`, e.g. Ultra / Pro. */
export function planFromCursorPlanInfo(body: unknown): string | null {
  if (!isObject(body)) return null;
  const info = isObject(body.planInfo) ? body.planInfo : body;
  return typeof info.planName === "string" && info.planName.trim() ? info.planName.trim() : null;
}

// ---- fetch ---------------------------------------------------------------

export async function fetchCursor(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const token = await readCursorAccessToken();
    if (!token) return snapshot(account, "signed_out", { message: "Not signed in. Run `cursor-agent login`." });
    const exp = jwtExpiry(token);
    if (exp && exp < Date.now()) {
      return snapshot(account, "error", { email: account.email ?? null, message: "Cursor session expired. Run `cursor-agent login`." });
    }
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    };
    const extra = {
      method: "POST" as const,
      headers,
      body: "{}",
    };
    const grokReq = fetchJson(GROK_BOT_URL, extra).catch(() => null);
    const planReq = fetchJson(PLAN_URL, extra).catch(() => null);
    const res = await fetchJson(USAGE_URL, extra);
    const email = account.email ?? null;
    if (res.status === 401 || res.status === 403) {
      return snapshot(account, "error", { email, message: `Cursor rejected the session (${res.status}). Run \`cursor-agent login\`.` });
    }
    if (res.status !== 200) {
      return snapshot(account, "error", { email, message: `Cursor usage endpoint returned HTTP ${res.status}.` });
    }
    let windows = normalizeCursorUsage(res.body);
    if (!windows) {
      return snapshot(account, "unsupported", { email, message: "Cursor returned no plan usage for this account (team/enterprise plans are not supported yet)." });
    }
    const [grokRes, planRes] = await Promise.all([grokReq, planReq]);
    if (grokRes?.status === 200) {
      const grok = normalizeGrokBotUsage(grokRes.body);
      if (grok) windows = insertGrokBot(windows, grok);
    }
    const plan = planRes?.status === 200 ? planFromCursorPlanInfo(planRes.body) : null;
    return snapshot(account, "ok", { email, plan, windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}
