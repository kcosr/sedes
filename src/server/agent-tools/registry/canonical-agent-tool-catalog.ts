import { createWorkpadToolDefinitions } from "../tools/workpad-management-tools.js";
import type { WorkpadAgentToolService } from "../tools/workpad-agent-tool-service.js";
import type { AgentToolDefinition } from "../contracts/agent-tool-contracts.js";
import { agentContextToolDefinition } from "../tools/agent-context-tool.js";
import type { AgentManagementService } from "../application/agent-management-service.js";
import type { AgentToolApplicationReader } from "../tools/agent-tool-readers.js";
import type { AutomationAgentToolService } from "../tools/automation-agent-tool-service.js";
import { createAutomationCreateToolDefinition } from "../tools/automation-create-tool.js";
import { createAutomationGetToolDefinition } from "../tools/automation-get-tool.js";
import { createAutomationRunNowToolDefinition } from "../tools/automation-run-now-tool.js";
import { createAutomationRunsToolDefinition } from "../tools/automation-runs-tool.js";
import { createAutomationSetStateToolDefinition } from "../tools/automation-set-state-tool.js";
import { createAutomationUpdateToolDefinition } from "../tools/automation-update-tool.js";
import {
  createTaskCreateToolDefinition,
  createTaskGetToolDefinition,
  createTaskListToolDefinition,
  createTaskUpdateToolDefinition,
} from "../tools/task-management-tools.js";
import {
  type AgentThreadCreationService,
  createThreadCreateToolDefinition,
  createThreadListToolDefinition,
} from "../tools/thread-management-tools.js";
import {
  type AgentThreadControlToolServices,
  createThreadArchiveToolDefinition,
  createThreadForkToolDefinition,
  createThreadMessagesToolDefinition,
  createThreadRestoreToolDefinition,
  createThreadSendToolDefinition,
} from "../tools/thread-control-tools.js";
import { createThreadStatusToolDefinition } from "../tools/thread-status-tool.js";
import { createEnvironmentListToolDefinition } from "../tools/environment-list-tool.js";
import { createWorkspaceListToolDefinition } from "../tools/workspace-list-tool.js";
import { createWorkspaceOpenToolDefinition } from "../tools/workspace-open-tool.js";
import {
  type SavedAgentCanonicalToolService,
  createSavedAgentCreateToolDefinition,
  createSavedAgentDeleteToolDefinition,
  createSavedAgentGetToolDefinition,
  createSavedAgentListToolDefinition,
  createSavedAgentOptionsToolDefinition,
  createSavedAgentUpdateToolDefinition,
} from "../tools/saved-agent-management-tools.js";
import { CANONICAL_AGENT_TOOL_GROUPS } from "./canonical-agent-tool-manifest.js";
import {
  createWebSearchToolDefinition,
  type WebSearchExecutor,
} from "../tools/web-search-tool.js";
import {
  type AgentThreadWorktreeService,
  createThreadWorktreeClearToolDefinition,
  createThreadWorktreeListToolDefinition,
  createThreadWorktreeSetToolDefinition,
} from "../tools/thread-worktree-tools.js";

export {
  CANONICAL_AGENT_TOOL_GROUPS,
  CANONICAL_AGENT_TOOL_MANIFEST,
  CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES,
  type CanonicalAgentToolGroup,
  type CanonicalAgentToolId,
  type CanonicalAgentToolManifestEntry,
} from "./canonical-agent-tool-manifest.js";

const groupOrder = new Map(
  CANONICAL_AGENT_TOOL_GROUPS.map(({ id, order }) => [id, order] as const),
);

export function compareCanonicalAgentToolDefinitions(
  left: AgentToolDefinition,
  right: AgentToolDefinition,
): number {
  const byGroup =
    (groupOrder.get(left.catalog.groupId) ?? Number.MAX_SAFE_INTEGER) -
    (groupOrder.get(right.catalog.groupId) ?? Number.MAX_SAFE_INTEGER);
  if (byGroup !== 0) return byGroup;
  const byOrder = left.catalog.order - right.catalog.order;
  return byOrder !== 0 ? byOrder : left.id.localeCompare(right.id);
}

