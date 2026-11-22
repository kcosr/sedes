import { createHash } from "node:crypto";
import path from "node:path";
import { build } from "esbuild";

const admittedSources = new Set([
  "src/server/backends/antigravity/native-history-worker.ts",
  "src/server/backends/antigravity/native-history-reader.ts",
  "src/server/backends/antigravity/native-history.ts",
  "src/server/backends/antigravity/native-schema.ts",
  "src/server/backends/antigravity/native-protobuf.ts",
  "src/server/backends/antigravity/native-projection.json",
  "src/server/backends/antigravity/native-guards.ts",
  "src/server/backends/antigravity/native-execution.ts",
  "src/server/backends/antigravity/host/native-activity.ts",
  "src/server/backends/antigravity/port.ts",
  "src/server/provider-protocol/transport/framed-message-limits.ts",
]);
const admittedBuiltins = new Set(["node:sqlite", "node:crypto", "node:fs/promises", "node:os", "node:path", "node:url", "node:worker_threads"]);
export function assertAntigravityHistoryWorkerSourceOwnership(metafile, root, outputPath) {
  const sources = Object.keys(metafile.inputs).map(file => path.relative(root, path.resolve(root, file)).split(path.sep).join("/"));
  if ([...admittedSources].filter(file => !file.endsWith("native-history-reader.ts")).some(file => !sources.includes(file)) ||
      sources.some(file => !admittedSources.has(file) && !file.startsWith("node_modules/zod/")))
    throw new Error("antigravity_history_worker_source_forbidden");
  const output = Object.entries(metafile.outputs).find(([file]) => path.resolve(root, file) === outputPath)?.[1];
  if (!output || output.imports.some(value => !admittedBuiltins.has(value.path))) throw new Error("antigravity_history_worker_import_forbidden");
  const sqliteImporters = Object.entries(metafile.inputs).filter(([, value]) => value.imports.some(item => item.path === "node:sqlite"));
  if (sqliteImporters.length !== 1 || !sqliteImporters[0][0].endsWith("src/server/backends/antigravity/native-history.ts"))
    throw new Error("antigravity_history_worker_database_import_forbidden");
}
export async function buildAntigravityHistoryWorkerArtifact(root, buildId) {
  const filename = "sedes-antigravity-history-worker.mjs";
  const outputPath = path.join(root, "dist", "antigravity-history-worker", filename);
  const result = await build({ entryPoints: [path.join(root, "src/server/backends/antigravity/native-history-worker.ts")],
    outfile: outputPath, bundle: true, platform: "node", format: "esm", target: "node22", packages: "bundle",
    sourcemap: false, legalComments: "none", metafile: true, write: false });
  assertAntigravityHistoryWorkerSourceOwnership(result.metafile, root, outputPath);
  const artifact = result.outputFiles.find(file => path.resolve(file.path) === outputPath)?.contents;
  if (!artifact) throw new Error("antigravity_history_worker_output_missing");
  return { artifact, manifest: { schemaVersion: 1, artifactId: "openai.sedes.antigravity-history-worker", filename,
    sha256: createHash("sha256").update(artifact).digest("hex"), bytes: artifact.byteLength, buildId, minimumNodeVersion: "22.19.0" } };
}
