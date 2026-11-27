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
  | "outputMediaTypes"
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
  Object.freeze({ id: "client" as const, label: "Client controls", description: "Control the user’s current Sedes client and its basic voice settings.", order: 30,
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
  Object.freeze({ id: "pages" as const, label: "Pages", description: "Publish and preview self-contained HTML documents.", order: 57,
  }),
  Object.freeze({ id: "images" as const, label: "Images", description: "Show retained image files in the conversation.", order: 58,
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
  Object.freeze({
    id: "execution" as const,
    label: "Execution configuration",
    description: "Manage execution environments, backends, runtime lifecycle, and tool policies.",
    order: 80,
  }),
] satisfies readonly CanonicalAgentToolGroup[]);

export const CANONICAL_AGENT_TOOL_MANIFEST = Object.freeze({
  "environment.get": threadOnlyManifestEntry({
    id: "environment.get", schemaVersion: 1,
    environmentAuthority: {"kind":"direct_resource","resource":"environment"},
    description: "Reads an authorized environment’s settings, exact configured variable literals and secret-reference metadata, configuration revision, and runtime effects. Secret references are never resolved.",
    catalog: { groupId: "execution", label: "Read environment settings", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "environment.create": threadOnlyManifestEntry({
    id: "environment.create", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"principal"},
    description: "Creates a local or SSH execution environment using its expected configuration revision. Reuse mutationId for retries; creation requires cross-environment authority. Saved configuration may await its host.",
    catalog: { groupId: "execution", label: "Create environment", order: 20 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "environment.rename": threadOnlyManifestEntry({
    id: "environment.rename", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"environment"},
    description: "Renames an environment without changing its identity. Reuse mutationId for retries and supply the current configuration revision.",
    catalog: { groupId: "execution", label: "Rename environment", order: 30 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "environment.configure": threadOnlyManifestEntry({
    id: "environment.configure", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"environment"},
    description: "Partially edits an environment’s settings and variable bindings. Omitted settings are preserved. This permission delegates configuration administration; reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Configure environment", order: 40 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "environment.remove": threadOnlyManifestEntry({
    id: "environment.remove", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"environment"},
    description: "Removes an environment under existing ownership and shutdown safeguards. Does not stop work, cascade-remove backends, or change the default connection. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Remove environment", order: 50 },
    effects: { application: "destructive", modelUsage: "none", external: "durable_side_effect" },
  }),
  "backend.list": threadOnlyManifestEntry({
    id: "backend.list", schemaVersion: 1,
    environmentAuthority: {"kind":"scoped_query","resource":"backend"},
    description: "Lists authorized backends and their connection IDs, excluding configured variable values. Omit environmentId to list all admitted environments.",
    catalog: { groupId: "execution", label: "List backends", order: 60 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "backend.get": threadOnlyManifestEntry({
    id: "backend.get", schemaVersion: 1,
    environmentAuthority: {"kind":"direct_resource","resource":"backend"},
    description: "Reads an authorized backend’s settings, exact configured variable literals and credential-reference metadata, connections, revision, and runtime effects. References remain unresolved.",
    catalog: { groupId: "execution", label: "Read backend settings", order: 70 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "backend.options": threadOnlyManifestEntry({
    id: "backend.options", schemaVersion: 1,
    environmentAuthority: { kind: "direct_resource", resource: "environment", inputField: "environmentId", defaultToSource: true },
    description: "Returns the supported provider configuration choices and Settings defaults for backend and connection creation.",
    catalog: { groupId: "execution", label: "Backend configuration options", order: 80 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "backend.create": threadOnlyManifestEntry({
    id: "backend.create", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"environment","inputField":"environmentId"},
    description: "Atomically creates a backend and its initial connection in an authorized environment. This permission delegates configuration administration, including credential references. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Create backend", order: 90 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "backend.rename": threadOnlyManifestEntry({
    id: "backend.rename", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"backend"},
    description: "Renames a backend while preserving its identity and separately named connections. Reuse mutationId for retries and supply the current configuration revision.",
    catalog: { groupId: "execution", label: "Rename backend", order: 100 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "backend.configure": threadOnlyManifestEntry({
    id: "backend.configure", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"backend"},
    description: "Partially edits a backend, its variables, and ID-addressed connections while preserving omitted settings. This permission delegates configuration administration. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Configure backend", order: 110 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "backend.remove": threadOnlyManifestEntry({
    id: "backend.remove", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"backend"},
    description: "Removes a backend under existing ownership and shutdown safeguards. Does not silently stop work or change the default connection. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Remove backend", order: 120 },
    effects: { application: "destructive", modelUsage: "none", external: "durable_side_effect" },
  }),
  "execution.defaults.get": threadOnlyManifestEntry({
    id: "execution.defaults.get", schemaVersion: 1,
    environmentAuthority: {"kind":"principal_management"},
    description: "Reads the default connection for future threads, including its configurationTargetId and projected targetId. Requires cross-environment authority.",
    catalog: { groupId: "execution", label: "Read default connection", order: 130 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "execution.defaults.update": threadOnlyManifestEntry({
    id: "execution.defaults.update", schemaVersion: 1,
    environmentAuthority: {"kind":"configuration_command","resource":"principal"},
    description: "Sets or clears the default connection for future threads using configurationTargetId and the current configuration revision. Reuse mutationId for retries. Requires cross-environment authority.",
    catalog: { groupId: "execution", label: "Set default connection", order: 140 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "runtime.impact": threadOnlyManifestEntry({
    id: "runtime.impact", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_resource"},
    description: "Inspects a supported environment or backend lifecycle action and returns its current impact token and incarnation fence. Does not perform the requested action; retirement confirmation is Settings-only.",
    catalog: { groupId: "execution", label: "Inspect lifecycle impact", order: 150 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "runtime.connect": threadOnlyManifestEntry({
    id: "runtime.connect", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_resource"},
    description: "Connects an authorized execution runtime through its existing lifecycle service. Reuse mutationId for retries; inspect the returned pending or uncertain receipt before further action.",
    catalog: { groupId: "execution", label: "Connect execution runtime", order: 160 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "runtime.disconnect": threadOnlyManifestEntry({
    id: "runtime.disconnect", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_resource"},
    description: "Disconnects an authorized execution runtime. Refuses an action that would invalidate the calling backend or tool route. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Disconnect execution runtime", order: 170 },
    effects: { application: "destructive", modelUsage: "none", external: "durable_side_effect" },
  }),
  "runtime.start": threadOnlyManifestEntry({
    id: "runtime.start", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_resource"},
    description: "Starts an authorized execution runtime through its existing lifecycle service. Reuse mutationId for retries; saved or pending state does not establish readiness.",
    catalog: { groupId: "execution", label: "Start execution runtime", order: 180 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "runtime.stop": threadOnlyManifestEntry({
    id: "runtime.stop", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_resource"},
    description: "Stops an authorized execution runtime using current impact and incarnation fences. Can interrupt its work; refuses source-route disruption. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Stop execution runtime", order: 190 },
    effects: { application: "destructive", modelUsage: "none", external: "durable_side_effect" },
  }),
  "runtime.restart": threadOnlyManifestEntry({
    id: "runtime.restart", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_resource"},
    description: "Restarts an authorized execution runtime using current impact and incarnation fences. Can interrupt its work; refuses source-route disruption. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Restart execution runtime", order: 200 },
    effects: { application: "destructive", modelUsage: "none", external: "durable_side_effect" },
  }),
  "runtime.upgrade": threadOnlyManifestEntry({
    id: "runtime.upgrade", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_resource"},
    description: "Upgrades a supported execution sidecar using current impact and incarnation fences. Can interrupt its work; refuses source-route disruption. Reuse mutationId for retries.",
    catalog: { groupId: "execution", label: "Upgrade execution sidecar", order: 210 },
    effects: { application: "destructive", modelUsage: "none", external: "durable_side_effect" },
  }),
  "runtime.operation.get": threadOnlyManifestEntry({
    id: "runtime.operation.get", schemaVersion: 1,
    environmentAuthority: {"kind":"runtime_receipt"},
    description: "Returns the original lifecycle mutation’s current result after authorizing its retained resource. This recovery operation may settle or withdraw an unadmitted command; it is not a side-effect-free read.",
    catalog: { groupId: "execution", label: "Inspect lifecycle operation", order: 220 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "tool_policy.options": threadOnlyManifestEntry({
    id: "tool_policy.options", schemaVersion: 1,
    environmentAuthority: {"kind":"public_information"},
    description: "Lists eligible tool IDs, groups, and descriptions for policy administration. Availability does not grant invocation authority.",
    catalog: { groupId: "execution", label: "Tool policy options", order: 230 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "tool_policy.list": threadOnlyManifestEntry({
    id: "tool_policy.list", schemaVersion: 1,
    environmentAuthority: {"kind":"principal_management"},
    description: "Lists principal-owned tool policy sets. Requires cross-environment authority; policy definitions do not alter existing thread snapshots.",
    catalog: { groupId: "execution", label: "List tool policies", order: 240 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "tool_policy.get": threadOnlyManifestEntry({
    id: "tool_policy.get", schemaVersion: 1,
    environmentAuthority: {"kind":"principal_management"},
    description: "Reads one principal-owned tool policy set and its revision. Requires cross-environment authority.",
    catalog: { groupId: "execution", label: "Read tool policy", order: 250 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "tool_policy.create": threadOnlyManifestEntry({
    id: "tool_policy.create", schemaVersion: 1,
    environmentAuthority: {"kind":"principal_management"},
    description: "Creates a named tool policy set. Requires cross-environment authority; authoring is not limited to the caller’s enabled tools. This operation has no durable replay: inspect current state after an uncertain reply.",
    catalog: { groupId: "execution", label: "Create tool policy", order: 260 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "tool_policy.update": threadOnlyManifestEntry({
    id: "tool_policy.update", schemaVersion: 1,
    environmentAuthority: {"kind":"principal_management"},
    description: "Revision-checks edits to a named policy set without changing existing thread snapshots. Requires cross-environment authority; after an uncertain reply reread the policy.",
    catalog: { groupId: "execution", label: "Update tool policy", order: 270 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "tool_policy.remove": threadOnlyManifestEntry({
    id: "tool_policy.remove", schemaVersion: 1,
    environmentAuthority: {"kind":"principal_management"},
    description: "Removes a named policy set at its expected revision, preserving existing missing-reference behavior. Requires cross-environment authority; does not rewrite thread snapshots.",
    catalog: { groupId: "execution", label: "Remove tool policy", order: 280 },
    effects: { application: "destructive", modelUsage: "none", external: "none" },
  }),
  "tool_policy.defaults.get": threadOnlyManifestEntry({
    id: "tool_policy.defaults.get", schemaVersion: 1,
    environmentAuthority: {"kind":"policy_selection"},
    description: "Reads one authorized account, environment, or backend policy selection. An unset selection is inherit at revision 0; the target must exist.",
    catalog: { groupId: "execution", label: "Read tool policy default", order: 290 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "tool_policy.defaults.update": threadOnlyManifestEntry({
    id: "tool_policy.defaults.update", schemaVersion: 1,
    environmentAuthority: {"kind":"policy_selection"},
    description: "Revision-checks one authorized account, environment, or backend policy selection for future threads. Does not change existing thread snapshots; reread after an uncertain reply.",
    catalog: { groupId: "execution", label: "Set tool policy default", order: 300 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "tool_policy.preview": threadOnlyManifestEntry({
    id: "tool_policy.preview", schemaVersion: 1,
    environmentAuthority: {"kind":"policy_preview"},
    description: "Previews the effective policy for an authorized projected targetId and optional Agent/thread selections, including supported presentations. Inspection grants no assignment or invocation authority.",
    catalog: { groupId: "execution", label: "Preview tool policy", order: 310 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread.tool_settings.get": threadOnlyManifestEntry({
    id: "thread.tool_settings.get", schemaVersion: 1,
    environmentAuthority: {"kind":"direct_resource","resource":"thread"},
    description: "Reads an authorized thread’s applied tool policy, policy revision, and supported presentations.",
    catalog: { groupId: "threads", label: "Read thread tool settings", order: 90 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread.tool_settings.update": threadOnlyManifestEntry({
    id: "thread.tool_settings.update", schemaVersion: 1,
    environmentAuthority: {"kind":"direct_resource","resource":"thread"},
    description: "Updates an authorized thread’s applied tool snapshot under existing live/idle checks and the caller ceiling. Refuses the source thread. mutationId is correlation only; reread after an uncertain reply.",
    catalog: { groupId: "threads", label: "Update thread tool settings", order: 100 },
    effects: { application: "write", modelUsage: "none", external: "durable_side_effect" },
  }),
  "thread_template.list": threadOnlyManifestEntry({
    id: "thread_template.list", schemaVersion: 1,
    environmentAuthority: {"kind":"template_query"},
    description: "Lists existing authorized thread templates without environment-variable bindings.",
    catalog: { groupId: "threads", label: "List thread templates", order: 110 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread_template.get": threadOnlyManifestEntry({
    id: "thread_template.get", schemaVersion: 1,
    environmentAuthority: {"kind":"direct_resource","resource":"thread_template"},
    description: "Reads an authorized template’s settings and revision, excluding environment-variable bindings.",
    catalog: { groupId: "threads", label: "Read thread template", order: 120 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread_template.update": threadOnlyManifestEntry({
    id: "thread_template.update", schemaVersion: 1,
    environmentAuthority: {"kind":"direct_resource","resource":"thread_template"},
    description: "Revision-checks a template’s tool-policy selection and presentation while preserving its other settings and variable bindings. Enforces the caller’s assignment ceiling; reread after an uncertain reply.",
    catalog: { groupId: "threads", label: "Update template tool settings", order: 130 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "image.show": threadOnlyManifestEntry({
    id: "image.show", schemaVersion: 1, environmentAuthority: { kind: "source_only" },
    description: "Show an image file in this conversation. Read a PNG, JPEG, GIF, or WebP from an absolute path in this thread's execution environment and retain a snapshot in chat, even if the source changes or is deleted. Optional title describes the image. Uses existing Files access and image size limits. Returns image metadata; it does not send image bytes to the model or create a Pages entry. Requires the originating active turn.",
    catalog: { groupId: "images", label: "Show image", order: 10 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "page.publish": threadOnlyManifestEntry({
    id: "page.publish", schemaVersion: 1, environmentAuthority: { kind: "source_only" },
    description: "Publish HTML from exactly one path (execution-environment file, max 1 MiB) or html (max 65,536 characters). Inline CSS/JS only. Files capture local PNG/JPEG/GIF/WebP; html needs data images. No HTTP resources. Optional viewport fixes width/height; update with pageId and expectedRevision. For controls or canvas, register window.sedes?.onSubmit(() => string): synchronously return all answers as one nonblank plain-text string, max 65,536 UTF-8 bytes, with no separate summary. Optional registration lets downloaded HTML run without the Sedes API. User's host Send captures once and sends or queues to the owning thread, never Steer. Unsent state is transient with no agent readback; pages cannot send themselves.",
    catalog: { groupId: "pages", label: "Publish HTML page", order: 10 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "page.preview": threadOnlyManifestEntry({
    id: "page.preview", schemaVersion: 1, environmentAuthority: { kind: "source_only" },
    outputMediaTypes: ["image/png"] as const,
    description: "Preview HTML as a PNG screenshot, console output and dimensions. Provide exactly one path or html using page.publish source and isolation rules. Returns native image content, or a private PNG path through CLI. Requires the optional preview browser. Supports window.sedes.onSubmit registration so page code can test its own producer. Preview never invokes it for submission, sends a response, or publishes a revision.",
    catalog: { groupId: "pages", label: "Preview HTML page", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "page.list": threadOnlyManifestEntry({
    id: "page.list", schemaVersion: 1, environmentAuthority: { kind: "source_only" },
    description: "List the current revisions of HTML pages published in this thread, including previews from before context compaction.",
    catalog: { groupId: "pages", label: "List HTML pages", order: 30 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "page.get": threadOnlyManifestEntry({
    id: "page.get", schemaVersion: 1, environmentAuthority: { kind: "source_only" },
    description: "Get a current or historical HTML page revision with its original source: sourcePath for a file publication, or html for an inline publication. Use the returned source to edit and publish another immutable revision, including after context compaction.",
    catalog: { groupId: "pages", label: "Get HTML page", order: 40 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "page.revisions": threadOnlyManifestEntry({
    id: "page.revisions", schemaVersion: 1, environmentAuthority: { kind: "source_only" },
    description: "List immutable saved revisions of an HTML page in this thread, newest first.",
    catalog: { groupId: "pages", label: "List page revisions", order: 50 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "client.list": threadOnlyManifestEntry({
    id: "client.list", schemaVersion: 2, environmentAuthority: { kind: "source_only" },
    description: "List connected Sedes clients only when the user asks to list devices or explicitly target another device. Never automatically choose another client.",
    catalog: { groupId: "client", label: "List clients", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "client.end_interaction": threadOnlyManifestEntry({
    id: "client.end_interaction", schemaVersion: 2, environmentAuthority: { kind: "source_only" },
    description: "Finish this turn\u2019s spoken reply, then suppress its follow-up listening on the current client. Does not cancel the turn or change voice settings. Current client means the client that started this turn; later Steer input never changes it. Set clientId only when the user explicitly requests another client.",
    catalog: { groupId: "client", label: "End interaction", order: 20 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "client.switch_thread": threadOnlyManifestEntry({
    id: "client.switch_thread", schemaVersion: 2, environmentAuthority: { kind: "direct_resource", resource: "thread" },
    description: "After turn completion and reply playback, navigate the foreground client to the exact thread. listen defaults to false; true requests one listen even with autoListen off, without enabling voice or changing its default. Background Android requires ready native voice for listen=true and never navigates, including on resume; listen=false is a no-op. The current client started this turn; Steer never changes it. Set clientId only when the user explicitly requests another client.",
    catalog: { groupId: "client", label: "Switch thread", order: 30 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "client.settings.get": threadOnlyManifestEntry({
    id: "client.settings.get", schemaVersion: 2, environmentAuthority: { kind: "source_only" },
    description: "Read the current client\u2019s basic voice settings, revision, capabilities and readiness. Current client means the client that started this turn; later Steer input never changes it. Set clientId only when the user explicitly requests another client.",
    catalog: { groupId: "client", label: "Read client settings", order: 40 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "client.settings.update": threadOnlyManifestEntry({
    id: "client.settings.update", schemaVersion: 2, environmentAuthority: { kind: "direct_resource", resource: "thread", inputField: "patch.voice.voiceThreadId", defaultToSource: true,
    },
    description: "Update the current client\u2019s basic voice settings using the revision from settings.get. Persists immediately; Off stops voice immediately. Setting the default thread does not navigate or listen. Current client means the client that started this turn; later Steer input never changes it. Set clientId only when the user explicitly requests another client.",
    catalog: { groupId: "client", label: "Update client settings", order: 50 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "client.replay_turn": threadOnlyManifestEntry({
    id: "client.replay_turn", schemaVersion: 2, environmentAuthority: { kind: "direct_resource", resource: "thread", defaultToSource: true,
    },
    description: "Replay an ended turn\u2019s reply on the current client, queued behind voice work without navigation or automatic-playback filters. Auto-listen can record a new reply to that thread when input is available. threadId defaults to this thread; turnId to its latest ended turn with a stored reply. For an earlier turn, use turns[].id from thread.messages. Current client started this turn; Steer never changes it. Set clientId only when the user explicitly requests another client.",
    catalog: { groupId: "client", label: "Replay turn reply", order: 60 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "agent.context": threadOnlyManifestEntry({
    environmentAuthority: { kind: "source_only" },
    id: "agent.context",
    schemaVersion: 5,
    description: "Returns the Sedes source thread, workspace, project, and backend.",
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
    schemaVersion: 5,
    description:
      "Lists admitted principal-owned Sedes workspaces with their projects by recent use, defaulting to the caller's configured environment.",
    catalog: { groupId: "context", label: "List workspaces", order: 30 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workspace.open": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "environment",
      inputField: "environmentId",
      projectInputField: "projectId",
    },
    id: "workspace.open",
    schemaVersion: 3,
    description:
      "Opens an existing directory in a configured execution environment as a Sedes workspace, optionally as a location of an existing project; otherwise a new directory becomes its own project. Restoring a removed location requires naming its project.",
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
    catalog: { groupId: "threads", label: "Clear preferred worktree", order: 3,
    },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.status": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread" },
    id: "thread.status",
    schemaVersion: 7,
    description:
      "Returns a Sedes thread's lifecycle, activity, pin state, Group membership, and any snooze deadline and reminder.",
    catalog: { groupId: "threads", label: "Thread status", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread.list": manifestEntry({
    environmentAuthority: { kind: "scoped_query", resource: "thread" },
    id: "thread.list",
    schemaVersion: 11,
    description:
      "Searches admitted Sedes threads with lifecycle, activity, pin state, Group membership, and snooze details. Filter by groupId, or use null for ungrouped threads. Defaults to the caller's configured environment with newest activity first.",
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
    schemaVersion: 6,
    description:
      "Creates an unbound Sedes draft thread without sending a prompt or starting model work.",
    catalog: { groupId: "threads", label: "Create thread", order: 30 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.messages": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread" },
    id: "thread.messages",
    schemaVersion: 5,
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
    schemaVersion: 2,
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
  "thread.set_state": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "thread.set_state",
    schemaVersion: 1,
    description:
      "Parks, unparks, snoozes, or wakes one Sedes thread. Omit threadId to target the calling thread or the Tool client's configured default. Parking mutes progress speech. A running thread returns to Active when that turn ends. If an agent parks its own thread from that same turn, success keeps it parked and failure or interruption returns it to Active. Parking keeps Tasks and stashes attached. Set a parked thread to active before snoozing it. A thread already in the requested lifecycle keeps its current settings. Use thread.restore for archived threads.",
    catalog: { groupId: "threads", label: "Set thread state", order: 85 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.set_pinned": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread", defaultToSource: true },
    id: "thread.set_pinned",
    schemaVersion: 1,
    description:
      "Pins or unpins a thread for the current user, including archived threads. Omit threadId for the calling thread or configured default. Setting the current pin value succeeds without changing it.",
    catalog: { groupId: "threads", label: "Set thread pin", order: 86 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread.set_group": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread", defaultToSource: true },
    id: "thread.set_group",
    schemaVersion: 1,
    description:
      "Moves one thread into an existing Group, or removes it when groupId is null. Accepts archived threads. Omit threadId for the calling thread or configured default. Setting the current membership succeeds without changing it.",
    catalog: { groupId: "threads", label: "Set thread Group", order: 87 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "thread_group.list": manifestEntry({
    environmentAuthority: { kind: "environment_neutral" },
    id: "thread_group.list",
    schemaVersion: 1,
    description:
      "Lists the current user's Group IDs and names across projects and environments, including empty Groups. Use thread.list with groupId to find admitted members.",
    catalog: { groupId: "threads", label: "List thread Groups", order: 88 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "thread_group.create": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "thread", defaultToSource: true },
    id: "thread_group.create",
    schemaVersion: 1,
    description:
      "Creates a named Group and assigns one founding thread, including an archived thread. Omit threadId for the calling thread or configured default. Duplicate names conflict. After an uncertain result, check the thread and Group directory before retrying.",
    catalog: { groupId: "threads", label: "Create thread Group", order: 89 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "saved_agent.list": manifestEntry({
    environmentAuthority: { kind: "environment_neutral" },
    id: "saved_agent.list",
    schemaVersion: 7,
    description:
      "Lists bounded database-backed summaries of principal-owned saved Agents.",
    catalog: { groupId: "agents", label: "List Agents", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "saved_agent.get": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "saved_agent", inputField: "agentId",
    },
    id: "saved_agent.get",
    schemaVersion: 7,
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
    schemaVersion: 7,
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
    schemaVersion: 7,
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
    schemaVersion: 7,
    description:
      "Revision-checks and atomically updates selected saved Agent fields.",
    catalog: { groupId: "agents", label: "Update Agent", order: 50 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "saved_agent.delete": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "saved_agent", inputField: "agentId",
    },
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
    schemaVersion: 2,
    description: "Lists bounded workpad summaries in a scope or its descendants, optionally searching title and content.",
    catalog: { groupId: "workpads", label: "List workpads", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workpad.get": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "workpad" },
    id: "workpad.get",
    schemaVersion: 2,
    description: "Reads current or historical workpad text and revision author. Access follows the current scope.",
    catalog: { groupId: "workpads", label: "Get workpad", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workpad.revisions": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "workpad" },
    id: "workpad.revisions",
    schemaVersion: 2,
    description: "Lists bounded revision history metadata for a workpad.",
    catalog: { groupId: "workpads", label: "Workpad revisions", order: 30 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "workpad.create": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "workpad" },
    id: "workpad.create",
    schemaVersion: 2,
    description: "Creates a scoped Markdown workpad attributed to the authenticated caller.",
    catalog: { groupId: "workpads", label: "Create workpad", order: 40 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "workpad.update": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "workpad" },
    id: "workpad.update",
    schemaVersion: 2,
    description: "Atomically edits, renames, moves, archives, or restores a workpad against its expected revision. Replace content, append text, or apply exact unique replacements; unchanged text retains attribution.",
    catalog: { groupId: "workpads", label: "Update workpad", order: 50 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "task.list": manifestEntry({
    environmentAuthority: { kind: "scoped_query", resource: "task" },
    id: "task.list",
    schemaVersion: 5,
    description:
      "Lists filtered tasks in one scope or its descendant scopes as summaries or bounded full records. Backlog tasks are included unless filtered out.",
    catalog: { groupId: "tasks", label: "List tasks", order: 10 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "task.get": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "task" },
    id: "task.get",
    schemaVersion: 3,
    description: "Returns one complete principal-owned Sedes task.",
    catalog: { groupId: "tasks", label: "Get task", order: 20 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "task.create": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "task" },
    id: "task.create",
    schemaVersion: 3,
    description:
      "Creates an open task atomically with its content, pin, backlog stage, files, and scope.",
    catalog: { groupId: "tasks", label: "Create task", order: 30 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "task.update": manifestEntry({
    environmentAuthority: { kind: "scope_transition", resource: "task" },
    id: "task.update",
    schemaVersion: 3,
    description:
      "Atomically updates one or more mutable task fields against an expected revision. Completing a task unpins it and takes it out of the backlog.",
    catalog: { groupId: "tasks", label: "Update task", order: 40 },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "task.delete": manifestEntry({
    environmentAuthority: { kind: "direct_resource", resource: "task" },
    id: "task.delete",
    schemaVersion: 1,
    description:
      "Deletes a completed task at the expected revision. Invoke only at the user’s request.",
    catalog: { groupId: "tasks", label: "Delete task", order: 50 },
    effects: { application: "destructive", modelUsage: "none", external: "none",
    },
  }),
  "automation.get": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "automation",
    },
    id: "automation.get",
    schemaVersion: 3,
    description:
      "Returns the named automation selected by automationId and its upcoming occurrences.",
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
      resource: "automation",
    },
    id: "automation.runs",
    schemaVersion: 2,
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
    schemaVersion: 3,
    description:
      "Creates a named independent automation in its requested initial state. Reuse mutationId for a retry; enabled state schedules model execution.",
    catalog: {
      groupId: "automations",
      label: "Create automation",
      order: 30,
    },
    effects: { application: "write", modelUsage: "none", external: "none" },
  }),
  "automation.update": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "automation",
    },
    id: "automation.update",
    schemaVersion: 3,
    description:
      "Revision-checks schedule, pre-check, prompt, and run-mode changes that govern future automated executions; omitted fields are preserved and a null pre-check clears it. retired is true when the change retired a finished one-time automation, which then no longer exists.",
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
      resource: "automation",
    },
    id: "automation.set_state",
    schemaVersion: 3,
    description:
      "Enables or pauses an automation using its revision. Enabling schedules future model execution. retired is true when pausing retired a finished one-time automation, which then no longer exists.",
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
      resource: "automation",
    },
    id: "automation.run_now",
    schemaVersion: 2,
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
  "automation.list": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "thread",
      defaultToSource: true,
    },
    id: "automation.list",
    schemaVersion: 2,
    description:
      "Lists independent automations on the requested thread, defaulting to the current thread. Follow nextCursor until null.",
    catalog: {
      groupId: "automations",
      label: "List automations", order: 5 },
    effects: { application: "read", modelUsage: "none", external: "none" },
  }),
  "automation.delete": manifestEntry({
    environmentAuthority: {
      kind: "direct_resource",
      resource: "automation" },
    id: "automation.delete",
    schemaVersion: 1,
    description:
      "Deletes the selected automation at its expected revision, retaining run history. Invoke only at the user's request.",
    catalog: {
      groupId: "automations",
      label: "Delete automation", order: 70 },
    effects: {
      application: "destructive",
      modelUsage: "none",
      external: "none",
    },
  }),
  "research.web_search": manifestEntry({
    environmentAuthority: { kind: "public_information" },
    id: "research.web_search",
    schemaVersion: 1,
    description:
      "Searches the current public web and opens relevant pages. Pass a complete natural-language request. Set continue only for a direct follow-up that relies on the most recent successful search by this same Sedes caller; use a new search for a different question. Continuation is best-effort and safely becomes a fresh search when the exact prior session is unavailable.",
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