export function orderCanonicalAgentToolDefinitions(
  definitions: readonly AgentToolDefinition[],
): readonly AgentToolDefinition[] {
  return Object.freeze(
    [...definitions].sort(compareCanonicalAgentToolDefinitions),
  );
}

/**
 * One assembly seam shared by execution, exposure policy, and artifact checks.
 * Domain slices supply their definitions here instead of creating parallel
 * registries or adapter-specific catalogs.
 */
export function createCanonicalAgentToolDefinitions(input: {
  readonly application: AgentToolApplicationReader;
  readonly management?: AgentManagementService;
  readonly workpads?: WorkpadAgentToolService;
  readonly automations?: AutomationAgentToolService;
  readonly threadCreation?: AgentThreadCreationService;
  readonly savedAgents?: SavedAgentCanonicalToolService;
  readonly threadControl?: AgentThreadControlToolServices;
  readonly webSearch?: WebSearchExecutor;
  readonly threadWorktrees?: AgentThreadWorktreeService;
  readonly additionalDefinitions?: readonly AgentToolDefinition[];
}): readonly AgentToolDefinition[] {
  const suppliedDomainServices = [
    input.management,
    input.automations,
    input.threadCreation,
    input.savedAgents,
  ].filter((service) => service !== undefined).length;
  if (suppliedDomainServices !== 0 && suppliedDomainServices !== 4) {
    throw new Error("canonical_agent_tool_domain_services_incomplete");
  }
  const serviceBackedDefinitions =
    input.management &&
    input.automations &&
    input.threadCreation &&
    input.savedAgents
      ? [
          createEnvironmentListToolDefinition(input.management),
          createWorkspaceListToolDefinition(input.management),
          createWorkspaceOpenToolDefinition(input.management),
          createThreadListToolDefinition(input.management),
          createThreadCreateToolDefinition(input.threadCreation),
          createSavedAgentListToolDefinition(input.savedAgents),
          createSavedAgentGetToolDefinition(input.savedAgents),
          createSavedAgentOptionsToolDefinition(input.savedAgents),
          createSavedAgentCreateToolDefinition(input.savedAgents),
          createSavedAgentUpdateToolDefinition(input.savedAgents),
          createSavedAgentDeleteToolDefinition(input.savedAgents),
          createTaskListToolDefinition(input.management),
          createTaskGetToolDefinition(input.management),
          createTaskCreateToolDefinition(input.management),
          createTaskUpdateToolDefinition(input.management),
          createAutomationGetToolDefinition(input.automations),
          createAutomationRunsToolDefinition(input.automations),
          createAutomationCreateToolDefinition(input.automations),
          createAutomationUpdateToolDefinition(input.automations),
          createAutomationSetStateToolDefinition(input.automations),
          createAutomationRunNowToolDefinition(input.automations),
        ]
      : [];
  return orderCanonicalAgentToolDefinitions([
    agentContextToolDefinition,
    ...(input.workpads ? createWorkpadToolDefinitions(input.workpads) : []),
    ...(input.threadWorktrees
      ? [
          createThreadWorktreeListToolDefinition(input.threadWorktrees),
          createThreadWorktreeSetToolDefinition(input.threadWorktrees),
          createThreadWorktreeClearToolDefinition(input.threadWorktrees),
        ]
      : []),
    createThreadStatusToolDefinition(input.application),
    ...(input.threadControl
      ? [
          createThreadMessagesToolDefinition(input.threadControl),
          createThreadSendToolDefinition(input.threadControl),
          createThreadForkToolDefinition(input.threadControl),
          createThreadArchiveToolDefinition(input.threadControl),
          createThreadRestoreToolDefinition(input.threadControl),
        ]
      : []),
    ...serviceBackedDefinitions,
    ...(input.webSearch
      ? [createWebSearchToolDefinition(input.webSearch)]
      : []),
    ...(input.additionalDefinitions ?? []),
  ]);
}
