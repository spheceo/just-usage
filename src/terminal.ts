import { formatPercent, formatResetIn, severity } from "./format.ts";
import type { QuotaSnapshot, UsageReport } from "./types.ts";

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s: string) => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
};

function bar(used: number | null, width = 20): string {
  if (used === null) return c.dim("░".repeat(width));
  const filled = Math.round((used / 100) * width);
  const s = "█".repeat(filled) + c.dim("░".repeat(width - filled));
  const sev = severity(used);
  return sev === "crit" ? c.red(s) : sev === "warn" ? c.yellow(s) : s;
}

function pct(used: number | null): string {
  if (used === null) return "  —  ";
  const s = formatPercent(used).padStart(5);
  const sev = severity(used);
  return sev === "crit" ? c.red(s) : sev === "warn" ? c.yellow(s) : s;
}

function renderAccount(a: QuotaSnapshot, now: number): string[] {
  const lines: string[] = [];
  const title = a.account.email ?? a.account.label;
  const extras = [a.account.label !== "Default" && a.account.label !== title ? a.account.label : null, a.account.plan].filter(Boolean).join(" · ");
  lines.push(`  ${c.bold(title)}${extras ? c.dim(`  ${extras}`) : ""}`);
  if (a.status !== "ok") {
    lines.push(`    ${c.dim(a.status.replace("_", " "))}  ${a.message ?? ""}`);
    return lines;
  }
  const labelWidth = Math.max(6, ...a.windows.map((w) => w.label.length));
  for (const w of a.windows) {
    const reset = formatResetIn(w.resetsAt, now, w.kind);
    lines.push(`    ${w.label.padEnd(labelWidth)}  ${bar(w.usedPercent)}  ${pct(w.usedPercent)} used${reset ? c.dim(`  ${reset}`) : ""}`);
  }
  if (a.resetCredits && a.resetCredits.availableCount > 0) {
    lines.push(`    ${c.dim(`${a.resetCredits.availableCount} rate-limit reset(s) banked`)}`);
  }
  return lines;
}

export function renderReport(report: UsageReport, now: number = Date.now()): string {
  const out: string[] = [];
  for (const p of report.providers) {
    out.push(`${c.bold(p.name)}${p.version ? c.dim(`  v${p.version}`) : ""}${p.installed ? "" : c.dim("  not installed")}`);
    if (p.accounts.length === 0) out.push(c.dim("  no accounts"));
    for (const a of p.accounts) out.push(...renderAccount(a, now));
    out.push("");
  }
  if (report.update?.available) {
    out.push(c.yellow(`Update available: v${report.update.current} → v${report.update.latest}. Run: just-usage upgrade`));
  }
  return out.join("\n");
}
