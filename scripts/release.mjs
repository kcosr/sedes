#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env };
delete env.NODE_ENV;
env.GH_HOST = "github.com";
const sections = ["Breaking Changes", "Added", "Changed", "Fixed", "Removed"];
const template = `## [Unreleased]\n\n${sections.map((name) => `### ${name}\n`).join("\n")}`;
const repository = "kcosr/sedes";

function run(command, args, input) {
  return execFileSync(command, args, { cwd: root, env, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function git(...args) { return run("git", args); }
function fail(message) { throw new Error(message); }
function assertClean() {
  if (git("status", "--porcelain")) fail("A clean working tree is required; commit your reviewed changes first.");
}
function parseVersion(value) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) fail(`Expected a stable X.Y.Z version: ${value}`);
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) fail("Version component exceeds the safe integer range.");
  return parts;
}
function compare(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function targetVersion(argument, current) {
  const parts = parseVersion(current);
  const index = ["major", "minor", "patch"].indexOf(argument);
  if (index >= 0) {
    parts[index]++;
    for (let i = index + 1; i < 3; i++) parts[i] = 0;
    argument = parts.join(".");
  }
  const version = argument.replace(/^v/, "");
  parseVersion(version);
  if (compare(version, current) < 0) fail("The release version cannot go backwards.");
  return version;
}
function changelogSections(text) {
  const headings = [...text.matchAll(/^## \[([^\]]+)\]([^\n]*)\n/gm)];
  if (headings[0]?.[1] !== "Unreleased") fail("CHANGELOG.md must start with an Unreleased section.");
  if (new Set(headings.map((heading) => heading[1])).size !== headings.length) fail("Duplicate changelog version headings.");
  return headings.map((heading, i) => ({
    name: heading[1], suffix: heading[2], start: heading.index,
    end: headings[i + 1]?.index ?? text.length,
    body: text.slice(heading.index + heading[0].length, headings[i + 1]?.index ?? text.length).trim(),
  }));
}
function cleanNotes(body) {
  const chunks = body.split(/(?=^### )/m);
  return chunks.filter((chunk) => !/^### [^\n]+\s*$/.test(chunk)).join("").trim();
}
function remoteRefs() {
  return new Map(git("ls-remote", "origin", "refs/heads/main", "refs/tags/v*", "refs/tags/v*^{}")
    .split("\n").filter(Boolean).map((line) => { const [sha, ref] = line.split(/\s+/); return [ref, sha]; }));
}
function assertOrigin() {
  // Use the configured URL (before Git's insteadOf transport rewriting).
  const urls = git("config", "--get-regexp", "^remote\\.origin\\.(url|pushurl)$").split("\n").map((line) => line.slice(line.indexOf(" ") + 1));
  const allowed = [`https://github.com/${repository}.git`, `https://github.com/${repository}`, `git@github.com:${repository}.git`, `ssh://git@github.com/${repository}.git`];
  if (urls.some((url) => !allowed.includes(url))) {
    fail(`origin fetch and push URLs must point to ${repository}.`);
  }
}
function assertNewVersion(version, refs) {
  if (git("tag", "--list", `v${version}`) || refs.has(`refs/tags/v${version}`)) fail(`Tag v${version} already exists.`);
  const versions = [...git("tag", "--list", "v*").split("\n"), ...[...refs.keys()].map((ref) => ref.replace("refs/tags/", ""))];
  for (const tag of versions) {
    if (/^v\d+\.\d+\.\d+$/.test(tag) && compare(version, tag.slice(1)) <= 0) fail(`Version must be newer than ${tag}.`);
  }
}

function prepare(argument, dryRun, current, text) {
  if (!git("branch", "--show-current")) fail("Prepare on a branch, not a detached HEAD.");
  const version = targetVersion(argument, current);
  const entries = changelogSections(text);
  if (entries.some((entry) => entry.name === version)) fail(`${version} is already prepared in CHANGELOG.md.`);
  assertNewVersion(version, remoteRefs());
  const notes = cleanNotes(entries[0].body);
  if (!notes) fail("Unreleased has no release notes.");
  for (const entry of entries.slice(1)) {
    if (compare(version, entry.name) <= 0) fail(`Version must be newer than changelog entry ${entry.name}.`);
  }
  const date = new Date().toISOString().slice(0, 10);
  const next = `${text.slice(0, entries[0].start)}${template}\n## [${version}] - ${date}\n\n${notes}\n\n${text.slice(entries[0].end)}`.trimEnd() + "\n";
  console.log(`${dryRun ? "Would prepare" : "Preparing"} v${version} (${current} → ${version})\n\n${notes}`);
  if (dryRun) return;
  run(process.execPath, ["scripts/version.mjs", "set", version]);
  writeFileSync(path.join(root, "CHANGELOG.md"), next);
  console.log("Prepared version and changelog. Review, verify, commit, and merge before publishing.");
}

function publish(argument, dryRun, current, text) {
  const version = argument.replace(/^v/, "");
  parseVersion(version);
  if (version !== current) fail(`Package version is ${current}, not ${version}.`);
  if (git("branch", "--show-current") !== "main") fail("Publish requires main.");
  const head = git("rev-parse", "HEAD");
  const refs = remoteRefs();
  if (refs.get("refs/heads/main") !== head) fail("main must match origin/main; fetch and fast-forward first.");
  const entry = changelogSections(text)[1];
  if (entry?.name !== version || !/^ - \d{4}-\d{2}-\d{2}$/.test(entry.suffix)) fail(`The latest changelog release must be dated ${version}. Run release:prepare first.`);
  const notes = cleanNotes(entry.body);
  if (!notes) fail(`No release notes for ${version}.`);
  const tag = `v${version}`, ref = `refs/tags/${tag}`;
  const remoteTag = refs.get(ref);
  const localTag = git("tag", "--list", tag);
  if (localTag && (git("cat-file", "-t", ref) !== "tag" || git("rev-parse", `${ref}^{commit}`) !== head)) fail(`${tag} must be annotated and point to HEAD; it will not be replaced.`);
  if (remoteTag && refs.get(`${ref}^{}`) !== head) fail(`Remote ${tag} is not an annotated tag at HEAD; it will not be replaced.`);
  if (remoteTag && localTag && git("rev-parse", ref) !== remoteTag) fail(`Local and remote ${tag} objects differ; resolve this without moving the published tag.`);

  // A list failure is fatal, not evidence that a release is absent.
  const releases = JSON.parse(run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]));
  const existing = releases.flat().find((release) => release.tag_name === tag);
  if (existing) {
    if (!remoteTag || existing.draft || existing.prerelease || existing.name !== tag || existing.body?.trim() !== notes) fail(`GitHub release ${tag} differs from this release; inspect it manually.`);
    console.log(`Already published: ${existing.html_url}`);
    return;
  }
  console.log(`${dryRun ? "Would publish" : "Publishing"} ${tag} at ${head}\nRepository: ${repository}\n\n${notes}`);
  if (dryRun) return;
  // Recheck after network preflight before making a tag or publishing anything.
  assertClean();
  if (git("branch", "--show-current") !== "main" || git("rev-parse", "HEAD") !== head || remoteRefs().get("refs/heads/main") !== head) fail("main changed during preflight; retry.");
  if (!remoteTag) {
    if (!localTag) git("tag", "-a", tag, head, "-m", `Release ${tag}`);
    git("push", "--no-follow-tags", "origin", `${ref}:${ref}`);
  }
  const directory = mkdtempSync(path.join(tmpdir(), "sedes-release-"));
  try {
    const file = path.join(directory, "notes.md");
    writeFileSync(file, `${notes}\n`);
    console.log(run("gh", ["release", "create", tag, "--repo", repository, "--verify-tag", "--title", tag, "--notes-file", file]));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

try {
  const [command, argument, ...options] = process.argv.slice(2);
  if (!["prepare", "publish"].includes(command) || !argument || options.some((option) => option !== "--dry-run")) {
    fail("Usage: node scripts/release.mjs prepare <X.Y.Z|patch|minor|major> [--dry-run] | publish <X.Y.Z> [--dry-run]");
  }
  assertClean();
  assertOrigin();
  run(process.execPath, ["scripts/version.mjs", "check"]);
  const current = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  const text = readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
  (command === "prepare" ? prepare : publish)(argument, options.includes("--dry-run"), current, text);
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
