export type ChangeCommit = {
  sha: string;
  subject: string;
};

const RELEASE_SUBJECT = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function githubRepoFromRemote(url: string): string {
  const trimmed = url.trim().replace(/\.git$/, "");
  const match = trimmed.match(/github\.com[:/]([^/]+\/[^/]+)$/);
  return match?.[1] ?? "spheceo/just-usage";
}

export function parseCommitLog(raw: string): ChangeCommit[] {
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf("\t");
      if (sep === -1) return null;
      const sha = line.slice(0, sep).trim();
      const subject = line.slice(sep + 1).trim();
      if (!sha || !subject || RELEASE_SUBJECT.test(subject)) return null;
      return { sha, subject };
    })
    .filter((row): row is ChangeCommit => row !== null);
}

export function formatReleaseNotes(_version: string, commits: ChangeCommit[], repo: string): string {
  const lines = commits.map((commit) => {
    const short = commit.sha.slice(0, 7);
    return `${commit.subject} in [#${short}](https://github.com/${repo}/commit/${commit.sha})`;
  });
  return `## What's Changed\n${lines.join("\n")}\n`;
}

export function prependChangelog(existing: string, notes: string, version: string): string {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const section = `## ${tag}\n\n${notes.trim()}\n`;
  const body = existing.replace(/^# Changelog\s*/i, "").trim();
  return body ? `# Changelog\n\n${section}\n${body}\n` : `# Changelog\n\n${section}`;
}

export function extractReleaseNotes(changelog: string, version: string): string | null {
  const tag = version.startsWith("v") ? version : `v${version}`;
  const heading = `## ${tag}`;
  const start = changelog.indexOf(`${heading}\n`);
  if (start === -1) return null;
  const after = changelog.slice(start + heading.length).replace(/^\n+/, "");
  const next = after.search(/\n## v\d/);
  const notes = (next === -1 ? after : after.slice(0, next)).trim();
  return notes ? `${notes}\n` : null;
}
