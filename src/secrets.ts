import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDir, paths } from "./config.ts";
import { run } from "./proc.ts";

/**
 * Stores tokens/keys the user hands us (Claude setup-tokens, OpenCode Go keys).
 * macOS: login Keychain (service "just-usage"). Elsewhere: a 0600 JSON file.
 * Force the file backend with JUST_USAGE_SECRET_STORE=file.
 */
export interface SecretStore {
  readonly kind: "keychain" | "file";
  get(id: string): Promise<string | null>;
  set(id: string, value: string): Promise<void>;
  delete(id: string): Promise<void>;
}

const SERVICE = "just-usage";

class KeychainStore implements SecretStore {
  readonly kind = "keychain" as const;
  async get(id: string): Promise<string | null> {
    const res = await run("security", ["find-generic-password", "-a", id, "-s", SERVICE, "-w"], { timeoutMs: 10_000 });
    if (res.code !== 0) return null;
    const v = res.stdout.replace(/\r?\n$/, "");
    return v || null;
  }
  async set(id: string, value: string): Promise<void> {
    // -U updates in place if the item exists.
    const res = await run("security", ["add-generic-password", "-U", "-a", id, "-s", SERVICE, "-w", value], { timeoutMs: 10_000 });
    if (res.code !== 0) throw new Error(`keychain write failed: ${res.stderr.trim() || res.code}`);
  }
  async delete(id: string): Promise<void> {
    await run("security", ["delete-generic-password", "-a", id, "-s", SERVICE], { timeoutMs: 10_000 });
  }
}

class FileStore implements SecretStore {
  readonly kind = "file" as const;
  private read(): Record<string, string> {
    const file = paths.secrets();
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }
  private write(data: Record<string, string>): void {
    const file = paths.secrets();
    ensureDir(dirname(file));
    writeFileSync(file, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  async get(id: string): Promise<string | null> {
    return this.read()[id] ?? null;
  }
  async set(id: string, value: string): Promise<void> {
    const data = this.read();
    data[id] = value;
    this.write(data);
  }
  async delete(id: string): Promise<void> {
    const data = this.read();
    delete data[id];
    this.write(data);
  }
}

let store: SecretStore | null = null;

export function secretStore(): SecretStore {
  if (!store) {
    const forced = process.env.JUST_USAGE_SECRET_STORE;
    store = process.platform === "darwin" && forced !== "file" ? new KeychainStore() : new FileStore();
  }
  return store;
}
