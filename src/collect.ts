import { hostname } from "node:os";
import { formatHostname } from "./format.ts";
import { fetchSnapshot } from "./adapters/index.ts";
import { snapshot } from "./adapters/common.ts";
import { FETCH_TIMEOUT_MS, VERSION } from "./config.ts";
import { binVersion, which, withTimeout } from "./proc.ts";
import { listAccounts } from "./registry.ts";
import { PROVIDERS, type ProviderId, type ProviderReport, type QuotaSnapshot, type ResolvedAccount, type UpdateInfo, type UsageReport } from "./types.ts";

export interface ProviderPresence {
  id: ProviderId;
  installed: boolean;
  version: string | null;
}

export async function detectProviders(): Promise<ProviderPresence[]> {
  return Promise.all(
    PROVIDERS.map(async (p) => {
      const path = await which(p.bin);
      return { id: p.id, installed: path !== null, version: null };
    }),
  );
}

/** Default (CLI-owned) account plus any accounts the user added for this provider. */
export function resolveAccounts(provider: ProviderId, installed: boolean): ResolvedAccount[] {
  const out: ResolvedAccount[] = [];
  // Cursor and Codex/Claude default accounts need the CLI. OpenCode's key file can exist without the binary.
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
    return await withTimeout(fetchSnapshot(account), FETCH_TIMEOUT_MS, `${account.provider} fetch`);
  } catch (e) {
    return snapshot(account, "error", { message: e instanceof Error ? e.message : String(e) });
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
        pres.installed ? binVersion(p.bin) : Promise.resolve(null),
      ]);
      return { id: p.id, name: p.name, installed: pres.installed, version, accounts: snapshots };
    }),
  );
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
