import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { PiToolIdentity } from "./pi-tool-identities.js";
import { isPiBuiltinToolKind } from "./pi-builtin-tool-policy.js";

export const piToolIdentityMarkerType = "sedes.tool_identity.v2";
const legacyPiToolIdentityMarkerType = "harness.tool_identity.v2";

export function isPiToolIdentityMarkerType(value: string): boolean {
  return (
    value === piToolIdentityMarkerType ||
    value === legacyPiToolIdentityMarkerType
  );
}

export interface PiToolIdentityAuthentication {
  readonly conversationId: string;
  readonly installationKey: Uint8Array;
}

export interface PiToolIdentityMarkerFields {
  readonly assistantEntryId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly identity: PiToolIdentity;
}

export interface PiToolIdentityMarker extends PiToolIdentityMarkerFields {
  readonly version: 2;
  readonly authentication: {
    readonly algorithm: "hmac-sha256";
    readonly tag: string;
  };
}

export type PiToolIdentityMarkerReadResult =
  | {
      readonly status: "authenticated";
      readonly marker: PiToolIdentityMarker;
    }
  | { readonly status: "malformed" }
  | { readonly status: "unauthenticated" };

const authenticationTagPattern = /^[A-Za-z0-9_-]{43}$/;
const agentToolIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const reservedAgentToolNamePattern = /^sedes_[a-z][a-z0-9_]{0,119}$/;
const legacyReservedAgentToolNamePattern = /^harness_[a-z][a-z0-9_]{0,119}$/;

type ParsedPiToolIdentity = Omit<PiToolIdentity, "origin"> & {
  readonly origin:
    | PiToolIdentity["origin"]
    | "harness_integration"
    | "harness_agent_tool"
    | "harness_agent_tool_gateway";
};
type ParsedPiToolIdentityMarker = Omit<PiToolIdentityMarker, "identity"> & {
  readonly identity: ParsedPiToolIdentity;
};

function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function boundedString(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength
  );
}

