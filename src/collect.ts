import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { formatHostname } from "./format.ts";
import { fetchSnapshot } from "./adapters/index.ts";
import { snapshot } from "./adapters/common.ts";
import { FETCH_TIMEOUT_MS, VERSION } from "./config.ts";
import { log } from "./log.ts";
import { binVersion, clearBinCache, which, withTimeout } from "./proc.ts";
import { listAccounts } from "./registry.ts";
import { PROVIDERS, type ProviderId, type ProviderReport, type QuotaSnapshot, type ResolvedAccount, type UpdateInfo, type UsageReport } from "./types.ts";

export interface ProviderPresence {
  id: ProviderId;
  installed: boolean;
  version: string | null;
}

/** Marker files that mean the CLI has been installed or signed in, even if PATH is stale. */
export function providerHomeMarkers(id: ProviderId): string[] {
  const home = homedir();
  switch (id) {
    case "antigravity":
      return [
        join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token"),
        join(home, ".gemini", "antigravity-cli", "settings.json"),
        join(home, ".gemini", "antigravity-cli", "installation_id"),
      ];
    case "claude":
      return [join(home, ".claude", ".credentials.json"), join(home, ".claude", "settings.json")];
    case "codex":
      return [join(home, ".codex", "auth.json"), join(home, ".codex", "config.toml")];
    case "cursor":
      return [join(home, ".cursor", "auth.json")];
    case "grok":
      return [join(home, ".grok", "auth.json")];
    case "opencode": {
      const xdg = process.env.XDG_DATA_HOME;
      const base = xdg && xdg.trim() ? xdg : join(home, ".local", "share");
      return [join(base, "opencode", "auth.json")];
    }
  }
}

export function providerHomeExists(id: ProviderId): boolean {
  return providerHomeMarkers(id).some((file) => existsSync(file));
}

export function isProviderPresent(opts: { binPath: string | null; homeExists: boolean; provider: ProviderId }): boolean {
  if (opts.binPath) return true;
  if (opts.provider === "opencode") return true;
  return opts.homeExists;
}

export async function detectProviders(): Promise<ProviderPresence[]> {
  clearBinCache();
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const path = await which(p.bin, { fresh: true });
      const homeExists = providerHomeExists(p.id);
      const installed = isProviderPresent({ binPath: path, homeExists, provider: p.id });
      log("info", "detect", {
        provider: p.id,
        installed,
        path: path ?? undefined,
        home: homeExists || undefined,
      });
      return { id: p.id, installed, version: null };
    }),
  );
}

/** Default (CLI-owned) account plus any accounts the user added for this provider. */
export function resolveAccounts(provider: ProviderId, installed: boolean): ResolvedAccount[] {
  const out: ResolvedAccount[] = [];
  // Most defaults need the CLI. OpenCode's key file can exist without the binary.
  if (installed || provider === "opencode") {
    out.push({ id: `${provider}:default`, provider, label: "Default", kind: "default" });
  }
  for (const rec of listAccounts(provider)) {
    out.push({ id: rec.id, provider, label: rec.label, kind: rec.kind, path: rec.path, email: rec.email ?? null });
  }
  return out;
}

export async function fetchAccount(account: ResolvedAccount): Promise<QuotaSnapshot> {
  try {
    const snap = await withTimeout(fetchSnapshot(account), FETCH_TIMEOUT_MS, `${account.provider} fetch`);
    log(snap.status === "error" ? "error" : "info", "quotas.fetch", {
      account: snap.account.id,
      provider: snap.account.provider,
      status: snap.status,
      windows: snap.windows.length,
      message: snap.message ?? undefined,
    });
    return snap;
  } catch (e) {
    const snap = snapshot(account, "error", { message: e instanceof Error ? e.message : String(e) });
    log("error", "quotas.fetch", {
      account: account.id,
      provider: account.provider,
      status: snap.status,
      message: snap.message ?? undefined,
    });
    return snap;
  }
}

export async function collectReport(update: UpdateInfo | null, only?: ProviderId[]): Promise<UsageReport> {
  const presence = await detectProviders();
  const providers = await Promise.all(
    PROVIDERS.filter((p) => !only || only.includes(p.id)).map(async (p): Promise<ProviderReport> => {
      const pres = presence.find((x) => x.id === p.id)!;
      const accounts = resolveAccounts(p.id, pres.installed);
      const [snapshots, version] = await Promise.all([
        Promise.all(accounts.map(fetchAccount)),
        pres.installed ? binVersion((await which(p.bin)) ?? p.bin) : Promise.resolve(null),
      ]);
      return { id: p.id, name: p.name, installed: pres.installed, version, accounts: snapshots };
    }),
  );
  const accounts = providers.flatMap((p) => p.accounts);
  log("info", "quotas.collect", {
    providers: providers.length,
    accounts: accounts.length,
    ok: accounts.filter((a) => a.status === "ok").length,
    error: accounts.filter((a) => a.status === "error").length,
    signed_out: accounts.filter((a) => a.status === "signed_out").length,
    unsupported: accounts.filter((a) => a.status === "unsupported").length,
  });
  return {
    version: VERSION,
    hostname: formatHostname(hostname()),
    fetchedAt: new Date().toISOString(),
    update,
    providers,
  };
}

/** Memoizes the last report and de-duplicates concurrent refreshes. */
export class ReportCache {
  private report: UsageReport | null = null;
  private inflight: Promise<UsageReport> | null = null;
  constructor(
    private readonly ttlMs: number,
    private readonly getUpdate: () => UpdateInfo | null,
  ) {}

  get(force = false): Promise<UsageReport> {
    const cached = this.report ? { ...this.report, update: this.getUpdate() } : null;
    const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < this.ttlMs;
    if (!force && fresh) return Promise.resolve(cached);
    if (this.inflight) return cached && !force ? Promise.resolve(cached) : this.inflight;
    this.inflight = collectReport(this.getUpdate())
      .then((r) => {
        this.report = r;
        return r;
      })
      .finally(() => {
        this.inflight = null;
      });
    // Serve the last good report immediately while a refresh runs.
    if (!force && cached) return Promise.resolve(cached);
    return this.inflight;
  }

  peek(): UsageReport | null {
    return this.report ? { ...this.report, update: this.getUpdate() } : null;
  }

  invalidate() {
    this.report = null;
  }
}
