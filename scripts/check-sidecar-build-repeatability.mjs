import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { assertSidecarSourceOwnership } from "./sidecar-source-ownership.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const bundlePath = path.join(repositoryRoot, "dist", "sidecar", "sedes");
const manifestPath = path.join(
  repositoryRoot,
  "dist",
  "sidecar",
  "manifest.json",
);
const run = promisify(execFile);

const canonicalInputs = {
  "src/cli/sedes-dynamic-tool-command.ts": {},
  "src/cli/sedes-cli.ts": {},
  "src/cli/sedes-tool-local-client.ts": {},
  "src/server/composer-attachments/execution-attachment-staging-engine.ts": {},
  "src/server/workspace-files/workspace-files-engine.ts": {},
  "src/server/workspace-files/workspace-file-policy.ts": {},
  "src/server/workspace-files/canonical-mutation-serializer.ts": {},
  "src/server/workspace-tools/workspace-tool-engine.ts": {},
  "src/server/workspace-context/workspace-context-discovery.ts": {},
};
const syntheticOutputPath = path.join(
  repositoryRoot,
  "dist",
  "sidecar",
  "test.mjs",
);
const canonicalOutputInputs = {
  "src/cli/sedes-dynamic-tool-command.ts": { bytesInOutput: 1 },
  "src/cli/sedes-cli.ts": { bytesInOutput: 1 },
  "src/cli/sedes-tool-local-client.ts": { bytesInOutput: 1 },
  "src/server/composer-attachments/execution-attachment-staging-engine.ts": {
    bytesInOutput: 1,
  },
  "src/server/workspace-files/workspace-files-engine.ts": { bytesInOutput: 1 },
  "src/server/workspace-files/workspace-file-policy.ts": { bytesInOutput: 1 },
  "src/server/workspace-files/canonical-mutation-serializer.ts": {
    bytesInOutput: 1,
  },
  "src/server/workspace-tools/workspace-tool-engine.ts": { bytesInOutput: 1 },
  "src/server/workspace-context/workspace-context-discovery.ts": {
    bytesInOutput: 1,
  },
};
const ownershipMetafile = (inputs, outputInputs = canonicalOutputInputs) => ({
  inputs,
  outputs: {
    "dist/sidecar/test.mjs": { inputs: outputInputs },
  },
});
assertSidecarSourceOwnership(
  ownershipMetafile(canonicalInputs),
  repositoryRoot,
  syntheticOutputPath,
);
assertSidecarSourceOwnership(
  {
    inputs: canonicalInputs,
    outputs: {
      "dist/sidecar/test.mjs": {
        inputs: canonicalOutputInputs,
        imports: [
          { path: "node:http", kind: "import-statement", external: true },
          { path: "node:https", kind: "import-statement", external: true },
        ],
      },
    },
  },
  repositoryRoot,
  syntheticOutputPath,
);
expectOwnershipFailure(
  ownershipMetafile({
    "src/server/workspace-files/workspace-files-engine.ts": {},
  }),
  "sidecar_build_shared_source_missing",
);
expectOwnershipFailure(
  ownershipMetafile({
    ...canonicalInputs,
    "src/server/sidecar/workspace-files-engine.ts": {},
  }),
  "sidecar_build_shared_source_duplicate",
);
expectOwnershipFailure(
  ownershipMetafile({
    ...canonicalInputs,
    "src/server/sidecar/workspace-file-policy.js": {},
  }),
  "sidecar_build_shared_source_duplicate",
);
expectOwnershipFailure(
  ownershipMetafile(canonicalInputs, {
    ...canonicalOutputInputs,
    "src/server/workspace-files/workspace-file-policy.ts": {
      bytesInOutput: 0,
    },
  }),
  "sidecar_build_shared_source_not_emitted",
);
for (const forbiddenSource of [
  "src/server/db/repositories/inventory-repository.ts",
  "src/server/backends/pi/pi-sdk-session.ts",
  "src/client/workspace-files/WorkspaceFilesPanel.tsx",
  "src/server/normalized-app.ts",
  "src/server/runtime/backend-module-startup.ts",
]) {
  expectOwnershipFailure(
    ownershipMetafile({
      ...canonicalInputs,
      [forbiddenSource]: {},
    }),
    "sidecar_build_source_forbidden",
  );
}
expectOwnershipFailure(
  {
    inputs: canonicalInputs,
    outputs: {
      "dist/sidecar/test.mjs": {
        inputs: canonicalOutputInputs,
        imports: [{ path: "node:sqlite", kind: "import-statement" }],
      },
    },
  },
  "sidecar_build_database_import_forbidden",
);
expectOwnershipFailure(
  ownershipMetafile({
    ...canonicalInputs,
    "node_modules/better-sqlite3/lib/index.js": {},
  }),
  "sidecar_build_source_forbidden",
);
expectOwnershipFailure(
  {
    inputs: canonicalInputs,
    outputs: {
      "dist/sidecar/test.mjs": {
        inputs: canonicalOutputInputs,
        imports: [{ path: "pg", kind: "import-statement", external: true }],
      },
    },
  },
  "sidecar_build_database_import_forbidden",
);
expectOwnershipFailure(
  {
    inputs: canonicalInputs,
    outputs: {
      "dist/sidecar/test.mjs": {
        inputs: canonicalOutputInputs,
        imports: [
          { path: "node:dns", kind: "import-statement", external: true },
        ],
      },
    },
  },
  "sidecar_build_external_import_forbidden",
);

