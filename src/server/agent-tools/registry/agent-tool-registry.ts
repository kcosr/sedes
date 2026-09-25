import type {
  AgentToolAdapter,
  AgentToolContractArtifact,
  AgentToolDefinition,
  AgentToolPresentations,
  ToolExecutionPolicy,
} from "../contracts/agent-tool-contracts.js";
import { nativeAgentToolName } from "../contracts/agent-tool-contracts.js";
import {
  AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES,
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
} from "../contracts/agent-tool-transport-limits.js";
import {
  compileCanonicalAgentToolSchema,
  type CanonicalSchemaValidator,
  type CanonicalAgentToolRootSchema,
} from "../schema/canonical-json-schema.js";
import { canonicalCliOptionSpecs } from "../schema/canonical-cli-options.js";
import { deterministicJsonArtifact } from "../../canonical-json.js";
import { compareCanonicalAgentToolDefinitions } from "./canonical-agent-tool-catalog.js";

const toolIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const capabilityPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const adapterNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/;
const concurrencyClassPattern = /^[a-z][a-z0-9_-]{0,63}$/;
const groupIds = new Set([
  "context",
  "files",
  "threads",
  "agents",
  "tasks",
  "workpads",
  "automations",
  "research",
]);
const reservedCliCommandRoots = new Set(["tool"]);

export function cliCommandPath(command: string): readonly string[] {
  const commandPath = command
    .split(".")
    .map((part) => part.replaceAll("_", "-"));
  if (
    commandPath.length === 0 ||
    commandPath.length > 4 ||
    commandPath.some((part) => !/^[a-z][a-z0-9-]{0,31}$/.test(part)) ||
    reservedCliCommandRoots.has(commandPath[0]!)
  ) {
    throw new Error("agent_tool_cli_command_path_invalid");
  }
  return Object.freeze(commandPath);
}

interface RegisteredAgentTool {
  readonly definition: AgentToolDefinition;
  readonly inputSchema: CanonicalAgentToolRootSchema;
  readonly outputSchema: CanonicalAgentToolRootSchema;
  readonly inputValidator: CanonicalSchemaValidator;
  readonly outputValidator: CanonicalSchemaValidator;
  readonly artifact: AgentToolContractArtifact;
  readonly serializedArtifact: string;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function assertBoundedString(
  value: unknown,
  name: string,
  maximumBytes: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    throw new Error(`agent_tool_${name}_invalid`);
  }
}

function assertPositiveInteger(value: unknown, name: string, maximum: number) {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new Error(`agent_tool_${name}_invalid`);
  }
}

function assertPresentationName(value: string, adapter: string): void {
  if (!adapterNamePattern.test(value)) {
    throw new Error(`agent_tool_${adapter}_name_invalid`);
  }
}

function validatePresentations(
  toolId: string,
  adapters: AgentToolPresentations,
  exposure: readonly AgentToolAdapter[],
): void {
  if (typeof adapters !== "object" || adapters === null) {
    throw new Error("agent_tool_presentations_invalid");
  }
  if (adapters.pi) {
    assertPresentationName(adapters.pi.name, "pi");
    assertBoundedString(adapters.pi.label, "pi_label", 120);
    if (adapters.pi.promptSnippet !== undefined) {
      assertBoundedString(adapters.pi.promptSnippet, "pi_prompt_snippet", 500);
    }
    for (const guideline of adapters.pi.promptGuidelines ?? []) {
      assertBoundedString(guideline, "pi_prompt_guideline", 500);
    }
  }
  if (adapters.mcp) {
    assertPresentationName(adapters.mcp.name, "mcp");
    if (adapters.mcp.name !== nativeAgentToolName(toolId)) {
      throw new Error("agent_tool_mcp_name_not_canonical");
    }
    if (adapters.mcp.title !== undefined) {
      assertBoundedString(adapters.mcp.title, "mcp_title", 120);
    }
  }
  if (adapters.cli) {
    assertPresentationName(adapters.cli.command, "cli");
    cliCommandPath(adapters.cli.command);
  }
  if (adapters.http && adapters.http.invocation !== "inline") {
    throw new Error("agent_tool_http_presentation_invalid");
  }
  if (exposure.includes("pi_sdk") !== (adapters.pi !== undefined)) {
    throw new Error("agent_tool_pi_exposure_presentation_mismatch");
  }
  if (exposure.includes("mcp") !== (adapters.mcp !== undefined)) {
    throw new Error("agent_tool_mcp_exposure_presentation_mismatch");
  }
  if (exposure.includes("cli") !== (adapters.cli !== undefined)) {
    throw new Error("agent_tool_cli_exposure_presentation_mismatch");
  }
  if (exposure.includes("http") !== (adapters.http !== undefined)) {
    throw new Error("agent_tool_http_exposure_presentation_mismatch");
  }
}

