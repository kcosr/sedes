import {
  classifyPiBuiltinTool,
  type PiBuiltinToolKind,
} from "./pi-builtin-tool-policy.js";

export type { PiBuiltinToolKind } from "./pi-builtin-tool-policy.js";

export interface PiToolInfoLike {
  readonly name: string;
  readonly description?: string;
  readonly sourceInfo: {
    readonly path: string;
    readonly source: string;
    readonly scope?: string;
    readonly origin?: string;
  };
}

export interface PiToolIdentity {
  readonly registrationId: string;
  readonly origin:
    | "pi_builtin"
    | "sedes_integration"
    | "sedes_agent_tool"
    | "sedes_agent_tool_gateway"
    | "extension";
  readonly canonicalKind?:
    PiBuiltinToolKind | "mcp" | "web_search" | "agent_tool";
  readonly displayName: string;
  readonly mcpServer?: string;
  readonly agentToolId?: string;
  readonly agentToolSchemaVersion?: number;
}

export interface TrustedPiIntegration {
  readonly sourcePath: string;
  readonly source: string;
  readonly toolName: string;
  readonly canonicalKind: "mcp" | "web_search";
  readonly displayName?: string;
  readonly mcpServer?: string;
}

export interface TrustedPiAgentToolDescriptor {
  readonly toolName: string;
  readonly toolId: string;
  readonly schemaVersion: number;
  readonly displayName?: string;
  /** Explicit adapter policy; omitted descriptors are never read-only. */
  readonly readOnly?: boolean;
}

export const PI_AGENT_TOOL_GATEWAY_NAMES = [
  "sedes_catalog",
  "sedes_read",
  "sedes_act",
] as const;

export type PiAgentToolGatewayName =
  (typeof PI_AGENT_TOOL_GATEWAY_NAMES)[number];

export interface TrustedPiAgentToolGatewayDescriptor {
  readonly toolName: PiAgentToolGatewayName;
  readonly gateway: true;
  readonly displayName: string;
  readonly readOnly: boolean;
}

export type TrustedPiAgentToolRegistration =
  TrustedPiAgentToolDescriptor | TrustedPiAgentToolGatewayDescriptor;

const reservedAgentToolNamePattern = /^sedes_[a-z][a-z0-9_]{0,119}$/;
const agentToolIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const gatewayNames = new Set<string>(PI_AGENT_TOOL_GATEWAY_NAMES);

function validAgentToolDescriptor(
  descriptor: TrustedPiAgentToolDescriptor,
): boolean {
  return (
    reservedAgentToolNamePattern.test(descriptor.toolName) &&
    agentToolIdPattern.test(descriptor.toolId) &&
    descriptor.toolId.length <= 128 &&
    Number.isSafeInteger(descriptor.schemaVersion) &&
    descriptor.schemaVersion > 0 &&
    descriptor.schemaVersion <= 1_000_000 &&
    (descriptor.readOnly === undefined ||
      typeof descriptor.readOnly === "boolean") &&
    (descriptor.displayName === undefined ||
      (descriptor.displayName.length > 0 &&
        descriptor.displayName.length <= 512))
  );
}

function validGatewayDescriptor(
  descriptor: TrustedPiAgentToolGatewayDescriptor,
): boolean {
  return (
    descriptor.gateway === true &&
    gatewayNames.has(descriptor.toolName) &&
    descriptor.displayName.length > 0 &&
    descriptor.displayName.length <= 512 &&
    typeof descriptor.readOnly === "boolean"
  );
}

function agentToolIdentity(
  tool: PiToolInfoLike,
  descriptor: TrustedPiAgentToolDescriptor,
): PiToolIdentity {
  if (
    tool.name !== descriptor.toolName ||
    tool.sourceInfo.source !== "sdk" ||
    tool.sourceInfo.path !== `<sdk:${descriptor.toolName}>`
  ) {
    throw new Error("pi_agent_tool_descriptor_mismatch");
  }
  return {
    registrationId: [
      "sedes",
      "agent-tool",
      descriptor.toolId,
      String(descriptor.schemaVersion),
      descriptor.toolName,
    ]
      .map((part) => encodeURIComponent(part))
      .join(":"),
    origin: "sedes_agent_tool",
    canonicalKind: "agent_tool",
    displayName: descriptor.displayName ?? descriptor.toolName,
    agentToolId: descriptor.toolId,
    agentToolSchemaVersion: descriptor.schemaVersion,
  };
}

