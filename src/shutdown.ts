import { log } from "./log.ts";
import { killAllChildren, stopAllChildren } from "./proc.ts";

export interface ShutdownOptions {
  /** SIGTERM → SIGKILL grace for each child group. */
  graceMs?: number;
  /** Exit no matter what after this long. */
  forceAfterMs?: number;
}

/**
 * Exit on SIGINT / SIGTERM / SIGHUP after reaping every tracked child.
 * A second signal, or a stuck cleanup, exits immediately. Any exit path
 * SIGKILLs whatever children are still tracked.
 */
export function installShutdown(onStop: () => void, opts: ShutdownOptions = {}): void {
  const graceMs = opts.graceMs ?? 1500;
  const forceAfterMs = opts.forceAfterMs ?? graceMs + 2000;
  let stopping = false;

  const shutdown = (signal: NodeJS.Signals) => {
    if (stopping) {
      killAllChildren();
      process.exit(1);
    }
    stopping = true;
    log("info", "serve.signal", { signal });
    setTimeout(() => {
      killAllChildren();
      process.exit(0);
    }, forceAfterMs).unref();
    try {
      onStop();
    } catch {
      // Still reap children and exit.
    }
    void stopAllChildren(graceMs).finally(() => process.exit(0));
  };

  process.on("exit", killAllChildren);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => shutdown(signal));
}