function validateExecution(
  policy: ToolExecutionPolicy,
  exposure: readonly AgentToolAdapter[],
): void {
  if (
    !["inline", "operation", "hybrid"].includes(policy.form) ||
    !["required", "supported", "not_applicable"].includes(policy.idempotency) ||
    !["none", "structured"].includes(policy.progress) ||
    typeof policy.supportsCancellation !== "boolean" ||
    typeof policy.uncertainExternalOutcome !== "boolean" ||
    !concurrencyClassPattern.test(policy.concurrencyClass)
  ) {
    throw new Error("agent_tool_execution_policy_invalid");
  }
  assertPositiveInteger(
    policy.maximumInputBytes,
    "maximum_input_bytes",
    4 * 1_024 * 1_024,
  );
  assertPositiveInteger(
    policy.maximumOutputBytes,
    "maximum_output_bytes",
    AGENT_TOOL_MAXIMUM_RESPONSE_BYTES,
  );
  if (
    exposure.includes("http") &&
    policy.maximumOutputBytes > AGENT_TOOL_MAXIMUM_HTTP_TOOL_OUTPUT_BYTES
  ) {
    throw new Error("agent_tool_http_output_transport_limit_exceeded");
  }
  for (const [adapter, milliseconds] of Object.entries(
    policy.adapterWaitCeilingMilliseconds,
  )) {
    if (
      !(["pi_sdk", "mcp", "http", "cli"] as const).includes(
        adapter as AgentToolAdapter,
      )
    ) {
      throw new Error("agent_tool_adapter_wait_ceiling_invalid");
    }
    assertPositiveInteger(milliseconds, "adapter_wait_ceiling", 10 * 60_000);
  }
  if (
    exposure.some(
      (adapter) => policy.adapterWaitCeilingMilliseconds[adapter] === undefined,
    )
  ) {
    throw new Error("agent_tool_adapter_wait_ceiling_missing");
  }
}

function validateEffects(definition: AgentToolDefinition): void {
  if (
    !["read", "write", "destructive"].includes(
      definition.effects.application,
    ) ||
    !["none", "agent_execution"].includes(definition.effects.modelUsage) ||
    !["none", "durable_side_effect"].includes(definition.effects.external)
  ) {
    throw new Error("agent_tool_effects_invalid");
  }
  if (
    (definition.effects.application === "read") ===
    definition.execution.uncertainExternalOutcome
  ) {
    throw new Error("agent_tool_effect_uncertainty_mismatch");
  }
}

function validateCatalog(definition: AgentToolDefinition): void {
  const catalog = definition.catalog;
  if (
    typeof catalog !== "object" ||
    catalog === null ||
    !groupIds.has(catalog.groupId) ||
    !Number.isSafeInteger(catalog.order) ||
    catalog.order < 0 ||
    catalog.order > 10_000
  ) {
    throw new Error("agent_tool_catalog_presentation_invalid");
  }
  assertBoundedString(catalog.label, "catalog_label", 120);
}

