import { describe, expect, test } from "bun:test";
import {
  extractReleaseNotes,
  formatReleaseNotes,
  githubRepoFromRemote,
  parseCommitLog,
  prependChangelog,
} from "../scripts/changelog.ts";

describe("changelog notes", () => {
  test("parses commits and skips version-only subjects", () => {
    expect(
      parseCommitLog(
        [
          "abc1234\tAdd favicon",
          "def5678\tv0.0.2",
          "bad",
          "fff9999\tPublish to npm with Trusted Publishing instead of a stored token.",
        ].join("\n"),
      ),
    ).toEqual([
      { sha: "abc1234", subject: "Add favicon" },
      { sha: "fff9999", subject: "Publish to npm with Trusted Publishing instead of a stored token." },
    ]);
  });

  test("formats GitHub release body without a committer", () => {
    expect(
      formatReleaseNotes(
        "0.0.2",
        [
          { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subject: "Add settings, extra accounts, and Tailscale URLs" },
          { sha: "bbbbbbbccccccccccccccccccccccccccccccccc", subject: "Add favicon" },
        ],
        "spheceo/just-usage",
      ),
    ).toBe(
      [
        "Just Usage v0.0.2",
        "",
        "What's Changed",
        "Add settings, extra accounts, and Tailscale URLs in [#aaaaaaa](https://github.com/spheceo/just-usage/commit/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa)",
        "Add favicon in [#bbbbbbb](https://github.com/spheceo/just-usage/commit/bbbbbbbccccccccccccccccccccccccccccccccc)",
        "",
      ].join("\n"),
    );
  });

  test("prepends and extracts the same notes", () => {
    const notes = formatReleaseNotes(
      "v0.0.2",
      [{ sha: "abc1234deadbeef", subject: "Add favicon" }],
      "spheceo/just-usage",
    );
    const changelog = prependChangelog("", notes, "0.0.2");
    expect(changelog.startsWith("# Changelog\n\n## v0.0.2\n\n")).toBe(true);
    expect(extractReleaseNotes(changelog, "v0.0.2")).toBe(notes);
    expect(
      extractReleaseNotes(prependChangelog(changelog, "Just Usage v0.0.3\n\nWhat's Changed\nNext\n", "v0.0.3"), "v0.0.2"),
    ).toBe(notes);
  });

  test("reads owner/repo from git remotes", () => {
    expect(githubRepoFromRemote("git@github.com:spheceo/just-usage.git")).toBe("spheceo/just-usage");
    expect(githubRepoFromRemote("https://github.com/spheceo/just-usage.git")).toBe("spheceo/just-usage");
  });
});
