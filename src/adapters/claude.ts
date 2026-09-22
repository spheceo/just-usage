/**
 * Claude adapter. Uses the same endpoint Claude Code's `/usage` screen uses:
 *   GET https://api.anthropic.com/api/oauth/usage
 * It is undocumented, so parsing is defensive and any drift becomes a gray card.
 *
 * Credential sources, in order of preference:
 *   - token accounts: a `claude setup-token` value the user pasted, held in our secret store
 *   - profile/default accounts: Claude Code's own credential (macOS Keychain, or .credentials.json)
 * When the access token has expired we run the same refresh_token grant `claude` uses and
 * write the rotated tokens back to the store they were read from — losing the new refresh
 * token would strand the CLI's own login.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { clampPercent, isoOrNull } from "../format.ts";
import { log } from "../log.ts";
import { binVersion, run } from "../proc.ts";
import { secretStore } from "../secrets.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
/** Same refresh endpoint and public client id Claude Code itself uses. */
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const FALLBACK_CLI_VERSION = "2.1.259";

interface ClaudeCreds {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  refreshTokenExpiresAt: number | null;
  subscriptionType: string | null;
}

/** Where the credential blob came from, so a refreshed token can be written back. */
type CredStore =
  | { kind: "keychain"; service: string; raw: string }
  | { kind: "file"; path: string };

function keychainService(configDir: string | undefined): string {
  if (!configDir) return "Claude Code-credentials";
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `Claude Code-credentials-${hash}`;
}

function parseCreds(text: string): ClaudeCreds | null {
  try {
    const parsed = JSON.parse(text) as JsonObject;
    const o = isObject(parsed.claudeAiOauth) ? parsed.claudeAiOauth : null;
    if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
    return {
      accessToken: o.accessToken,
      refreshToken: typeof o.refreshToken === "string" && o.refreshToken ? o.refreshToken : null,
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null,
      refreshTokenExpiresAt: typeof o.refreshTokenExpiresAt === "number" ? o.refreshTokenExpiresAt : null,
      subscriptionType: typeof o.subscriptionType === "string" ? o.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

function credentialsFile(configDir: string | undefined): string {
  return join(configDir ?? join(homedir(), ".claude"), ".credentials.json");
}

/** Read Claude Code's stored OAuth credential for a config dir (undefined = ~/.claude). */
export async function readClaudeCredentials(
  configDir: string | undefined,
): Promise<{ creds: ClaudeCreds; store: CredStore } | null> {
  if (process.platform === "darwin") {
    const service = keychainService(configDir);
    const res = await run("security", ["find-generic-password", "-s", service, "-w"], { timeoutMs: 20_000 });
    if (res.code === 0) {
      const raw = res.stdout.trim();
      const creds = parseCreds(raw);
      if (creds) return { creds, store: { kind: "keychain", service, raw } };
    }
  }
  const file = credentialsFile(configDir);
  if (existsSync(file)) {
    const creds = parseCreds(readFileSync(file, "utf8"));
    if (creds) return { creds, store: { kind: "file", path: file } };
  }
  return null;
}

interface RefreshedToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  refreshTokenExpiresAt: number | null;
}

/** `refresh_token` grant against the same endpoint `claude` uses. "rejected" = the session is dead. */
export async function refreshClaudeToken(
  refreshToken: string,
): Promise<{ ok: true; token: RefreshedToken } | { ok: false; rejected: boolean; detail: string }> {
  let res: Awaited<ReturnType<typeof fetchJson>>;
  try {
    res = await fetchJson(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
        scope: SCOPES,
      }),
    });
  } catch (e) {
    return { ok: false, rejected: false, detail: errorMessage(e) };
  }
  const body = isObject(res.body) ? res.body : null;
  if (res.status !== 200 || !body || typeof body.access_token !== "string" || !body.access_token) {
    const err = typeof body?.error === "string" ? body.error : "";
    const detail = err || `HTTP ${res.status}`;
    const rejected = res.status === 400 || res.status === 401 || err === "invalid_grant";
    return { ok: false, rejected, detail };
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 28_800;
  const rtExpiresIn = typeof body.refresh_token_expires_in === "number" ? body.refresh_token_expires_in : null;
  return {
    ok: true,
    token: {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" && body.refresh_token ? body.refresh_token : refreshToken,
      expiresAt: Date.now() + expiresIn * 1000,
      refreshTokenExpiresAt: rtExpiresIn !== null ? Date.now() + rtExpiresIn * 1000 : null,
    },
  };
}

/**
 * Merge refreshed tokens into the credential JSON. Returns null when the store has
 * moved on (e.g. `claude` refreshed itself) — the current contents win.
 */