function validateEnvironmentAuthority(definition: AgentToolDefinition): void {
  const authority = definition.environmentAuthority;
  if (typeof authority !== "object" || authority === null) {
    throw new Error("agent_tool_environment_authority_missing");
  }
  if (
    authority.kind === "source_only" ||
    authority.kind === "public_information" ||
    authority.kind === "installation_directory" ||
    authority.kind === "environment_neutral"
  ) {
    if (Object.keys(authority).length !== 1) {
      throw new Error("agent_tool_environment_authority_invalid");
    }
    return;
  }
  if (authority.kind === "direct_resource") {
    if (
      !["environment", "workspace", "thread", "thread_family", "task", "workpad", "saved_agent"].includes(
        authority.resource,
      ) ||
      (authority.inputField !== undefined &&
        !/^[a-z][A-Za-z0-9]{0,63}$/.test(authority.inputField)) ||
      (authority.defaultToSource !== undefined &&
        typeof authority.defaultToSource !== "boolean") ||
      ((authority.resource === "thread_family" ||
        authority.resource === "task" || authority.resource === "workpad" || authority.resource === "saved_agent") &&
        authority.defaultToSource !== undefined) ||
      Object.keys(authority).some(
        (key) =>
          !["kind", "resource", "inputField", "defaultToSource"].includes(key),
      )
    ) {
      throw new Error("agent_tool_environment_authority_invalid");
    }
    return;
  }
  if (
    authority.kind === "scoped_query" &&
    ["environment", "workspace", "thread", "task", "workpad"].includes(
      authority.resource,
    ) &&
    Object.keys(authority).every((key) => ["kind", "resource"].includes(key))
  )
    return;
  if (
    authority.kind === "scope_transition" &&
    ["workspace", "task", "workpad"].includes(authority.resource) &&
    (authority.inputField === undefined ||
      /^[a-z][A-Za-z0-9]{0,63}(?:\.[a-z][A-Za-z0-9]{0,63})*$/.test(
        authority.inputField,
      )) &&
    (authority.defaultToSource === undefined ||
      typeof authority.defaultToSource === "boolean") &&
    Object.keys(authority).every((key) =>
      ["kind", "resource", "inputField", "defaultToSource"].includes(key),
    )
  )
    return;
  throw new Error("agent_tool_environment_authority_invalid");
}

function normalizedArtifact(
  definition: AgentToolDefinition,
  inputSchema: CanonicalAgentToolRootSchema,
  outputSchema: CanonicalAgentToolRootSchema,
): AgentToolContractArtifact {
  const requiredCapabilities = [...definition.requiredCapabilities].sort();
  const exposure = {
    adapters: [...definition.exposure.adapters].sort(),
  };
  const waitCeilings = Object.fromEntries(
    Object.entries(definition.execution.adapterWaitCeilingMilliseconds).sort(
      ([left], [right]) => left.localeCompare(right),
    ),
  );
  return deepFreeze({
    artifactVersion: 2,
    id: definition.id,
    schemaVersion: definition.schemaVersion,
    description: definition.description,
    inputSchema,
    outputSchema,
    requiredCapabilities,
    callerEligibility: [...definition.callerEligibility].sort(),
    effects: { ...definition.effects },
    execution: {
      form: definition.execution.form,
      adapterWaitCeilingMilliseconds: waitCeilings,
      supportsCancellation: definition.execution.supportsCancellation,
      idempotency: definition.execution.idempotency,
      progress: definition.execution.progress,
      maximumInputBytes: definition.execution.maximumInputBytes,
      maximumOutputBytes: definition.execution.maximumOutputBytes,
      concurrencyClass: definition.execution.concurrencyClass,
      uncertainExternalOutcome: definition.execution.uncertainExternalOutcome,
    },
    exposure,
    catalog: {
      groupId: definition.catalog.groupId,
      label: definition.catalog.label,
      order: definition.catalog.order,
    },
    deployment: { eligible: definition.deployment?.eligible ?? false },
    adapters: {
      ...(definition.adapters.pi
        ? {
            pi: {
              ...definition.adapters.pi,
              ...(definition.adapters.pi.promptGuidelines
                ? {
                    promptGuidelines: [
                      ...definition.adapters.pi.promptGuidelines,
                    ],
                  }
                : {}),
            },
          }
        : {}),
      ...(definition.adapters.mcp
        ? { mcp: { ...definition.adapters.mcp } }
        : {}),
      ...(definition.adapters.cli
        ? {
            cli: { ...definition.adapters.cli },
          }
        : {}),
      ...(definition.adapters.http
        ? { http: { ...definition.adapters.http } }
        : {}),
    },
  });
}

