/**
 * Cursor adapter. Single account: whatever `cursor-agent` is logged in as.
 * Quota comes from the dashboard RPC the Cursor app itself uses:
 *   POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
 * Cursor plans are dollar budgets per billing cycle, so this yields "cycle" windows, not 5h/7d.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, epochToIso } from "../format.ts";
import { run, stripAnsi } from "../proc.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const USAGE_URL = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage";

function authFile(): string {
  return process.env.CURSOR_AUTH_FILE ?? join(homedir(), ".cursor", "auth.json");
}

function readAccessToken(): string | null {
  const file = authFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as JsonObject;
    return typeof parsed.accessToken === "string" && parsed.accessToken ? parsed.accessToken : null;
  } catch {
    return null;
  }
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

export async function cursorEmail(): Promise<string | null> {
  const res = await run("cursor-agent", ["status"], { timeoutMs: 15_000 });
  const text = stripAnsi(res.stdout + "\n" + res.stderr);
  const m = text.match(/Logged in as\s+(\S+)/i);
  return m?.[1] ?? null;
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
    const limit = cents(plan.limit);
    const included = cents(plan.includedSpend);
    const bonus = cents(plan.bonusSpend);
    // The included allowance is the real plan meter. totalPercentUsed is a blended
    // figure Cursor only quotes for auto-mode, so it is a fallback, not the headline.
    let used = limit && included !== null ? clampPercent((included / limit) * 100) : null;
    if (used === null) used = clampPercent(plan.totalPercentUsed);
    if (used !== null) {
      const parts: string[] = [];
      if (limit !== null && included !== null) parts.push(`${money(included)} of ${money(limit)} included`);
      if (bonus) parts.push(`${money(bonus)} bonus usage`);
      if (typeof body.displayMessage === "string" && body.displayMessage.trim()) parts.push(body.displayMessage.trim());
      out.push({ id: "included", label: "Included · billing cycle", usedPercent: used, resetsAt: cycleEnd, windowMinutes: null, kind: "cycle", note: parts.join(" · ") || undefined });
    }
    const api = clampPercent(plan.apiPercentUsed);
    if (api !== null) out.push({ id: "api", label: "Named models", usedPercent: api, resetsAt: cycleEnd, windowMinutes: null, kind: "cycle" });
    const auto = clampPercent(plan.autoPercentUsed);
    if (auto !== null) out.push({ id: "auto", label: "Auto models", usedPercent: auto, resetsAt: cycleEnd, windowMinutes: null, kind: "cycle" });
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

// ---- fetch ---------------------------------------------------------------

export async function fetchCursor(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const token = readAccessToken();
    if (!token) return snapshot(account, "signed_out", { message: "Not signed in. Run `cursor-agent login`." });
    const exp = jwtExpiry(token);
    const emailP = cursorEmail().catch(() => null);
    if (exp && exp < Date.now()) {
      return snapshot(account, "error", { email: await emailP, message: "Cursor session expired. Run `cursor-agent login`." });
    }
    const res = await fetchJson(USAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: "{}",
    });
    const email = await emailP;
    if (res.status === 401 || res.status === 403) {
      return snapshot(account, "error", { email, message: `Cursor rejected the session (${res.status}). Run \`cursor-agent login\`.` });
    }
    if (res.status !== 200) {
      return snapshot(account, "error", { email, message: `Cursor usage endpoint returned HTTP ${res.status}.` });
    }
    const windows = normalizeCursorUsage(res.body);
    if (!windows) {
      return snapshot(account, "unsupported", { email, message: "Cursor returned no plan usage for this account (team/enterprise plans are not supported yet)." });
    }
    return snapshot(account, "ok", { email, windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}
