import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  materializedTaskContextsSchema,
  type MaterializedTaskContext,
} from "../../../shared/protocol/tasks.js";
import {
  assertPiToolIdentityAuthentication,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";

export const piTaskContextMarkerType = "sedes.task_contexts.v1";
const legacyPiTaskContextMarkerType = "harness.task_contexts.v1";

export function isPiTaskContextMarkerType(value: string): boolean {
  return (
    value === piTaskContextMarkerType || value === legacyPiTaskContextMarkerType
  );
}

export interface PiTaskContextMarkerFields {
  readonly applicationOperationId: string;
  readonly requestFingerprint: string;
  readonly taskContexts: readonly MaterializedTaskContext[];
}

export interface PiTaskContextMarker extends PiTaskContextMarkerFields {
  readonly version: 1;
  readonly authentication: {
    readonly algorithm: "hmac-sha256";
    readonly tag: string;
  };
}

export type PiTaskContextMarkerReadResult =
  | { readonly status: "authenticated"; readonly marker: PiTaskContextMarker }
  | { readonly status: "malformed" }
  | { readonly status: "unauthenticated" };

const tagPattern = /^[A-Za-z0-9_-]{43}$/;

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

function parseMarker(value: unknown): PiTaskContextMarker | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, [
      "version",
      "applicationOperationId",
      "requestFingerprint",
      "taskContexts",
      "authentication",
    ])
  )
    return undefined;
  const version = own(value, "version");
  const applicationOperationId = own(value, "applicationOperationId");
  const requestFingerprint = own(value, "requestFingerprint");
  const parsedTasks = materializedTaskContextsSchema.safeParse(
    own(value, "taskContexts"),
  );
  const authentication = own(value, "authentication");
  const algorithm = own(authentication, "algorithm");
  const tag = own(authentication, "tag");
  return version === 1 &&
    typeof applicationOperationId === "string" &&
    applicationOperationId.length > 0 &&
    applicationOperationId.length <= 160 &&
    typeof requestFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(requestFingerprint) &&
    parsedTasks.success &&
    parsedTasks.data.length > 0 &&
    typeof authentication === "object" &&
    authentication !== null &&
    exactKeys(authentication, ["algorithm", "tag"]) &&
    algorithm === "hmac-sha256" &&
    typeof tag === "string" &&
    tagPattern.test(tag)
    ? {
        version,
        applicationOperationId,
        requestFingerprint,
        taskContexts: parsedTasks.data,
        authentication: { algorithm, tag },
      }
    : undefined;
}

function authenticatedBytes(
  fields: PiTaskContextMarkerFields,
  conversationId: string,
  markerType = piTaskContextMarkerType,
): string {
  return JSON.stringify([
    markerType,
    conversationId,
    fields.applicationOperationId,
    fields.requestFingerprint,
    fields.taskContexts,
  ]);
}

function authenticationTag(
  fields: PiTaskContextMarkerFields,
  authentication: PiToolIdentityAuthentication,
  markerType = piTaskContextMarkerType,
): Buffer {
  return createHmac("sha256", authentication.installationKey)
    .update(
      authenticatedBytes(fields, authentication.conversationId, markerType),
      "utf8",
    )
    .digest();
}

export function createPiTaskContextMarker(
  fields: PiTaskContextMarkerFields,
  authentication: PiToolIdentityAuthentication,
): PiTaskContextMarker {
  assertPiToolIdentityAuthentication(authentication);
  const parsed = parseMarker({
    version: 1,
    ...fields,
    authentication: {
      algorithm: "hmac-sha256",
      tag: Buffer.alloc(32).toString("base64url"),
    },
  });
  if (!parsed) throw new Error("pi_task_context_marker_invalid");
  return {
    ...parsed,
    authentication: {
      algorithm: "hmac-sha256",
      tag: authenticationTag(parsed, authentication).toString("base64url"),
    },
  };
}

export function readPiTaskContextMarker(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): PiTaskContextMarkerReadResult {
  if (entry.type !== "custom" || !isPiTaskContextMarkerType(entry.customType)) {
    return { status: "malformed" };
  }
  const marker = parseMarker(entry.data);
  if (!marker) return { status: "malformed" };
  if (!authentication) return { status: "unauthenticated" };
  assertPiToolIdentityAuthentication(authentication);
  const supplied = Buffer.from(marker.authentication.tag, "base64url");
  const expected = authenticationTag(marker, authentication, entry.customType);
  return supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
    ? { status: "authenticated", marker }
    : { status: "unauthenticated" };
}

export function findPiTaskContextsForSubmission(
  entries: readonly SessionEntry[],
  applicationOperationId: string,
  requestFingerprint: string,
  authentication?: PiToolIdentityAuthentication,
): readonly MaterializedTaskContext[] | undefined {
  if (!authentication) return undefined;
  const matches = entries.flatMap((entry) => {
    if (entry.type !== "custom" || !isPiTaskContextMarkerType(entry.customType))
      return [];
    const result = readPiTaskContextMarker(entry, authentication);
    return result.status === "authenticated" &&
      result.marker.applicationOperationId === applicationOperationId &&
      result.marker.requestFingerprint === requestFingerprint
      ? [result.marker.taskContexts]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}
