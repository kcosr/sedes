import type {
  AgentToolDefinition,
  AgentToolGroupId,
} from "../contracts/agent-tool-contracts.js";

export interface CanonicalAgentToolGroup {
  readonly id: AgentToolGroupId;
  readonly label: string;
  readonly description: string;
  readonly order: number;
}

export type CanonicalAgentToolManifestEntry = Pick<
  AgentToolDefinition,
  | "id"
  | "schemaVersion"
  | "description"
  | "catalog"
  | "effects"
  | "deployment"
  | "callerEligibility"
  | "environmentAuthority"
>;

function manifestEntry<
  const T extends Omit<
    CanonicalAgentToolManifestEntry,
    "deployment" | "callerEligibility"
  >,
>(
  value: T,
): Readonly<
  T & {
    readonly callerEligibility: readonly ["thread_agent", "principal_client"];
    readonly deployment: { readonly eligible: true };
  }
> {
  return Object.freeze({
    ...value,
    catalog: Object.freeze({ ...value.catalog }),
    effects: Object.freeze({ ...value.effects }),
    callerEligibility: Object.freeze([
      "thread_agent",
      "principal_client",
    ] as const),
    deployment: Object.freeze({ eligible: true as const }),
  });
}

function threadOnlyManifestEntry<
  const T extends Omit<
    CanonicalAgentToolManifestEntry,
    "deployment" | "callerEligibility"
  >,
>(
  value: T,
): Readonly<
  T & {
    readonly callerEligibility: readonly ["thread_agent"];
    readonly deployment: { readonly eligible: true };
  }
> {
  return Object.freeze({
    ...value,
    catalog: Object.freeze({ ...value.catalog }),
    effects: Object.freeze({ ...value.effects }),
    callerEligibility: Object.freeze(["thread_agent"] as const),
    deployment: Object.freeze({ eligible: true as const }),
  });
}

export const CANONICAL_AGENT_TOOL_GROUPS = Object.freeze([
  Object.freeze({
    id: "context" as const,
    label: "Context",
    description:
      "Inspect the source context and manage configured environments and workspaces.",
    order: 10,
  }),
  Object.freeze({
    id: "threads" as const,
    label: "Threads",
    description: "Inspect, read, create, and control Sedes threads.",
    order: 20,
  }),
  Object.freeze({
    id: "agents" as const,
    label: "Agents",
    description: "Inspect and manage reusable saved Agent configurations.",
    order: 40,
  }),
  Object.freeze({
    id: "tasks" as const,
    label: "Tasks",
    description: "Inspect and manage principal-owned tasks.",
    order: 50,
  }),
  Object.freeze({
    id: "workpads" as const,
    label: "Workpads",
    description: "Read and collaboratively edit scoped working documents.",
    order: 55,
  }),
  Object.freeze({
    id: "automations" as const,
    label: "Automations",
    description: "Inspect, configure, and run thread automations.",
    order: 60,
  }),
  Object.freeze({
    id: "research" as const,
    label: "Research",
    description: "Research current public information with external models.",
    order: 70,
  }),
] satisfies readonly CanonicalAgentToolGroup[]);

