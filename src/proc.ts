import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
}

/** Run a command, capture output. Never throws for non-zero exit; throws for spawn failures other than ENOENT (which yields code null). */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    };
    const child = spawn(cmd, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\n[just-usage] timed out";
      finish(null);
    }, opts.timeoutMs ?? 15_000);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      stderr += String(err);
      finish(null);
    });
    child.on("close", (code) => finish(code));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** Run interactively, inheriting the terminal. Resolves with the exit code. */
export function runInteractive(cmd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

const whichCache = new Map<string, Promise<string | null>>();

/** Resolve a binary on PATH. Cached for the process lifetime. */
export function which(bin: string): Promise<string | null> {
  let p = whichCache.get(bin);
  if (!p) {
    p = (async () => {
      const finder = process.platform === "win32" ? "where" : "which";
      const res = await run(finder, [bin], { timeoutMs: 5000 });
      if (res.code !== 0) return null;
      const first = res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      return first ?? null;
    })();
    whichCache.set(bin, p);
  }
  return p;
}

const versionCache = new Map<string, Promise<string | null>>();

/** `bin --version`, reduced to the first x.y.z-ish token. */
export function binVersion(bin: string): Promise<string | null> {
  let p = versionCache.get(bin);
  if (!p) {
    p = (async () => {
      const res = await run(bin, ["--version"], { timeoutMs: 8000 });
      const text = `${res.stdout}\n${res.stderr}`;
      const m = text.match(/\d+\.\d+\.\d+(?:[-.][0-9A-Za-z.-]+)?/);
      return m ? m[0] : null;
    })();
    versionCache.set(bin, p);
  }
  return p;
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Opening a browser is best-effort.
  }
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
