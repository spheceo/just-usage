/**
 * Devin (`devin`) adapter. Single account: whatever `devin auth login` stored.
 * There is no `devin usage` command — quota is the same Connect-RPC the TUI `/usage` panel uses:
 *   POST {api_server_url}/exa.seat_management_pb.SeatManagementService/GetUserStatus
 *
 * Default credentials: `credentials.toml` under the Devin data dir
 * ($XDG_DATA_HOME/devin or ~/.local/share/devin; %LOCALAPPDATA%/devin on Windows).
 * The file carries a `windsurf_api_key` session token; `WINDSURF_API_KEY` /
 * `WINDSURF_API_SERVER_URL` env vars override it (the same vars `devin acp` reads).
 *
 * Quota-billed accounts report daily/weekly remaining percents + reset times.
 * Credit-billed accounts report acuConsumed/acuLimit or prompt credits instead.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, epochToIso, isoOrNull } from "../format.ts";
import { binVersion } from "../proc.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const DEFAULT_API_SERVER = "https://server.codeium.com";
const USER_STATUS_PATH = "/exa.seat_management_pb.SeatManagementService/GetUserStatus";
const FALLBACK_CLI_VERSION = "3000.10.0";

export interface DevinCredentials {
  apiKey: string;
  apiServerUrl: string;
}

/** Flat `key = "value"` TOML — credentials.toml has no tables. */
export function parseDevinCredentialsToml(text: string): JsonObject {
  const out: JsonObject = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_.]+)\s*=\s*"([^"]*)"\s*(?:#.*)?$/);
    if (m) out[m[1]!] = m[2];
  }
  return out;
}

function credentialsPaths(): string[] {
  const home = homedir();
  const xdg = process.env.XDG_DATA_HOME;
  const data = xdg && xdg.trim() ? xdg : join(home, ".local", "share");
  const out = [
    join(data, "devin", "credentials.toml"),
    join(home, ".local", "share", "devin", "credentials.toml"),
    join(home, "Library", "Application Support", "devin", "credentials.toml"),
  ];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA;
    if (local) out.unshift(join(local, "devin", "credentials.toml"));
  }
  return [...new Set(out)];
}

function credentialsFromToml(parsed: unknown): DevinCredentials | null {
  if (!isObject(parsed)) return null;
  const apiKey = typeof parsed.windsurf_api_key === "string" ? parsed.windsurf_api_key.trim() : "";
  if (!apiKey) return null;
  const server = typeof parsed.api_server_url === "string" ? parsed.api_server_url.trim() : "";
  return { apiKey, apiServerUrl: server.replace(/\/+$/, "") || DEFAULT_API_SERVER };
}

