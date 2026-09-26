import path from "node:path";

const REQUIRED_SHARED_SOURCES = Object.freeze([
  "src/cli/sedes-dynamic-tool-command.ts",
  "src/cli/sedes-cli.ts",
  "src/cli/sedes-mcp.ts",
  "src/cli/sedes-mcp-server.ts",
  "src/cli/sedes-tool-local-client.ts",
  "src/server/composer-attachments/execution-attachment-staging-engine.ts",
  "src/server/workspace-files/workspace-files-engine.ts",
  "src/server/workspace-files/workspace-file-policy.ts",
  "src/server/workspace-files/canonical-mutation-serializer.ts",
  "src/server/workspace-tools/workspace-tool-engine.ts",
  "src/server/workspace-context/workspace-context-discovery.ts",
]);

const ALLOWED_REPOSITORY_SOURCES = new Set([
  "src/server/environment-variables/runtime-environment.ts",
  "src/server/config/configuration-fingerprint.ts",
  "src/shared/protocol/environment-variables.ts",
  "src/cli/create-sedes-tool-client.ts",
  "src/cli/sedes-agent-tool-endpoint.ts",
  "src/cli/sedes-cli.ts",
  "src/cli/sedes-dynamic-tool-command.ts",
  "src/cli/sedes-mcp.ts",
  "src/cli/sedes-mcp-server.ts",
  "src/cli/sedes-tool-api-client.ts",
  "src/cli/sedes-tool-client.ts",
  "src/cli/sedes-tool-local-client.ts",
  "src/server/agent-tools/contracts/agent-tool-contracts.ts",
  "src/server/agent-tools/contracts/agent-tool-transport-limits.ts",
  "src/server/agent-tools/http/agent-tool-http-contracts.ts",
  "src/server/agent-tools/schema/canonical-cli-options.ts",
  "src/server/agent-tools/schema/canonical-json-schema.ts",
  "src/server/canonical-json.ts",
  "src/server/diagnostics/attachment-diagnostics.ts",
  "src/server/diagnostics/delivery-diagnostic-output.ts",
  "src/server/diagnostics/event-loop-diagnostics.ts",
  "src/server/composer-attachments/execution-attachment-staging-engine.ts",
  "src/server/local-file-descriptor-path.ts",
  "src/server/composer-attachments/windows-staging-privacy.ts",
  "src/server/path-containment.ts",
  "src/server/sidecar/sedes-sidecar-main.ts",
  "src/server/sidecar/persistent-sidecar-paths.ts",
  "src/server/sidecar/persistent-sidecar-diagnostics.ts",
  "src/server/sidecar/sidecar-socket-byte-stream.ts",
  "src/server/provider-protocol/transport/framed-message-limits.ts",
  "src/server/sidecar/runtime-body-channel.ts",
  "src/server/execution/windows-owned-process.ts",
  "src/server/managed-workers/artifact.ts",
  "src/server/managed-workers/local-launcher.ts",
  "src/server/execution/environment-channel.ts",
  "src/server/execution/local-environment-channel.ts",
  "src/server/backends/codex/codex-native-store-ownership.ts",
  "src/server/backends/codex/codex-native-store-lock.ts",
  "src/server/provider-protocol/bindings/codex-app-server/generated/0.153.0/validators.ts",
  "src/server/provider-protocol/bindings/codex-app-server/generated/0.153.0/route-registry.ts",
  "src/server/provider-protocol/json/bounded-json-snapshot.ts",
  "src/shared/output-artifact-limits.ts",
  "src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.ts",
  "src/server/backends/codex/codex-release-guard.ts",
  "src/server/backends/codex/codex-runtime-config.ts",
  "src/server/provider-protocol/transport/assured-framed-transport.ts",
  "src/server/backends/codex/rpc/errors.ts",
  "src/server/backends/codex/rpc/protocol.ts",
  "src/server/backends/codex/rpc/codex-rpc-client.ts",
  "src/shared/protocol/questions.ts",
  "src/server/backends/codex/codex-c1-protocol.ts",
  "src/server/conversations/payload-policy.ts",
  "src/server/backends/codex/codex-goal-feature.ts",
  "src/server/backends/codex/codex-goal-protocol.ts",
  "src/server/backends/codex/codex-c2-protocol.ts",
  "src/server/backends/codex/codex-server-request-router.ts",
  "src/server/backends/codex/codex-client-facade.ts",
  "src/server/backends/codex/codex-daemon-supervisor.ts",
  "src/server/provider-protocol/transport/owned-ndjson-stdio-transport.ts",
  "src/server/backends/codex/transport/owned-stdio-transport.ts",
  "src/server/provider-protocol/transport/websocket-framed-connection.ts",
  "src/server/backends/codex/transport/unix-websocket-transport.ts",
  "src/server/backends/codex/transport/tcp-websocket-transport.ts",
  "src/server/backends/codex/runtime/codex-runtime-transport.ts",
  "src/server/backends/codex/runtime/codex-runtime-protocol.ts",
  "src/server/backends/codex/runtime/codex-runtime-sessions.ts",
  "src/server/backends/codex/runtime/codex-runtime-host.ts",
  "src/server/backends/codex/runtime/codex-runtime-environment-fingerprint.ts",
  "src/server/backends/codex/runtime/codex-runtime-event-order.ts",
  "src/server/backends/codex/codex-execution-policy.ts",
  "src/server/backends/codex/codex-live-model-selection.ts",
  "src/server/backends/codex/codex-service-tier.ts",
  "src/server/backends/codex/codex-managed-tui-launcher.ts",
  "src/server/backends/codex/codex-tui-feature.ts",
  "src/server/backends/codex/codex-managed-tui-registry.ts",
  "src/server/backends/codex/runtime/codex-runtime-managed-tui.ts",
  "src/server/backends/codex/runtime/codex-runtime-host-registry.ts",
  "src/server/backends/model-policy.ts",
  "src/server/backends/runtime-control.ts",
  "src/server/backends/retained-runtime-lifecycle.ts",
  "src/server/backends/codex/codex-backend-configuration.ts",
  "src/server/backends/codex/runtime/codex-runtime-wire.ts",
  "src/server/backends/codex/runtime/codex-sidecar-runtime.ts",
  "src/server/backends/claude/claude-release-guard.ts",
  "src/server/backends/claude/claude-background-activity.ts",
  "src/server/backends/claude/claude-result-lifecycle.ts",
  "src/server/backends/claude/claude-session-history.ts",
  "src/server/backends/claude/claude-message-scope.ts",
  "src/server/backends/claude/claude-skill-name.ts",
  "src/server/backends/claude/claude-skills.ts",
  "src/server/backends/claude/worker/claude-runtime-v1.ts",
  "src/server/backends/claude/worker/claude-runtime-host-support.ts",
  "src/server/backends/claude/claude-runtime-worker-client.ts",
  "src/server/backends/claude/worker/claude-outer-process-supervisor.ts",
  "src/server/runtime/process-table.ts",
  "src/server/runtime/owned-process-tree.ts",
  "src/server/backends/claude/claude-managed-runtime-owner.ts",
  "src/server/backends/claude/runtime/claude-persistent-runtime-wire.ts",
  "src/server/backends/claude/runtime/claude-persistent-runtime-host.ts",
  "src/server/backends/claude/runtime/claude-replay-retention.ts",
  "src/server/backends/claude/runtime/claude-persistent-runtime-registry.ts",
  "src/server/backends/claude/runtime/claude-sidecar-runtime.ts",
  "src/server/backends/claude/worker/claude-runtime-worker-artifact.ts",
  "src/server/backends/claude/worker/claude-sidecar-worker-artifact.ts",


  "src/server/sidecar/agent-tool-cli-local-ingress.ts",
  "src/server/sidecar/composer-attachments-sidecar-host.ts",
  "src/server/sidecar/directory-browser-sidecar-host.ts",
  "src/server/sidecar/workspace-files-sidecar-host.ts",
  "src/server/sidecar/workspace-tools-sidecar-host.ts",
  "src/server/sidecar/workspace-tools-shell-host.ts",
  "src/server/sidecar/workspace-context-sidecar-host.ts",
  "src/server/sidecar/workspace-skills-scanner.ts",
  "src/server/sidecar/workspace-skills-sidecar-host.ts",
  "src/server/sidecar/sanitized-sidecar-environment.ts",
  "src/server/sidecar/persistent-sidecar-bootstrap.ts",
  "src/server/sidecar/sidecar-process-ownership.ts",
  "src/server/sidecar/sidecar-darwin-platform.ts",
  "src/server/sidecar/sidecar-windows-platform.ts",
  "src/server/sidecar/sidecar-windows-ipc.ts",
  "src/server/sidecar/persistent-sidecar-service-registry.ts",
  "src/server/sidecar/persistent-sidecar-service-server.ts",
  "src/server/sidecar/persistent-sidecar-management-receipts.ts",
  "src/server/sidecar/sidecar-abandonment-archive.ts",
  "src/server/sidecar/sidecar-runtime-attachment.ts",
  "src/server/sidecar/runtime-channel.ts",
  "src/server/sidecar/persistent-terminal-host.ts",
  "src/server/execution/local-interactive-terminal-provider.ts",
  "src/server/terminals/terminal-emulator.ts",
  "src/server/sidecar/sidecar-operation-receipts.ts",
  "src/server/sidecar/persistent-sidecar-service-registry.ts",
  "src/server/workspace-files/contracts.ts",
  "src/server/workspace-files/local-workspace-file-watcher.ts",
  "src/server/workspace-files/workspace-diffs-engine.ts",
  "src/server/workspace-files/workspace-file-content-classifier.ts",
  "src/server/workspace-files/workspace-file-policy.ts",
  "src/server/workspace-files/canonical-mutation-serializer.ts",
  "src/server/workspace-files/workspace-files-engine.ts",
  "src/server/workspace-tools/contracts.ts",
  "src/server/workspace-tools/edit-semantics.ts",
  "src/server/workspace-tools/image-mime.ts",
  "src/server/workspace-tools/path-grammar.ts",
  "src/server/workspace-tools/deterministic-search.ts",
  "src/server/workspace-tools/trusted-search-executables.ts",
  "src/server/workspace-tools/trusted-search-windows.ts",
  "src/server/workspace-tools/workspace-tool-engine.ts",
  "src/server/workspace-context/workspace-context-discovery.ts",
  "src/shared/workspace-file-limits.ts",
  "src/shared/absolute-path.ts",
  "src/shared/version.ts",
  "src/shared/workspace-diff-limits.ts",
  "src/shared/composer-attachment-staging-limits.ts",
  "src/shared/protocol/composer-attachments.ts",
  "src/shared/protocol/domain.ts",
  "src/shared/protocol/payload.ts",
  "src/shared/protocol/background-activity.ts",
  "src/shared/protocol/workspace-diffs.ts",
  "src/shared/protocol/workspace-files.ts",
]);

