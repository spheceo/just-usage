/**
 * Antigravity (`agy`) adapter.
 *
 * The CLI has no machine-readable `/usage` flag — that panel is TUI-only.
 * Quota is the same Code Assist RPC the CLI refreshes when you open `/usage`:
 *   POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
 * Plan/tier comes from `loadCodeAssist`. Email from Google userinfo.
 *
 * Default account: the OS keyring item `agy` writes (`service=gemini`,
 * `account=antigravity`), a go-keyring base64 JSON blob. Extra accounts store
 * their own refresh token in our secret store so we never overwrite the CLI login.
 *
 * Client id/secret are the public installed-app credentials embedded in `agy`.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, isoOrNull } from "../format.ts";
import { binVersion, run } from "../proc.ts";
import { secretStore } from "../secrets.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

export const AGY_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
export const AGY_CLIENT_SECRET = "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";
export const AGY_REDIRECT_URI = "https://antigravity.google/oauth-callback";
export const AGY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
] as const;
const USAGE_HOST = "https://daily-cloudcode-pa.googleapis.com";
const KEYCHAIN_SERVICE = "gemini";
const KEYCHAIN_ACCOUNT = "antigravity";
const FALLBACK_CLI_VERSION = "1.1.26";

export interface AgyToken {
  accessToken: string;
  refreshToken: string;
  expiry: number | null;
}

function settingsFile(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "settings.json");
}

export function usesGeminiApiKey(): boolean {
  try {
    if (!existsSync(settingsFile())) return false;
    const parsed = JSON.parse(readFileSync(settingsFile(), "utf8")) as JsonObject;
    return parsed.modelProvider === "gemini" && Boolean(process.env.GEMINI_API_KEY?.trim());
  } catch {
    return false;
  }
}

export function parseAgyKeyringBlob(raw: string): AgyToken | null {
  const text = raw.replace(/\r?\n$/, "");
  const prefix = "go-keyring-base64:";
  const json = text.startsWith(prefix) ? Buffer.from(text.slice(prefix.length), "base64").toString("utf8") : text;
  try {
    const parsed = JSON.parse(json) as JsonObject;
    const token = isObject(parsed.token) ? parsed.token : parsed;
    if (typeof token.access_token !== "string" || !token.access_token) return null;
    if (typeof token.refresh_token !== "string" || !token.refresh_token) return null;
    const expiry = typeof token.expiry === "string" ? Date.parse(token.expiry) : typeof token.expiry === "number" ? token.expiry : NaN;
    return {
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiry: Number.isFinite(expiry) ? expiry : null,
    };
  } catch {
    return null;
  }
}

export function parseStoredAgySecret(raw: string): AgyToken | null {
  try {
    const parsed = JSON.parse(raw) as JsonObject;
    if (typeof parsed.refresh_token !== "string" || !parsed.refresh_token) return parseAgyKeyringBlob(raw);
    return {
      accessToken: typeof parsed.access_token === "string" ? parsed.access_token : "",
      refreshToken: parsed.refresh_token,
      expiry: typeof parsed.expiry === "number" ? parsed.expiry : typeof parsed.expiry === "string" ? Date.parse(parsed.expiry) || null : null,
    };
  } catch {
    return parseAgyKeyringBlob(raw);
  }
}

export function serializeAgySecret(token: AgyToken): string {
  return JSON.stringify({
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expiry: token.expiry,
  });
}

async function tokenFromKeychain(): Promise<AgyToken | null> {
  if (process.platform !== "darwin") return null;
  const res = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  return parseAgyKeyringBlob(res.stdout);
}

async function tokenFromSecretTool(): Promise<AgyToken | null> {
  if (process.platform === "darwin" || process.platform === "win32") return null;
  const res = await run("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "username", KEYCHAIN_ACCOUNT], { timeoutMs: 20_000 });
  if (res.code !== 0) return null;
  return parseAgyKeyringBlob(res.stdout);
}

function tokenFromOauthFile(): AgyToken | null {
  const file = join(homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
  if (!existsSync(file)) return null;
  try {
    return parseAgyKeyringBlob(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export async function readDefaultAgyToken(): Promise<AgyToken | null> {
  return (await tokenFromKeychain()) ?? (await tokenFromSecretTool()) ?? tokenFromOauthFile();
}

export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function antigravityAuthUrl(opts: { state: string; challenge: string }): string {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", AGY_CLIENT_ID);
  url.searchParams.set("redirect_uri", AGY_REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", AGY_SCOPES.join(" "));
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function isAntigravityCallbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.hostname === "antigravity.google" && u.pathname === "/oauth-callback" && Boolean(u.searchParams.get("code"));
}

/** Google's callback page shows a pasteable `4/0A…` code. A full callback URL still works. */
export function parseAntigravityAuthInput(raw: string): { code: string; state: string | null } | null {
  const text = raw.trim().replace(/^["']|["']$/g, "");
  if (!text) return null;
  if (isAntigravityCallbackUrl(text)) {
    const u = new URL(text);
    return { code: u.searchParams.get("code")!, state: u.searchParams.get("state") };
  }
  if (/^https?:\/\//i.test(text)) return null;
  if (/^4\/[A-Za-z0-9_\-/]+$/.test(text) && text.length >= 20) return { code: text, state: null };
  return null;
}

async function userAgent(): Promise<string> {
  const v = (await binVersion("agy")) ?? FALLBACK_CLI_VERSION;
  return `antigravity-cli/${v}`;
}

function headers(token: string, ua: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": ua,
  };
}

export async function refreshAgyToken(refreshToken: string): Promise<AgyToken | null> {
  const res = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: AGY_CLIENT_ID,
      client_secret: AGY_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });
  if (res.status !== 200 || !isObject(res.body) || typeof res.body.access_token !== "string") return null;
  const expiresIn = typeof res.body.expires_in === "number" ? res.body.expires_in : 3600;
  return {
    accessToken: res.body.access_token,
    refreshToken: typeof res.body.refresh_token === "string" && res.body.refresh_token ? res.body.refresh_token : refreshToken,
    expiry: Date.now() + expiresIn * 1000,
  };
}

