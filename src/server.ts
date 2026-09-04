import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import {
  AccountError,
  addClaudeToken,
  addOpenCodeKey,
  antigravitySessionStatus,
  beginAntigravityAdd,
  beginAntigravityRelogin,
  beginCodexAdd,
  beginCodexRelogin,
  codexSessionStatus,
  removeExtraAccount,
  renameExtraAccount,
  submitAntigravityCallback,
  submitCodexCallback,
} from "./accounts.ts";
import { ReportCache } from "./collect.ts";
import { CACHE_TTL_MS, VERSION } from "./config.ts";
import { run } from "./proc.ts";
import type { ProviderId, UpdateInfo } from "./types.ts";
import indexHtml from "./ui/index.html" with { type: "text" };
import antigravityLogo from "./ui/logos/antigravity.svg" with { type: "text" };
import claudeLogo from "./ui/logos/claude.svg" with { type: "text" };
import codexLogo from "./ui/logos/codex.svg" with { type: "text" };
import cursorLogo from "./ui/logos/cursor.svg" with { type: "text" };
import opencodeLogo from "./ui/logos/opencode.svg" with { type: "text" };

const LOGOS: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  cursor: cursorLogo,
  opencode: opencodeLogo,
  antigravity: antigravityLogo,
};

export interface ServerOptions {
  host: string;
  port: number;
  getUpdate: () => UpdateInfo | null;
}

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage, limit = 64_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        req.destroy();
        reject(new AccountError("Request body too large."));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readBody(req);
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AccountError("Expected a JSON object.");
  return parsed as Record<string, unknown>;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export async function startServer(opts: ServerOptions): Promise<{ close: () => void; urls: ListedUrl[] }> {
  const cache = new ReportCache(CACHE_TTL_MS, opts.getUpdate);
  // Warm the cache so the first page load is fast.
  void cache.get(true).catch(() => {});
  const tailscaleIp = await detectTailscaleIp();

  const mutated = async <T>(work: () => Promise<T>): Promise<T> => {
    const out = await work();
    cache.invalidate();
    return out;
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      const method = req.method ?? "GET";
      if (url.pathname === "/" && (method === "GET" || method === "HEAD")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(indexHtml);
        return;
      }
      const logo = url.pathname.match(/^\/logos\/([a-z]+)\.svg$/);
      if (logo && (method === "GET" || method === "HEAD")) {
        const svg = LOGOS[logo[1]!];
        if (!svg) {
          json(res, 404, { error: "not found" });
          return;
        }
        res.writeHead(200, { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=86400" });
        res.end(svg);
        return;
      }
      if (url.pathname === "/api/quotas" && (method === "GET" || method === "HEAD")) {
        const force = url.searchParams.get("refresh") === "1";
        json(res, 200, await cache.get(force));
        return;
      }
      if (url.pathname === "/api/health" && (method === "GET" || method === "HEAD")) {
        json(res, 200, { ok: true, version: VERSION });
        return;
      }
      if (url.pathname === "/api/accounts" && method === "POST") {
        const body = await readJson(req);
        const provider = str(body.provider) as ProviderId;
        const label = str(body.label) || undefined;
        const secret = str(body.secret);
        if (provider === "claude") {
          json(res, 200, await mutated(() => addClaudeToken(secret, label)));
          return;
        }
        if (provider === "opencode") {
          json(res, 200, await mutated(() => addOpenCodeKey(secret, label)));
          return;
        }
        json(res, 400, { error: "Add Claude with a setup-token, OpenCode with an API key, or start a Codex / Antigravity sign-in." });
        return;
      }
      if (url.pathname === "/api/accounts/antigravity/start" && method === "POST") {
        const body = await readJson(req);
        const accountId = str(body.accountId);
        json(
          res,
          200,
          accountId ? await beginAntigravityRelogin(accountId) : await beginAntigravityAdd(str(body.label) || undefined),
        );
        return;
      }
      if (url.pathname === "/api/accounts/antigravity/callback" && method === "POST") {
        const body = await readJson(req);
        json(res, 200, { ok: true, account: await mutated(() => submitAntigravityCallback(str(body.sessionId), str(body.url))) });
        return;
      }
      const agySession = url.pathname.match(/^\/api\/accounts\/antigravity\/session\/([^/]+)$/);
      if (agySession && (method === "GET" || method === "HEAD")) {
        json(res, 200, antigravitySessionStatus(decodeURIComponent(agySession[1]!)));
        return;
      }
      if (url.pathname === "/api/accounts/codex/start" && method === "POST") {
        const body = await readJson(req);
        const accountId = str(body.accountId);
        json(
          res,
          200,
          accountId ? await beginCodexRelogin(accountId) : await beginCodexAdd(str(body.label) || undefined),
        );
        return;
      }
      if (url.pathname === "/api/accounts/codex/callback" && method === "POST") {
        const body = await readJson(req);
        await submitCodexCallback(str(body.sessionId), str(body.url));
        json(res, 200, { ok: true });
        return;
      }
      const session = url.pathname.match(/^\/api\/accounts\/codex\/session\/([^/]+)$/);
      if (session && (method === "GET" || method === "HEAD")) {
        const state = codexSessionStatus(decodeURIComponent(session[1]!));
        if (state.status === "done") cache.invalidate();
        json(res, 200, state);
        return;
      }
      const remove = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (remove && method === "PATCH") {
        const body = await readJson(req);
        json(res, 200, { account: await mutated(async () => renameExtraAccount(decodeURIComponent(remove[1]!), str(body.label))) });
        return;
      }
      if (remove && method === "DELETE") {
        json(res, 200, { account: await mutated(() => removeExtraAccount(decodeURIComponent(remove[1]!))) });
        return;
      }
      if (method !== "GET" && method !== "HEAD" && method !== "POST" && method !== "DELETE" && method !== "PATCH") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      if (e instanceof AccountError) {
        json(res, e.status, { error: e.message });
        return;
      }
      if (e instanceof SyntaxError) {
        json(res, 400, { error: "Invalid JSON." });
        return;
      }
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      resolve({ close: () => server.close(), urls: reachableUrls(opts.host, opts.port, tailscaleIp) });
    });
  });
}

