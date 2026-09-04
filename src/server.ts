import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { hostname, networkInterfaces } from "node:os";
import indexHtml from "./ui/index.html" with { type: "text" };
import { ReportCache } from "./collect.ts";
import { CACHE_TTL_MS, VERSION } from "./config.ts";
import type { UpdateInfo } from "./types.ts";

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

export function startServer(opts: ServerOptions): Promise<{ close: () => void; urls: string[] }> {
  const cache = new ReportCache(CACHE_TTL_MS, opts.getUpdate);
  // Warm the cache so the first page load is fast.
  void cache.get(true).catch(() => {});

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        json(res, 405, { error: "method not allowed" });
        return;
      }
      if (url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(indexHtml);
        return;
      }
      if (url.pathname === "/api/quotas") {
        const force = url.searchParams.get("refresh") === "1";
        json(res, 200, await cache.get(force));
        return;
      }
      if (url.pathname === "/api/health") {
        json(res, 200, { ok: true, version: VERSION });
        return;
      }
      json(res, 404, { error: "not found" });
    } catch (e) {
      json(res, 500, { error: e instanceof Error ? e.message : String(e) });
    }
  };

  const server = createServer((req, res) => void handler(req, res));
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      resolve({ close: () => server.close(), urls: reachableUrls(opts.host, opts.port) });
    });
  });
}

function isTailscale(ip: string): boolean {
  // Tailscale hands out CGNAT addresses 100.64.0.0/10.
  const [a, b] = ip.split(".").map(Number);
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/** Human-friendly list of URLs the server can be reached on. */
export function reachableUrls(host: string, port: number): string[] {
  if (host !== "0.0.0.0" && host !== "::") return [`http://${host === "::1" ? "localhost" : host}:${port}`];
  const urls = [`http://127.0.0.1:${port}`];
  const shortHost = hostname().replace(/\.local$/, "").toLowerCase();
  if (shortHost) urls.push(`http://${shortHost}:${port}`);
  const seen = new Set<string>();
  for (const list of Object.values(networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family !== "IPv4" || iface.internal || seen.has(iface.address)) continue;
      seen.add(iface.address);
      urls.push(`http://${iface.address}:${port}${isTailscale(iface.address) ? "  (tailscale)" : ""}`);
    }
  }
  return urls;
}