export const CANONICAL_AGENT_TOOL_MANIFEST = Object.freeze({
  "agent.context": threadOnlyManifestEntry({
    environmentAuthority: { kind: "source_only" },
    id: "agent.context",
    schemaVersion: 2,
    description: "Returns the Sedes source thread, workspace, and backend.",
    catalog: { groupId: "context", label: "Agent context", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "environment.list": manifestEntry({
    environmentAuthority: { kind: "installation_directory" },
    id: "environment.list",
    schemaVersion: 1,
    description:
      "Lists configured principal-scoped execution environments without exposing topology or credentials.",
    catalog: { groupId: "context", label: "List environments", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workspace.list": manifestEntry({
    environmentAuthority: { kind: "scoped_query", resource: "workspace" },
    id: "workspace.list",
    schemaVersion: 4,
    description:
      "Lists admitted principal-owned Sedes workspaces by recent use, defaulting to the caller's configured environment.",
    catalog: { groupId: "context", label: "List workspaces", order: 30 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workspace.open": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "environment",
      inputField: "environmentId",
    },
    id: "workspace.open",
    schemaVersion: 1,
    description:
      "Opens an existing project directory in a configured execution environment and records it as a Sedes workspace.",
    catalog: { groupId: "context", label: "Open workspace", order: 40 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.worktree_list": threadOnlyManifestEntry({
    environmentAuthority: { kind: "source_only" },
    id: "thread.worktree_list",
    schemaVersion: 1,
    description:
      "Lists the source thread's primary project directory and registered linked Git worktrees, together with its preferred worktree revision.",
    catalog: { groupId: "threads", label: "List linked worktrees", order: 1 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread.worktree_set": threadOnlyManifestEntry({
    environmentAuthority: { kind: "source_only" },
    id: "thread.worktree_set",
    schemaVersion: 1,
    description:
      "Revision-checks and sets one registered linked Git worktree as the source thread's preferred worktree.",
    catalog: { groupId: "threads", label: "Set preferred worktree", order: 2 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.worktree_clear": threadOnlyManifestEntry({
    environmentAuthority: { kind: "source_only" },
    id: "thread.worktree_clear",
    schemaVersion: 1,
    description:
      "Revision-checks and clears the source thread's preferred linked worktree so the thread uses its primary project directory.",
    catalog: { groupId: "threads", label: "Clear preferred worktree", order: 3 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.status": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread" },
    id: "thread.status",
    schemaVersion: 2,
    description:
      "Returns bounded lifecycle and activity state for a Sedes thread.",
    catalog: { groupId: "threads", label: "Thread status", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread.list": manifestEntry({
    environmentAuthority: { kind: "scoped_query", resource: "thread" },
    id: "thread.list",
    schemaVersion: 5,
    description:
      "Searches admitted principal-owned Sedes threads, defaulting to the caller's configured environment, with newest activity first.",
    catalog: { groupId: "threads", label: "List threads", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread.create": manifestEntry({
    environmentAuthority: {
      kind: "scope_transition",
      resource: "workspace",
      inputField: "workspaceId",
    },
    id: "thread.create",
    schemaVersion: 5,
    description:
      "Creates an unbound Sedes draft thread without sending a prompt or starting model work.",
    catalog: { groupId: "threads", label: "Create thread", order: 30 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.messages": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread" },
    id: "thread.messages",
    schemaVersion: 4,
    description:
      "Returns the newest bounded page of settled terminal turns and, on a fresh read, text-finalized ordinary messages from the active turn; continuation moves toward older settled history.",
    catalog: { groupId: "threads", label: "Thread messages", order: 40 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread.send": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread" },
    id: "thread.send",
    schemaVersion: 2,
    description:
      "Durably sends an independent message to an unbound or idle Sedes thread and starts model work without reading or changing its composer draft, optionally returning its completion to the calling thread agent.",
    catalog: {
      groupId: "threads",
      label: "Send message (starts model work)",
      order: 50,
    },
    effects: {
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    },
  }),
  "thread.fork": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread" },
    id: "thread.fork",
    schemaVersion: 1,
    description:
      "Creates a Sedes thread from an exact completed turn without sending a message or starting model work.",
    catalog: { groupId: "threads", label: "Fork thread", order: 60 },
    effects: {
      application: "write",
      modelUsage: "none",
      external: "durable_side_effect",
    },
  }),
  "thread.archive": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread_family",
      inputField: "threadId",
    },
    id: "thread.archive",
    schemaVersion: 1,
    description:
      "Archives a principal-owned Sedes thread, optionally including descendants, without changing provider-owned conversation data.",
    catalog: { groupId: "threads", label: "Archive thread", order: 70 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.restore": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread" },
    id: "thread.restore",
    schemaVersion: 1,
    description:
      "Restores one archived principal-owned Sedes thread to active inventory.",
    catalog: { groupId: "threads", label: "Restore thread", order: 80 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "saved_agent.list": manifestEntry({
    environmentAuthority: { kind: "environment_neutral" },
    id: "saved_agent.list",
    schemaVersion: 5,
    description:
      "Lists bounded database-backed summaries of principal-owned saved Agents.",
    catalog: { groupId: "agents", label: "List Agents", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "saved_agent.get": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "saved_agent", inputField: "agentId" },
    id: "saved_agent.get",
    schemaVersion: 5,
    description: "Returns one complete principal-owned saved Agent definition.",
    catalog: { groupId: "agents", label: "Get Agent", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "saved_agent.options": manifestEntry({
    environmentAuthority: {
      kind: "scope_transition",
      resource: "workspace",
      inputField: "workspaceId",
    },
    id: "saved_agent.options",
    schemaVersion: 5,
    description:
      "Returns bounded dynamic authoring options for a workspace and optional target.",
    catalog: { groupId: "agents", label: "Agent options", order: 30 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "saved_agent.create": manifestEntry({
    environmentAuthority: {
      kind: "scope_transition",
      resource: "workspace",
      inputField: "authoringContext.workspaceId",
    },
    id: "saved_agent.create",
    schemaVersion: 5,
    description:
      "Creates a principal-owned saved Agent after validating one authoring context.",
    catalog: { groupId: "agents", label: "Create Agent", order: 40 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "saved_agent.update": manifestEntry({
    environmentAuthority: {
      kind: "scope_transition",
      resource: "workspace",
      inputField: "authoringContext.workspaceId",
      defaultToSource: false,
    },
    id: "saved_agent.update",
    schemaVersion: 5,
    description:
      "Revision-checks and atomically updates selected saved Agent fields.",
    catalog: { groupId: "agents", label: "Update Agent", order: 50 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "saved_agent.delete": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "saved_agent", inputField: "agentId" },
    id: "saved_agent.delete",
    schemaVersion: 1,
    description:
      "Revision-checks and deletes only the reusable saved Agent preset.",
    catalog: { groupId: "agents", label: "Delete Agent", order: 60 },
    effects: {
      application: "destructive",
      modelUsage: "none",
      external: "none",
    },
  }),
  "workpad.list": manifestEntry({
    environmentAuthority: { kind: "scoped_query", resource: "workpad" },
    id: "workpad.list",
    schemaVersion: 1,
    description: "Lists bounded workpad summaries in a scope or its descendants, optionally searching title and content.",
    catalog: { groupId: "workpads", label: "List workpads", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workpad.get": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "workpad" },
    id: "workpad.get",
    schemaVersion: 1,
    description: "Reads current or historical workpad text and revision author. Access follows the current scope.",
    catalog: { groupId: "workpads", label: "Get workpad", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workpad.revisions": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "workpad" },
    id: "workpad.revisions",
    schemaVersion: 1,
    description: "Lists bounded revision history metadata for a workpad.",
    catalog: { groupId: "workpads", label: "Workpad revisions", order: 30 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workpad.create": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "workpad" },
    id: "workpad.create",
    schemaVersion: 1,
    description: "Creates a scoped Markdown workpad attributed to the authenticated caller.",
    catalog: { groupId: "workpads", label: "Create workpad", order: 40 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "workpad.update": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "workpad" },
    id: "workpad.update",
    schemaVersion: 1,
    description: "Atomically edits, renames, moves, archives, or restores a workpad against its expected revision. Replace content, append text, or apply exact unique replacements; unchanged text retains attribution.",
    catalog: { groupId: "workpads", label: "Update workpad", order: 50 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "task.list": manifestEntry({
    environmentAuthority: { kind: "scoped_query", resource: "task" },
    id: "task.list",
    schemaVersion: 3,
    description:
      "Lists filtered tasks in one scope or its descendant scopes as summaries or bounded full records.",
    catalog: { groupId: "tasks", label: "List tasks", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "task.get": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "task" },
    id: "task.get",
    schemaVersion: 1,
    description: "Returns one complete principal-owned Sedes task.",
    catalog: { groupId: "tasks", label: "Get task", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "task.create": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "task" },
    id: "task.create",
    schemaVersion: 1,
    description:
      "Creates an open task atomically with its content, pin, files, and scope.",
    catalog: { groupId: "tasks", label: "Create task", order: 30 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "task.update": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "task" },
    id: "task.update",
    schemaVersion: 1,
    description:
      "Atomically updates one or more mutable task fields against an expected revision.",
    catalog: { groupId: "tasks", label: "Update task", order: 40 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "automation.get": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "automation.get",
    schemaVersion: 1,
    description:
      "Returns the target thread's automation definition and upcoming schedule occurrences.",
    catalog: {
      groupId: "automations",
      label: "Get automation",
      order: 10,
    },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "automation.runs": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "automation.runs",
    schemaVersion: 1,
    description: "Returns a bounded page of recent automation runs.",
    catalog: {
      groupId: "automations",
      label: "List automation runs",
      order: 20,
    },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "automation.create": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "automation.create",
    schemaVersion: 1,
    description:
      "Attaches a paused automation. A configured pre-check runs only when the automation later runs.",
    catalog: {
      groupId: "automations",
      label: "Create paused automation",
      order: 30,
    },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "automation.update": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "automation.update",
    schemaVersion: 1,
    description:
      "Revision-checks schedule, pre-check, prompt, and run-mode changes that govern future automated executions; omitted fields are preserved and a null pre-check clears it.",
    catalog: {
      groupId: "automations",
      label: "Update automation",
      order: 40,
    },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "automation.set_state": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "automation.set_state",
    schemaVersion: 1,
    description:
      "Enables or pauses an automation using its revision. Enabling schedules future model execution.",
    catalog: {
      groupId: "automations",
      label: "Enable or pause automation (enable schedules model work)",
      order: 50,
    },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "automation.run_now": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "automation.run_now",
    schemaVersion: 1,
    description:
      "Starts a new manual automation run and returns its durable run record. A configured pre-check executes first.",
    catalog: {
      groupId: "automations",
      label: "Run automation now (starts model work)",
      order: 60,
    },
    effects: {
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    },
  }),
  "research.web_search": manifestEntry({
    environmentAuthority: { kind: "public_information" },
    id: "research.web_search",
    schemaVersion: 1,
    description:
      "Searches the current public web, fetches relevant pages, and searches public X when useful. Pass a complete natural-language request. Set continue only for a direct follow-up that relies on the most recent successful search by this same Sedes caller; use a new search for a different question. Continuation is best-effort and safely becomes a fresh search when the exact prior session is unavailable.",
    catalog: {
      groupId: "research",
      label: "Web search",
      order: 10,
    },
    effects: {
      application: "read",
      modelUsage: "agent_execution",
      external: "none",
    },
  }),
} as const satisfies Readonly<Record<string, CanonicalAgentToolManifestEntry>>);

export type CanonicalAgentToolId = keyof typeof CANONICAL_AGENT_TOOL_MANIFEST;

const groupOrder = new Map(
  CANONICAL_AGENT_TOOL_GROUPS.map(({ id, order }) => [id, order] as const),
);

export const CANONICAL_AGENT_TOOL_MANIFEST_ENTRIES = Object.freeze(
  Object.values(CANONICAL_AGENT_TOOL_MANIFEST).sort(
    (left, right) =>
      (groupOrder.get(left.catalog.groupId) ?? Number.MAX_SAFE_INTEGER) -
        (groupOrder.get(right.catalog.groupId) ?? Number.MAX_SAFE_INTEGER) ||
      left.catalog.order - right.catalog.order ||
      left.id.localeCompare(right.id),
  ),
);
