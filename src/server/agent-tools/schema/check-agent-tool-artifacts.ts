import { createHash } from "node:crypto";
import type { WorkpadAgentToolService } from "../tools/workpad-agent-tool-service.js";
import type { PageAgentToolService } from "../tools/page-agent-tool-service.js";
import type { ImageShowAgentToolService } from "../tools/image-show-agent-tool-service.js";
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
const historicalArtifactHashes: Readonly<Record<string, string>> =
  Object.freeze({
    "thread.list.v6.json":
      "e5c223751b3bf821218ae9939224994a0c6e68670ca8f3e7a74e6ff7d35ca536",
    "automation.get.v1.json":
      "3e37d2c4fa9e97979332aa856bc1451c51ca869074935ef76ed719b46abc4f3f",
    "automation.runs.v1.json":
      "8456a0bd29db93abb392dfc5dd15516b2db6d54456bc1f535ef8f41b7c398fab",
    "automation.create.v1.json":
      "40f1e2b66351e60b6677e587e401347c2d2c140898e270968db7441362ba9ef1",
    "automation.update.v1.json":
      "30d4adeccf10025de54ab89227e38df729dca33298f6eec3f4b71fe5c8f0aec8",
    "automation.set_state.v1.json":
      "d773d278a682cc832b7a6429fb9b6fd9596b5efa57fffcb4d586553fefdd33b2",
    "automation.run_now.v1.json":
      "1739021a12b25e44bf66bb5f3356e9e57bbc208781aca55496e09b38cbed4ec9",
  });
const artifactDirectoryUrl = new URL("./artifacts/", import.meta.url);
const artifactFilenamePattern = /^[a-z][a-z0-9_.-]*\.v[1-9][0-9]*\.json$/;

function expectedArtifactFilenames(): readonly string[] {
  return [
    ...Object.values(artifactUrls).map((url) => basename(fileURLToPath(url))),
    ...Object.keys(historicalArtifactHashes),
  ].sort();
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
  unavailableDomainService<AgentThreadWorktreeService>(
    "thread_worktree_service",
  );

function definitions(): readonly AgentToolDefinition[] {
  return createCanonicalAgentToolDefinitions({
    application: artifactReader,
    workpads:
      unavailableDomainService<WorkpadAgentToolService>("workpad_service"),
    pages: unavailableDomainService<PageAgentToolService>("page_service"),
    images:
      unavailableDomainService<ImageShowAgentToolService>("image_service"),
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
  for (const [filename, hash] of Object.entries(historicalArtifactHashes)) {
    if (
      createHash("sha256")
        .update(read(new URL(`./artifacts/${filename}`, import.meta.url)))
        .digest("hex") !== hash
    ) {
      throw new Error(`agent_tool_historical_artifact_changed:${filename}`);
    }
  }
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
