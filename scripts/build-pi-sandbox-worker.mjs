import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(repositoryRoot, "dist", "pi-sandbox-worker");
const outputPath = path.join(outputDirectory, "sedes-pi-sandbox-worker.mjs");
const manifestPath = path.join(outputDirectory, "manifest.json");
const packageMetadata = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const buildId = `sedes-${packageMetadata.version}`;

await mkdir(outputDirectory, { recursive: true });
await rm(outputPath, { force: true });
await rm(manifestPath, { force: true });
const result = await build({
  entryPoints: [
    path.join(
      repositoryRoot,
      "src/server/pi-sandbox/pi-sandbox-worker-main.ts",
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
  metafile: true,
  write: false,
});
assertWorkerSourceBoundary(result.metafile);
const output = result.outputFiles?.find(
  (candidate) => path.resolve(candidate.path) === outputPath,
);
if (!output) throw new Error("pi_sandbox_worker_build_output_missing");
await writeFile(outputPath, output.contents, { mode: 0o500 });
await chmod(outputPath, 0o500);
const artifact = await readFile(outputPath);
const manifest = {
  schemaVersion: 1,
  artifactId: "openai.sedes.pi-sandbox-worker",
  filename: "sedes-pi-sandbox-worker.mjs",
  sha256: createHash("sha256").update(artifact).digest("hex"),
  bytes: artifact.byteLength,
  buildId,
  minimumNodeVersion: "24.18.0",
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o400,
});

function assertWorkerSourceBoundary(metafile) {
  const inputs = Object.keys(metafile.inputs ?? {}).map((value) =>
    value.split(path.sep).join("/"),
  );
  const required = [
    "src/server/pi-sandbox/pi-sandbox-worker-main.ts",
    "src/server/workspace-tools/workspace-tool-engine.ts",
    "src/server/workspace-context/workspace-context-discovery.ts",
  ];
  if (required.some((value) => !inputs.some((input) => input.endsWith(value)))) {
    throw new Error("pi_sandbox_worker_required_source_missing");
  }
  const forbidden = [
    "src/client/",
    "src/server/backends/",
    "src/server/conversations/",
    "src/server/db/",
    "src/server/normalized-app.ts",
    "src/server/production-application.ts",
    "better-sqlite3",
    "node-pty",
  ];
  if (inputs.some((input) => forbidden.some((value) => input.includes(value)))) {
    throw new Error("pi_sandbox_worker_source_forbidden");
  }
}
