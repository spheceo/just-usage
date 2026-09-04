/** Pure helpers shared by the CLI, server and tests. */

export function parseSemver(v: string): { nums: number[]; pre: string | null } | null {
  const m = v.trim().replace(/^v/, "").match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** true when a > b */
export function semverGt(a: string, b: string): boolean {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return false;
  for (let i = 0; i < 3; i++) {
    const x = pa.nums[i] ?? 0;
    const y = pb.nums[i] ?? 0;
    if (x !== y) return x > y;
  }
  // Equal core: a release beats a prerelease; two prereleases compare lexically.
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true;
  if (pb.pre === null) return false;
  return pa.pre > pb.pre;
}

export function epochToIso(v: unknown): string | null {
  if (typeof v === "string" && /^\d+$/.test(v)) v = Number(v);
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  // Heuristic: seconds vs milliseconds.
  const ms = v < 1e12 ? v * 1000 : v;
  return new Date(ms).toISOString();
}

export function isoOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export function clampPercent(v: unknown): number | null {
  if (typeof v === "string" && v.trim() !== "") v = Number(v);
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return Math.min(100, Math.max(0, Math.round(v * 10) / 10));
}

export function windowLabel(minutes: number | null): string {
  if (minutes === null) return "Window";
  if (minutes === 300) return "5h";
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function formatDuration(ms: number): string {
  if (ms <= 0) return "now";
  const totalMin = Math.round(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${Math.max(1, m)}m`;
}

export function formatResetIn(resetsAt: string | null, now: number = Date.now(), kind: "rolling" | "cycle" = "rolling"): string | null {
  if (!resetsAt) return null;
  const t = Date.parse(resetsAt);
  if (!Number.isFinite(t)) return null;
  const diff = t - now;
  if (kind === "cycle") return diff <= 0 ? "renewing" : `renews in ${formatDuration(diff)}`;
  return diff <= 0 ? "resetting" : `resets in ${formatDuration(diff)}`;
}

export type Severity = "ok" | "warn" | "crit";

/** Bars turn yellow at 60% used and red at 85% used. */
export function severity(usedPercent: number | null): Severity | null {
  if (usedPercent === null) return null;
  if (usedPercent >= 85) return "crit";
  if (usedPercent >= 60) return "warn";
  return "ok";
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "account";
}