const snapshots = [];
for (let attempt = 0; attempt < 2; attempt += 1) {
  await run(
    process.execPath,
    [path.join(repositoryRoot, "scripts", "build-sidecar.mjs")],
    { cwd: repositoryRoot },
  );
  const [bundle, manifestText, bundleMetadata, manifestMetadata] =
    await Promise.all([
      readFile(bundlePath),
      readFile(manifestPath, "utf8"),
      stat(bundlePath),
      stat(manifestPath),
    ]);
  const manifest = JSON.parse(manifestText);
  const digest = createHash("sha256").update(bundle).digest("hex");
  if (
    manifest.schemaVersion !== 6 ||
    manifest.filename !== "sedes" ||
    JSON.stringify(manifest.modes) !==
      JSON.stringify(["agent_tools_cli", "persistent_service"]) ||
    !Array.isArray(manifest.nativeAssets) ||
    manifest.minimumNodeVersion !== "22.19.0" ||
    manifest.sha256 !== digest ||
    manifest.bytes !== bundle.byteLength ||
    (bundleMetadata.mode & 0o777) !== 0o500 ||
    (manifestMetadata.mode & 0o777) !== 0o400
  ) {
    throw new Error("sidecar_build_output_invalid");
  }
  const seenNativeAssets = new Set();
  for (const asset of manifest.nativeAssets) {
    const names = asset.platform === "linux" ? ["pty.node"]
      : asset.platform === "darwin" ? ["pty.node", "spawn-helper"]
      : asset.platform === "win32" ? ["conpty.node", "conpty_console_list.node", "conout-worker.cjs", "console-list-agent.cjs"]
      : undefined;
    const key = `${asset.platform}-${asset.architecture}`;
    if (!names || !["x64", "arm64"].includes(asset.architecture) || seenNativeAssets.has(key) ||
      !Array.isArray(asset.files) || asset.files.length !== names.length) throw new Error("sidecar_build_native_path_invalid");
    seenNativeAssets.add(key);
    for (const [index, file] of asset.files.entries()) {
      if (file.relativePath !== `native/${key}/${names[index]}`)
        throw new Error("sidecar_build_native_path_invalid");
      const filename = path.join(
        repositoryRoot,
        "dist/sidecar",
        file.relativePath,
      );
      const [contents, metadata] = await Promise.all([
        readFile(filename),
        stat(filename),
      ]);
      if (
        file.mode !== 0o500 ||
        (metadata.mode & 0o777) !== file.mode ||
        contents.length !== file.size ||
        createHash("sha256").update(contents).digest("hex") !== file.sha256
      )
        throw new Error("sidecar_build_native_artifact_invalid");
    }
  }
  snapshots.push({ digest, manifestText });
}

if (
  snapshots[0]?.digest !== snapshots[1]?.digest ||
  snapshots[0]?.manifestText !== snapshots[1]?.manifestText
) {
  throw new Error("sidecar_build_not_repeatable");
}

function expectOwnershipFailure(metafile, expectedCode) {
  try {
    assertSidecarSourceOwnership(metafile, repositoryRoot, syntheticOutputPath);
  } catch (error) {
    if (error instanceof Error && error.message === expectedCode) return;
    throw error;
  }
  throw new Error("sidecar_build_source_ownership_gate_inactive");
}
