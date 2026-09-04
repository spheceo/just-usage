import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorMessage } from "./adapters/common.ts";
import { VERSION, ensureDir } from "./config.ts";

export type LogLevel = "info" | "warn" | "error";

const SECRET_KEY =
  /^(.*[._-]?)?(secret|token|password|authorization|cookie|verifier|refresh_token|access_token|api[_-]?key|key)$/i;
const SKIP_KEY = /^(url|authurl|callback|body|headers|authorization)$/i;
const MAX_STRING = 400;

/** `~/.just-usage/logs`, or JUST_USAGE_LOG_DIR when tests / a user override it. */
export function logDir(): string {
  const override = process.env.JUST_USAGE_LOG_DIR;
  if (override && override.trim()) return override.trim();
  return join(homedir(), ".just-usage", "logs");
}

export function logFile(at = new Date()): string {
  return join(logDir(), `${at.toISOString().slice(0, 10)}.log`);
}

export function sanitizeFields(fields?: Record<string, unknown>): Record<string, unknown> {
  if (!fields) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    if (SECRET_KEY.test(k) || SKIP_KEY.test(k)) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
      continue;
    }
    if (typeof v === "string") {
      out[k] = v.length <= MAX_STRING ? v : `${v.slice(0, MAX_STRING)}…`;
      continue;
    }
    if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
      out[k] = v.slice(0, 20);
    }
  }
  return out;
}

/** Append one JSON line. Never throws — logging must not break the app. */
export function log(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  try {
    ensureDir(logDir());
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      pid: process.pid,
      v: VERSION,
      ...sanitizeFields(fields),
    });
    appendFileSync(logFile(), `${line}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // Disk / permission failures are ignored on purpose.
  }
}

export function logError(event: string, e: unknown, fields?: Record<string, unknown>): void {
  log("error", event, { ...fields, message: errorMessage(e) });
}
