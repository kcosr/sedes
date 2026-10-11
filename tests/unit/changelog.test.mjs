import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { assertReleasedNotesUnchanged, checkChangelog, cleanNotes, parseChangelog, unreleasedTemplate } from "../../scripts/changelog.mjs";

const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const previous = "## [0.1.1] - 2026-09-21\n\n### Fixed\n\n- Existing fix (#1).\n\nInitial release\n";
const changelog = (notes = "### Added\n\n- A feature (#2).", history = previous) => `# Changelog\n\n## [Unreleased]\n\n${notes}\n\n${history}`;

function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "sedes-changelog-test-"));
  directories.push(root);
  return root;
}

describe("changelog validation", () => {
  it("accepts wrapped PR-linked notes, empty Unreleased templates, and the existing historical format", () => {
    const text = changelog("### Breaking Changes\n\n- Upgrade clients.\n  See [PR #2](https://example.invalid/pull/2).\n\n### Fixed");
    expect(parseChangelog(text).map((entry) => entry.name)).toEqual(["Unreleased", "0.1.1"]);
    expect(parseChangelog(`# Changelog\n\n${unreleasedTemplate}\n${previous}`)).toHaveLength(2);
    expect(parseChangelog(changelog(""))).toHaveLength(2);
    expect(cleanNotes(parseChangelog(text)[0].body)).not.toContain("### Fixed");
  });

  it("allows bootstrap notes only before the first release", () => {
    expect(parseChangelog(changelog("Initial release", ""))).toHaveLength(1);
    expect(() => parseChangelog(changelog("Initial release"))).toThrow("must be bullets");
  });

  it.each([
    ["duplicate Unreleased", changelog("### Added\n\n## [Unreleased]"), "Duplicate changelog version"],
    ["duplicate release", changelog("", `${previous}\n${previous}`), "Duplicate changelog version"],
    ["duplicate category", changelog("### Added\n\n- One.\n\n### Added\n\n- Two."), "Duplicate changelog category"],
    ["unknown category", changelog("### Maintenance\n\n- One."), "Unknown changelog category"],
    ["missing category", changelog("- One."), "must be bullets"],
    ["non-bullet notes", changelog("### Fixed\n\nA fix."), "must be bullets"],
    ["empty bullet", changelog("### Fixed\n\n- \n"), "Empty changelog note"],
    ["missing date", changelog("", "## [0.1.1]\n\n- One.\n"), "Malformed changelog release"],
    ["invalid date", changelog("", "## [0.1.1] - 2026-02-30\n\n- One.\n"), "Invalid changelog release date"],
    ["invalid version", changelog("", "## [01.1.1] - 2026-09-21\n\n- One.\n"), "Malformed changelog release"],
    ["missing heading space", changelog("", "##[0.1.1] - 2026-09-21\n\n- One.\n"), "Malformed changelog release"],
    ["empty release", changelog("", "## [0.1.1] - 2026-09-21\n\n### Fixed\n"), "No release notes"],
    ["ascending versions", changelog("", `${previous}\n## [0.2.0] - 2026-09-22\n\n- Later.\n`), "descending version order"],
  ])("rejects %s", (_name, text, message) => {
    expect(() => parseChangelog(text)).toThrow(message);
  });

  it("preserves released notes exactly while allowing new releases and Unreleased edits", () => {
    const baseline = changelog();
    const current = changelog("### Fixed\n\n- A fix (#3).", `## [0.2.0] - 2026-10-11\n\n### Added\n\n- A feature (#2).\n\n${previous}`);
    expect(() => assertReleasedNotesUnchanged(parseChangelog(current), baseline)).not.toThrow();
    for (const changed of [current.replace("Existing fix", "Edited fix"), current.replace(previous, ""), current.trimEnd() + "\n\n"]) {
      expect(() => assertReleasedNotesUnchanged(parseChangelog(changed), baseline)).toThrow("Released changelog notes for 0.1.1 changed");
    }
  });

  it("checks committed edits against the local main merge-base without contacting a remote", () => {
    const root = temporaryRoot();
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
    const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
    git("init", "-b", "main");
    git("config", "user.name", "Changelog test");
    git("config", "user.email", "changelog@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog());
    git("add", ".");
    git("commit", "-m", "baseline");
    const baseline = git("rev-parse", "HEAD");
    expect(checkChangelog(root).baseline).toBe(baseline); // HEAD fallback.
    git("update-ref", "refs/remotes/origin/main", baseline);
    git("switch", "-c", "feature");
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog().replace("Existing fix", "Altered history"));
    git("add", ".");
    git("commit", "-m", "change old notes");
    expect(() => checkChangelog(root)).toThrow("Released changelog notes for 0.1.1 changed");
  });

  it("validates source exports without requiring Git history", () => {
    const root = temporaryRoot();
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog());
    expect(checkChangelog(root).baseline).toBeNull();
    writeFileSync(path.join(root, "CHANGELOG.md"), changelog("### Fixed\n\n- "));
    expect(() => checkChangelog(root)).toThrow("Empty changelog note");
  });
});
