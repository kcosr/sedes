import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { buildClaudeRuntimeWorkerArtifact } from "./build-claude-runtime-worker-artifact.mjs";
import { assertSidecarSourceOwnership } from "./sidecar-source-ownership.mjs";
import {
  collectSidecarNativeArtifacts,
  sidecarNodePtyPlugin,
} from "./sidecar-native-artifacts.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const arguments_ = process.argv.slice(2);
if (
  arguments_.length !== 0 &&
  (arguments_.length !== 2 ||
    arguments_[0] !== "--output-directory" ||
    !path.isAbsolute(arguments_[1]) ||
    path.resolve(arguments_[1]) !== arguments_[1] ||
    path.dirname(arguments_[1]) === arguments_[1])
) {
  throw new Error("sidecar_build_output_directory_invalid");
}
const outputDirectory =
  arguments_[1] ?? path.join(repositoryRoot, "dist", "sidecar");
const filename = "sedes";
const outputPath = path.join(outputDirectory, filename);
const manifestPath = path.join(outputDirectory, "manifest.json");
const packageMetadata = JSON.parse(
  await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
);
const buildId = `sedes-${packageMetadata.version}`;
const claudeWorker = await buildClaudeRuntimeWorkerArtifact(repositoryRoot, buildId);
const require = createRequire(import.meta.url);
const { nativeAssets, sources } = await collectSidecarNativeArtifacts({
  nodePtyRoot: path.dirname(require.resolve("node-pty/package.json")),
});

await mkdir(outputDirectory, { recursive: true });
// Remove only the two exact generated targets. Their final owner-only modes
// deliberately make in-place truncation fail, and rebuilding must be
// repeatable without broad cleanup of the output directory.
await rm(outputPath, { force: true });
await rm(manifestPath, { force: true });
const result = await build({
  entryPoints: [
    path.join(
      repositoryRoot,
      "src",
      "server",
      "sidecar",
      "sedes-sidecar-main.ts",
    ),
  ],
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "esm",
  plugins: [sidecarNodePtyPlugin(nativeAssets)],
  banner: {
    js: "import { createRequire as sidecarCreateRequire } from 'node:module'; import { fileURLToPath as sidecarFileURLToPath } from 'node:url'; import { dirname as sidecarDirname } from 'node:path'; const require = sidecarCreateRequire(import.meta.url); const __dirname = sidecarDirname(sidecarFileURLToPath(import.meta.url));",
  },
  target: "node22",
  alias: {
    yaml: path.join(
      repositoryRoot,
      "node_modules",
      "yaml",
      "browser",
      "index.js",
    ),
  },
  packages: "bundle",
  sourcemap: false,
  legalComments: "none",
  define: {
    __SEDES_SIDECAR_BUILD_ID__: JSON.stringify(buildId),
    __SEDES_CLAUDE_WORKER_SOURCE__: JSON.stringify(Buffer.from(claudeWorker.artifact).toString("utf8")),
    __SEDES_CLAUDE_WORKER_MANIFEST__: JSON.stringify(JSON.stringify(claudeWorker.manifest)),
    "process.env.WS_NO_BUFFER_UTIL": "true",
    "process.env.WS_NO_UTF_8_VALIDATE": "true",
  },
  metafile: true,
  write: false,
});
assertSidecarSourceOwnership(result.metafile, repositoryRoot, outputPath);
const output = result.outputFiles?.find(
  (candidate) => path.resolve(candidate.path) === outputPath,
);
if (!output) throw new Error("sidecar_build_output_missing");
await writeFile(outputPath, output.contents, { mode: 0o500 });
await chmod(outputPath, 0o500);
const artifact = await readFile(outputPath);
for (const source of sources) {
  const target = path.join(outputDirectory, source.relativePath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await rm(target, { force: true });
  await writeFile(target, source.contents, { mode: 0o500 });
  await chmod(target, 0o500);
}
const manifest = {
  schemaVersion: 6,
  artifactId: "openai.sedes.sidecar",
  filename,
  modes: ["agent_tools_cli", "persistent_service"],
  nativeAssets,
  sha256: createHash("sha256").update(artifact).digest("hex"),
  bytes: artifact.byteLength,
  buildId,
  minimumNodeVersion: "22.19.0",
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  mode: 0o400,
});
