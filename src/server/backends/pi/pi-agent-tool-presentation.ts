import path from "node:path";
import type { BackendAgentToolPolicy } from "../../agent-tools/adapters/backend-facade.js";
import type { AgentToolCliAvailability } from "../module.js";
import type {
  TrustedPiAgentToolDescriptor,
  TrustedPiAgentToolRegistration,
} from "./pi-tool-identities.js";
import type { PiToolAccessMode } from "./pi-tool-access.js";
import type { AgentToolPresentationMode } from "../../../shared/protocol/conversation.js";

export interface PiAgentToolCliEnvironment {
  readonly SEDES_AGENT_TOOL_ENDPOINT: string;
  readonly SEDES_AGENT_TOOL_SOURCE_CAPABILITY: string;
  readonly SEDES_AGENT_TOOL_CLI_MODE: AgentToolPresentationMode;
  readonly executableDirectory: string;
}

export type PiAgentToolCliResolution = AgentToolCliAvailability;

export type PiResolvedAgentToolPolicy = BackendAgentToolPolicy;

export interface PiAgentToolTurnPresentation {
  readonly enabledNativeToolNames: ReadonlySet<string>;
  readonly enabledReadOnlyNativeToolNames: ReadonlySet<string>;
}

export function createPiAgentToolCliEnvironment(
  resolution: Extract<PiAgentToolCliResolution, { availability: "available" }>,
  sourceCapability: string,
  mode: AgentToolPresentationMode,
): PiAgentToolCliEnvironment {
  const environment = Object.freeze({
    SEDES_AGENT_TOOL_ENDPOINT: resolution.endpoint,
    SEDES_AGENT_TOOL_SOURCE_CAPABILITY: sourceCapability,
    SEDES_AGENT_TOOL_CLI_MODE: mode,
    executableDirectory: resolution.executableDirectory,
  });
  if (
    !isSedesEndpoint(environment.SEDES_AGENT_TOOL_ENDPOINT) ||
    !isAbsoluteNormalizedPath(environment.executableDirectory) ||
    (mode !== "progressive" && mode !== "individual") ||
    !/^[A-Za-z0-9_-]{32,256}$/u.test(sourceCapability)
  ) {
    throw new Error("pi_agent_tool_cli_environment_invalid");
  }
  return environment;
}

export function resolvePiAgentToolTurnPresentation(
  policy: PiResolvedAgentToolPolicy,
  descriptors: readonly TrustedPiAgentToolRegistration[],
  accessMode: PiToolAccessMode = "full",
): PiAgentToolTurnPresentation {
  const descriptorsById = new Map(
    descriptors.flatMap((descriptor) =>
      "gateway" in descriptor ? [] : [[descriptor.toolId, descriptor] as const],
    ),
  );
  const individualDescriptors = descriptors.filter(
    (descriptor): descriptor is TrustedPiAgentToolDescriptor =>
      !("gateway" in descriptor),
  );
  if (descriptorsById.size !== individualDescriptors.length) {
    throw new Error("pi_agent_tool_descriptor_ambiguous");
  }
  if (!policy.enabled) {
    return {
      enabledNativeToolNames: new Set(),
      enabledReadOnlyNativeToolNames: new Set(),
    };
  }
  if (policy.presentation.surface === "cli") {
    // CLI availability is deployment state, not conversation validity. When
    // the environment cannot be provisioned, keep the session attachable and
    // fail closed by exposing no native tools (and no usable CLI context).
    return {
      enabledNativeToolNames: new Set(),
      enabledReadOnlyNativeToolNames: new Set(),
    };
  }
  if (
    policy.presentation.surface === "native" &&
    policy.presentation.mode === "progressive"
  ) {
    const enabledIds = new Set(policy.enabledToolIds);
    let hasRead = false;
    let hasAction = false;
    for (const descriptor of individualDescriptors) {
      if (!enabledIds.has(descriptor.toolId)) continue;
      if (descriptor.readOnly === true) hasRead = true;
      else hasAction = true;
    }
    const enabledNativeToolNames = new Set<string>(["sedes_catalog"]);
    const enabledReadOnlyNativeToolNames = new Set<string>(["sedes_catalog"]);
    if (hasRead) {
      enabledNativeToolNames.add("sedes_read");
      enabledReadOnlyNativeToolNames.add("sedes_read");
    }
    if (hasAction && accessMode !== "read_only") {
      enabledNativeToolNames.add("sedes_act");
    }
    return { enabledNativeToolNames, enabledReadOnlyNativeToolNames };
  }
  if (
    policy.presentation.surface !== "native" ||
    policy.presentation.mode !== "individual"
  ) {
    throw new Error("pi_agent_tool_presentation_invalid");
  }
  const enabledIds = new Set(policy.enabledToolIds);
  const enabledNativeToolNames = new Set<string>();
  const enabledReadOnlyNativeToolNames = new Set<string>();
  // Preserve the registered catalog order. Tool activation may be reflected in
  // the provider prompt, so policy storage order must not perturb it.
  for (const descriptor of individualDescriptors) {
    if (!enabledIds.has(descriptor.toolId)) continue;
    enabledNativeToolNames.add(descriptor.toolName);
    if (descriptor.readOnly === true) {
      enabledReadOnlyNativeToolNames.add(descriptor.toolName);
    }
  }
  return { enabledNativeToolNames, enabledReadOnlyNativeToolNames };
}

function isAbsoluteNormalizedPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function isSedesEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port.length > 0 &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.pathname === "/" &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
