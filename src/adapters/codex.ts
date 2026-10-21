/**
 * Codex adapter. Talks to `codex app-server` over stdio JSON-RPC.
 * Multi-account works by pointing CODEX_HOME at an isolated directory per account;
 * the app-server owns login, token storage and refresh. We never read auth.json.
 */
import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { FETCH_TIMEOUT_MS, VERSION } from "../config.ts";
import { clampPercent, epochToIso, windowLabel } from "../format.ts";
import { spawnTracked, terminateTree } from "../proc.ts";
import type { QuotaSnapshot, QuotaWindow, ResetCredit, ResolvedAccount } from "../types.ts";
import { errorMessage, isObject, snapshot, type JsonObject } from "./common.ts";

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Notification = { method: string; params: unknown };

/** Leave the fetch a little headroom so our own deadline, not collect's, ends it. */
const CODEX_FETCH_TIMEOUT_MS = FETCH_TIMEOUT_MS - 1000;

export class AppServerClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(n: Notification) => void>();
  private exited = false;
  private closing: Promise<void> | null = null;
  private readonly spawned: Promise<void>;

  private constructor(
    private readonly proc: ChildProcess,
    private readonly killGraceMs: number,
  ) {
    this.spawned = new Promise<void>((resolve, reject) => {
      proc.once("spawn", () => resolve());
      proc.once("error", (e) => reject(new Error(`could not start codex app-server: ${e.message}`)));
    });
    this.spawned.catch(() => {});
    createInterface({ input: proc.stdout! }).on("line", (line) => this.onLine(line));
    proc.stderr!.on("data", () => {});
    proc.stdin!.on("error", () => {});
    const gone = (reason: string) => {
      this.exited = true;
      this.failPending(reason);
    };
    proc.on("exit", () => gone("codex app-server exited"));
    proc.on("error", () => gone("codex app-server failed to start"));
  }

  /** Spawn without waiting, so the caller owns the process from the first moment. */
  static spawn(codexHome?: string, opts: { killGraceMs?: number } = {}): AppServerClient {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (codexHome) env.CODEX_HOME = codexHome;
    const proc = spawnTracked("codex", ["app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    return new AppServerClient(proc, opts.killGraceMs ?? 1500);
  }

  /** Spawn and initialize. The process is torn down if initialization fails. */
  static async start(codexHome?: string): Promise<AppServerClient> {
    const client = AppServerClient.spawn(codexHome);
    try {
      await client.initialize();
      return client;
    } catch (e) {
      await client.close();
      throw e;
    }
  }

  async initialize(): Promise<void> {
    await this.spawned;
    await this.request("initialize", {
      clientInfo: { name: "just-usage", title: "just-usage", version: VERSION },
      capabilities: {},
    });
    this.notify("initialized", {});
  }

  private failPending(reason: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private onLine(line: string) {
    let msg: JsonObject;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && ("result" in msg || "error" in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = msg.error as JsonObject;
        p.reject(new Error(String(err.message ?? "app-server error")));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (typeof msg.method === "string" && !("id" in msg)) {
      for (const l of this.listeners) l({ method: msg.method, params: msg.params });
    }
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 20_000): Promise<T> {
    if (this.exited || this.closing) return Promise.reject(new Error("codex app-server exited"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method: string, params: unknown) {
    if (this.exited || this.closing) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  onNotification(cb: (n: Notification) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Close stdin, then SIGTERM the process group and SIGKILL it if it lingers. Idempotent. */
  close(reason = "codex app-server closed"): Promise<void> {
    if (!this.closing) {
      this.failPending(reason);
      this.proc.stdin!.end();
      this.closing = terminateTree(this.proc, this.killGraceMs);
    }
    return this.closing;
  }
}

// ---- normalization -------------------------------------------------------

export interface CodexNormalized {
  windows: QuotaWindow[];
  plan: string | null;
  resetCredits: { availableCount: number; credits: ResetCredit[] } | null;
}

function windowsFromLimit(limit: JsonObject, prefix: string, labelPrefix: string): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const w = limit[key];
    if (!isObject(w)) continue;
    const minutes = typeof w.windowDurationMins === "number" ? w.windowDurationMins : null;
    out.push({
      id: `${prefix}${key}`,
      label: `${labelPrefix}${windowLabel(minutes)}`,
      usedPercent: clampPercent(w.usedPercent),
      resetsAt: epochToIso(w.resetsAt),
      windowMinutes: minutes,
      kind: "rolling",
    });
  }
  return out;
}

/** Turn an `account/rateLimits/read` result into windows + plan + banked reset credits. */
export function normalizeCodexRateLimits(result: unknown): CodexNormalized {
  const empty: CodexNormalized = { windows: [], plan: null, resetCredits: null };
  if (!isObject(result)) return empty;

  const byId = isObject(result.rateLimitsByLimitId) ? result.rateLimitsByLimitId : null;
  const limits: JsonObject[] = byId
    ? Object.values(byId).filter(isObject)
    : isObject(result.rateLimits)
      ? [result.rateLimits]
      : [];

  const windows: QuotaWindow[] = [];
  let plan: string | null = null;
  const multi = limits.length > 1;
  for (const limit of limits) {
    const limitId = typeof limit.limitId === "string" ? limit.limitId : "codex";
    const limitName = typeof limit.limitName === "string" && limit.limitName ? limit.limitName : null;
    const labelPrefix = multi && limitName ? `${limitName} · ` : multi && limitId !== "codex" ? `${limitId} · ` : "";
    windows.push(...windowsFromLimit(limit, `${limitId}:`, labelPrefix));
    if (!plan && typeof limit.planType === "string") plan = limit.planType;
  }
  // Put the main "codex" limit first.
  windows.sort((a, b) => Number(!a.id.startsWith("codex:")) - Number(!b.id.startsWith("codex:")));

  let resetCredits: CodexNormalized["resetCredits"] = null;
  const rc = result.rateLimitResetCredits;
  if (isObject(rc)) {
    const credits: ResetCredit[] = Array.isArray(rc.credits)
      ? rc.credits.filter(isObject).map((c) => ({
          id: String(c.id ?? ""),
          title: typeof c.title === "string" ? c.title : null,
          status: typeof c.status === "string" ? c.status : null,
          expiresAt: epochToIso(c.expiresAt),
        }))
      : [];
    const availableCount =
      typeof rc.availableCount === "number" ? rc.availableCount : credits.filter((c) => c.status === "available").length;
    resetCredits = { availableCount, credits };
  }

  return { windows, plan, resetCredits };
}

// ---- fetch ---------------------------------------------------------------

export interface CodexFetchOptions {
  /** Hard budget for the whole fetch, including app-server startup. */
  timeoutMs?: number;
  /** Time between SIGTERM and SIGKILL when tearing the app-server down. */
  killGraceMs?: number;
}

export async function fetchCodex(account: ResolvedAccount, opts: CodexFetchOptions = {}): Promise<QuotaSnapshot> {
  const timeoutMs = opts.timeoutMs ?? CODEX_FETCH_TIMEOUT_MS;
  let client: AppServerClient | null = null;
  let deadline: NodeJS.Timeout | undefined;
  try {
    client = AppServerClient.spawn(account.path, { killGraceMs: opts.killGraceMs });
    const c = client;
    deadline = setTimeout(() => void c.close(`codex app-server timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    await client.initialize();
    const acct = await client.request<JsonObject>("account/read", { refreshToken: false });
    const info = isObject(acct.account) ? acct.account : null;
    if (!info) {
      return snapshot(account, "signed_out", {
        message: account.kind === "default" ? "Not signed in. Run `codex login`." : `Not signed in. Run \`just-usage login ${account.id}\`.`,
      });
    }
    const email = typeof info.email === "string" ? info.email : null;
    const planFromAccount = typeof info.planType === "string" ? info.planType : null;
    if (info.type === "apiKey") {
      return snapshot(account, "unsupported", { email, plan: "api key", message: "API-key logins have no subscription windows." });
    }
    let raw: unknown;
    try {
      raw = await client.request("account/rateLimits/read", {});
    } catch {
      // A stale token can fail the first call; the app-server owns the OAuth
      // tokens, so force its refresh and try once more.
      await client.request("account/read", { refreshToken: true }).catch(() => null);
      raw = await client.request("account/rateLimits/read", {});
    }
    const norm = normalizeCodexRateLimits(raw);
    return snapshot(account, "ok", {
      email,
      plan: norm.plan ?? planFromAccount,
      windows: norm.windows,
      resetCredits: norm.resetCredits,
    });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  } finally {
    clearTimeout(deadline);
    await client?.close();
  }
}

export interface CodexLoginHandle {
  authUrl: string;
  completed: Promise<{ email: string | null; plan: string | null }>;
  close: () => void;
}

/** Start a ChatGPT OAuth login inside an isolated CODEX_HOME. Caller waits on `completed` or closes. */
export async function startCodexLogin(codexHome: string, timeoutMs = 5 * 60_000): Promise<CodexLoginHandle> {
  const client = await AppServerClient.start(codexHome);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void client.close();
  };
  const completed = new Promise<{ email: string | null; plan: string | null }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("login timed out")), timeoutMs);
    client.onNotification(async (n) => {
      if (n.method !== "account/login/completed") return;
      clearTimeout(timer);
      const p = isObject(n.params) ? n.params : {};
      if (!p.success) {
        reject(new Error(typeof p.error === "string" ? p.error : "login failed"));
        return;
      }
      try {
        const acct = await client.request<JsonObject>("account/read", {});
        const info = isObject(acct.account) ? acct.account : {};
        resolve({
          email: typeof info.email === "string" ? info.email : null,
          plan: typeof info.planType === "string" ? info.planType : null,
        });
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }).finally(close);
  try {
    const start = await client.request<JsonObject>("account/login/start", { type: "chatgpt" });
    if (typeof start.authUrl !== "string" || !start.authUrl) throw new Error("Codex did not return an auth URL.");
    return { authUrl: start.authUrl, completed, close };
  } catch (e) {
    close();
    throw e;
  }
}

/** Drive a ChatGPT OAuth login inside an isolated CODEX_HOME. Resolves with the account info. */
export async function codexLogin(
  codexHome: string,
  onAuthUrl: (url: string) => void,
  timeoutMs = 5 * 60_000,
): Promise<{ email: string | null; plan: string | null }> {
  const handle = await startCodexLogin(codexHome, timeoutMs);
  onAuthUrl(handle.authUrl);
  try {
    return await handle.completed;
  } catch (e) {
    handle.close();
    throw e;
  }
}