export class AgentToolRegistry {
  readonly #byId = new Map<string, RegisteredAgentTool>();
  readonly #adapterNames = new Map<AgentToolAdapter, Map<string, string>>();
  readonly #cliCommandPaths = new Map<string, string>();

  register<Input, Output>(
    definition: AgentToolDefinition<Input, Output>,
  ): void {
    if (!toolIdPattern.test(definition.id) || definition.id.length > 128) {
      throw new Error("agent_tool_id_invalid");
    }
    assertPositiveInteger(
      definition.schemaVersion,
      "schema_version",
      1_000_000,
    );
    assertBoundedString(definition.description, "description", 2_000);
    if (this.#byId.has(definition.id)) {
      throw new Error(`agent_tool_already_registered:${definition.id}`);
    }
    if (typeof definition.execute !== "function") {
      throw new Error("agent_tool_executor_invalid");
    }
    if (
      definition.reconstructCompleted !== undefined &&
      typeof definition.reconstructCompleted !== "function"
    ) {
      throw new Error("agent_tool_completed_reconstructor_invalid");
    }
    const capabilities = [...definition.requiredCapabilities];
    if (
      capabilities.some(
        (capability) =>
          !capabilityPattern.test(capability) || capability.length > 128,
      ) ||
      new Set(capabilities).size !== capabilities.length
    ) {
      throw new Error("agent_tool_capabilities_invalid");
    }
    const exposure = [...definition.exposure.adapters];
    if (
      exposure.length === 0 ||
      exposure.some(
        (adapter) =>
          !(["pi_sdk", "mcp", "http", "cli"] as const).includes(adapter),
      ) ||
      new Set(exposure).size !== exposure.length
    ) {
      throw new Error("agent_tool_exposure_invalid");
    }
    const callerEligibility = [...definition.callerEligibility];
    if (
      callerEligibility.length === 0 ||
      callerEligibility.some(
        (caller) =>
          !(["thread_agent", "principal_client"] as const).includes(caller),
      ) ||
      new Set(callerEligibility).size !== callerEligibility.length
    ) {
      throw new Error("agent_tool_caller_eligibility_invalid");
    }
    if (
      definition.deployment !== undefined &&
      (typeof definition.deployment !== "object" ||
        definition.deployment === null ||
        typeof definition.deployment.eligible !== "boolean")
    ) {
      throw new Error("agent_tool_deployment_exposure_invalid");
    }
    validatePresentations(definition.id, definition.adapters, exposure);
    validateExecution(definition.execution, exposure);
    validateEffects(definition as AgentToolDefinition);
    validateCatalog(definition as AgentToolDefinition);
    validateEnvironmentAuthority(definition as AgentToolDefinition);
    const inputValidator = compileCanonicalAgentToolSchema(
      definition.inputSchema,
    );
    const outputValidator = compileCanonicalAgentToolSchema(
      definition.outputSchema,
    );
    const inputSchema = inputValidator.schema;
    const outputSchema = outputValidator.schema;
    if (exposure.includes("cli")) canonicalCliOptionSpecs(inputSchema);
    const artifact = normalizedArtifact(definition, inputSchema, outputSchema);
    const { artifactVersion: _artifactVersion, ...contract } = artifact;
    const normalizedDefinition = Object.freeze({
      ...contract,
      environmentAuthority: deepFreeze({ ...definition.environmentAuthority }),
      execute: definition.execute,
      ...(definition.reconstructCompleted
        ? { reconstructCompleted: definition.reconstructCompleted }
        : {}),
    }) as AgentToolDefinition;
    const registered: RegisteredAgentTool = {
      definition: normalizedDefinition,
      inputSchema,
      outputSchema,
      inputValidator,
      outputValidator,
      artifact,
      serializedArtifact: deterministicJsonArtifact(artifact),
    };
    const adapterNames = this.#names(normalizedDefinition);
    const normalizedCliPath = normalizedDefinition.adapters.cli
      ? cliCommandPath(normalizedDefinition.adapters.cli.command).join("\u0000")
      : undefined;
    if (normalizedCliPath !== undefined) {
      const owner = this.#cliCommandPaths.get(normalizedCliPath);
      if (owner) {
        throw new Error(
          `agent_tool_cli_command_path_already_registered:${normalizedDefinition.adapters.cli!.command}:${owner}`,
        );
      }
      const ambiguous = [...this.#cliCommandPaths.entries()].find(
        ([path]) =>
          path.startsWith(`${normalizedCliPath}\u0000`) ||
          normalizedCliPath.startsWith(`${path}\u0000`),
      );
      if (ambiguous) {
        throw new Error(
          `agent_tool_cli_command_path_ambiguous:${normalizedDefinition.adapters.cli!.command}:${ambiguous[1]}`,
        );
      }
    }
    for (const [adapter, name] of adapterNames) {
      const owner = this.#adapterNames.get(adapter)?.get(name);
      if (owner) {
        throw new Error(
          `agent_tool_adapter_name_already_registered:${adapter}:${name}:${owner}`,
        );
      }
    }
    for (const [adapter, name] of adapterNames) {
      const names =
        this.#adapterNames.get(adapter) ?? new Map<string, string>();
      names.set(name, definition.id);
      this.#adapterNames.set(adapter, names);
    }
    if (normalizedCliPath !== undefined) {
      this.#cliCommandPaths.set(normalizedCliPath, definition.id);
    }
    this.#byId.set(definition.id, registered);
  }

