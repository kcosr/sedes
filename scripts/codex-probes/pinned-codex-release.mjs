import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE = "0.153.0";
const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const releaseRoot = path.join(
  repositoryRoot,
  "protocol",
  "codex-app-server",
  RELEASE,
);
const release = JSON.parse(
  readFileSync(path.join(releaseRoot, "release.json"), "utf8"),
);
const platform = release.generation.supportedPlatforms.find(
  (candidate) =>
    candidate.nodePlatform === process.platform &&
    candidate.nodeArch === process.arch,
);

if (platform === undefined) {
  throw new Error(
    `Codex ${RELEASE} probes do not have reviewed artifact evidence for ` +
      `${process.platform}/${process.arch}.`,
  );
}

export const codexBinary = path.join(
  repositoryRoot,
  "node_modules",
  platform.nativePackage,
  ...platform.executableRelativePath.split("/"),
);

export function assertPinnedCodexRelease() {
  const executableSha256 = createHash("sha256")
    .update(readFileSync(codexBinary))
    .digest("hex");
  if (executableSha256 !== platform.executableSha256) {
    throw new Error(
      "Codex probe executable does not match the pinned release SHA-256.",
    );
  }
  const version = execFileSync(codexBinary, ["--version"], {
    encoding: "utf8",
  }).trim();
  if (version !== `codex-cli ${RELEASE}`) {
    throw new Error(
      `Codex probe expected codex-cli ${RELEASE}, received ${JSON.stringify(version)}.`,
    );
  }
  return {
    release: RELEASE,
    nativeExecutableSha256: executableSha256,
  };
}