const ALLOWED_SOURCE_PREFIXES = Object.freeze([
  "src/internal/agent-tool-cli-protocol/",
  "src/internal/agent-tool-mcp/",
  "src/internal/sidecar-protocol/",
  "node_modules/ajv/",
  "node_modules/diff/",
  "node_modules/fast-deep-equal/",
  "node_modules/fast-uri/",
  "node_modules/json-schema-traverse/",
  "node_modules/zod/",
  "node_modules/yaml/",
  "node_modules/node-pty/",
  "node_modules/@xterm/headless/",
  "node_modules/@xterm/addon-unicode11/",
  "node_modules/@xterm/addon-serialize/",
  "node_modules/ws/",
]);

const ALLOWED_EXTERNAL_IMPORTS = new Set([
  "node:async_hooks",
  "node:child_process",
  "node:crypto",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:https",
  "node:net",
  "node:os",
  "node:path",
  "node:perf_hooks",
  "node:util",
  "node:url",
  "node:module",
  "node:events",
  "node:stream",
  "fs",
  "path",
  "tty",
  "events",
  "util",
  "worker_threads",
  "os",
  "child_process",
  "net",
  "zlib",
  "buffer",
  "stream",
  "crypto",
  "https",
  "http",
  "tls",
  "url",
  "node:tls",
  "node:string_decoder",
]);

