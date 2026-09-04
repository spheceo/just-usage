import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDir, paths } from "./config.ts";
import { slugify } from "./format.ts";
import type { AccountRecord, ProviderId } from "./types.ts";

interface RegistryFile {
  version: 1;
  accounts: AccountRecord[];
}

function readRegistry(): RegistryFile {
  const file = paths.registry();
  if (!existsSync(file)) return { version: 1, accounts: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RegistryFile>;
    return { version: 1, accounts: Array.isArray(parsed.accounts) ? parsed.accounts : [] };
  } catch {
    return { version: 1, accounts: [] };
  }
}

function writeRegistry(reg: RegistryFile): void {
  const file = paths.registry();
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(reg, null, 2) + "\n", { mode: 0o600 });
}

export function listAccounts(provider?: ProviderId): AccountRecord[] {
  const all = readRegistry().accounts;
  return provider ? all.filter((a) => a.provider === provider) : all;
}

export function getAccount(id: string): AccountRecord | null {
  return readRegistry().accounts.find((a) => a.id === id) ?? null;
}

/** Build a unique id like `codex:work`. */
export function newAccountId(provider: ProviderId, hint: string): string {
  const existing = new Set(readRegistry().accounts.map((a) => a.id));
  const base = `${provider}:${slugify(hint)}`;
  if (base.endsWith(":default")) return newAccountId(provider, `${hint}-2`);
  if (!existing.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export function profileDirFor(provider: ProviderId, id: string): string {
  return join(paths.profiles(provider), id.split(":")[1] ?? "account");
}

export function saveAccount(record: AccountRecord): void {
  const reg = readRegistry();
  reg.accounts = reg.accounts.filter((a) => a.id !== record.id);
  reg.accounts.push(record);
  writeRegistry(reg);
}

export function updateAccount(id: string, patch: Partial<AccountRecord>): void {
  const reg = readRegistry();
  const idx = reg.accounts.findIndex((a) => a.id === id);
  if (idx === -1) return;
  reg.accounts[idx] = { ...reg.accounts[idx]!, ...patch, id };
  writeRegistry(reg);
}

/** Remove the registry entry and, for profile accounts, the isolated home directory we created. */
export function deleteAccount(id: string): AccountRecord | null {
  const reg = readRegistry();
  const record = reg.accounts.find((a) => a.id === id) ?? null;
  if (!record) return null;
  reg.accounts = reg.accounts.filter((a) => a.id !== id);
  writeRegistry(reg);
  if (record.kind === "profile" && record.path && record.path.startsWith(paths.profiles(record.provider))) {
    rmSync(record.path, { recursive: true, force: true });
  }
  return record;
}