export function mergeRefreshedCreds(parsed: unknown, prev: ClaudeCreds, next: RefreshedToken): JsonObject | null {
  if (!isObject(parsed) || !isObject(parsed.claudeAiOauth)) return null;
  const o = parsed.claudeAiOauth;
  if (prev.refreshToken && o.refreshToken !== prev.refreshToken) return null;
  o.accessToken = next.accessToken;
  o.refreshToken = next.refreshToken;
  o.expiresAt = next.expiresAt;
  if (next.refreshTokenExpiresAt !== null) o.refreshTokenExpiresAt = next.refreshTokenExpiresAt;
  else delete o.refreshTokenExpiresAt;
  return parsed;
}

/** Write refreshed creds back to the store they were read from. Best effort. */
async function persistCreds(store: CredStore, prev: ClaudeCreds, next: RefreshedToken): Promise<boolean> {
  try {
    if (store.kind === "file") {
      const merged = mergeRefreshedCreds(JSON.parse(readFileSync(store.path, "utf8")), prev, next);
      if (!merged) return false;
      const tmp = `${store.path}.just-usage-tmp`;
      writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
      renameSync(tmp, store.path);
      return true;
    }
    const merged = mergeRefreshedCreds(JSON.parse(store.raw), prev, next);
    if (!merged) return false;
    // Claude Code stores the item under account = login username.
    const account = process.env.USER || userInfo().username;
    const res = await run("security", ["add-generic-password", "-U", "-a", account, "-s", store.service, "-w", JSON.stringify(merged)], {
      timeoutMs: 10_000,
    });
    return res.code === 0;
  } catch {
    return false;
  }
}

export async function claudeAuthStatus(configDir: string | undefined): Promise<{ loggedIn: boolean } | null> {
  const env: NodeJS.ProcessEnv = {};
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const res = await run("claude", ["auth", "status", "--json"], { env, timeoutMs: 15_000 });
  if (res.code === null) return null;
  const m = res.stdout.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const parsed = JSON.parse(m[0]) as JsonObject;
    return { loggedIn: parsed.loggedIn === true };
  } catch {
    return null;
  }
}

async function userAgent(): Promise<string> {
  const v = (await binVersion("claude")) ?? FALLBACK_CLI_VERSION;
  return `claude-code/${v}`;
}

function headers(token: string, ua: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "User-Agent": ua,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json",
  };
}

// ---- normalization -------------------------------------------------------

function bucket(v: unknown, id: string, label: string, minutes: number | null, kind: QuotaWindow["kind"] = "rolling"): QuotaWindow | null {
  if (!isObject(v)) return null;
  const used = clampPercent(v.utilization);
  if (used === null) return null;
  return { id, label, usedPercent: used, resetsAt: isoOrNull(v.resets_at), windowMinutes: minutes, kind };
}

/** Normalize the `/api/oauth/usage` body. Unknown or null buckets are simply absent. */
export function normalizeClaudeUsage(body: unknown): QuotaWindow[] {
  if (!isObject(body)) return [];
  const out: QuotaWindow[] = [];
  const push = (w: QuotaWindow | null) => w && out.push(w);

  push(bucket(body.five_hour, "five_hour", "5h Usage", 300));
  push(bucket(body.seven_day, "seven_day", "Weekly Usage", 10080));
  push(bucket(body.seven_day_opus, "seven_day_opus", "Weekly · Opus Usage", 10080));
  push(bucket(body.seven_day_sonnet, "seven_day_sonnet", "Weekly · Sonnet Usage", 10080));
  push(bucket(body.seven_day_oauth_apps, "seven_day_oauth_apps", "Weekly · OAuth apps Usage", 10080));

  // Newer payloads may carry a `limits` array; only consult it when the legacy buckets are missing.
  if (out.length === 0 && Array.isArray(body.limits)) {
    for (const [i, item] of body.limits.entries()) {
      if (!isObject(item)) continue;
      const name = [item.name, item.type, item.id].find((x): x is string => typeof x === "string" && x.length > 0) ?? `limit ${i + 1}`;
      const label = name.replace(/_/g, " ");
      push(bucket(item, `limits:${name}`, /usage$/i.test(label) ? label : `${label} Usage`, null));
    }
  }

  const extra = body.extra_usage;
  if (isObject(extra) && extra.is_enabled === true) {
    const used = clampPercent(extra.utilization);
    if (used !== null) {
      const limit = typeof extra.monthly_limit === "number" ? extra.monthly_limit : null;
      const spent = typeof extra.used_credits === "number" ? extra.used_credits : null;
      out.push({
        id: "extra_usage",
        label: "Extra usage",
        usedPercent: used,
        resetsAt: null,
        windowMinutes: null,
        kind: "cycle",
        note: limit !== null && spent !== null ? `${spent.toFixed(2)} of ${limit.toFixed(0)} credits` : undefined,
      });
    }
  }
  return out;
}

// ---- fetch ---------------------------------------------------------------