function parseIdentity(
  value: unknown,
  legacy = false,
): ParsedPiToolIdentity | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const registrationId = own(value, "registrationId");
  const origin = own(value, "origin");
  const canonicalKind = own(value, "canonicalKind");
  const displayName = own(value, "displayName");
  const mcpServer = own(value, "mcpServer");
  const agentToolId = own(value, "agentToolId");
  const agentToolSchemaVersion = own(value, "agentToolSchemaVersion");
  const optionalKeys = [
    ...(canonicalKind === undefined ? [] : ["canonicalKind"]),
    ...(mcpServer === undefined ? [] : ["mcpServer"]),
    ...(agentToolId === undefined ? [] : ["agentToolId"]),
    ...(agentToolSchemaVersion === undefined ? [] : ["agentToolSchemaVersion"]),
  ];
  if (
    !exactKeys(value, [
      "registrationId",
      "origin",
      "displayName",
      ...optionalKeys,
    ]) ||
    !boundedString(registrationId, 2_048) ||
    !boundedString(displayName, 512) ||
    (origin !== "pi_builtin" &&
      origin !== "extension" &&
      (legacy
        ? origin !== "harness_integration" &&
          origin !== "harness_agent_tool" &&
          origin !== "harness_agent_tool_gateway"
        : origin !== "sedes_integration" &&
          origin !== "sedes_agent_tool" &&
          origin !== "sedes_agent_tool_gateway")) ||
    (mcpServer !== undefined && !boundedString(mcpServer, 512))
  ) {
    return undefined;
  }
  if (origin === "pi_builtin") {
    if (
      typeof canonicalKind !== "string" ||
      !isPiBuiltinToolKind(canonicalKind) ||
      registrationId !== `pi:builtin:${canonicalKind}` ||
      mcpServer !== undefined ||
      agentToolId !== undefined ||
      agentToolSchemaVersion !== undefined
    ) {
      return undefined;
    }
  } else if (
    origin === (legacy ? "harness_integration" : "sedes_integration")
  ) {
    if (
      (canonicalKind !== "mcp" && canonicalKind !== "web_search") ||
      (canonicalKind !== "mcp" && mcpServer !== undefined) ||
      agentToolId !== undefined ||
      agentToolSchemaVersion !== undefined
    ) {
      return undefined;
    }
  } else if (origin === (legacy ? "harness_agent_tool" : "sedes_agent_tool")) {
    if (
      canonicalKind !== "agent_tool" ||
      mcpServer !== undefined ||
      typeof agentToolId !== "string" ||
      !agentToolIdPattern.test(agentToolId) ||
      agentToolId.length > 128 ||
      !Number.isSafeInteger(agentToolSchemaVersion) ||
      (agentToolSchemaVersion as number) <= 0 ||
      (agentToolSchemaVersion as number) > 1_000_000
    ) {
      return undefined;
    }
  } else if (
    origin ===
    (legacy ? "harness_agent_tool_gateway" : "sedes_agent_tool_gateway")
  ) {
    if (
      canonicalKind !== "agent_tool" ||
      mcpServer !== undefined ||
      agentToolId !== undefined ||
      agentToolSchemaVersion !== undefined ||
      (legacy
        ? registrationId !== "harness:agent-tool-gateway:harness_catalog" &&
          registrationId !== "harness:agent-tool-gateway:harness_read" &&
          registrationId !== "harness:agent-tool-gateway:harness_act"
        : registrationId !== "sedes:agent-tool-gateway:sedes_catalog" &&
          registrationId !== "sedes:agent-tool-gateway:sedes_read" &&
          registrationId !== "sedes:agent-tool-gateway:sedes_act")
    ) {
      return undefined;
    }
  } else if (
    canonicalKind !== undefined ||
    mcpServer !== undefined ||
    agentToolId !== undefined ||
    agentToolSchemaVersion !== undefined
  ) {
    return undefined;
  }
  return {
    registrationId,
    origin: origin as ParsedPiToolIdentity["origin"],
    displayName,
    ...(canonicalKind !== undefined
      ? {
          canonicalKind: canonicalKind as PiToolIdentity["canonicalKind"],
        }
      : {}),
    ...(mcpServer !== undefined ? { mcpServer } : {}),
    ...(agentToolId !== undefined
      ? { agentToolId: agentToolId as string }
      : {}),
    ...(agentToolSchemaVersion !== undefined
      ? { agentToolSchemaVersion: agentToolSchemaVersion as number }
      : {}),
  };
}

export function assertPiToolIdentityAuthentication(
  authentication: PiToolIdentityAuthentication,
): void {
  if (
    !boundedString(authentication.conversationId, 2_048) ||
    !(authentication.installationKey instanceof Uint8Array) ||
    authentication.installationKey.byteLength !== 32
  ) {
    throw new Error("pi_tool_identity_authentication_invalid");
  }
}

function authenticatedBytes(
  fields: Omit<PiToolIdentityMarkerFields, "identity"> & {
    readonly identity: ParsedPiToolIdentity;
  },
  conversationId: string,
  markerType = piToolIdentityMarkerType,
): string {
  const identityFields: unknown[] = [
    fields.identity.registrationId,
    fields.identity.origin,
    fields.identity.canonicalKind ?? null,
    fields.identity.displayName,
    fields.identity.mcpServer ?? null,
  ];
  // Preserve the exact authenticated byte sequence of every existing v2
  // identity. Agent-tool fields extend only the new origin's tuple.
  if (
    fields.identity.origin === "sedes_agent_tool" ||
    fields.identity.origin === "harness_agent_tool"
  ) {
    identityFields.push(
      fields.identity.agentToolId ?? null,
      fields.identity.agentToolSchemaVersion ?? null,
    );
  }
  return JSON.stringify([
    markerType,
    conversationId,
    fields.assistantEntryId,
    fields.toolCallId,
    fields.toolName,
    identityFields,
  ]);
}

