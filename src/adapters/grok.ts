/**
 * Grok Build (`grok`) adapter. Single account: whatever `grok login --oauth` stored.
 * There is no `grok usage` command — quota is the same HTTP the TUI `/usage` panel uses:
 *   GET https://cli-chat-proxy.grok.com/v1/billing?format=credits
 * Plan name is a remote-settings field (`subscription_tier_display` / `subscription_tier`).
 *
 * Default credentials: `~/.grok/auth.json` (OIDC access + refresh). An xAI API key is a
 * different product (prepaid console) and has no SuperGrok / Grok Build pool.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, isoOrNull } from "../format.ts";
import { binVersion } from "../proc.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const DEFAULT_PROXY = "https://cli-chat-proxy.grok.com/v1";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const FALLBACK_CLI_VERSION = "1.0.13";

const TIER_NAMES: Record<string, string> = {
  supergrok: "SuperGrok",
  supergrok_lite: "SuperGrok Lite",
  supergrok_plus: "SuperGrok Plus",
  supergrok_heavy: "SuperGrok Heavy",
  x_premium: "X Premium",
  x_premium_plus: "X Premium+",
};

export interface GrokSession {
  accessToken: string;
  refreshToken: string | null;
  clientId: string | null;
  email: string | null;
  expiresAt: number | null;
  authMode: string | null;
}

function authFile(): string {
  if (process.env.GROK_AUTH_FILE) return process.env.GROK_AUTH_FILE;
  return join(homedir(), ".grok", "auth.json");
}

function proxyBase(): string {
  const raw = process.env.GROK_CLI_CHAT_PROXY_BASE_URL?.trim();
  if (!raw) return DEFAULT_PROXY;
  return raw.replace(/\/+$/, "");
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (isObject(v) && typeof v.val === "number" && Number.isFinite(v.val)) return v.val;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function money(n: number): string {
  return `$${n.toFixed(n % 1 ? 2 : 0)}`;
}

function sessionFromEntry(entry: JsonObject): GrokSession | null {
  const access = typeof entry.key === "string" && entry.key ? entry.key : null;
  if (!access) return null;
  const expiry = typeof entry.expires_at === "string" ? Date.parse(entry.expires_at) : NaN;
  return {
    accessToken: access,
    refreshToken: typeof entry.refresh_token === "string" && entry.refresh_token ? entry.refresh_token : null,
    clientId: typeof entry.oidc_client_id === "string" && entry.oidc_client_id ? entry.oidc_client_id : null,
    email: typeof entry.email === "string" && entry.email.trim() ? entry.email.trim() : null,
    expiresAt: Number.isFinite(expiry) ? expiry : null,
    authMode: typeof entry.auth_mode === "string" ? entry.auth_mode : null,
  };
}

/** Pull the OIDC session `grok login --oauth` writes into auth.json. */
export function sessionFromAuthJson(parsed: unknown): GrokSession | null {
  if (!isObject(parsed)) return null;
  if (typeof parsed.key === "string" && parsed.key) return sessionFromEntry(parsed);
  const entries = Object.values(parsed).filter(isObject);
  const oidc = entries.find((e) => e.auth_mode === "oidc" && typeof e.key === "string" && e.key);
  if (oidc) return sessionFromEntry(oidc);
  const any = entries.find((e) => typeof e.key === "string" && e.key);
  return any ? sessionFromEntry(any) : null;
}

