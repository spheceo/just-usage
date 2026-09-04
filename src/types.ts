export type ProviderId = "claude" | "codex" | "cursor" | "opencode";

export const PROVIDERS: ReadonlyArray<{ id: ProviderId; name: string; bin: string }> = [
  { id: "claude", name: "Claude", bin: "claude" },
  { id: "codex", name: "Codex", bin: "codex" },
  { id: "cursor", name: "Cursor", bin: "cursor-agent" },
  { id: "opencode", name: "OpenCode Go", bin: "opencode" },
];

export function providerName(id: ProviderId): string {
  return PROVIDERS.find((p) => p.id === id)?.name ?? id;
}

/** "rolling" = sliding window (5h / weekly). "cycle" = billing period / monthly. */
export type WindowKind = "rolling" | "cycle";

export interface QuotaWindow {
  id: string;
  label: string;
  /** Percent of the window already used, 0-100. null when the provider did not say. */
  usedPercent: number | null;
  /** ISO-8601 instant when the window resets. null when unknown. */
  resetsAt: string | null;
  windowMinutes: number | null;
  kind: WindowKind;
  note?: string;
}

export type SnapshotStatus = "ok" | "signed_out" | "unsupported" | "error";

/** "default" = the CLI's own login. "profile" = isolated CLI home we created. "token" = a key/token we store. */
export type AccountKind = "default" | "profile" | "token";

export interface ResetCredit {
  id: string;
  title: string | null;
  status: string | null;
  expiresAt: string | null;
}

export interface QuotaSnapshot {
  account: {
    id: string;
    provider: ProviderId;
    label: string;
    email: string | null;
    plan: string | null;
    kind: AccountKind;
  };
  status: SnapshotStatus;
  message: string | null;
  windows: QuotaWindow[];
  resetCredits: { availableCount: number; credits: ResetCredit[] } | null;
  fetchedAt: string;
}

/** A persisted, user-added account. Default accounts are discovered, never stored. */
export interface AccountRecord {
  id: string;
  provider: ProviderId;
  label: string;
  kind: Exclude<AccountKind, "default">;
  /** Isolated CLI home directory (profile accounts). */
  path?: string;
  email?: string | null;
  createdAt: string;
}

/** Runtime view of an account the collector should fetch. */
export interface ResolvedAccount {
  id: string;
  provider: ProviderId;
  label: string;
  kind: AccountKind;
  path?: string;
  email?: string | null;
}

export interface ProviderReport {
  id: ProviderId;
  name: string;
  installed: boolean;
  version: string | null;
  accounts: QuotaSnapshot[];
}

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  checkedAt: string;
}

export interface UsageReport {
  version: string;
  hostname: string;
  fetchedAt: string;
  update: UpdateInfo | null;
  providers: ProviderReport[];
}