export async function exchangeAntigravityCode(code: string, verifier: string): Promise<AgyToken> {
  const res = await fetchJson("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: AGY_CLIENT_ID,
      client_secret: AGY_CLIENT_SECRET,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: AGY_REDIRECT_URI,
    }).toString(),
  });
  if (res.status !== 200 || !isObject(res.body) || typeof res.body.access_token !== "string" || typeof res.body.refresh_token !== "string") {
    throw new Error(isObject(res.body) && typeof res.body.error_description === "string" ? res.body.error_description : `Token exchange failed (HTTP ${res.status}).`);
  }
  const expiresIn = typeof res.body.expires_in === "number" ? res.body.expires_in : 3600;
  return {
    accessToken: res.body.access_token,
    refreshToken: res.body.refresh_token,
    expiry: Date.now() + expiresIn * 1000,
  };
}

export async function fetchAgyEmail(accessToken: string): Promise<string | null> {
  const res = await fetchJson("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status !== 200 || !isObject(res.body) || typeof res.body.email !== "string") return null;
  return res.body.email;
}

const GOOGLE_AI_PLANS: Record<string, string> = {
  "g1-plus-tier": "Plus",
  "g1-pro-tier": "Pro",
  "g1-ultra-tier": "Ultra",
};

/** Product shell names — Code Assist keeps these on currentTier even for Pro/Ultra. */
const PRODUCT_TIER_NAMES = /^(antigravity|gemini code assist)$/i;

function planFromTier(tier: JsonObject | null): string | null {
  if (!tier) return null;
  const id = typeof tier.id === "string" ? tier.id.trim().toLowerCase() : "";
  if (id && GOOGLE_AI_PLANS[id]) return GOOGLE_AI_PLANS[id];
  if (id.includes("ultra")) return "Ultra";
  if (id.includes("pro")) return "Pro";
  if (id.includes("plus")) return "Plus";
  const name = typeof tier.name === "string" ? tier.name.trim() : "";
  if (name && !PRODUCT_TIER_NAMES.test(name)) return name;
  if (id === "free-tier") return "Free";
  if (id === "standard-tier") return "Standard";
  if (id === "legacy-tier") return "Legacy";
  return name || null;
}

export function planFromCodeAssist(body: unknown): string | null {
  if (!isObject(body)) return null;
  const current = isObject(body.currentTier) ? body.currentTier : null;
  const paid = isObject(body.paidTier) ? body.paidTier : null;
  // Google AI Pro/Ultra is paidTier (g1-*-tier). currentTier stays free-tier / "Antigravity".
  return planFromTier(paid) ?? planFromTier(current);
}

function windowMinutes(window: string | undefined): number | null {
  const key = (window ?? "").toLowerCase().replace(/[_-]/g, "");
  if (key === "5h" || key === "fivehour" || key === "fivehours") return 300;
  if (key === "weekly" || key === "week") return 10080;
  return null;
}

function usageLabel(minutes: number | null, fallback: string): string {
  if (minutes === 300) return "5h Usage";
  if (minutes === 10080) return "Weekly Usage";
  return fallback.replace(/\s+remaining$/i, "").trim() || "Usage";
}

/** `remainingFraction` is leftover quota; the dashboard shows used percent. */
export function normalizeAntigravityQuota(body: unknown): QuotaWindow[] {
  if (!isObject(body) || !Array.isArray(body.groups)) return [];
  const out: QuotaWindow[] = [];
  for (const group of body.groups) {
    if (!isObject(group) || !Array.isArray(group.buckets)) continue;
    const rawGroup = typeof group.displayName === "string" && group.displayName.trim() ? group.displayName.trim() : undefined;
    const groupName = rawGroup && !/^gemini models$/i.test(rawGroup) ? rawGroup : undefined;
    for (const bucket of group.buckets) {
      if (!isObject(bucket) || bucket.disabled === true) continue;
      const remaining = typeof bucket.remainingFraction === "number" ? bucket.remainingFraction : null;
      const used = remaining === null ? null : clampPercent((1 - remaining) * 100);
      if (used === null) continue;
      const id = typeof bucket.bucketId === "string" && bucket.bucketId ? bucket.bucketId : `${groupName ?? "quota"}:${out.length}`;
      const minutes = windowMinutes(typeof bucket.window === "string" ? bucket.window : undefined);
      const fallback = typeof bucket.displayName === "string" ? bucket.displayName : "Usage";
      out.push({
        id,
        label: usageLabel(minutes, fallback),
        group: groupName,
        usedPercent: used,
        resetsAt: isoOrNull(bucket.resetTime),
        windowMinutes: minutes,
        kind: "rolling",
      });
    }
  }
  return out;
}

async function resolveToken(account: ResolvedAccount): Promise<{ token: AgyToken } | { fail: QuotaSnapshot }> {
  if (account.kind === "token") {
    const raw = await secretStore().get(account.id);
    if (!raw) return { fail: snapshot(account, "error", { message: "Stored Google session missing. Remove the account and sign in again." }) };
    const parsed = parseStoredAgySecret(raw);
    if (!parsed) return { fail: snapshot(account, "error", { message: "Stored Google session is unreadable. Remove the account and sign in again." }) };
    return { token: parsed };
  }
  const token = await readDefaultAgyToken();
  if (!token) {
    if (usesGeminiApiKey()) {
      return { fail: snapshot(account, "unsupported", { message: "This CLI is using a Gemini API key, which has no subscription quota." }) };
    }
    return { fail: snapshot(account, "signed_out", { message: "Not signed in. Run `agy` and complete Google sign-in." }) };
  }
  return { token };
}

async function liveToken(account: ResolvedAccount, token: AgyToken): Promise<AgyToken | { fail: QuotaSnapshot }> {
  if (token.expiry && token.expiry > Date.now() + 60_000 && token.accessToken) return token;
  const refreshed = await refreshAgyToken(token.refreshToken);
  if (!refreshed) {
    return { fail: snapshot(account, "error", { message: "Google session expired. Sign in again with `agy`." }) };
  }
  if (account.kind === "token") {
    await secretStore().set(account.id, serializeAgySecret(refreshed));
  }
  return refreshed;
}

export async function fetchAntigravity(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const resolved = await resolveToken(account);
    if ("fail" in resolved) return resolved.fail;
    const live = await liveToken(account, resolved.token);
    if ("fail" in live) return live.fail;
    const ua = await userAgent();
    const h = headers(live.accessToken, ua);

    const [usage, assist, email] = await Promise.all([
      fetchJson(`${USAGE_HOST}/v1internal:retrieveUserQuotaSummary`, { method: "POST", headers: h, body: "{}" }),
      fetchJson(`${USAGE_HOST}/v1internal:loadCodeAssist`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ metadata: { ideType: "ANTIGRAVITY" } }),
      }),
      account.email ? Promise.resolve(account.email) : fetchAgyEmail(live.accessToken),
    ]);

    const plan = assist.status === 200 ? planFromCodeAssist(assist.body) : null;
    if (usage.status === 401) {
      return snapshot(account, "error", { email, plan, message: "Google session rejected (401). Sign in again." });
    }
    if (usage.status === 403) {
      return snapshot(account, "unsupported", {
        email,
        plan,
        message: "This Google account has no Antigravity quota. A Google AI Pro / Antigravity subscription is required.",
      });
    }
    if (usage.status !== 200) {
      return snapshot(account, "error", { email, plan, message: `Usage endpoint returned HTTP ${usage.status}.` });
    }
    const windows = normalizeAntigravityQuota(usage.body);
    if (windows.length === 0) {
      return snapshot(account, "unsupported", { email, plan, message: "Usage response had no recognizable windows (schema may have changed)." });
    }
    return snapshot(account, "ok", { email, plan, windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}
