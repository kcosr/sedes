import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const directories = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "sedes-release-test-"));
  directories.push(directory);
  const root = path.join(directory, "checkout"), remote = path.join(directory, "origin.git");
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GH_STATE: path.join(directory, "gh.json") };
  delete env.NODE_ENV;
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[key];
  const git = (...args) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: "pipe" }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "tag.gpgsign", "false");
  git("init", "--bare", remote);
  git("config", `url.${remote}.insteadOf`, "https://github.com/kcosr/sedes.git");
  git("remote", "add", "origin", "https://github.com/kcosr/sedes.git");
  for (const file of ["scripts/release.mjs", "scripts/version.mjs", "src/shared/version.ts", "package.json", "package-lock.json", "electron/package.json", "electron/package-lock.json", "packages/electron-client-credentials/package.json", "packages/electron-connection-runtime/package.json", "packages/server-runtime/package.json", "packages/server-runtime/package-lock.json", "packages/electron-workspace-file-download/package.json"]) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    cpSync(path.join(source, file), path.join(root, file));
  }
  const write = (file, content) => writeFileSync(path.join(root, file), content);
  const read = (file) => readFileSync(path.join(root, file), "utf8");
  execFileSync(process.execPath, ["scripts/version.mjs", "set", "0.1.0"], { cwd: root, env, stdio: "pipe" });
  write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\nInitial release\n");
  const commit = () => { git("add", "."); git("commit", "-m", "fixture"); };
  commit();
  git("push", "-u", "origin", "main");
  const bin = path.join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(env.GH_STATE, JSON.stringify({ releases: [], failCreate: false, failList: false, creates: 0 }));
  writeFileSync(path.join(bin, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
const args = process.argv.slice(2);
if (args[0] === 'api') {
  if (state.failList) { console.error('API unavailable'); process.exit(1); }
  console.log(JSON.stringify([state.releases]));
} else if (args[0] === 'release' && args[1] === 'create') {
  if (state.failCreate) { console.error('creation unavailable'); process.exit(1); }
  state.creates++;
  const tag = args[2];
  state.releases.push({tag_name: tag, name: tag, body: fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8'), draft: false, prerelease: false, html_url: 'https://example.invalid/releases/' + tag});
  fs.writeFileSync(process.env.GH_STATE, JSON.stringify(state));
  console.log(state.releases.at(-1).html_url);
} else { process.exit(2); }
`, { mode: 0o755 });
  env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const state = () => JSON.parse(readFileSync(env.GH_STATE, "utf8"));
  const setState = (values) => writeFileSync(env.GH_STATE, JSON.stringify({ ...state(), ...values }));
  const run = (...args) => {
    const result = spawnSync(process.execPath, ["scripts/release.mjs", ...args], { cwd: root, env, encoding: "utf8" });
    return { status: result.status, output: result.stdout + result.stderr };
  };
  const prepared = () => {
    expect(run("prepare", "0.1.0").status).toBe(0);
    commit();
    git("push", "origin", "main");
  };
  return { git, write, read, commit, run, state, setState, prepared, remote };
}

describe("source release workflow", () => {
  it("previews without changes, then prepares the initial notes and fresh template", () => {
    const f = fixture();
    expect(f.run("prepare", "0.1.0", "--dry-run").status).toBe(0);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.git("tag")).toBe("");
    expect(f.run("prepare", "0.1.0").status).toBe(0);
    expect(f.read("CHANGELOG.md")).toMatch(/## \[0.1.0\] - \d{4}-\d{2}-\d{2}\n\nInitial release\n$/);
    expect(f.read("CHANGELOG.md")).toContain("## [Unreleased]\n\n### Breaking Changes");
    expect(f.git("tag")).toBe("");
  });

  it.each([["patch", "0.1.1"], ["minor", "0.2.0"], ["major", "1.0.0"]])("increments %s and synchronizes all product versions", (increment, expected) => {
    const f = fixture();
    expect(f.run("prepare", increment).status).toBe(0);
    expect(JSON.parse(f.read("package.json")).version).toBe(expected);
    expect(JSON.parse(f.read("electron/package-lock.json")).version).toBe(expected);
    expect(JSON.parse(f.read("packages/server-runtime/package.json")).version).toBe(expected);
    expect(JSON.parse(f.read("packages/server-runtime/package-lock.json")).packages[""].version).toBe(expected);
    expect(f.read("src/shared/version.ts")).toContain(`"${expected}"`);
    // Preparation's version helper checks every package and workspace lock entry.
    f.commit();
    const retry = f.run("prepare", expected);
    expect(retry.status).toBe(1);
    expect(retry.output).toContain("already prepared");
  });

  it("strips empty headings, preserves older notes, and refuses empty notes", () => {
    const f = fixture();
    f.write("CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n### Added\n\n### Fixed\n\n- A fix (#7).\n\n### Removed\n\n## [0.0.1] - 2026-01-01\n\nOld notes\n");
    f.commit();
    expect(f.run("prepare", "patch").status).toBe(0);
    expect(f.read("CHANGELOG.md")).toMatch(/## \[0.1.1\][^\n]*\n\n### Fixed\n\n- A fix \(#7\).\n\n## \[0.0.1\]/);
    f.commit();
    expect(f.run("prepare", "patch").output).toContain("no release notes");
  });

  it("refuses dirty trees, malformed versions, downgrades, and existing tags", () => {
    const f = fixture();
    f.write("scratch", "dirty");
    expect(f.run("prepare", "patch").output).toContain("clean working tree");
    f.commit();
    for (const version of ["01.1.0", "0.1.0-rc.1", "0.0.9"]) expect(f.run("prepare", version).status).toBe(1);
    f.git("tag", "-a", "v0.2.0", "-m", "already released");
    expect(f.run("prepare", "0.1.1").output).toContain("newer than v0.2.0");
    expect(f.run("prepare", "0.2.0").output).toContain("already exists");
  });

  it("requires prepared notes, main, synchronized origin, and matching versions", () => {
    const f = fixture();
    expect(f.run("publish", "0.1.0").output).toContain("latest changelog release");
    f.prepared();
    expect(f.run("publish", "0.2.0").output).toContain("Package version");
    f.git("switch", "-c", "feature");
    expect(f.run("publish", "0.1.0").output).toContain("requires main");
    f.git("switch", "main");
    f.write("extra", "new commit");
    f.commit();
    expect(f.run("publish", "0.1.0").output).toContain("match origin/main");
    expect(f.git("tag")).toBe("");
  });

  it("publishes an annotated tag and exact notes, then retries without duplication", () => {
    const f = fixture();
    f.prepared();
    expect(f.run("publish", "0.1.0", "--dry-run").status).toBe(0);
    expect(f.git("tag")).toBe("");
    expect(f.state().creates).toBe(0);
    const head = f.git("rev-parse", "HEAD");
    f.git("config", "push.followTags", "true");
    f.git("tag", "-a", "unrelated-tag", "-m", "Must stay local");
    expect(f.run("publish", "0.1.0").status).toBe(0);
    expect(f.git("ls-remote", "origin", "refs/tags/unrelated-tag")).toBe("");
    expect(f.git("cat-file", "-t", "refs/tags/v0.1.0")).toBe("tag");
    expect(f.git("rev-parse", "v0.1.0^{commit}")).toBe(head);
    expect(f.state().releases[0].body).toBe("Initial release\n");
    expect(f.run("publish", "0.1.0").output).toContain("Already published");
    expect(f.state().creates).toBe(1);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(f.git("rev-parse", "HEAD")).toBe(head);
  });

  it("recovers after tag push succeeds but GitHub creation fails, even without a local tag", () => {
    const f = fixture();
    f.prepared();
    f.setState({ failCreate: true });
    expect(f.run("publish", "0.1.0").status).toBe(1);
    const tag = f.git("rev-parse", "refs/tags/v0.1.0");
    expect(f.git("ls-remote", "origin", "refs/tags/v0.1.0")).toContain(tag);
    f.git("tag", "-d", "v0.1.0");
    f.setState({ failCreate: false });
    expect(f.run("publish", "0.1.0").status).toBe(0);
    expect(f.git("ls-remote", "origin", "refs/tags/v0.1.0")).toContain(tag);
    expect(f.state().creates).toBe(1);
  });

  it("reuses the local annotated tag after a failed push", () => {
    const f = fixture();
    f.prepared();
    const hook = path.join(f.remote, "hooks/pre-receive");
    writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(f.run("publish", "0.1.0").status).toBe(1);
    const tag = f.git("rev-parse", "refs/tags/v0.1.0");
    expect(f.state().creates).toBe(0);
    rmSync(hook);
    expect(f.run("publish", "0.1.0").status).toBe(0);
    expect(f.git("rev-parse", "refs/tags/v0.1.0")).toBe(tag);
    expect(f.state().creates).toBe(1);
  });

  it("refuses an origin push URL for a different repository", () => {
    const f = fixture();
    f.prepared();
    f.git("config", "remote.origin.pushurl", "https://github.com/other/repository.git");
    expect(f.run("publish", "0.1.0").output).toContain("fetch and push URLs");
    expect(f.git("tag")).toBe("");
  });

  it("stops on API failure or conflicting release metadata without replacing it", () => {
    const f = fixture();
    f.prepared();
    f.setState({ failList: true });
    expect(f.run("publish", "0.1.0").output).toContain("API unavailable");
    expect(f.git("tag")).toBe("");
    f.setState({ failList: false });
    expect(f.run("publish", "0.1.0").status).toBe(0);
    f.setState({ releases: [{ ...f.state().releases[0], body: "Different notes" }] });
    expect(f.run("publish", "0.1.0").output).toContain("differs from this release");
    expect(f.state().creates).toBe(1);
  });

  it("refuses lightweight tags and remote tags at another commit", () => {
    const f = fixture();
    f.prepared();
    f.git("tag", "v0.1.0");
    expect(f.run("publish", "0.1.0").output).toContain("must be annotated");
    f.git("tag", "-d", "v0.1.0");
    f.git("tag", "-a", "v0.1.0", "HEAD~1", "-m", "wrong commit");
    f.git("push", "origin", "refs/tags/v0.1.0");
    f.git("tag", "-d", "v0.1.0");
    expect(f.run("publish", "0.1.0").output).toContain("Remote v0.1.0");
    expect(f.state().creates).toBe(0);
  });
});
