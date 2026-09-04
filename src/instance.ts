import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { PACKAGE_NAME, DEFAULT_PORT, ensureDir, paths } from "./config.ts";
import { fetchJson, isObject } from "./adapters/common.ts";
import { log } from "./log.ts";
import { run } from "./proc.ts";

export interface RunRecord {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
}

export function looksLikeJustUsageCommand(command: string): boolean {
  const s = command.replace(/\\/g, "/").toLowerCase();
  return s.includes("just-usage") || /\/just-usage\/(?:src\/|dist\/)?cli\.(ts|js)\b/.test(s);
}

export function parseRunRecord(raw: string): RunRecord | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) return null;
    const pid = typeof parsed.pid === "number" ? parsed.pid : Number(parsed.pid);
    const port = typeof parsed.port === "number" ? parsed.port : Number(parsed.port);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    return {
      pid,
      port,
      host: typeof parsed.host === "string" && parsed.host ? parsed.host : "0.0.0.0",
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

export function writeRunRecord(opts: { port: number; host: string }): void {
  ensureDir(paths.runDir());
  writeFileSync(
    paths.runRecord(opts.port),
    JSON.stringify({
      pid: process.pid,
      port: opts.port,
      host: opts.host,
      startedAt: new Date().toISOString(),
    } satisfies RunRecord),
    { encoding: "utf8", mode: 0o600 },
  );
}

export function readRunRecord(port: number): RunRecord | null {
  const file = paths.runRecord(port);
  if (!existsSync(file)) return null;
  return parseRunRecord(readFileSync(file, "utf8"));
}

export function removeRunRecord(port: number): void {
  const file = paths.runRecord(port);
  try {
    unlinkSync(file);
  } catch {
    // Missing file is fine — stop and crash recovery both land here.
  }
}

export function listRunPorts(): number[] {
  const dir = paths.runDir();
  if (!existsSync(dir)) return [];
  const ports: number[] = [];
  for (const name of readdirSync(dir)) {
    const m = name.match(/^(\d+)\.json$/);
    if (!m) continue;
    const port = Number(m[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
  }
  return ports.sort((a, b) => a - b);
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function processCommand(pid: number): Promise<string> {
  if (process.platform === "win32") {
    const res = await run("wmic", ["process", "where", `ProcessId=${pid}`, "get", "CommandLine", "/value"], { timeoutMs: 5000 });
    const line = res.stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.toLowerCase().startsWith("commandline="));
    return line ? line.slice(line.indexOf("=") + 1).trim() : "";
  }
  const res = await run("ps", ["-p", String(pid), "-www", "-o", "command="], { timeoutMs: 5000 });
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s && !/^command$/i.test(s)) ?? "";
}

export async function pidsOnPort(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    const res = await run("netstat", ["-ano"], { timeoutMs: 8000 });
    const re = new RegExp(`[:\\[]${port}\\]?(?:\\s+\\S+){1,2}\\s+LISTENING\\s+(\\d+)`, "gi");
    const pids = new Set<number>();
    for (const m of res.stdout.matchAll(re)) {
      const pid = Number(m[1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids];
  }
  const res = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeoutMs: 8000 });
  const pids = new Set<number>();
  for (const line of res.stdout.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

export interface HealthInfo {
  ok: boolean;
  version: string | null;
  name: string | null;
  pid: number | null;
}

export function parseHealth(body: unknown): HealthInfo | null {
  if (!isObject(body) || body.ok !== true) return null;
  const pid = typeof body.pid === "number" && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
  return {
    ok: true,
    version: typeof body.version === "string" ? body.version : null,
    name: typeof body.name === "string" ? body.name : null,
    pid,
  };
}

export function isJustUsageHealth(info: HealthInfo | null): boolean {
  if (!info?.ok) return false;
  if (info.name && info.name !== PACKAGE_NAME) return false;
  return info.name === PACKAGE_NAME || Boolean(info.version);
}

export async function fetchHealth(port: number): Promise<HealthInfo | null> {
  try {
    const res = await fetchJson(`http://127.0.0.1:${port}/api/health`, { timeoutMs: 2000 });
    if (res.status !== 200) return null;
    return parseHealth(res.body);
  } catch {
    return null;
  }
}

async function oursOnPort(port: number): Promise<{ pids: number[]; health: HealthInfo | null; listening: boolean }> {
  const record = readRunRecord(port);
  const listeners = await pidsOnPort(port);
  const health = await fetchHealth(port);
  const ours = new Set<number>();
  const known = new Set<number>(listeners);
  if (record && processAlive(record.pid)) known.add(record.pid);
  if (health?.pid && processAlive(health.pid)) known.add(health.pid);

  for (const pid of known) {
    if (pid === process.pid) continue;
    const command = await processCommand(pid);
    const listening = listeners.includes(pid);
    if (looksLikeJustUsageCommand(command) || (isJustUsageHealth(health) && (listening || pid === record?.pid || pid === health?.pid))) {
      ours.add(pid);
    }
  }
  return { pids: [...ours], health, listening: listeners.length > 0 };
}

async function terminate(pids: number[]): Promise<void> {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline && pids.some(processAlive)) {
    await new Promise((r) => setTimeout(r, 80));
  }
  for (const pid of pids) {
    if (!processAlive(pid)) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Last try; the process may have exited between the check and the signal.
    }
  }
}

export type StopResult =
  | { status: "stopped"; port: number; pids: number[] }
  | { status: "idle"; port: number }
  | { status: "busy"; port: number };

export async function stopPort(port: number): Promise<StopResult> {
  const found = await oursOnPort(port);
  if (found.pids.length === 0) {
    if (found.listening && !isJustUsageHealth(found.health)) {
      log("warn", "stop.busy", { port });
      return { status: "busy", port };
    }
    removeRunRecord(port);
    log("info", "stop.idle", { port });
    return { status: "idle", port };
  }
  await terminate(found.pids);
  removeRunRecord(port);
  log("info", "stop.ok", { port, pids: found.pids });
  return { status: "stopped", port, pids: found.pids };
}

export async function stopServers(opts: { port?: number; all?: boolean }): Promise<StopResult[]> {
  const ports = opts.all
    ? [...new Set([DEFAULT_PORT, ...listRunPorts(), ...(opts.port ? [opts.port] : [])])]
    : [opts.port ?? DEFAULT_PORT];
  const out: StopResult[] = [];
  for (const port of ports) out.push(await stopPort(port));
  return out;
}

export function formatStopResults(results: StopResult[]): { text: string; code: number } {
  const stopped = results.filter((r): r is Extract<StopResult, { status: "stopped" }> => r.status === "stopped");
  const busy = results.filter((r) => r.status === "busy");
  const lines: string[] = [];
  for (const r of stopped) {
    lines.push(`Stopped ${PACKAGE_NAME} on port ${r.port} (pid ${r.pids.join(", ")}).`);
  }
  for (const r of busy) {
    lines.push(`Port ${r.port} is in use, but it is not a ${PACKAGE_NAME} server.`);
  }
  if (stopped.length === 0 && busy.length === 0) {
    if (results.length === 1) lines.push(`No ${PACKAGE_NAME} server is running on port ${results[0]!.port}.`);
    else lines.push(`No ${PACKAGE_NAME} server is running.`);
  }
  const code = busy.length ? 1 : stopped.length ? 0 : 1;
  return { text: lines.join("\n"), code };
}
