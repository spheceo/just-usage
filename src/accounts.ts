import { renameSync, rmSync } from "node:fs";
import {
  antigravityAuthUrl,
  createPkce,
  exchangeAntigravityCode,
  fetchAgyEmail,
  parseAntigravityAuthInput,
  serializeAgySecret,
} from "./adapters/antigravity.ts";
import { verifyClaudeToken } from "./adapters/claude.ts";
import { startCodexLogin, type CodexLoginHandle } from "./adapters/codex.ts";
import { fetchOpenCodeUsage } from "./adapters/opencode.ts";
import { ensureDir } from "./config.ts";
import { which } from "./proc.ts";
import { deleteAccount, getAccount, newAccountId, profileDirFor, saveAccount, updateAccount } from "./registry.ts";
import { secretStore } from "./secrets.ts";
import type { AccountRecord } from "./types.ts";

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export interface AddResult {
  account: AccountRecord;
  warning?: string;
}

export async function addClaudeToken(token: string, label?: string): Promise<AddResult> {
  const secret = token.trim();
  if (!secret) throw new AccountError("No token given.");
  const check = await verifyClaudeToken(secret);
  if (!check.ok) throw new AccountError(`Token check failed: ${check.message}`);
  const named = label?.trim() || "";
  const id = newAccountId("claude", named || check.email || "account");
  await secretStore().set(id, secret);
  const account: AccountRecord = {
    id,
    provider: "claude",
    label: named,
    kind: "token",
    email: check.email,
    createdAt: new Date().toISOString(),
  };
  saveAccount(account);
  return { account };
}

export async function addOpenCodeKey(key: string, label?: string): Promise<AddResult> {
  const secret = key.trim();
  if (!secret) throw new AccountError("No key given.");
  const { status } = await fetchOpenCodeUsage(secret);
  if (status === 401) throw new AccountError("Key rejected (401).");
  if (status !== 200 && status !== 403) throw new AccountError(`Usage endpoint returned HTTP ${status}.`);
  const named = label?.trim() || "";
  const id = newAccountId("opencode", named || "account");
  await secretStore().set(id, secret);
  const account: AccountRecord = {
    id,
    provider: "opencode",
    label: named,
    kind: "token",
    createdAt: new Date().toISOString(),
  };
  saveAccount(account);
  return {
    account,
    warning: status === 403 ? "Key is valid but has no active OpenCode Go subscription." : undefined,
  };
}

export function renameExtraAccount(id: string, label: string): AccountRecord {
  if (id.endsWith(":default")) throw new AccountError("Default accounts are renamed on the page only.");
  if (!getAccount(id)) throw new AccountError(`Unknown account: ${id}`, 404);
  updateAccount(id, { label: label.trim() });
  return getAccount(id)!;
}

export async function removeExtraAccount(id: string): Promise<AccountRecord> {
  if (id.endsWith(":default")) throw new AccountError("Default accounts belong to the CLI itself; sign out there instead.");
  const rec = deleteAccount(id);
  if (!rec) throw new AccountError(`Unknown account: ${id}`, 404);
  if (rec.kind === "token") await secretStore().delete(id);
  return rec;
}

export function saveCodexProfile(opts: {
  label?: string;
  tmpId: string;
  dir: string;
  email: string | null;
}): AccountRecord {
  const named = opts.label?.trim() || "";
  const finalLabel = named;
  const id = named ? opts.tmpId : newAccountId("codex", opts.email || opts.tmpId.split(":")[1] || "account");
  const path = id === opts.tmpId ? opts.dir : ensureDir(profileDirFor("codex", id));
  if (path !== opts.dir) {
    rmSync(path, { recursive: true, force: true });
    renameSync(opts.dir, path);
  }
  const account: AccountRecord = {
    id,
    provider: "codex",
    label: finalLabel,
    kind: "profile",
    path,
    email: opts.email,
    createdAt: new Date().toISOString(),
  };
  saveAccount(account);
  return account;
}

