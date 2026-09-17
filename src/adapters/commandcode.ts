/**
 * Command Code (`cmd`, `cmdc` on Windows) adapter. Quota is the same HTTP the
 * TUI `/usage` overlay calls:
 *   GET {api}/alpha/whoami
 *   GET {api}/alpha/billing/credits
 *   GET {api}/alpha/billing/subscriptions
 *   GET {api}/alpha/usage/summary?since=<currentPeriodStart>
 * Auth is `Authorization: Bearer <apiKey>`.
 *
 * Default credentials: `~/.commandcode/auth.json` (`apiKey`), or the
 * COMMAND_CODE_API_KEY env var. Extra accounts are API keys in our secret store.
 * Plan name and monthly pool come from the subscription's planId prefix table,
 * matching the CLI's own /usage math.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, epochToIso, isoOrNull } from "../format.ts";
import { secretStore } from "../secrets.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const API_BASE = "https://api.commandcode.ai";
const LOGIN_CMD = process.platform === "win32" ? "cmdc login" : "cmd login";

/** planId prefix → monthly credit pool, from the CLI's plan table. */
const PLAN_CREDITS: Record<string, number> = {
  "individual-go": 10,
  "individual-goat": 70,
  "individual-pro": 30,
  "individual-pro-v1": 80,
  "individual-provider": 15,
  "individual-max": 150,
  "individual-ultra": 300,
  "teams-pro": 40,
};
const PLAN_NAMES: Record<string, string> = {
  "individual-go": "Go",
  "individual-goat": "GOAT",
  "individual-pro": "Pro",
  "individual-pro-v1": "Pro",
  "individual-provider": "Provider",
  "individual-max": "Max",
  "individual-ultra": "Ultra",
  "teams-pro": "Teams Pro",
};
const PLAN_KEYS = Object.keys(PLAN_CREDITS).sort((a, b) => b.length - a.length);

function authFile(): string {
  return join(homedir(), ".commandcode", "auth.json");
}

/** Session key `cmd` is currently using. Never logged or written back. */
export function readCommandCodeKey(): string | null {
  const envKey = process.env.COMMAND_CODE_API_KEY?.trim();
  if (envKey) return envKey;
  const file = authFile();
  if (!existsSync(file)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isObject(parsed) || typeof parsed.apiKey !== "string") return null;
    return parsed.apiKey.trim() || null;
  } catch {
    return null;
  }
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

function money(n: number): string {
  return `$${n.toFixed(n % 1 ? 2 : 0)}`;
}

/** planId like "individual-goat" → { name: "GOAT", monthlyCredits: 70 }. Unknown ids yield null. */
export function planFromCommandCodeSub(planId: unknown): { name: string; monthlyCredits: number } | null {
  if (typeof planId !== "string" || !planId.trim()) return null;
  const id = planId.toLowerCase().replace(/_/g, "-");
  const key = PLAN_KEYS.find((k) => id.startsWith(k));
  if (!key) return null;
  return { name: PLAN_NAMES[key] ?? key, monthlyCredits: PLAN_CREDITS[key]! };
}

function windowLimit(id: string, label: string, w: unknown, minutes: number): QuotaWindow | null {
  if (!isObject(w)) return null;
  const used = num(w.used);
  const cap = num(w.cap);
  if (used === null || cap === null || cap <= 0) return null;
  return {
    id,
    label,
    usedPercent: clampPercent((used / cap) * 100),
    resetsAt: epochToIso(w.resetAt),
    windowMinutes: minutes,
    kind: "rolling",
    note: `${money(used)} of ${money(cap)}`,
  };
}

/**
 * Turn the three usage responses into windows — 5h, then weekly, then the
 * monthly pool. Mirrors the CLI's /usage math: monthly pool = plan monthly
 * credits (+ purchased + free), and the 5h/weekly meters only exist while the
 * account is window-limited.
 */
export function normalizeCommandCodeQuota(input: {
  credits: unknown;
  subscription: unknown;
  summary: unknown;
}): { plan: string | null; windows: QuotaWindow[] } {
  const out = { plan: null as string | null, windows: [] as QuotaWindow[] };

  const subBody = isObject(input.subscription) && isObject(input.subscription.data) ? input.subscription.data : null;
  const plan = subBody ? planFromCommandCodeSub(subBody.planId) : null;
  out.plan = plan?.name ?? null;
  const subActive = subBody?.status === "active";
  const periodEnd = isoOrNull(subBody?.currentPeriodEnd);

  const limits = isObject(input.credits) && isObject(input.credits.windowLimits) ? input.credits.windowLimits : null;
  if (limits && limits.limited === true) {
    const five = windowLimit("five_hour", "5h Usage", limits.fiveHour, 300);
    if (five) out.windows.push(five);
    const weekly = windowLimit("weekly", "Weekly Usage", limits.weekly, 10080);
    if (weekly) out.windows.push(weekly);
  }

  const credits = isObject(input.credits) && isObject(input.credits.credits) ? input.credits.credits : null;
  if (credits) {
    const monthly = Math.max(0, num(credits.monthlyCredits) ?? 0);
    const purchased = Math.max(0, num(credits.purchasedCredits) ?? 0);
    const free = Math.max(0, num(credits.freeCredits) ?? 0);
    const remaining = monthly + purchased + free;
    const spent = Math.max(
      0,
      num(isObject(input.summary) ? input.summary.totalCost : null) ?? 0,
    );
    const planPool = subActive && plan ? plan.monthlyCredits : null;
    const pool = planPool !== null ? Math.max(planPool, monthly) + purchased + free : spent + remaining;
    if (pool > 0 && (remaining > 0 || spent > 0)) {
      const usedAmt = pool - remaining;
      out.windows.push({
        id: "monthly",
        label: "Monthly Usage",
        usedPercent: clampPercent((usedAmt / pool) * 100),
        resetsAt: periodEnd,
        windowMinutes: null,
        kind: "cycle",
        note: `${money(usedAmt)} of ${money(pool)}`,
      });
    }
  }
  return out;
}