const FORBIDDEN_DATABASE_IMPORTS = Object.freeze([
  "node:sqlite",
  "better-sqlite3",
  "sqlite3",
  "sql.js",
  "pg",
  "postgres",
  "mysql",
  "mysql2",
  "mariadb",
  "mongodb",
  "mongoose",
  "tedious",
  "@libsql/client",
  "@prisma/client",
]);

/** Proves the dual-purpose bundle contains only its reviewed CLI/sidecar sources. */
export function assertSidecarSourceOwnership(
  metafile,
  repositoryRoot,
  bundleOutputPath,
) {
  if (
    !metafile ||
    typeof metafile !== "object" ||
    !metafile.inputs ||
    typeof metafile.inputs !== "object" ||
    !metafile.outputs ||
    typeof metafile.outputs !== "object" ||
    !path.isAbsolute(repositoryRoot) ||
    !path.isAbsolute(bundleOutputPath)
  ) {
    throw new Error("sidecar_build_metafile_invalid");
  }
  const canonical = new Map(
    REQUIRED_SHARED_SOURCES.map((relativePath) => [
      path.parse(relativePath).name,
      path.resolve(repositoryRoot, relativePath),
    ]),
  );
  const inputs = Object.keys(metafile.inputs).map((inputPath) =>
    path.isAbsolute(inputPath)
      ? path.normalize(inputPath)
      : path.resolve(repositoryRoot, inputPath),
  );
  const repositoryInputs = inputs.map((inputPath) =>
    path.relative(repositoryRoot, inputPath).split(path.sep).join("/"),
  );
  if ([...canonical.values()].some((required) => !inputs.includes(required))) {
    throw new Error("sidecar_build_shared_source_missing");
  }
  if (
    inputs.some((inputPath) => {
      const expected = canonical.get(path.parse(inputPath).name);
      return expected !== undefined && inputPath !== expected;
    })
  ) {
    throw new Error("sidecar_build_shared_source_duplicate");
  }
  if (
    repositoryInputs.some(
      (inputPath) =>
        !ALLOWED_REPOSITORY_SOURCES.has(inputPath) &&
        !ALLOWED_SOURCE_PREFIXES.some((prefix) => inputPath.startsWith(prefix)),
    )
  ) {
    throw new Error("sidecar_build_source_forbidden", {
      cause: repositoryInputs.filter(
        (inputPath) =>
          !ALLOWED_REPOSITORY_SOURCES.has(inputPath) &&
          !ALLOWED_SOURCE_PREFIXES.some((prefix) =>
            inputPath.startsWith(prefix),
          ),
      ),
    });
  }
  const output = Object.entries(metafile.outputs).find(
    ([outputPath]) =>
      path.resolve(repositoryRoot, outputPath) ===
      path.normalize(bundleOutputPath),
  )?.[1];
  if (!output?.inputs || typeof output.inputs !== "object") {
    throw new Error("sidecar_build_output_metafile_missing");
  }
  if (
    Array.isArray(output.imports) &&
    output.imports.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.path === "string" &&
        FORBIDDEN_DATABASE_IMPORTS.some(
          (specifier) =>
            entry.path === specifier || entry.path.startsWith(`${specifier}/`),
        ),
    )
  ) {
    throw new Error("sidecar_build_database_import_forbidden");
  }
  if (
    Array.isArray(output.imports) &&
    output.imports.some(
      (entry) =>
        !entry ||
        typeof entry !== "object" ||
        typeof entry.path !== "string" ||
        !ALLOWED_EXTERNAL_IMPORTS.has(entry.path),
    )
  ) {
    throw new Error("sidecar_build_external_import_forbidden", {
      cause: output.imports.filter(
        (entry) => !ALLOWED_EXTERNAL_IMPORTS.has(entry.path),
      ),
    });
  }
  const contributingInputs = new Map(
    Object.entries(output.inputs).map(([inputPath, contribution]) => [
      path.isAbsolute(inputPath)
        ? path.normalize(inputPath)
        : path.resolve(repositoryRoot, inputPath),
      contribution,
    ]),
  );
  if (
    [...canonical.values()].some((required) => {
      const contribution = contributingInputs.get(required);
      return (
        !contribution ||
        typeof contribution.bytesInOutput !== "number" ||
        !Number.isFinite(contribution.bytesInOutput) ||
        contribution.bytesInOutput <= 0
      );
    })
  ) {
    throw new Error("sidecar_build_shared_source_not_emitted");
  }
}
