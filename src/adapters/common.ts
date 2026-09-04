import { formatPlan } from "../format.ts";
import type { QuotaSnapshot, ResolvedAccount, SnapshotStatus } from "../types.ts";

export function snapshot(
  account: ResolvedAccount,
  status: SnapshotStatus,
  patch: Partial<Omit<QuotaSnapshot, "account" | "status">> & { email?: string | null; plan?: string | null } = {},
): QuotaSnapshot {
  const { email, plan, ...rest } = patch;
  return {
    account: {
      id: account.id,
      provider: account.provider,
      label: account.label,
      email: email ?? account.email ?? null,
      plan: formatPlan(plan) ?? null,
      kind: account.kind,
    },
    status,
    message: null,
    windows: [],
    resetCredits: null,
    fetchedAt: new Date().toISOString(),
    ...rest,
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export type JsonObject = Record<string, unknown>;

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: unknown; text: string }> {
  const { timeoutMs = 15_000, ...rest } = init;
  const res = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}
