/**
 * Claude adapter. Uses the same endpoint Claude Code's `/usage` screen uses:
 *   GET https://api.anthropic.com/api/oauth/usage
 * It is undocumented, so parsing is defensive and any drift becomes a gray card.
 *
 * Credential sources, in order of preference:
 *   - token accounts: a `claude setup-token` value the user pasted, held in our secret store
 *   - profile/default accounts: Claude Code's own credential (macOS Keychain, or .credentials.json)
 * Tokens are read into memory for one request and never written anywhere by us.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, isoOrNull } from "../format.ts";
import { binVersion, run } from "../proc.ts";
import { secretStore } from "../secrets.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const FALLBACK_CLI_VERSION = "2.1.259";

interface ClaudeCreds {
  accessToken: string;
  expiresAt: number | null;
  subscriptionType: string | null;
}

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
      expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null,
      subscriptionType: typeof o.subscriptionType === "string" ? o.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

/** Read Claude Code's stored OAuth credential for a config dir (undefined = ~/.claude). */
export async function readClaudeCredentials(configDir: string | undefined): Promise<ClaudeCreds | null> {
  if (process.platform === "darwin") {
    const res = await run("security", ["find-generic-password", "-s", keychainService(configDir), "-w"], { timeoutMs: 20_000 });
    if (res.code === 0) {
      const creds = parseCreds(res.stdout.trim());
      if (creds) return creds;
    }
  }
  const file = join(configDir ?? join(homedir(), ".claude"), ".credentials.json");
  if (existsSync(file)) return parseCreds(readFileSync(file, "utf8"));
  return null;
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

  push(bucket(body.five_hour, "five_hour", "5h", 300));
  push(bucket(body.seven_day, "seven_day", "Weekly", 10080));
  push(bucket(body.seven_day_opus, "seven_day_opus", "Weekly · Opus", 10080));
  push(bucket(body.seven_day_sonnet, "seven_day_sonnet", "Weekly · Sonnet", 10080));
  push(bucket(body.seven_day_oauth_apps, "seven_day_oauth_apps", "Weekly · OAuth apps", 10080));

  // Newer payloads may carry a `limits` array; only consult it when the legacy buckets are missing.
  if (out.length === 0 && Array.isArray(body.limits)) {
    for (const [i, item] of body.limits.entries()) {
      if (!isObject(item)) continue;
      const name = [item.name, item.type, item.id].find((x): x is string => typeof x === "string" && x.length > 0) ?? `limit ${i + 1}`;
      push(bucket(item, `limits:${name}`, name.replace(/_/g, " "), null));
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

async function resolveToken(account: ResolvedAccount): Promise<
  { token: string; plan: string | null } | { fail: QuotaSnapshot }
> {
  if (account.kind === "token") {
    const token = await secretStore().get(account.id);
    if (!token) return { fail: snapshot(account, "error", { message: "Stored token missing. Run `just-usage remove` and add it again." }) };
    return { token, plan: null };
  }
  const status = await claudeAuthStatus(account.path);
  if (status && !status.loggedIn) {
    const hint = account.kind === "default" ? "Run `claude` and `/login`." : `Run \`just-usage login ${account.id}\`.`;
    return { fail: snapshot(account, "signed_out", { message: `Not signed in. ${hint}` }) };
  }
  const creds = await readClaudeCredentials(account.path);
  if (!creds) {
    return { fail: snapshot(account, "error", { message: "Could not read Claude Code's credential (Keychain access denied or file missing)." }) };
  }
  if (creds.expiresAt && creds.expiresAt < Date.now()) {
    const hint = account.kind === "default" ? "Open `claude` once to refresh it." : `Run \`CLAUDE_CONFIG_DIR=${account.path} claude\` once to refresh it.`;
    return { fail: snapshot(account, "error", { plan: creds.subscriptionType, message: `Access token expired. ${hint}` }) };
  }
  return { token: creds.accessToken, plan: creds.subscriptionType };
}

export async function fetchClaude(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const resolved = await resolveToken(account);
    if ("fail" in resolved) return resolved.fail;
    const ua = await userAgent();
    const h = headers(resolved.token, ua);

    const [usage, profile] = await Promise.all([
      fetchJson(USAGE_URL, { headers: h }),
      account.email ? Promise.resolve(null) : fetchJson(PROFILE_URL, { headers: h }).catch(() => null),
    ]);

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