function loginHint(account: ResolvedAccount): string {
  return account.kind === "default" ? "Run `claude` and `/login`." : `Run \`just-usage login ${account.id}\`.`;
}

async function resolveToken(
  account: ResolvedAccount,
  force = false,
): Promise<{ token: string; plan: string | null } | { fail: QuotaSnapshot }> {
  if (account.kind === "token") {
    const token = await secretStore().get(account.id);
    if (!token) return { fail: snapshot(account, "error", { message: "Stored token missing. Run `just-usage remove` and add it again." }) };
    return { token, plan: null };
  }
  const found = await readClaudeCredentials(account.path);
  if (!found) {
    return { fail: snapshot(account, "signed_out", { message: `Not signed in. ${loginHint(account)}` }) };
  }
  const { creds, store } = found;
  const expired = creds.expiresAt !== null && creds.expiresAt <= Date.now() + 60_000;
  if (!expired && !force) return { token: creds.accessToken, plan: creds.subscriptionType };

  // refreshTokenExpiresAt can be stale — let the server decide whether the session is dead.
  if (creds.refreshToken) {
    const refreshed = await refreshClaudeToken(creds.refreshToken);
    if (refreshed.ok) {
      if (!(await persistCreds(store, creds, refreshed.token))) {
        log("warn", "claude.refresh.persist", { account: account.id, store: store.kind, ok: false });
      }
      return { token: refreshed.token.accessToken, plan: creds.subscriptionType };
    }
    if (refreshed.rejected) {
      return { fail: snapshot(account, "error", { plan: creds.subscriptionType, message: `Claude session expired. ${loginHint(account)}` }) };
    }
    if (force) return { token: creds.accessToken, plan: creds.subscriptionType };
    return {
      fail: snapshot(account, "error", {
        plan: creds.subscriptionType,
        message: `Couldn't refresh the Claude session (${refreshed.detail}). ${loginHint(account)}`,
      }),
    };
  }
  if (force) return { token: creds.accessToken, plan: creds.subscriptionType };
  return {
    fail: snapshot(account, "error", {
      plan: creds.subscriptionType,
      message: `Claude session expired. ${loginHint(account)}`,
    }),
  };
}

export async function fetchClaude(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const resolved = await resolveToken(account);
    if ("fail" in resolved) return resolved.fail;
    const ua = await userAgent();

    let token = resolved.token;
    let usage = await fetchJson(USAGE_URL, { headers: headers(token, ua) });
    if (usage.status === 401 && account.kind !== "token") {
      // Server says no — force a refresh once and retry.
      const again = await resolveToken(account, true);
      if (!("fail" in again) && again.token !== token) {
        token = again.token;
        usage = await fetchJson(USAGE_URL, { headers: headers(token, ua) });
      }
    }
    const profile =
      !account.email && usage.status === 200
        ? await fetchJson(PROFILE_URL, { headers: headers(token, ua) }).catch(() => null)
        : null;

    let email = account.email ?? null;
    if (profile && profile.status === 200 && isObject(profile.body) && isObject(profile.body.account)) {
      const e = profile.body.account.email;
      if (typeof e === "string") email = e;
    }

    if (usage.status === 401) {
      return snapshot(account, "error", { email, plan: resolved.plan, message: "Token rejected (401). Sign in again." });
    }
    if (usage.status === 429) {
      return snapshot(account, "error", { email, plan: resolved.plan, message: "Rate limited by Anthropic (429). Try again in a minute." });
    }
    if (usage.status !== 200) {
      return snapshot(account, "error", { email, plan: resolved.plan, message: `Usage endpoint returned HTTP ${usage.status}.` });
    }
    const windows = normalizeClaudeUsage(usage.body);
    if (windows.length === 0) {
      return snapshot(account, "unsupported", { email, plan: resolved.plan, message: "Usage response had no recognizable windows (schema may have changed)." });
    }
    return snapshot(account, "ok", { email, plan: resolved.plan, windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}

/** Validate a pasted setup-token by hitting the profile endpoint. Returns the account email when possible. */
export async function verifyClaudeToken(token: string): Promise<{ ok: boolean; email: string | null; message: string }> {
  const h = headers(token, await userAgent());
  const res = await fetchJson(USAGE_URL, { headers: h });
  if (res.status === 401) return { ok: false, email: null, message: "Token rejected (401)." };
  if (res.status !== 200) return { ok: false, email: null, message: `HTTP ${res.status} from usage endpoint.` };
  let email: string | null = null;
  const profile = await fetchJson(PROFILE_URL, { headers: h }).catch(() => null);
  if (profile && profile.status === 200 && isObject(profile.body) && isObject(profile.body.account) && typeof profile.body.account.email === "string") {
    email = profile.body.account.email;
  }
  return { ok: true, email, message: "ok" };
}
