/**
 * OpenCode Go adapter.
 *   GET https://opencode.ai/zen/go/v1/usage   (Authorization: Bearer <go key>)
 * Default account: the `opencode-go` key OpenCode already stores. Extra accounts: keys the user adds.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { clampPercent, isoOrNull } from "../format.ts";
import { secretStore } from "../secrets.ts";
import type { QuotaSnapshot, QuotaWindow, ResolvedAccount } from "../types.ts";
import { errorMessage, fetchJson, isObject, snapshot, type JsonObject } from "./common.ts";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

function openCodeAuthFile(): string {
  if (process.env.OPENCODE_AUTH_FILE) return process.env.OPENCODE_AUTH_FILE;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".local", "share");
  return join(base, "opencode", "auth.json");
}

/** The Go key OpenCode itself is using, if any. */
export function readOpenCodeGoKey(): string | null {
  const file = openCodeAuthFile();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as JsonObject;
    const entry = parsed["opencode-go"];
    if (isObject(entry) && typeof entry.key === "string" && entry.key) return entry.key;
    return null;
  } catch {
    return null;
  }
}

// ---- normalization -------------------------------------------------------

const WINDOWS: ReadonlyArray<{ key: string; id: string; label: string; minutes: number | null; kind: QuotaWindow["kind"] }> = [
  { key: "rolling", id: "rolling", label: "5h Usage", minutes: 300, kind: "rolling" },
  { key: "weekly", id: "weekly", label: "Weekly Usage", minutes: 10080, kind: "rolling" },
  { key: "monthly", id: "monthly", label: "Monthly Usage", minutes: null, kind: "cycle" },
];

export function normalizeOpenCodeUsage(body: unknown): QuotaWindow[] {
  if (!isObject(body)) return [];
  const usage = isObject(body.usage) ? body.usage : body;
  const out: QuotaWindow[] = [];
  for (const def of WINDOWS) {
    const w = usage[def.key];
    if (!isObject(w)) continue;
    let used = clampPercent(w.percent);
    if (w.status === "rate-limited") used = 100;
    if (used === null) continue;
    out.push({ id: def.id, label: def.label, usedPercent: used, resetsAt: isoOrNull(w.resetsAt), windowMinutes: def.minutes, kind: def.kind });
  }
  return out;
}

// ---- fetch ---------------------------------------------------------------

export async function fetchOpenCodeUsage(key: string): Promise<{ status: number; windows: QuotaWindow[] }> {
  const res = await fetchJson(USAGE_URL, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } });
  return { status: res.status, windows: res.status === 200 ? normalizeOpenCodeUsage(res.body) : [] };
}

export async function fetchOpenCode(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const key = account.kind === "token" ? await secretStore().get(account.id) : readOpenCodeGoKey();
    if (!key) {
      return account.kind === "token"
        ? snapshot(account, "error", { message: "Stored key missing. Remove and re-add this account." })
        : snapshot(account, "signed_out", { message: "No OpenCode Go key found. Run `opencode auth login` or `just-usage add opencode`." });
    }
    const { status, windows } = await fetchOpenCodeUsage(key);
    if (status === 401) return snapshot(account, "error", { message: "Key rejected (401)." });
    if (status === 403) return snapshot(account, "unsupported", { message: "No active OpenCode Go subscription." });
    if (status === 429) return snapshot(account, "error", { message: "Rate limited (429). Try again shortly." });
    if (status !== 200) return snapshot(account, "error", { message: `Usage endpoint returned HTTP ${status}.` });
    if (windows.length === 0) return snapshot(account, "unsupported", { message: "Usage response had no recognizable windows." });
    return snapshot(account, "ok", { plan: "go", windows });
  } catch (e) {
    return snapshot(account, "error", { message: errorMessage(e) });
  }
}
