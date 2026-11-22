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

function hasExpectedFileMode(metadata, expectedMode) {
  // Windows chmod exposes the read-only attribute, not POSIX ownership or
  // executable bits. Runtime ACL admission is checked by the native gate.
  return metadata.isFile() && (process.platform === "win32"
    ? (metadata.mode & 0o222) === 0
    : (metadata.mode & 0o777) === expectedMode);
}

const syntheticOutputPath = path.join(
  repositoryRoot,
  "dist",
  "sidecar",
  "test.mjs",
);
const canonicalOutputInputs = {
  "src/cli/opencode-owner-cli.ts": { bytesInOutput: 1 },
  "src/cli/sedes-dynamic-tool-command.ts": { bytesInOutput: 1 },
  "src/cli/sedes-cli.ts": { bytesInOutput: 1 },
  "src/cli/sedes-mcp.ts": { bytesInOutput: 1 },
  "src/cli/sedes-mcp-server.ts": { bytesInOutput: 1 },
  "src/cli/sedes-opencode-mcp.ts": { bytesInOutput: 1 },
  "src/cli/sedes-tool-local-client.ts": { bytesInOutput: 1 },
  "src/shared/workpad-content-limits.ts": { bytesInOutput: 1 },
  "src/server/composer-attachments/execution-attachment-staging-engine.ts": {
    bytesInOutput: 1,
  },
  "src/server/workspace-files/workspace-files-engine.ts": { bytesInOutput: 1 },
  "src/server/workspace-files/git-environment.ts": { bytesInOutput: 1 },
  "src/server/workspace-files/workspace-file-policy.ts": { bytesInOutput: 1 },
  "src/server/workspace-files/canonical-mutation-serializer.ts": {
    bytesInOutput: 1,
  },
  "src/server/workspace-tools/workspace-tool-engine.ts": { bytesInOutput: 1 },
  "src/server/workspace-context/workspace-context-discovery.ts": {
    bytesInOutput: 1,
  },
};
const canonicalInputs = Object.fromEntries(
  Object.keys(canonicalOutputInputs).map(source => [source, { imports: [] }]),
);
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
  ownershipMetafile({
    ...canonicalInputs,
    "src/server/backends/contracts.ts": { imports: [] },
    "src/server/backends/claude/claude-interrupt-operation.ts": { imports: [] },
  }),
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
  "src/shared/protocol/tasks.ts",
  "src/shared/protocol/workpads.ts",
  "src/server/db/repositories/inventory-repository.ts",
  "src/server/backends/opencode/opencode-backend-module.ts",
  "src/server/backends/opencode/opencode-thread-repository.ts",
  "src/server/backends/antigravity/thread-repository.ts",
  "src/server/backends/antigravity/driver.ts",
  "src/server/backends/pi/pi-sdk-session.ts",
  "src/client/workspace-files/WorkspaceFilesPanel.tsx",
  "src/server/normalized-app.ts",
  "src/server/runtime/backend-module-startup.ts",
  "src/server/conversations/conversation-actor-manager.ts",
  "src/server/backends/backend-runtime-registry.ts",
]) {
  expectOwnershipFailure(
    ownershipMetafile({
      ...canonicalInputs,
      [forbiddenSource]: {},
    }),
    "sidecar_build_source_forbidden",
  );
}
for (const builtin of ["node:worker_threads", "worker_threads"]) {
  assertSidecarSourceOwnership(
    ownershipMetafile({
      ...canonicalInputs,
      "src/server/backends/antigravity/native-history-reader.ts": {
        imports: [{ path: builtin, kind: "import-statement", external: true }],
      },
    }),
    repositoryRoot,
    syntheticOutputPath,
  );
}
for (const launchImport of [
  { path: "node:child_process", kind: "import-statement", external: true },
  { path: "child_process", kind: "require-call", external: true },
  { path: "node_modules/node-pty/lib/index.js", kind: "dynamic-import", original: "node-pty" },
  { path: "worker_threads", kind: "import-statement", external: true },
]) {
  // An existing sidecar multiplexer can gain a launch without changing its
  // module name, capability major, operation name, or bundle-wide externals.
  expectOwnershipFailure(
    ownershipMetafile({
      ...canonicalInputs,
      "src/server/backends/opencode/opencode-sidecar-runtime.ts": { imports: [launchImport] },
    }),
    "sidecar_build_process_launch_import_unreviewed",
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
// Provider-owned read-only SQLite has one reviewed importer. Merely importing
// the same builtin from another allowed sidecar source does not grant SQL access.
const nativeReader = "src/server/backends/antigravity/native-history.ts";
const sqliteImport = { path: "node:sqlite", kind: "import-statement", external: true };
const providerSqliteMetafile = {
  inputs: { ...canonicalInputs, [nativeReader]: { imports: [sqliteImport] } },
  outputs: { "dist/sidecar/test.mjs": { inputs: { ...canonicalOutputInputs, [nativeReader]: { bytesInOutput: 1 } }, imports: [sqliteImport] } },
};
assertSidecarSourceOwnership(providerSqliteMetafile, repositoryRoot, syntheticOutputPath);
expectOwnershipFailure({ ...providerSqliteMetafile, inputs: { ...providerSqliteMetafile.inputs,
  "src/cli/sedes-cli.ts": { imports: [sqliteImport] } } }, "sidecar_build_database_import_forbidden");
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
    !hasExpectedFileMode(bundleMetadata, 0o500) ||
    !hasExpectedFileMode(manifestMetadata, 0o400)
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
        !hasExpectedFileMode(metadata, file.mode) ||
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
