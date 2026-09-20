import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertClaudeRuntimeWorkerSourceOwnership } from "./claude-runtime-worker-source-ownership.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildScript = path.join(repositoryRoot, "scripts/build-claude-runtime-worker.mjs");
const outputPath = path.join(
  repositoryRoot,
  "dist/claude-runtime-worker/sedes-claude-runtime-worker.mjs",
);
const manifestPath = path.join(repositoryRoot, "dist/claude-runtime-worker/manifest.json");
const run = promisify(execFile);
const supportsPosixModes = process.platform !== "win32";

exerciseSourceBoundary();
const snapshots = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  await run(process.execPath, [buildScript], { cwd: repositoryRoot });
  const [artifact, manifestText, artifactStat, manifestStat] = await Promise.all([
    readFile(outputPath),
    readFile(manifestPath, "utf8"),
    stat(outputPath),
    stat(manifestPath),
  ]);
  const manifest = JSON.parse(manifestText);
  const sha256 = createHash("sha256").update(artifact).digest("hex");
  if (
    Object.keys(manifest).sort().join("\0") !==
      "artifactId\0buildId\0bytes\0filename\0minimumNodeVersion\0modes\0schemaVersion\0sha256" ||
    manifest.schemaVersion !== 1 ||
    manifest.artifactId !== "openai.sedes.claude-runtime-worker" ||
    manifest.filename !== "sedes-claude-runtime-worker.mjs" ||
    JSON.stringify(manifest.modes) !== JSON.stringify(["claude_runtime"]) ||
    manifest.minimumNodeVersion !== "24.18.0" ||
    manifest.sha256 !== sha256 ||
    manifest.bytes !== artifact.byteLength ||
    artifact.byteLength > 16 * 1_024 * 1_024 ||
    (supportsPosixModes &&
      ((artifactStat.mode & 0o777) !== 0o500 ||
        (manifestStat.mode & 0o777) !== 0o400))
  ) {
    throw new Error("claude_runtime_worker_build_invalid");
  }
  snapshots.push({ sha256, manifestText });
}
if (
  snapshots[0]?.sha256 !== snapshots[1]?.sha256 ||
  snapshots[0]?.manifestText !== snapshots[1]?.manifestText
) {
  throw new Error("claude_runtime_worker_build_not_repeatable");
}

function exerciseSourceBoundary() {
  const requiredInputs = {
    "src/server/backends/claude/worker/claude-runtime-worker-main.ts": {},
    "src/server/backends/claude/worker/claude-child-process-supervisor.ts": {},
    "src/server/backends/claude/worker/claude-outer-process-supervisor.ts": {},
    "src/server/backends/claude/worker/claude-worker-supervision-ipc.ts": {},
    "src/server/backends/claude/worker/tracked-claude-sdk-facade.ts": {},
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs": {},
  };
  const emitted = Object.fromEntries(
    Object.keys(requiredInputs).map((input) => [input, { bytesInOutput: 1 }]),
  );
  const metafile = (extra = {}) => ({
    inputs: { ...requiredInputs, ...extra },
    outputs: {
      "dist/claude-runtime-worker/sedes-claude-runtime-worker.mjs": {
        inputs: emitted,
      },
    },
  });
  assertClaudeRuntimeWorkerSourceOwnership(metafile(), repositoryRoot, outputPath);
  expectFailure(
    metafile({
      "node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/sdk": {},
    }),
    "claude_runtime_worker_platform_cli_included",
  );
  expectFailure(
    metafile({ "src/server/db/database.ts": {} }),
    "claude_runtime_worker_source_forbidden",
  );
}

function expectFailure(metafile, expected) {
  try {
    assertClaudeRuntimeWorkerSourceOwnership(metafile, repositoryRoot, outputPath);
  } catch (error) {
    if (error instanceof Error && error.message === expected) return;
    throw error;
  }
  throw new Error("claude_runtime_worker_source_boundary_inactive");
}
