import path from "node:path";

const REQUIRED_INPUT_SUFFIXES = Object.freeze([
  "src/server/backends/claude/worker/claude-runtime-worker-main.ts",
  "src/server/backends/claude/worker/claude-child-process-supervisor.ts",
  "src/server/backends/claude/worker/claude-outer-process-supervisor.ts",
  "src/server/backends/claude/worker/claude-worker-supervision-ipc.ts",
  "src/server/backends/claude/worker/tracked-claude-sdk-facade.ts",
  "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
]);

const ALLOWED_REPOSITORY_PREFIXES = Object.freeze([
  "src/server/backends/claude/",
  "src/server/provider-protocol/",
  "src/internal/sidecar-protocol/",
  "src/internal/agent-tool-cli-protocol/",
  "src/shared/",
]);

const ALLOWED_REPOSITORY_SOURCES = new Set([
  "src/server/environment-variables/runtime-environment.ts",
  "src/server/config/configuration-fingerprint.ts",
  "src/server/agent-tools/contracts/agent-tool-transport-limits.ts",
  "src/server/agent-tools/schema/canonical-json-schema.ts",
  "src/server/canonical-json.ts",
  "src/server/conversations/payload-policy.ts",
]);

const FORBIDDEN_INPUT_FRAGMENTS = Object.freeze([
  "node_modules/@anthropic-ai/claude-agent-sdk-linux-",
  "node_modules/@anthropic-ai/claude-agent-sdk-darwin-",
  "node_modules/@anthropic-ai/claude-agent-sdk-win32-",
  "node_modules/better-sqlite3/",
  "node_modules/node-pty/",
]);

const FORBIDDEN_REPOSITORY_PREFIXES = Object.freeze([
  "src/client/",
  "src/server/conversations/",
  "src/server/db/",
  "src/server/production-application.ts",
]);

/** Proves the worker contains provider runtime code, not server authority. */
export function assertClaudeRuntimeWorkerSourceOwnership(
  metafile,
  repositoryRoot,
  outputPath,
) {
  if (
    !metafile ||
    typeof metafile !== "object" ||
    !metafile.inputs ||
    typeof metafile.inputs !== "object" ||
    !metafile.outputs ||
    typeof metafile.outputs !== "object" ||
    !path.isAbsolute(repositoryRoot) ||
    !path.isAbsolute(outputPath)
  ) {
    throw new Error("claude_runtime_worker_build_metafile_invalid");
  }
  const inputs = Object.keys(metafile.inputs).map((value) =>
    value.split(path.sep).join("/"),
  );
  if (
    REQUIRED_INPUT_SUFFIXES.some(
      (required) => !inputs.some((input) => input.endsWith(required)),
    )
  ) {
    throw new Error("claude_runtime_worker_required_source_missing");
  }
  if (
    inputs.some((input) =>
      FORBIDDEN_INPUT_FRAGMENTS.some((fragment) => input.includes(fragment)),
    )
  ) {
    throw new Error("claude_runtime_worker_platform_cli_included");
  }
  const repositoryInputs = inputs.filter((input) => input.startsWith("src/"));
  if (
    repositoryInputs.some(
      (input) =>
        !ALLOWED_REPOSITORY_SOURCES.has(input) &&
        (FORBIDDEN_REPOSITORY_PREFIXES.some((prefix) =>
          input.startsWith(prefix),
        ) ||
          !ALLOWED_REPOSITORY_PREFIXES.some((prefix) =>
            input.startsWith(prefix),
          )),
    )
  ) {
    throw new Error("claude_runtime_worker_source_forbidden");
  }
  const output = Object.entries(metafile.outputs).find(
    ([candidate]) =>
      path.resolve(repositoryRoot, candidate) === path.normalize(outputPath),
  )?.[1];
  if (!output?.inputs || typeof output.inputs !== "object") {
    throw new Error("claude_runtime_worker_output_metafile_missing");
  }
  const contributingInputs = Object.entries(output.inputs);
  if (
    REQUIRED_INPUT_SUFFIXES.some(
      (required) =>
        !contributingInputs.some(
          ([input, contribution]) =>
            input.split(path.sep).join("/").endsWith(required) &&
            contribution &&
            typeof contribution === "object" &&
            typeof contribution.bytesInOutput === "number" &&
            contribution.bytesInOutput > 0,
        ),
    )
  ) {
    throw new Error("claude_runtime_worker_required_source_not_emitted");
  }
  if (
    Array.isArray(output.imports) &&
    output.imports.some(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        typeof entry.path === "string" &&
        (entry.path.startsWith("@anthropic-ai/claude-agent-sdk-") ||
          entry.path === "better-sqlite3" ||
          entry.path === "node-pty"),
    )
  ) {
    throw new Error("claude_runtime_worker_external_import_forbidden");
  }
}
