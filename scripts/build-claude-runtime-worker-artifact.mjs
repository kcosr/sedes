import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";
import { assertClaudeRuntimeWorkerSourceOwnership } from "./claude-runtime-worker-source-ownership.mjs";

/** Build once from reviewed sources for both the standalone worker and sidecar. */
export async function buildClaudeRuntimeWorkerArtifact(repositoryRoot, buildId) {
  const filename = "sedes-claude-runtime-worker.mjs";
  const outputPath = path.join(repositoryRoot, "dist", "claude-runtime-worker", filename);
  const result = await build({
    entryPoints: [
      path.join(
        repositoryRoot,
        "src/server/backends/claude/worker/claude-runtime-worker-main.ts",
      ),
    ],
    outfile: outputPath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    packages: "bundle",
    sourcemap: false,
    legalComments: "none",
    define: {
      __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__: JSON.stringify(buildId),
    },
    metafile: true,
    write: false,
  });
  assertClaudeRuntimeWorkerSourceOwnership(result.metafile, repositoryRoot, outputPath);
  const output = result.outputFiles?.find(
    (candidate) => path.resolve(candidate.path) === outputPath,
  );
  if (!output) throw new Error("claude_runtime_worker_build_output_missing");
  const artifact = output.contents;
  const manifest = {
    schemaVersion: 1,
    artifactId: "openai.sedes.claude-runtime-worker",
    filename,
    modes: ["claude_runtime"],
    sha256: createHash("sha256").update(artifact).digest("hex"),
    bytes: artifact.byteLength,
    buildId,
    minimumNodeVersion: "24.18.0",
  };
  return { artifact, manifest };
}
