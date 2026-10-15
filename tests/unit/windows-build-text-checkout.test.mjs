import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { checkChangelog } from "../../scripts/changelog.mjs";
import { checkAgentToolArtifacts } from "../../src/server/agent-tools/schema/check-agent-tool-artifacts.js";

it("keeps strict build text checks valid in a CRLF Git checkout", () => {
  const repository = fileURLToPath(new URL("../../", import.meta.url));
  const root = mkdtempSync(path.join(os.tmpdir(), "sedes-crlf-checkout-"));
  const artifactDirectory = "src/server/agent-tools/schema/artifacts";
  const profileDirectory = "protocol/grok-acp/1.0.4";
  const profileFiles = readdirSync(path.join(repository, profileDirectory), { recursive: true })
    .filter((filename) => lstatSync(path.join(repository, profileDirectory, filename)).isFile())
    .map((filename) => path.join(profileDirectory, filename));
  const filenames = [
    ".gitattributes", "CHANGELOG.md",
    "scripts/grok-probes/check-grok-profile.mjs", ...profileFiles,
    // Retained historical contracts are immutable checked inputs too.
    ...readdirSync(path.join(repository, artifactDirectory))
      .filter((filename) => /^[a-z][a-z0-9_.-]*\.v[1-9][0-9]*\.json$/.test(filename))
      .map((filename) => path.join(artifactDirectory, filename)),
  ];
  const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = path.join(root, "global.gitconfig");
  const git = (...arguments_) => execFileSync("git", arguments_, { cwd: root, env: environment, stdio: "pipe" });
  try {
    writeFileSync(environment.GIT_CONFIG_GLOBAL, "");
    for (const filename of filenames) {
      const target = path.join(root, filename);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(path.join(repository, filename)));
    }
    writeFileSync(path.join(root, "ordinary.txt"), "ordinary\ntext\n");
    git("init", "-q");
    git("config", "core.autocrlf", "true");
    git("add", ".");
    for (const filename of [...filenames, "ordinary.txt"]) rmSync(path.join(root, filename));
    git("checkout-index", "--all", "--force");

    // The ordinary file proves this is a real CRLF checkout; the scoped rules
    // retain LF only where generated/baseline comparisons require exact text.
    expect(readFileSync(path.join(root, "ordinary.txt"), "utf8")).toBe("ordinary\r\ntext\r\n");
    expect(() => checkChangelog(root)).not.toThrow();
    expect(() => checkAgentToolArtifacts((url) =>
      readFileSync(path.join(root, path.relative(repository, fileURLToPath(url))), "utf8"),
      () => readdirSync(path.join(root, artifactDirectory))
        .filter((filename) => /^[a-z][a-z0-9_.-]*\.v[1-9][0-9]*\.json$/.test(filename)),
    )).not.toThrow();
    // Run the real checker against the checked-out profile. It validates both
    // canonical JSON and exact pinned byte counts/hashes, including help text.
    expect(() => execFileSync(process.execPath, [
      path.join(root, "scripts/grok-probes/check-grok-profile.mjs"),
    ], { cwd: root, env: environment, stdio: "pipe" })).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
