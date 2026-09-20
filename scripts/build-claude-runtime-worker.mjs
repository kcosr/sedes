import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudeRuntimeWorkerArtifact } from "./build-claude-runtime-worker-artifact.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDirectory = path.join(repositoryRoot, "dist", "claude-runtime-worker");
const filename = "sedes-claude-runtime-worker.mjs";
const outputPath = path.join(outputDirectory, filename);
const manifestPath = path.join(outputDirectory, "manifest.json");
const packageMetadata = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const buildId = `sedes-${packageMetadata.version}`;

await mkdir(outputDirectory, { recursive: true });
await rm(outputPath, { force: true });
await rm(manifestPath, { force: true });
const { artifact, manifest } = await buildClaudeRuntimeWorkerArtifact(repositoryRoot, buildId);
await writeFile(outputPath, artifact, { mode: 0o500 });
await chmod(outputPath, 0o500);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o400,
});