function authenticationTag(
  fields: Omit<PiToolIdentityMarkerFields, "identity"> & {
    readonly identity: ParsedPiToolIdentity;
  },
  authentication: PiToolIdentityAuthentication,
  markerType = piToolIdentityMarkerType,
): Buffer {
  return createHmac("sha256", authentication.installationKey)
    .update(
      authenticatedBytes(fields, authentication.conversationId, markerType),
      "utf8",
    )
    .digest();
}

function parseMarker(
  value: unknown,
  legacy = false,
): ParsedPiToolIdentityMarker | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, [
      "version",
      "assistantEntryId",
      "toolCallId",
      "toolName",
      "identity",
      "authentication",
    ])
  ) {
    return undefined;
  }
  const version = own(value, "version");
  const assistantEntryId = own(value, "assistantEntryId");
  const toolCallId = own(value, "toolCallId");
  const toolName = own(value, "toolName");
  const identity = parseIdentity(own(value, "identity"), legacy);
  const authentication = own(value, "authentication");
  const algorithm = own(authentication, "algorithm");
  const tag = own(authentication, "tag");
  const identityMatchesTool =
    identity !== undefined &&
    typeof toolName === "string" &&
    (identity.origin === "pi_builtin"
      ? identity.canonicalKind === toolName && identity.displayName === toolName
      : identity.origin === (legacy ? "harness_agent_tool" : "sedes_agent_tool")
        ? (legacy
            ? legacyReservedAgentToolNamePattern.test(toolName)
            : reservedAgentToolNamePattern.test(toolName)) &&
          identity.registrationId ===
            [
              legacy ? "harness" : "sedes",
              "agent-tool",
              identity.agentToolId!,
              String(identity.agentToolSchemaVersion),
              toolName,
            ]
              .map((part) => encodeURIComponent(part))
              .join(":")
        : identity.origin ===
            (legacy ? "harness_agent_tool_gateway" : "sedes_agent_tool_gateway")
          ? (legacy
              ? toolName === "harness_catalog" ||
                toolName === "harness_read" ||
                toolName === "harness_act"
              : toolName === "sedes_catalog" ||
                toolName === "sedes_read" ||
                toolName === "sedes_act") &&
            identity.registrationId ===
              `${legacy ? "harness" : "sedes"}:agent-tool-gateway:${toolName}`
          : identity.registrationId.endsWith(
              `:${encodeURIComponent(toolName)}`,
            ) &&
            (identity.origin !== "extension" ||
              identity.displayName === toolName));
  return version === 2 &&
    boundedString(assistantEntryId, 512) &&
    boundedString(toolCallId, 512) &&
    boundedString(toolName, 512) &&
    identityMatchesTool &&
    typeof authentication === "object" &&
    authentication !== null &&
    exactKeys(authentication, ["algorithm", "tag"]) &&
    algorithm === "hmac-sha256" &&
    typeof tag === "string" &&
    authenticationTagPattern.test(tag)
    ? {
        version,
        assistantEntryId,
        toolCallId,
        toolName,
        identity: identity!,
        authentication: { algorithm, tag },
      }
    : undefined;
}

export function createPiToolIdentityMarker(
  fields: PiToolIdentityMarkerFields,
  authentication: PiToolIdentityAuthentication,
): PiToolIdentityMarker {
  assertPiToolIdentityAuthentication(authentication);
  const parsed = parseMarker({
    version: 2,
    ...fields,
    authentication: {
      algorithm: "hmac-sha256",
      tag: Buffer.alloc(32).toString("base64url"),
    },
  });
  if (!parsed) {
    throw new Error("pi_tool_identity_marker_invalid");
  }
  return {
    ...parsed,
    identity: parsed.identity as PiToolIdentity,
    authentication: {
      algorithm: "hmac-sha256",
      tag: authenticationTag(parsed, authentication).toString("base64url"),
    },
  };
}

