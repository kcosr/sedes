import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  contextExcerptArraySchema,
  type ContextExcerpt,
} from "../../../shared/protocol/context-excerpts.js";
import {
  assertPiToolIdentityAuthentication,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";

export const piContextExcerptMarkerType = "sedes.context_excerpts.v1";
const legacyPiContextExcerptMarkerType = "harness.context_excerpts.v1";

export function isPiContextExcerptMarkerType(value: string): boolean {
  return (
    value === piContextExcerptMarkerType ||
    value === legacyPiContextExcerptMarkerType
  );
}

export interface PiContextExcerptMarkerFields {
  readonly applicationOperationId: string;
  readonly requestFingerprint: string;
  readonly contextExcerpts: readonly ContextExcerpt[];
}

export interface PiContextExcerptMarker extends PiContextExcerptMarkerFields {
  readonly version: 1;
  readonly authentication: {
    readonly algorithm: "hmac-sha256";
    readonly tag: string;
  };
}

export type PiContextExcerptMarkerReadResult =
  | {
      readonly status: "authenticated";
      readonly marker: PiContextExcerptMarker;
    }
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

function parseMarker(value: unknown): PiContextExcerptMarker | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, [
      "version",
      "applicationOperationId",
      "requestFingerprint",
      "contextExcerpts",
      "authentication",
    ])
  ) {
    return undefined;
  }
  const version = own(value, "version");
  const applicationOperationId = own(value, "applicationOperationId");
  const requestFingerprint = own(value, "requestFingerprint");
  const parsedExcerpts = contextExcerptArraySchema.safeParse(
    own(value, "contextExcerpts"),
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
    parsedExcerpts.success &&
    parsedExcerpts.data.length > 0 &&
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
        contextExcerpts: parsedExcerpts.data,
        authentication: { algorithm, tag },
      }
    : undefined;
}

function authenticatedBytes(
  fields: PiContextExcerptMarkerFields,
  conversationId: string,
  markerType = piContextExcerptMarkerType,
): string {
  return JSON.stringify([
    markerType,
    conversationId,
    fields.applicationOperationId,
    fields.requestFingerprint,
    fields.contextExcerpts,
  ]);
}

function authenticationTag(
  fields: PiContextExcerptMarkerFields,
  authentication: PiToolIdentityAuthentication,
  markerType = piContextExcerptMarkerType,
): Buffer {
  return createHmac("sha256", authentication.installationKey)
    .update(
      authenticatedBytes(fields, authentication.conversationId, markerType),
      "utf8",
    )
    .digest();
}

export function createPiContextExcerptMarker(
  fields: PiContextExcerptMarkerFields,
  authentication: PiToolIdentityAuthentication,
): PiContextExcerptMarker {
  assertPiToolIdentityAuthentication(authentication);
  const parsed = parseMarker({
    version: 1,
    ...fields,
    authentication: {
      algorithm: "hmac-sha256",
      tag: Buffer.alloc(32).toString("base64url"),
    },
  });
  if (!parsed) throw new Error("pi_context_excerpt_marker_invalid");
  return {
    ...parsed,
    authentication: {
      algorithm: "hmac-sha256",
      tag: authenticationTag(parsed, authentication).toString("base64url"),
    },
  };
}

export function readPiContextExcerptMarker(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): PiContextExcerptMarkerReadResult {
  if (
    entry.type !== "custom" ||
    !isPiContextExcerptMarkerType(entry.customType)
  ) {
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

export function findPiContextExcerptsForSubmission(
  entries: readonly SessionEntry[],
  applicationOperationId: string,
  requestFingerprint: string,
  authentication?: PiToolIdentityAuthentication,
): readonly ContextExcerpt[] | undefined {
  if (!authentication) return undefined;
  const matches = entries.flatMap((entry) => {
    if (
      entry.type !== "custom" ||
      !isPiContextExcerptMarkerType(entry.customType)
    ) {
      return [];
    }
    const result = readPiContextExcerptMarker(entry, authentication);
    return result.status === "authenticated" &&
      result.marker.applicationOperationId === applicationOperationId &&
      result.marker.requestFingerprint === requestFingerprint
      ? [result.marker.contextExcerpts]
      : [];
  });
  if (matches.length === 0) return undefined;
  const canonical = JSON.stringify(matches[0]);
  return matches.every((candidate) => JSON.stringify(candidate) === canonical)
    ? matches[0]
    : undefined;
}