  get(id: string, schemaVersion: number): AgentToolDefinition {
    const registered = this.#byId.get(id);
    if (!registered || registered.definition.schemaVersion !== schemaVersion) {
      throw new Error(`agent_tool_not_registered:${id}@${schemaVersion}`);
    }
    return registered.definition;
  }

  list(): readonly AgentToolDefinition[] {
    return [...this.#byId.values()]
      .sort((left, right) =>
        compareCanonicalAgentToolDefinitions(left.definition, right.definition),
      )
      .map(({ definition }) => definition);
  }

  artifact(id: string, schemaVersion: number): AgentToolContractArtifact {
    const registered = this.#registered(id, schemaVersion);
    return registered.artifact;
  }

  serializedArtifact(id: string, schemaVersion: number): string {
    return this.#registered(id, schemaVersion).serializedArtifact;
  }

  validatesInput(id: string, schemaVersion: number, value: unknown): boolean {
    return this.#registered(id, schemaVersion).inputValidator.check(value);
  }

  validatesOutput(id: string, schemaVersion: number, value: unknown): boolean {
    return this.#registered(id, schemaVersion).outputValidator.check(value);
  }

  resolveAdapterName(
    adapter: AgentToolAdapter,
    name: string,
  ): AgentToolDefinition {
    const id = this.#adapterNames.get(adapter)?.get(name);
    if (!id) {
      throw new Error(
        `agent_tool_adapter_name_not_registered:${adapter}:${name}`,
      );
    }
    return this.#byId.get(id)!.definition;
  }

  #registered(id: string, schemaVersion: number): RegisteredAgentTool {
    const registered = this.#byId.get(id);
    if (!registered || registered.definition.schemaVersion !== schemaVersion) {
      throw new Error(`agent_tool_not_registered:${id}@${schemaVersion}`);
    }
    return registered;
  }

  #names(
    definition: AgentToolDefinition,
  ): readonly (readonly [AgentToolAdapter, string])[] {
    return [
      ...(definition.adapters.pi
        ? ([["pi_sdk", definition.adapters.pi.name]] as const)
        : []),
      ...(definition.adapters.mcp
        ? ([["mcp", definition.adapters.mcp.name]] as const)
        : []),
      ...(definition.adapters.cli
        ? ([["cli", definition.adapters.cli.command]] as const)
        : []),
      ...(definition.exposure.adapters.includes("http")
        ? ([["http", definition.id]] as const)
        : []),
    ];
  }
}
