// Test-only artifact: production daemon and managed worker, with the SDK facade
// replaced only at worker-main's provider boundary. Production builds never
// import this file or the offline SDK fixture.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";
import { collectSidecarNativeArtifacts, sidecarNodePtyPlugin } from "../../scripts/sidecar-native-artifacts.mjs";

const root = process.cwd();
const outputDirectory = process.argv[2];
if (!outputDirectory || !path.isAbsolute(outputDirectory)) throw new Error("fixture_output_directory_required");
const buildId = "sedes-outbound-claude-fixture";
const worker = await build({
  entryPoints: [path.join(root, "src/server/backends/claude/worker/claude-runtime-worker-main.ts")],
  outfile: path.join(outputDirectory, "worker.mjs"), bundle: true, platform: "node", format: "esm",
  target: "node24", packages: "bundle", write: false, legalComments: "none",
  define: { __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__: JSON.stringify(buildId) },
  plugins: [{ name: "offline-claude-sdk-at-worker-boundary", setup(context) {
    context.onResolve({ filter: /claude-sdk-facade\.js$/ }, args => {
      if (args.path === "../claude-sdk-facade.js" && args.importer === path.join(root, "src/server/backends/claude/worker/claude-runtime-worker-main.ts")) {
        return { path: path.join(root, "tests/support/outbound-claude-sdk-fixture.ts") };
      }
      return undefined;
    });
  } }],
});
const workerBytes = worker.outputFiles[0].contents;
const workerManifest = {
  schemaVersion: 1, artifactId: "openai.sedes.claude-runtime-worker", filename: "sedes-claude-runtime-worker.mjs",
  modes: ["claude_runtime"], sha256: createHash("sha256").update(workerBytes).digest("hex"),
  bytes: workerBytes.byteLength, buildId, minimumNodeVersion: "24.18.0",
};
const require = createRequire(import.meta.url);
const { nativeAssets, sources } = await collectSidecarNativeArtifacts({ nodePtyRoot: path.dirname(require.resolve("node-pty/package.json")) });
const sidecar = await build({
  entryPoints: [path.join(root, "src/server/sidecar/sedes-sidecar-main.ts")],
  outfile: path.join(outputDirectory, "sedes"), bundle: true, platform: "node", format: "esm",
  target: "node22", packages: "bundle", write: false, legalComments: "none",
  plugins: [sidecarNodePtyPlugin(nativeAssets)],
  banner: { js: "import { createRequire as sidecarCreateRequire } from 'node:module'; import { fileURLToPath as sidecarFileURLToPath } from 'node:url'; import { dirname as sidecarDirname } from 'node:path'; const require = sidecarCreateRequire(import.meta.url); const __dirname = sidecarDirname(sidecarFileURLToPath(import.meta.url));" },
  alias: { yaml: path.join(root, "node_modules/yaml/browser/index.js") },
  define: {
    __SEDES_SIDECAR_BUILD_ID__: JSON.stringify(buildId),
    __SEDES_CLAUDE_WORKER_SOURCE__: JSON.stringify(Buffer.from(workerBytes).toString("utf8")),
    __SEDES_CLAUDE_WORKER_MANIFEST__: JSON.stringify(JSON.stringify(workerManifest)),
    "process.env.WS_NO_BUFFER_UTIL": "true", "process.env.WS_NO_UTF_8_VALIDATE": "true",
  },
});
await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
const artifact = sidecar.outputFiles[0].contents;
await writeFile(path.join(outputDirectory, "sedes"), artifact, { mode: 0o500 });
for (const source of sources) {
  const target = path.join(outputDirectory, source.relativePath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, source.contents, { mode: 0o500 });
}
await writeFile(path.join(outputDirectory, "manifest.json"), JSON.stringify({
  schemaVersion: 6, artifactId: "openai.sedes.sidecar", filename: "sedes",
  modes: ["agent_tools_cli", "persistent_service"], nativeAssets,
  sha256: createHash("sha256").update(artifact).digest("hex"), bytes: artifact.byteLength,
  buildId, minimumNodeVersion: "22.19.0",
}), { mode: 0o400 });