// ---- fetch ---------------------------------------------------------------

async function resolveKey(account: ResolvedAccount): Promise<{ key: string } | { fail: QuotaSnapshot }> {
  if (account.kind === "token") {
    const key = await secretStore().get(account.id);
    if (!key) return { fail: snapshot(account, "error", { message: "Stored key missing. Run `just-usage remove` and add it again." }) };
    return { key };
  }
  const key = readCommandCodeKey();
  if (!key) return { fail: snapshot(account, "signed_out", { message: `Not signed in. Run \`${LOGIN_CMD}\`.` }) };
  return { key };
}

function apiGet(key: string, path: string) {
  return fetchJson(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  });
}

export async function fetchCommandCode(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const resolved = await resolveKey(account);
    if ("fail" in resolved) return resolved.fail;
    const key = resolved.key;

    const whoami = await apiGet(key, "/alpha/whoami");
    if (whoami.status === 401 || whoami.status === 403) {
      return snapshot(account, "error", { message: `Command Code rejected the key (${whoami.status}). Run \`${LOGIN_CMD}\`.` });
    }
    if (whoami.status !== 200 || !isObject(whoami.body)) {
      return snapshot(account, "error", { message: `Usage endpoint returned HTTP ${whoami.status}.` });
    }
    const user = isObject(whoami.body.user) ? whoami.body.user : null;
    const email = typeof user?.email === "string" && user.email.trim() ? user.email.trim() : account.email ?? null;
    const org = isObject(whoami.body.org) ? whoami.body.org : null;
    const orgId = typeof org?.id === "string" && org.id ? org.id : null;
    const query = (extra?: Record<string, string>) => {
      const p = new URLSearchParams(extra);
      if (orgId) p.set("orgId", orgId);
      const s = p.toString();
      return s ? `?${s}` : "";
    };

    const [credits, subscription] = await Promise.all([
      apiGet(key, `/alpha/billing/credits${query()}`),
      apiGet(key, `/alpha/billing/subscriptions${query()}`).catch(() => null),
    ]);
    if (credits.status === 401 || credits.status === 403) {
      return snapshot(account, "error", { email, message: `Command Code rejected the key (${credits.status}). Run \`${LOGIN_CMD}\`.` });
    }
    if (credits.status !== 200) {
      return snapshot(account, "error", { email, message: `Usage endpoint returned HTTP ${credits.status}.` });
    }

    const subBody = subscription && subscription.status === 200 && isObject(subscription.body) && isObject(subscription.body.data)
      ? subscription.body.data
      : null;
    const since = typeof subBody?.currentPeriodStart === "string" && subBody.currentPeriodStart ? subBody.currentPeriodStart : null;
    const summary = await apiGet(key, `/alpha/usage/summary${query(since ? { since } : undefined)}`).catch(() => null);

    const norm = normalizeCommandCodeQuota({
      credits: credits.body,
      subscription: subscription?.status === 200 ? subscription.body : null,
      summary: summary?.status === 200 ? summary.body : null,
    });
    if (norm.windows.length === 0) {
      return snapshot(account, "unsupported", {
        email,
        plan: norm.plan,
        message: "Signed in, but this account has no Command Code plan quota.",
      });
    }
    return snapshot(account, "ok", { email, plan: norm.plan, windows: norm.windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}

/** Validate a pasted API key against whoami. Returns the account email when possible. */
export async function verifyCommandCodeKey(key: string): Promise<{ ok: boolean; email: string | null; message: string }> {
  const res = await apiGet(key, "/alpha/whoami");
  if (res.status === 401 || res.status === 403) return { ok: false, email: null, message: `Key rejected (${res.status}).` };
  if (res.status !== 200 || !isObject(res.body)) return { ok: false, email: null, message: `HTTP ${res.status} from whoami.` };
  const user = isObject(res.body.user) ? res.body.user : null;
  const email = typeof user?.email === "string" && user.email.trim() ? user.email.trim() : null;
  return { ok: true, email, message: "ok" };
}