/** Session token `devin` is currently using. Never logged or written back. */
export function readDevinCredentials(): DevinCredentials | null {
  const envKey = process.env.WINDSURF_API_KEY?.trim();
  if (envKey) {
    const envServer = process.env.WINDSURF_API_SERVER_URL?.trim();
    return { apiKey: envKey, apiServerUrl: envServer?.replace(/\/+$/, "") || DEFAULT_API_SERVER };
  }
  for (const file of credentialsPaths()) {
    if (!existsSync(file)) continue;
    try {
      const creds = credentialsFromToml(parseDevinCredentialsToml(readFileSync(file, "utf8")));
      if (creds) return creds;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// ---- normalization -------------------------------------------------------

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function money(micros: number): string {
  const d = micros / 1e6;
  return `$${d.toFixed(2)}`;
}

const TIER_NAMES: Record<string, string> = {
  TEAMS_TIER_DEVIN_FREE: "Devin Free",
  TEAMS_TIER_DEVIN_PRO: "Devin Pro",
  TEAMS_TIER_DEVIN_MAX: "Devin Max",
  TEAMS_TIER_DEVIN_TEAM: "Devin Team",
  TEAMS_TIER_DEVIN_ENTERPRISE: "Devin Enterprise",
};

function planFromUserStatus(us: JsonObject, planInfo: JsonObject | null): string | null {
  const name = planInfo && typeof planInfo.planName === "string" ? planInfo.planName.trim() : "";
  if (name) return name;
  const tier = typeof us.teamsTier === "string" ? us.teamsTier : planInfo && typeof planInfo.teamsTier === "string" ? planInfo.teamsTier : "";
  if (!tier) return null;
  return TIER_NAMES[tier] ?? tier.replace(/^TEAMS_TIER_/, "").replace(/_/g, " ").toLowerCase();
}

/** A quota window: server reports % *remaining*; we show % used. A missing percent with a reset time means 0 left. */
function quotaWindow(id: string, label: string, remaining: unknown, resetAt: unknown, minutes: number): QuotaWindow | null {
  const rem = num(remaining);
  const resetsAt = epochToIso(resetAt);
  if (rem === null && !resetsAt) return null;
  return {
    id,
    label,
    usedPercent: rem === null ? 100 : clampPercent(100 - rem),
    resetsAt,
    windowMinutes: minutes,
    kind: "rolling",
  };
}

/** Turn `GetUserStatus` into windows. Empty when the account has no quota fields at all. */
export function normalizeDevinUserStatus(body: unknown): { email: string | null; plan: string | null; windows: QuotaWindow[] } {
  const out = { email: null as string | null, plan: null as string | null, windows: [] as QuotaWindow[] };
  if (!isObject(body)) return out;
  const us = isObject(body.userStatus) ? body.userStatus : isObject(body.user_status) ? body.user_status : null;
  if (!us) return out;
  out.email = typeof us.email === "string" && us.email.trim() ? us.email.trim() : null;

  const ps = isObject(us.planStatus) ? us.planStatus : isObject(us.plan_status) ? us.plan_status : null;
  const info = ps && isObject(ps.planInfo) ? ps.planInfo : ps && isObject(ps.plan_info) ? ps.plan_info : null;
  out.plan = planFromUserStatus(us, info);
  if (!ps) return out;

  const cycleEnd = isoOrNull(ps.planEnd) ?? isoOrNull(ps.plan_end);
  const daily = quotaWindow("daily", "Daily Usage", ps.dailyQuotaRemainingPercent ?? ps.daily_quota_remaining_percent, ps.dailyQuotaResetAtUnix ?? ps.daily_quota_reset_at_unix, 1440);
  const weekly = quotaWindow("weekly", "Weekly Usage", ps.weeklyQuotaRemainingPercent ?? ps.weekly_quota_remaining_percent, ps.weeklyQuotaResetAtUnix ?? ps.weekly_quota_reset_at_unix, 10080);
  if (daily) out.windows.push(daily);
  if (weekly) out.windows.push(weekly);

  const acuLimit = num(ps.acuLimit ?? ps.acu_limit);
  const acuUsed = num(ps.acuConsumed ?? ps.acu_consumed);
  if (acuLimit && acuLimit > 0 && acuUsed !== null) {
    out.windows.push({
      id: "acu",
      label: "ACUs",
      usedPercent: clampPercent((acuUsed / acuLimit) * 100),
      resetsAt: cycleEnd,
      windowMinutes: null,
      kind: "cycle",
      note: `${acuUsed} of ${acuLimit} ACUs`,
    });
  }

  const monthly = num(ps.monthlyPromptCredits ?? ps.monthly_prompt_credits);
  const usedPrompt = num(ps.usedPromptCredits ?? ps.used_prompt_credits) ?? num(us.userUsedPromptCredits ?? us.user_used_prompt_credits);
  if (out.windows.length === 0 && monthly && monthly > 0 && usedPrompt !== null) {
    out.windows.push({
      id: "prompt_credits",
      label: "Monthly Credits",
      usedPercent: clampPercent((usedPrompt / monthly) * 100),
      resetsAt: cycleEnd,
      windowMinutes: null,
      kind: "cycle",
      note: `${usedPrompt} of ${monthly} credits`,
    });
  }

  const overage = num(ps.overageBalanceMicros ?? ps.overage_balance_micros);
  if (overage !== null && out.windows.length > 0) {
    out.windows.push({
      id: "overage",
      label: "On-demand",
      usedPercent: null,
      resetsAt: null,
      windowMinutes: null,
      kind: "cycle",
      note: `${money(overage)} balance`,
    });
  }
  return out;
}

// ---- fetch ---------------------------------------------------------------

async function clientVersion(): Promise<string> {
  return (await binVersion("devin")) ?? FALLBACK_CLI_VERSION;
}

export async function fetchDevin(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const creds = readDevinCredentials();
    if (!creds) {
      return snapshot(account, "signed_out", { message: "Not signed in. Run `devin auth login`." });
    }
    const version = await clientVersion();
    const res = await fetchJson(`${creds.apiServerUrl}${USER_STATUS_PATH}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${creds.apiKey}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({
        metadata: {
          apiKey: creds.apiKey,
          ideName: "devin-cli",
          ideVersion: version,
          extensionName: "devin-cli",
          extensionVersion: version,
          locale: "en-US",
        },
      }),
    });
    const norm = res.status === 200 ? normalizeDevinUserStatus(res.body) : null;
    const email = norm?.email ?? account.email ?? null;
    const plan = norm?.plan ?? null;
    if (res.status === 401 || res.status === 403) {
      return snapshot(account, "error", { email, plan, message: `Devin rejected the session (${res.status}). Run \`devin auth login\`.` });
    }
    if (res.status !== 200 || !norm) {
      return snapshot(account, "error", { email, plan, message: `Usage endpoint returned HTTP ${res.status}.` });
    }
    if (norm.windows.length === 0) {
      return snapshot(account, "unsupported", {
        email,
        plan,
        message: "Signed in, but this account has no Devin quota.",
      });
    }
    return snapshot(account, "ok", { email, plan, windows: norm.windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}
