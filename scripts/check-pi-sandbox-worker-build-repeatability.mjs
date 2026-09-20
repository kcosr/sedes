import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(repositoryRoot, "scripts", "build-pi-sandbox-worker.mjs");
const artifactPath = path.join(
  repositoryRoot,
  "dist/pi-sandbox-worker/sedes-pi-sandbox-worker.mjs",
);
const manifestPath = path.join(repositoryRoot, "dist/pi-sandbox-worker/manifest.json");
const run = promisify(execFile);
const supportsPosixModes = process.platform !== "win32";
const snapshots = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  await run(process.execPath, [buildScript], { cwd: repositoryRoot });
  const [artifact, manifestText, artifactStat, manifestStat] = await Promise.all([
    readFile(artifactPath),
    readFile(manifestPath, "utf8"),
    stat(artifactPath),
    stat(manifestPath),
  ]);
  const manifest = JSON.parse(manifestText);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactId !== "openai.sedes.pi-sandbox-worker" ||
    manifest.filename !== "sedes-pi-sandbox-worker.mjs" ||
    manifest.minimumNodeVersion !== "24.18.0" ||
    manifest.sha256 !== sha256 ||
    manifest.bytes !== artifact.byteLength ||
    (supportsPosixModes &&
      ((artifactStat.mode & 0o777) !== 0o500 ||
        (manifestStat.mode & 0o777) !== 0o400))
  ) {
    throw new Error("pi_sandbox_worker_build_invalid");
  }
  snapshots.push({ sha256, manifestText });
}
if (
  snapshots[0]?.sha256 !== snapshots[1]?.sha256 ||
  snapshots[0]?.manifestText !== snapshots[1]?.manifestText
) {
  throw new Error("pi_sandbox_worker_build_not_repeatable");
}