export function readPiToolIdentityMarker(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): PiToolIdentityMarkerReadResult {
  if (
    entry.type !== "custom" ||
    !isPiToolIdentityMarkerType(entry.customType)
  ) {
    return { status: "malformed" };
  }
  const legacy = entry.customType === legacyPiToolIdentityMarkerType;
  const marker = parseMarker(entry.data, legacy);
  if (!marker) {
    return { status: "malformed" };
  }
  if (!authentication) {
    return { status: "unauthenticated" };
  }
  assertPiToolIdentityAuthentication(authentication);
  const supplied = Buffer.from(marker.authentication.tag, "base64url");
  const expected = authenticationTag(marker, authentication, entry.customType);
  if (
    supplied.byteLength !== expected.byteLength ||
    !timingSafeEqual(supplied, expected)
  ) {
    return { status: "unauthenticated" };
  }
  return {
    status: "authenticated",
    marker: legacy
      ? normalizeLegacyMarker(marker)
      : (marker as PiToolIdentityMarker),
  };
}

function normalizeLegacyMarker(
  marker: ParsedPiToolIdentityMarker,
): PiToolIdentityMarker {
  const toolName = marker.toolName.replace(/^harness_/, "sedes_");
  const identity = marker.identity;
  const origin =
    identity.origin === "harness_integration"
      ? "sedes_integration"
      : identity.origin === "harness_agent_tool"
        ? "sedes_agent_tool"
        : identity.origin === "harness_agent_tool_gateway"
          ? "sedes_agent_tool_gateway"
          : identity.origin;
  const registrationId =
    identity.origin === "harness_agent_tool"
      ? [
          "sedes",
          "agent-tool",
          identity.agentToolId!,
          String(identity.agentToolSchemaVersion),
          toolName,
        ]
          .map((part) => encodeURIComponent(part))
          .join(":")
      : identity.origin === "harness_agent_tool_gateway"
        ? `sedes:agent-tool-gateway:${toolName}`
        : identity.registrationId;
  return {
    ...marker,
    toolName,
    identity: { ...identity, origin, registrationId } as PiToolIdentity,
  };
}

export function piToolIdentityMarker(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): PiToolIdentityMarker | undefined {
  const result = readPiToolIdentityMarker(entry, authentication);
  return result.status === "authenticated" ? result.marker : undefined;
}

/** Returns the provider-native name only when this exact marker authenticated. */
export function authenticatedPiToolIdentityNativeToolName(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): string | undefined {
  const result = readPiToolIdentityMarker(entry, authentication);
  if (result.status !== "authenticated" || entry.type !== "custom") {
    return undefined;
  }
  const toolName = own(entry.data, "toolName");
  return typeof toolName === "string" ? toolName : undefined;
}

export function samePiToolIdentity(
  left: PiToolIdentity,
  right: PiToolIdentity,
): boolean {
  return (
    left.registrationId === right.registrationId &&
    left.origin === right.origin &&
    left.canonicalKind === right.canonicalKind &&
    left.displayName === right.displayName &&
    left.mcpServer === right.mcpServer &&
    left.agentToolId === right.agentToolId &&
    left.agentToolSchemaVersion === right.agentToolSchemaVersion
  );
}

export function findPiToolCallAssistantEntryId(
  entries: readonly SessionEntry[],
  toolCallId: string,
  toolName: string,
): string | undefined {
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = entries[entryIndex];
    if (
      !entry ||
      entry.type !== "message" ||
      entry.message.role !== "assistant" ||
      !Array.isArray(entry.message.content)
    ) {
      continue;
    }
    let matches = 0;
    for (let index = 0; index < entry.message.content.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        entry.message.content,
        String(index),
      );
      const part =
        descriptor && "value" in descriptor ? descriptor.value : undefined;
      if (
        own(part, "type") === "toolCall" &&
        own(part, "id") === toolCallId &&
        own(part, "name") === toolName
      ) {
        matches += 1;
      }
    }
    if (matches === 1) return entry.id;
    if (matches > 1) return undefined;
  }
  return undefined;
}