function gatewayIdentity(
  tool: PiToolInfoLike,
  descriptor: TrustedPiAgentToolGatewayDescriptor,
): PiToolIdentity {
  if (
    tool.name !== descriptor.toolName ||
    tool.sourceInfo.source !== "sdk" ||
    tool.sourceInfo.path !== `<sdk:${descriptor.toolName}>`
  ) {
    throw new Error("pi_agent_tool_gateway_descriptor_mismatch");
  }
  return {
    registrationId: `sedes:agent-tool-gateway:${descriptor.toolName}`,
    origin: "sedes_agent_tool_gateway",
    canonicalKind: "agent_tool",
    displayName: descriptor.displayName,
  };
}

function builtinIdentity(
  tool: PiToolInfoLike,
  trustedBuiltinOverrides: ReadonlySet<PiBuiltinToolKind>,
): PiToolIdentity | undefined {
  const kind = classifyPiBuiltinTool(tool, trustedBuiltinOverrides);
  if (!kind) return undefined;
  return {
    registrationId: `pi:builtin:${kind}`,
    origin: "pi_builtin",
    canonicalKind: kind,
    displayName: kind,
  };
}

function registrationId(tool: PiToolInfoLike): string {
  return ["pi", tool.sourceInfo.source, tool.sourceInfo.path, tool.name]
    .map((part) => encodeURIComponent(part))
    .join(":");
}

function integrationMatches(
  tool: PiToolInfoLike,
  integration: TrustedPiIntegration,
): boolean {
  return (
    tool.name === integration.toolName &&
    tool.sourceInfo.source === integration.source &&
    tool.sourceInfo.path === integration.sourcePath
  );
}

export class PiToolIdentityCatalog {
  readonly #byName: ReadonlyMap<string, PiToolIdentity>;

  constructor(
    tools: readonly PiToolInfoLike[],
    trustedIntegrations: readonly TrustedPiIntegration[] = [],
    trustedAgentTools: readonly TrustedPiAgentToolRegistration[] = [],
    trustedBuiltinOverrides: ReadonlySet<PiBuiltinToolKind> = new Set(),
  ) {
    const agentToolsByName = new Map<string, TrustedPiAgentToolRegistration>();
    const agentToolIds = new Set<string>();
    for (const descriptor of trustedAgentTools) {
      const isGateway = "gateway" in descriptor;
      const descriptorKey = isGateway
        ? `gateway:${descriptor.toolName}`
        : `${descriptor.toolId}@${descriptor.schemaVersion}`;
      if (
        !(isGateway
          ? validGatewayDescriptor(descriptor)
          : validAgentToolDescriptor(descriptor)) ||
        agentToolsByName.has(descriptor.toolName) ||
        agentToolIds.has(descriptorKey)
      ) {
        throw new Error("pi_agent_tool_descriptor_ambiguous");
      }
      agentToolsByName.set(descriptor.toolName, descriptor);
      agentToolIds.add(descriptorKey);
    }
    const matchedAgentTools = new Set<string>();
    const byName = new Map<string, PiToolIdentity>();
    for (const tool of tools) {
      if (!tool.name || byName.has(tool.name)) {
        throw new Error("pi_tool_registry_ambiguous");
      }
      const builtin = builtinIdentity(tool, trustedBuiltinOverrides);
      if (builtin) {
        byName.set(tool.name, builtin);
        continue;
      }
      const agentTool = agentToolsByName.get(tool.name);
      if (tool.name.startsWith("sedes_") || agentTool) {
        if (!agentTool) {
          throw new Error("pi_agent_tool_descriptor_missing");
        }
        byName.set(
          tool.name,
          "gateway" in agentTool
            ? gatewayIdentity(tool, agentTool)
            : agentToolIdentity(tool, agentTool),
        );
        matchedAgentTools.add(tool.name);
        continue;
      }
      const integrations = trustedIntegrations.filter((candidate) =>
        integrationMatches(tool, candidate),
      );
      if (integrations.length > 1) {
        throw new Error("pi_tool_integration_ambiguous");
      }
      const integration = integrations[0];
      byName.set(
        tool.name,
        integration
          ? {
              registrationId: registrationId(tool),
              origin: "sedes_integration",
              canonicalKind: integration.canonicalKind,
              displayName: integration.displayName ?? tool.name,
              ...(integration.mcpServer
                ? { mcpServer: integration.mcpServer }
                : {}),
            }
          : {
              registrationId: registrationId(tool),
              origin: "extension",
              displayName: tool.name,
            },
      );
    }
    if (matchedAgentTools.size !== agentToolsByName.size) {
      throw new Error("pi_agent_tool_descriptor_unmatched");
    }
    this.#byName = byName;
  }

  get(toolName: string): PiToolIdentity | undefined {
    return this.#byName.get(toolName);
  }

  require(toolName: string): PiToolIdentity {
    const identity = this.get(toolName);
    if (!identity) {
      throw new Error("pi_tool_identity_missing");
    }
    return identity;
  }
}