export function readGrokSession(): GrokSession | null {
  const file = authFile();
  if (!existsSync(file)) return null;
  try {
    return sessionFromAuthJson(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

export function grokUsesApiKey(session: GrokSession | null): boolean {
  if (session?.authMode === "oidc" && session.accessToken) return false;
  return Boolean(process.env.XAI_API_KEY?.trim()) || session?.authMode === "api_key";
}

export function planFromGrokSettings(body: unknown): string | null {
  if (!isObject(body)) return null;
  if (typeof body.subscription_tier_display === "string" && body.subscription_tier_display.trim()) {
    return body.subscription_tier_display.trim();
  }
  const raw = typeof body.subscription_tier === "string" ? body.subscription_tier.trim() : "";
  if (!raw) return null;
  return TIER_NAMES[raw] ?? raw.replace(/_/g, " ");
}

function creditsRoot(body: unknown): JsonObject | null {
  if (!isObject(body)) return null;
  return isObject(body.config) ? body.config : body;
}

/** Map `GET /v1/billing?format=credits`. Empty when signed in with no included / on-demand pool. */
export function normalizeGrokCredits(body: unknown): QuotaWindow[] {
  const cfg = creditsRoot(body);
  if (!cfg) return [];
  const out: QuotaWindow[] = [];
  const period = isObject(cfg.currentPeriod) ? cfg.currentPeriod : null;
  const periodType = typeof period?.type === "string" ? period.type : "";
  const weekly = periodType.includes("WEEKLY");
  const resetsAt = isoOrNull(period?.end) ?? isoOrNull(cfg.billingPeriodEnd);
  const used = clampPercent(num(cfg.creditUsagePercent));
  if (used !== null) {
    out.push({
      id: "weekly",
      label: weekly || !periodType ? "Weekly Usage" : "Usage",
      usedPercent: used,
      resetsAt,
      windowMinutes: weekly || !periodType ? 10080 : null,
      kind: weekly || !periodType ? "rolling" : "cycle",
    });
  }
  const cap = num(cfg.onDemandCap);
  const spent = num(cfg.onDemandUsed);
  if (cap && cap > 0 && spent !== null) {
    out.push({
      id: "on_demand",
      label: "On-demand",
      usedPercent: clampPercent((spent / cap) * 100),
      resetsAt,
      windowMinutes: weekly ? 10080 : null,
      kind: weekly ? "rolling" : "cycle",
      note: `${money(spent)} of ${money(cap)}`,
    });
  }
  return out;
}

async function clientVersion(): Promise<string> {
  return (await binVersion("grok")) ?? FALLBACK_CLI_VERSION;
}

function headers(token: string, version: string, email: string | null): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: "application/json",
    "User-Agent": "xai-grok-cli",
    "x-grok-client-version": version,
    "x-grok-client-mode": "cli",
  };
  if (email) h["x-email"] = email;
  return h;
}

async function refreshAccessToken(session: GrokSession): Promise<GrokSession | null> {
  if (!session.refreshToken || !session.clientId) return null;
  const res = await fetchJson(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: session.refreshToken,
      client_id: session.clientId,
    }).toString(),
  });
  if (res.status !== 200 || !isObject(res.body) || typeof res.body.access_token !== "string" || !res.body.access_token) {
    return null;
  }
  const expiresIn = typeof res.body.expires_in === "number" ? res.body.expires_in : 3600;
  return {
    ...session,
    accessToken: res.body.access_token,
    refreshToken: typeof res.body.refresh_token === "string" && res.body.refresh_token ? res.body.refresh_token : session.refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

async function liveSession(session: GrokSession): Promise<GrokSession | null> {
  if (session.expiresAt && session.expiresAt > Date.now() + 60_000) return session;
  return (await refreshAccessToken(session)) ?? (session.expiresAt && session.expiresAt > Date.now() ? session : null);
}

export async function fetchGrok(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const stored = readGrokSession();
    if (!stored) {
      if (grokUsesApiKey(null)) {
        return snapshot(account, "unsupported", { message: "This CLI is using an xAI API key, which has no SuperGrok quota." });
      }
      return snapshot(account, "signed_out", { message: "Not signed in. Run `grok login --oauth`." });
    }
    if (stored.authMode && stored.authMode !== "oidc") {
      return snapshot(account, "unsupported", { email: stored.email, message: "This CLI is using an xAI API key, which has no SuperGrok quota." });
    }
    let session = await liveSession(stored);
    if (!session) {
      return snapshot(account, "error", { email: stored.email, message: "Grok session expired. Run `grok login --oauth`." });
    }
    const version = await clientVersion();
    const base = proxyBase();
    const get = (token: string, path: string) => fetchJson(`${base}${path}`, { headers: headers(token, version, session!.email) });
    let [credits, settings] = await Promise.all([
      get(session.accessToken, "/billing?format=credits"),
      get(session.accessToken, "/settings").catch(() => ({ status: 0, body: null, text: "" })),
    ]);
    if (credits.status === 401 || credits.status === 403) {
      const refreshed = await refreshAccessToken(session);
      if (refreshed) {
        session = refreshed;
        [credits, settings] = await Promise.all([
          get(session.accessToken, "/billing?format=credits"),
          get(session.accessToken, "/settings").catch(() => ({ status: 0, body: null, text: "" })),
        ]);
      }
    }
    const email = session.email ?? account.email ?? null;
    const plan = settings.status === 200 ? planFromGrokSettings(settings.body) : null;
    if (credits.status === 401 || credits.status === 403) {
      return snapshot(account, "error", { email, plan, message: `Grok rejected the session (${credits.status}). Run \`grok login --oauth\`.` });
    }
    if (credits.status !== 200) {
      return snapshot(account, "error", { email, plan, message: `Usage endpoint returned HTTP ${credits.status}.` });
    }
    const windows = normalizeGrokCredits(credits.body);
    if (windows.length === 0) {
      return snapshot(account, "unsupported", {
        email,
        plan,
        message: "Signed in, but this account has no SuperGrok / Grok Build allowance.",
      });
    }
    return snapshot(account, "ok", { email, plan, windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}
