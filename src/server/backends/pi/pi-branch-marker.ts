import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const piBranchMarkerType = "sedes.branch_source.v2";
const legacyPiBranchMarkerType = "harness.branch_source.v2";

export function isPiBranchMarkerType(value: string): boolean {
  return value === piBranchMarkerType || value === legacyPiBranchMarkerType;
}

export interface PiBranchMarkerFields {
  readonly sourceBackendConversationId: string;
  readonly targetBackendConversationId: string;
  readonly sourceLeafEntryId: string;
  readonly applicationOperationId: string;
  readonly inheritedSettingsFingerprint: string;
}

export interface PiBranchMarker extends PiBranchMarkerFields {
  readonly version: 2;
  readonly authentication: {
    readonly algorithm: "hmac-sha256";
    readonly tag: string;
  };
}

export type PiBranchMarkerReadResult =
  | { readonly status: "authenticated"; readonly marker: PiBranchMarker }
  | { readonly status: "malformed" }
  | { readonly status: "unauthenticated"; readonly marker: PiBranchMarker };

const tagPattern = /^[A-Za-z0-9_-]{43}$/;

function bounded(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maximum
  );
}

function authenticatedBytes(
  fields: PiBranchMarkerFields,
  markerType = piBranchMarkerType,
): string {
  return JSON.stringify([
    markerType,
    fields.sourceBackendConversationId,
    fields.targetBackendConversationId,
    fields.sourceLeafEntryId,
    fields.applicationOperationId,
    fields.inheritedSettingsFingerprint,
  ]);
}

function tag(
  fields: PiBranchMarkerFields,
  key: Uint8Array,
  markerType = piBranchMarkerType,
): Buffer {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) {
    throw new Error("pi_branch_marker_key_invalid");
  }
  return createHmac("sha256", key)
    .update(authenticatedBytes(fields, markerType), "utf8")
    .digest();
}

function parse(value: unknown): PiBranchMarker | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const marker = value as Partial<PiBranchMarker>;
  if (
    Object.keys(value).sort().join("\0") !==
      [
        "version",
        "sourceBackendConversationId",
        "targetBackendConversationId",
        "sourceLeafEntryId",
        "applicationOperationId",
        "inheritedSettingsFingerprint",
        "authentication",
      ]
        .sort()
        .join("\0") ||
    marker.version !== 2 ||
    !bounded(marker.sourceBackendConversationId, 128) ||
    !bounded(marker.targetBackendConversationId, 128) ||
    !bounded(marker.sourceLeafEntryId, 512) ||
    !bounded(marker.applicationOperationId, 160) ||
    typeof marker.inheritedSettingsFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.inheritedSettingsFingerprint) ||
    typeof marker.authentication !== "object" ||
    marker.authentication === null ||
    Object.keys(marker.authentication).sort().join("\0") !==
      ["algorithm", "tag"].sort().join("\0") ||
    marker.authentication.algorithm !== "hmac-sha256" ||
    !bounded(marker.authentication.tag, 64) ||
    !tagPattern.test(marker.authentication.tag)
  ) {
    return undefined;
  }
  return marker as PiBranchMarker;
}

export function createPiBranchMarker(
  fields: PiBranchMarkerFields,
  key: Uint8Array,
): PiBranchMarker {
  const authenticationTag = tag(fields, key).toString("base64url");
  return {
    version: 2,
    ...fields,
    authentication: { algorithm: "hmac-sha256", tag: authenticationTag },
  };
}

export function readPiBranchMarker(
  entry: SessionEntry,
  key: Uint8Array,
): PiBranchMarkerReadResult {
  if (entry.type !== "custom" || !isPiBranchMarkerType(entry.customType)) {
    return { status: "malformed" };
  }
  const marker = parse(entry.data);
  if (!marker) return { status: "malformed" };
  const { version: _version, authentication, ...fields } = marker;
  const expected = tag(fields, key, entry.customType);
  const actual = Buffer.from(authentication.tag, "base64url");
  return actual.byteLength === expected.byteLength &&
    timingSafeEqual(actual, expected)
    ? { status: "authenticated", marker }
    : { status: "unauthenticated", marker };
}