function isTailscale(ip: string): boolean {
  // Tailscale hands out CGNAT addresses 100.64.0.0/10.
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

export interface ListedUrl {
  kind: "local" | "network" | "tailscale";
  url: string;
}

/** Logged-in Tailscale IPv4, or null if the CLI isn't installed / isn't authed. */
export async function detectTailscaleIp(): Promise<string | null> {
  const res = await run("tailscale", ["status", "--json"], { timeoutMs: 4000 });
  if (res.code !== 0) return null;
  try {
    const body = JSON.parse(res.stdout) as { BackendState?: string; Self?: { TailscaleIPs?: unknown } };
    if (body.BackendState !== "Running") return null;
    const ips = body.Self?.TailscaleIPs ?? (body as { TailscaleIPs?: unknown }).TailscaleIPs;
    if (!Array.isArray(ips)) return null;
    for (const ip of ips) {
      if (typeof ip === "string" && isTailscale(ip)) return ip;
    }
    return null;
  } catch {
    return null;
  }
}

/** Human-friendly list of URLs the server can be reached on. */
export function reachableUrls(host: string, port: number, tailscaleIp: string | null = null): ListedUrl[] {
  if (host !== "0.0.0.0" && host !== "::") {
    return [{ kind: "local", url: `http://${host === "::1" ? "localhost" : host}:${port}` }];
  }
  const urls: ListedUrl[] = [{ kind: "local", url: `http://127.0.0.1:${port}` }];
  const shortHost = hostname().replace(/\.local$/, "").toLowerCase();
  if (shortHost) urls.push({ kind: "network", url: `http://${shortHost}:${port}` });
  const seen = new Set<string>(tailscaleIp ? [tailscaleIp] : []);
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== "IPv4" || iface.internal || seen.has(iface.address)) continue;
      if (isTailscale(iface.address)) continue;
      seen.add(iface.address);
      urls.push({ kind: "network", url: `http://${iface.address}:${port}` });
    }
  }
  if (tailscaleIp) {
    urls.push({ kind: "tailscale", url: `http://${tailscaleIp}:${port}` });
  }
  return urls;
}
