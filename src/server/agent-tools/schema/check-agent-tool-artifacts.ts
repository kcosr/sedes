import type { WorkpadAgentToolService } from "../tools/workpad-agent-tool-service.js";
import { readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { AgentToolRegistry } from "../registry/agent-tool-registry.js";
import { createCanonicalAgentToolDefinitions } from "../registry/canonical-agent-tool-catalog.js";
import { CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES } from "../registry/canonical-agent-tool-manifest.js";
import type { AgentManagementService } from "../application/agent-management-service.js";
import type { AgentThreadCreationService } from "../tools/thread-management-tools.js";
import type { SavedAgentCanonicalToolService } from "../tools/saved-agent-management-tools.js";
import type { AutomationAgentToolService } from "../tools/automation-agent-tool-service.js";
import type { AgentToolApplicationReader } from "../tools/agent-tool-readers.js";
import type { AgentThreadControlToolServices } from "../tools/thread-control-tools.js";
import type { WebSearchExecutor } from "../tools/web-search-tool.js";
import type { AgentThreadWorktreeService } from "../tools/thread-worktree-tools.js";

const artifactUrls = Object.freeze(
  Object.fromEntries(
    CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES.map(({ id, schemaVersion }) => [
      `${id}@${schemaVersion}`,
      new URL(`./artifacts/${id}.v${schemaVersion}.json`, import.meta.url),
    ]),
  ),
);
const artifactDirectoryUrl = new URL("./artifacts/", import.meta.url);
const artifactFilenamePattern = /^[a-z][a-z0-9_.-]*\.v[1-9][0-9]*\.json$/;

function expectedArtifactFilenames(): readonly string[] {
  return Object.values(artifactUrls)
    .map((url) => basename(fileURLToPath(url)))
    .sort();
}

function listArtifactFilenames(): readonly string[] {
  return readdirSync(artifactDirectoryUrl, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && artifactFilenamePattern.test(entry.name),
    )
    .map(({ name }) => name)
    .sort();
}

function assertArtifactFileSet(onDisk: readonly string[]): void {
  const expected = expectedArtifactFilenames();
  const actual = [...onDisk].sort();
  if (
    expected.length !== actual.length ||
    expected.some((filename, index) => filename !== actual[index])
  ) {
    throw new Error(
      `agent_tool_artifact_file_set_mismatch:expected=${expected.join(",")};actual=${actual.join(",")}`,
    );
  }
}

function orphanArtifactFilenames(onDisk: readonly string[]): readonly string[] {
  const expected = new Set(expectedArtifactFilenames());
  return [...onDisk]
    .filter(
      (filename) =>
        artifactFilenamePattern.test(filename) && !expected.has(filename),
    )
    .sort();
}

const artifactReader: AgentToolApplicationReader = {
  async readThreadStatus() {
    throw new Error("agent_tool_artifact_reader_unavailable");
  },
};

function unavailableDomainService<T extends object>(name: string): T {
  return new Proxy(Object.create(null) as T, {
    get() {
      return () => {
        throw new Error(`agent_tool_artifact_${name}_unavailable`);
      };
    },
  });
}

const artifactManagement =
  unavailableDomainService<AgentManagementService>("management_service");
const artifactThreadCreation =
  unavailableDomainService<AgentThreadCreationService>(
    "thread_creation_service",
  );
const artifactSavedAgents =
  unavailableDomainService<SavedAgentCanonicalToolService>(
    "saved_agent_service",
  );
const artifactAutomations =
  unavailableDomainService<AutomationAgentToolService>("automation_service");
const artifactThreadControl =
  unavailableDomainService<AgentThreadControlToolServices>(
    "thread_control_service",
  );
const artifactWebSearch =
  unavailableDomainService<WebSearchExecutor>("web_search_service");
const artifactThreadWorktrees =
  unavailableDomainService<AgentThreadWorktreeService>("thread_worktree_service");

function definitions(): readonly AgentToolDefinition[] {
  return createCanonicalAgentToolDefinitions({
    application: artifactReader,
    workpads: unavailableDomainService<WorkpadAgentToolService>("workpad_service"),
    management: artifactManagement,
    automations: artifactAutomations,
    threadCreation: artifactThreadCreation,
    savedAgents: artifactSavedAgents,
    threadControl: artifactThreadControl,
    webSearch: artifactWebSearch,
    threadWorktrees: artifactThreadWorktrees,
  });
}

export function assertAgentToolArtifactContractSet(
  generatedContracts: readonly string[],
  artifactContracts: readonly string[],
): void {
  const generated = [...generatedContracts].sort();
  const artifacts = [...artifactContracts].sort();
  if (
    generated.length !== artifacts.length ||
    generated.some((contract, index) => contract !== artifacts[index])
  ) {
    throw new Error(
      `agent_tool_artifact_contract_set_mismatch:generated=${generated.join(",")};artifacts=${artifacts.join(",")}`,
    );
  }
}

export function generatedAgentToolArtifacts(): Readonly<
  Record<string, string>
> {
  const registry = new AgentToolRegistry();
  for (const definition of definitions()) registry.register(definition);
  return Object.freeze(
    Object.fromEntries(
      definitions().map((definition) => [
        `${definition.id}@${definition.schemaVersion}`,
        registry.serializedArtifact(definition.id, definition.schemaVersion),
      ]),
    ),
  );
}

export function checkAgentToolArtifacts(
  read: (url: URL) => string = (url) => readFileSync(url, "utf8"),
  list: () => readonly string[] = listArtifactFilenames,
): void {
  const generated = generatedAgentToolArtifacts();
  assertAgentToolArtifactContractSet(
    Object.keys(generated),
    Object.keys(artifactUrls),
  );
  assertArtifactFileSet(list());
  for (const [contract, url] of Object.entries(artifactUrls)) {
    if (read(url) !== generated[contract]) {
      throw new Error(
        `agent_tool_artifact_stale:${contract}; regenerate the checked-in contract artifact`,
      );
    }
  }
}

export function writeAgentToolArtifacts(
  write: (url: URL, value: string) => void = (url, value) =>
    writeFileSync(url, value, "utf8"),
  list: () => readonly string[] = listArtifactFilenames,
  remove: (url: URL) => void = (url) => unlinkSync(url),
): void {
  const generated = generatedAgentToolArtifacts();
  for (const [contract, url] of Object.entries(artifactUrls)) {
    const value = generated[contract];
    if (value === undefined) {
      throw new Error(`agent_tool_artifact_missing:${contract}`);
    }
    write(url, value);
  }
  for (const filename of orphanArtifactFilenames(list())) {
    remove(new URL(`./artifacts/${filename}`, import.meta.url));
  }
}

const invokedPath = process.argv[1];
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  if (process.argv.includes("--write")) writeAgentToolArtifacts();
  else checkAgentToolArtifacts();
}
