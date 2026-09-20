import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { AgentToolInvocationCorrelation } from "../../../shared/protocol/payload.js";
import type { PiToolIdentity } from "./pi-tool-identities.js";
import {
  assertPiToolIdentityAuthentication,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";

export const piAgentToolInvocationMarkerType = "sedes.agent_tool_invocation.v1";
const legacyPiAgentToolInvocationMarkerType =
  "harness.agent_tool_invocation.v1";

export function isPiAgentToolInvocationMarkerType(value: string): boolean {
  return (
    value === piAgentToolInvocationMarkerType ||
    value === legacyPiAgentToolInvocationMarkerType
  );
}

export interface PiAgentToolInvocationMarkerFields {
  readonly assistantEntryId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolId: string;
  readonly schemaVersion: number;
  readonly invocationId: string;
}

export interface PiAgentToolInvocationMarker extends PiAgentToolInvocationMarkerFields {
  readonly version: 1;
  readonly authentication: {
    readonly algorithm: "hmac-sha256";
    readonly tag: string;
  };
}

export type PiAgentToolInvocationMarkerReadResult =
  | {
      readonly status: "authenticated";
      readonly marker: PiAgentToolInvocationMarker;
    }
  | { readonly status: "malformed" }
  | { readonly status: "unauthenticated" };

const authenticationTagPattern = /^[A-Za-z0-9_-]{43}$/;
const toolIdPattern = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const invocationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const reservedToolNamePattern = /^sedes_[a-z][a-z0-9_]{0,119}$/;
const legacyReservedToolNamePattern = /^harness_[a-z][a-z0-9_]{0,119}$/;

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

function parseMarker(
  value: unknown,
  legacy = false,
): PiAgentToolInvocationMarker | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, [
      "version",
      "assistantEntryId",
      "toolCallId",
      "toolName",
      "toolId",
      "schemaVersion",
      "invocationId",
      "authentication",
    ])
  ) {
    return undefined;
  }
  const version = own(value, "version");
  const assistantEntryId = own(value, "assistantEntryId");
  const toolCallId = own(value, "toolCallId");
  const toolName = own(value, "toolName");
  const toolId = own(value, "toolId");
  const schemaVersion = own(value, "schemaVersion");
  const invocationId = own(value, "invocationId");
  const authentication = own(value, "authentication");
  const algorithm = own(authentication, "algorithm");
  const tag = own(authentication, "tag");
  if (
    version !== 1 ||
    !boundedString(assistantEntryId, 512) ||
    !boundedString(toolCallId, 512) ||
    !boundedString(toolName, 128) ||
    !(legacy
      ? legacyReservedToolNamePattern.test(toolName)
      : reservedToolNamePattern.test(toolName)) ||
    !boundedString(toolId, 128) ||
    !toolIdPattern.test(toolId) ||
    !Number.isSafeInteger(schemaVersion) ||
    (schemaVersion as number) <= 0 ||
    (schemaVersion as number) > 1_000_000 ||
    !boundedString(invocationId, 160) ||
    !invocationIdPattern.test(invocationId) ||
    typeof authentication !== "object" ||
    authentication === null ||
    !exactKeys(authentication, ["algorithm", "tag"]) ||
    algorithm !== "hmac-sha256" ||
    typeof tag !== "string" ||
    !authenticationTagPattern.test(tag)
  ) {
    return undefined;
  }
  return {
    version,
    assistantEntryId,
    toolCallId,
    toolName,
    toolId,
    schemaVersion: schemaVersion as number,
    invocationId,
    authentication: { algorithm, tag },
  };
}

function authenticatedBytes(
  fields: PiAgentToolInvocationMarkerFields,
  conversationId: string,
  markerType = piAgentToolInvocationMarkerType,
): string {
  return JSON.stringify([
    markerType,
    conversationId,
    fields.assistantEntryId,
    fields.toolCallId,
    fields.toolName,
    fields.toolId,
    fields.schemaVersion,
    fields.invocationId,
  ]);
}

function authenticationTag(
  fields: PiAgentToolInvocationMarkerFields,
  authentication: PiToolIdentityAuthentication,
  markerType = piAgentToolInvocationMarkerType,
): Buffer {
  return createHmac("sha256", authentication.installationKey)
    .update(
      authenticatedBytes(fields, authentication.conversationId, markerType),
      "utf8",
    )
    .digest();
}

export function createPiAgentToolInvocationMarker(
  fields: PiAgentToolInvocationMarkerFields,
  authentication: PiToolIdentityAuthentication,
): PiAgentToolInvocationMarker {
  assertPiToolIdentityAuthentication(authentication);
  const parsed = parseMarker({
    version: 1,
    ...fields,
    authentication: {
      algorithm: "hmac-sha256",
      tag: Buffer.alloc(32).toString("base64url"),
    },
  });
  if (!parsed) {
    throw new Error("pi_agent_tool_invocation_marker_invalid");
  }
  return {
    ...parsed,
    authentication: {
      algorithm: "hmac-sha256",
      tag: authenticationTag(parsed, authentication).toString("base64url"),
    },
  };
}

export function readPiAgentToolInvocationMarker(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): PiAgentToolInvocationMarkerReadResult {
  if (
    entry.type !== "custom" ||
    !isPiAgentToolInvocationMarkerType(entry.customType)
  ) {
    return { status: "malformed" };
  }
  const legacy = entry.customType === legacyPiAgentToolInvocationMarkerType;
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
      ? {
          ...marker,
          toolName: marker.toolName.replace(/^harness_/, "sedes_"),
        }
      : marker,
  };
}

export function piAgentToolInvocationMarker(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): PiAgentToolInvocationMarker | undefined {
  const result = readPiAgentToolInvocationMarker(entry, authentication);
  return result.status === "authenticated" ? result.marker : undefined;
}

/** Returns the provider-native name only when this exact marker authenticated. */
export function authenticatedPiAgentToolInvocationNativeToolName(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): string | undefined {
  const result = readPiAgentToolInvocationMarker(entry, authentication);
  if (result.status !== "authenticated" || entry.type !== "custom") {
    return undefined;
  }
  const toolName = own(entry.data, "toolName");
  return typeof toolName === "string" ? toolName : undefined;
}

export function authenticatedAgentToolCorrelation(
  marker: PiAgentToolInvocationMarker,
  identity: PiToolIdentity,
  toolName: string,
): AgentToolInvocationCorrelation | undefined {
  const identityMatches =
    (identity.origin === "sedes_agent_tool" &&
      marker.toolId === identity.agentToolId &&
      marker.schemaVersion === identity.agentToolSchemaVersion) ||
    (identity.origin === "sedes_agent_tool_gateway" &&
      (toolName === "sedes_read" || toolName === "sedes_act"));
  return identityMatches && marker.toolName === toolName
    ? {
        toolId: marker.toolId,
        schemaVersion: marker.schemaVersion,
        invocationId: marker.invocationId,
      }
    : undefined;
}