/** Only http(s) URLs aimed at this machine's loopback listener. */
export function isLocalCallbackUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export async function submitLocalCallback(raw: string): Promise<void> {
  if (!isLocalCallbackUrl(raw)) throw new AccountError("Paste the localhost callback URL from the sign-in redirect.");
  try {
    await fetch(raw.trim(), { redirect: "manual" });
  } catch (e) {
    throw new AccountError(`Could not reach the local callback: ${e instanceof Error ? e.message : String(e)}`);
  }
}

interface CodexPending {
  id: string;
  label?: string;
  tmpId: string;
  dir: string;
  handle: CodexLoginHandle;
  status: "waiting" | "done" | "error";
  error?: string;
  account?: AccountRecord;
  timer: ReturnType<typeof setTimeout>;
}

const SESSION_TTL_MS = 10 * 60_000;
const codexSessions = new Map<string, CodexPending>();

function dropCodexSession(id: string, removeDir: boolean) {
  const rec = codexSessions.get(id);
  if (!rec) return;
  clearTimeout(rec.timer);
  rec.handle.close();
  codexSessions.delete(id);
  if (removeDir && rec.status !== "done") {
    try {
      rmSync(rec.dir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of an unfinished profile.
    }
  }
}

export async function beginCodexAdd(label?: string): Promise<{ sessionId: string; authUrl: string }> {
  if (!(await which("codex"))) throw new AccountError("codex is not installed (npm i -g @openai/codex).");
  const tmpId = newAccountId("codex", label?.trim() || "pending");
  const dir = ensureDir(profileDirFor("codex", tmpId));
  const handle = await startCodexLogin(dir);
  const id = crypto.randomUUID();
  const rec: CodexPending = {
    id,
    label: label?.trim() || undefined,
    tmpId,
    dir,
    handle,
    status: "waiting",
    timer: setTimeout(() => dropCodexSession(id, true), SESSION_TTL_MS),
  };
  rec.timer.unref?.();
  handle.completed
    .then((info) => {
      rec.account = saveCodexProfile({ label: rec.label, tmpId, dir, email: info.email });
      rec.status = "done";
    })
    .catch((e) => {
      rec.status = "error";
      rec.error = e instanceof Error ? e.message : String(e);
    });
  codexSessions.set(id, rec);
  return { sessionId: id, authUrl: handle.authUrl };
}

export async function beginCodexRelogin(accountId: string): Promise<{ sessionId: string; authUrl: string }> {
  const existing = getAccount(accountId);
  if (!existing) throw new AccountError(`Unknown account: ${accountId}`, 404);
  if (existing.provider !== "codex" || existing.kind !== "profile" || !existing.path) {
    throw new AccountError(`${accountId} cannot be re-authenticated this way.`);
  }
  const handle = await startCodexLogin(existing.path);
  const id = crypto.randomUUID();
  const rec: CodexPending = {
    id,
    tmpId: existing.id,
    dir: existing.path,
    handle,
    status: "waiting",
    timer: setTimeout(() => dropCodexSession(id, false), SESSION_TTL_MS),
  };
  rec.timer.unref?.();
  handle.completed
    .then((info) => {
      updateAccount(existing.id, { email: info.email });
      rec.account = { ...existing, email: info.email };
      rec.status = "done";
    })
    .catch((e) => {
      rec.status = "error";
      rec.error = e instanceof Error ? e.message : String(e);
    });
  codexSessions.set(id, rec);
  return { sessionId: id, authUrl: handle.authUrl };
}

export function codexSessionStatus(sessionId: string): {
  status: "waiting" | "done" | "error";
  authUrl?: string;
  error?: string;
  account?: AccountRecord;
} {
  const rec = codexSessions.get(sessionId);
  if (!rec) return { status: "error", error: "Login session expired." };
  return { status: rec.status, authUrl: rec.handle.authUrl, error: rec.error, account: rec.account };
}

export async function submitCodexCallback(sessionId: string, url: string): Promise<void> {
  if (!isLocalCallbackUrl(url)) throw new AccountError("Paste the localhost callback URL from the sign-in redirect.");
  const rec = codexSessions.get(sessionId);
  if (!rec) throw new AccountError("Login session expired.", 404);
  if (rec.status !== "waiting") return;
  await submitLocalCallback(url);
}

interface AgyPending {
  id: string;
  label?: string;
  accountId?: string;
  state: string;
  verifier: string;
  authUrl: string;
  status: "waiting" | "done" | "error";
  error?: string;
  account?: AccountRecord;
  timer: ReturnType<typeof setTimeout>;
}

const agySessions = new Map<string, AgyPending>();

function dropAgySession(id: string) {
  const rec = agySessions.get(id);
  if (!rec) return;
  clearTimeout(rec.timer);
  agySessions.delete(id);
}

function startAgySession(opts: { label?: string; accountId?: string }): { sessionId: string; authUrl: string } {
  const pkce = createPkce();
  const state = crypto.randomUUID();
  const id = crypto.randomUUID();
  const authUrl = antigravityAuthUrl({ state, challenge: pkce.challenge });
  const rec: AgyPending = {
    id,
    label: opts.label?.trim() || undefined,
    accountId: opts.accountId,
    state,
    verifier: pkce.verifier,
    authUrl,
    status: "waiting",
    timer: setTimeout(() => dropAgySession(id), SESSION_TTL_MS),
  };
  rec.timer.unref?.();
  agySessions.set(id, rec);
  return { sessionId: id, authUrl };
}

export async function beginAntigravityAdd(label?: string): Promise<{ sessionId: string; authUrl: string }> {
  if (!(await which("agy"))) throw new AccountError("agy is not installed (https://antigravity.google/docs/cli/install).");
  return startAgySession({ label });
}

export async function beginAntigravityRelogin(accountId: string): Promise<{ sessionId: string; authUrl: string }> {
  const existing = getAccount(accountId);
  if (!existing) throw new AccountError(`Unknown account: ${accountId}`, 404);
  if (existing.provider !== "antigravity" || existing.kind !== "token") {
    throw new AccountError(`${accountId} cannot be re-authenticated this way.`);
  }
  return startAgySession({ accountId });
}

export function antigravitySessionStatus(sessionId: string): {
  status: "waiting" | "done" | "error";
  authUrl?: string;
  error?: string;
  account?: AccountRecord;
} {
  const rec = agySessions.get(sessionId);
  if (!rec) return { status: "error", error: "Login session expired." };
  return { status: rec.status, authUrl: rec.authUrl, error: rec.error, account: rec.account };
}

export async function submitAntigravityCallback(sessionId: string, raw: string): Promise<AccountRecord> {
  const parsed = parseAntigravityAuthInput(raw);
  if (!parsed) {
    throw new AccountError("Paste the code from the Antigravity page, or the antigravity.google/oauth-callback URL.");
  }
  const rec = agySessions.get(sessionId);
  if (!rec) throw new AccountError("Login session expired.", 404);
  if (rec.status === "done" && rec.account) return rec.account;
  const { code, state } = parsed;
  if (state && state !== rec.state) throw new AccountError("Sign-in state did not match. Start again.");
  try {
    const token = await exchangeAntigravityCode(code, rec.verifier);
    const email = await fetchAgyEmail(token.accessToken);
    const named = rec.label?.trim() || "";
    if (rec.accountId) {
      await secretStore().set(rec.accountId, serializeAgySecret(token));
      updateAccount(rec.accountId, { email });
      rec.account = getAccount(rec.accountId)!;
    } else {
      const id = newAccountId("antigravity", named || email || "account");
      await secretStore().set(id, serializeAgySecret(token));
      rec.account = {
        id,
        provider: "antigravity",
        label: named,
        kind: "token",
        email,
        createdAt: new Date().toISOString(),
      };
      saveAccount(rec.account);
    }
    rec.status = "done";
    return rec.account;
  } catch (e) {
    rec.status = "error";
    rec.error = e instanceof Error ? e.message : String(e);
    throw new AccountError(rec.error);
  }
}
