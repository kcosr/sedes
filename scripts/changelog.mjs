import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

export const changelogCategories = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];
export const unreleasedTemplate = `## [Unreleased]\n\n${changelogCategories.map((name) => `### ${name}\n`).join("\n")}`;
const versionPattern = "(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)";
const releaseHeading = new RegExp(`^## \\[(${versionPattern})\\] - (\\d{4}-\\d{2}-\\d{2})$`);

export function cleanNotes(body) {
  return body.split(/(?=^### )/m).filter((chunk) => !/^### [^\n]+\s*$/.test(chunk)).join("").trim();
}

export function parseChangelog(text) {
  if (!text.startsWith("# Changelog\n")) throw new Error("CHANGELOG.md must start with # Changelog.");
  const headings = [...text.matchAll(/^##(?!#)[^\n]*/gm)];
  if (headings[0]?.[0] !== "## [Unreleased]") throw new Error("CHANGELOG.md must start with an Unreleased section.");
  const names = new Set();
  let previousVersion;
  return headings.map((heading, index) => {
    const match = heading[0] === "## [Unreleased]" ? null : heading[0].match(releaseHeading);
    if (index > 0 && !match && heading[0] !== "## [Unreleased]") {
      throw new Error(`Malformed changelog release heading: ${heading[0]}`);
    }
    const name = match?.[1] ?? "Unreleased";
    if (names.has(name)) throw new Error(`Duplicate changelog version heading: ${name}`);
    names.add(name);
    if (match) {
      const date = new Date(`${match[2]}T00:00:00Z`);
      if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== match[2]) {
        throw new Error(`Invalid changelog release date: ${match[2]}`);
      }
      const version = name.split(".").map(BigInt);
      if (previousVersion) {
        const differingPart = version.findIndex((part, i) => part !== previousVersion[i]);
        if (differingPart < 0 || version[differingPart] > previousVersion[differingPart]) {
          throw new Error("Changelog releases must be in descending version order.");
        }
      }
      previousVersion = version;
    }
    const start = heading.index;
    const end = headings[index + 1]?.index ?? text.length;
    const body = text.slice(start + heading[0].length, end).trim();
    const categories = [...body.matchAll(/^###(?!#)[^\n]*/gm)];
    const seen = new Set();
    for (const category of categories) {
      const title = category[0].slice(4);
      if (category[0] !== `### ${title}` || !changelogCategories.includes(title)) {
        throw new Error(`Unknown changelog category in ${name}: ${category[0]}`);
      }
      if (seen.has(title)) throw new Error(`Duplicate changelog category in ${name}: ${title}`);
      seen.add(title);
    }
    if (/^-\s*$/m.test(body)) throw new Error(`Empty changelog note in ${name}.`);
    if (name === "Unreleased") {
      // The original bootstrap format is allowed only before the first release.
      if (!(headings.length === 1 && body === "Initial release")) {
        let inCategory = false;
        let inNote = false;
        for (const line of body.split("\n")) {
          if (!line.trim()) continue;
          if (line.startsWith("### ")) { inCategory = true; inNote = false; continue; }
          if (inCategory && /^- \S/.test(line)) { inNote = true; continue; }
          if (inNote && /^ {2,}\S/.test(line)) continue;
          throw new Error("Unreleased notes must be bullets under a changelog category.");
        }
      }
    } else if (!cleanNotes(body)) {
      throw new Error(`No release notes for ${name}.`);
    }
    return { name, suffix: match ? ` - ${match[2]}` : "", start, end, body, raw: text.slice(start, end) };
  });
}

export function assertReleasedNotesUnchanged(entries, baseline) {
  const current = new Map(entries.map((entry) => [entry.name, entry.raw]));
  for (const entry of parseChangelog(baseline).slice(1)) {
    if (current.get(entry.name) !== entry.raw) {
      throw new Error(`Released changelog notes for ${entry.name} changed; put corrections under Unreleased.`);
    }
  }
}

function localBaseline(root) {
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return result.status === 0 ? result.stdout : null;
  };
  // Source archives need no Git checkout or network access to validate structure.
  const top = git("rev-parse", "--show-toplevel")?.trim();
  if (!top || path.resolve(top) !== path.resolve(root)) return null;
  const head = git("rev-parse", "--verify", "HEAD")?.trim();
  if (!head) return null;
  const revision = git("merge-base", head, "refs/remotes/origin/main")?.trim() ?? head;
  const text = git("show", `${revision}:CHANGELOG.md`);
  if (text === null) throw new Error(`Cannot read CHANGELOG.md from local baseline ${revision}.`);
  return { revision, text };
}

export function checkChangelog(root, text = readFileSync(path.join(root, "CHANGELOG.md"), "utf8")) {
  const entries = parseChangelog(text);
  const baseline = localBaseline(root);
  if (baseline) assertReleasedNotesUnchanged(entries, baseline.text);
  return { entries, baseline: baseline?.revision ?? null };
}
