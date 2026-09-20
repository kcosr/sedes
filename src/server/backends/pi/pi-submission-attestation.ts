import { createHmac, timingSafeEqual } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  assertPiToolIdentityAuthentication,
  type PiToolIdentityAuthentication,
} from "./pi-tool-identity-marker.js";
import {
  correlatePiSubmissions,
  piSubmissionMarker,
} from "./pi-submission-marker.js";
import {
  isPiTaskContextMarkerType,
  piTaskContextMarkerType,
  readPiTaskContextMarker,
} from "./pi-task-context-marker.js";
import { findPiContextExcerptsForSubmission } from "./pi-context-excerpt-marker.js";
import { projectPiUserMessageContent } from "./pi-skill-message.js";

export const piSubmissionAttestationType =
  "sedes.backend_submission_attestation.v1";
const legacyPiSubmissionAttestationType =
  "harness.backend_submission_attestation.v1";

export function isPiSubmissionAttestationType(value: string): boolean {
  return (
    value === piSubmissionAttestationType ||
    value === legacyPiSubmissionAttestationType
  );
}

export interface PiSubmissionAttestationFields {
  readonly applicationOperationId: string;
  readonly requestFingerprint: string;
  readonly userEntryId: string;
}

export interface PiSubmissionAttestation extends PiSubmissionAttestationFields {
  readonly version: 1;
  readonly authentication: {
    readonly algorithm: "hmac-sha256";
    readonly tag: string;
  };
}

export type PiSubmissionAttestationReadResult =
  | {
      readonly status: "authenticated";
      readonly marker: PiSubmissionAttestation;
    }
  | { readonly status: "malformed" }
  | { readonly status: "unauthenticated" };

const tagPattern = /^[A-Za-z0-9_-]{43}$/;
const fingerprintPattern = /^[a-f0-9]{64}$/;

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

function parseMarker(value: unknown): PiSubmissionAttestation | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !exactKeys(value, [
      "version",
      "applicationOperationId",
      "requestFingerprint",
      "userEntryId",
      "authentication",
    ])
  ) {
    return undefined;
  }
  const version = own(value, "version");
  const applicationOperationId = own(value, "applicationOperationId");
  const requestFingerprint = own(value, "requestFingerprint");
  const userEntryId = own(value, "userEntryId");
  const authentication = own(value, "authentication");
  const algorithm = own(authentication, "algorithm");
  const tag = own(authentication, "tag");
  return version === 1 &&
    typeof applicationOperationId === "string" &&
    applicationOperationId.length > 0 &&
    applicationOperationId.length <= 160 &&
    typeof requestFingerprint === "string" &&
    fingerprintPattern.test(requestFingerprint) &&
    typeof userEntryId === "string" &&
    userEntryId.length > 0 &&
    userEntryId.length <= 512 &&
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
        userEntryId,
        authentication: { algorithm, tag },
      }
    : undefined;
}

function authenticatedBytes(
  fields: PiSubmissionAttestationFields,
  conversationId: string,
  markerType = piSubmissionAttestationType,
): string {
  return JSON.stringify([
    markerType,
    conversationId,
    fields.applicationOperationId,
    fields.requestFingerprint,
    fields.userEntryId,
  ]);
}

function authenticationTag(
  fields: PiSubmissionAttestationFields,
  authentication: PiToolIdentityAuthentication,
  markerType = piSubmissionAttestationType,
): Buffer {
  return createHmac("sha256", authentication.installationKey)
    .update(
      authenticatedBytes(fields, authentication.conversationId, markerType),
      "utf8",
    )
    .digest();
}

export function createPiSubmissionAttestation(
  fields: PiSubmissionAttestationFields,
  authentication: PiToolIdentityAuthentication,
): PiSubmissionAttestation {
  assertPiToolIdentityAuthentication(authentication);
  const parsed = parseMarker({
    version: 1,
    ...fields,
    authentication: {
      algorithm: "hmac-sha256",
      tag: Buffer.alloc(32).toString("base64url"),
    },
  });
  if (!parsed) throw new Error("pi_submission_attestation_invalid");
  return {
    ...parsed,
    authentication: {
      algorithm: "hmac-sha256",
      tag: authenticationTag(parsed, authentication).toString("base64url"),
    },
  };
}

export function readPiSubmissionAttestation(
  entry: SessionEntry,
  authentication?: PiToolIdentityAuthentication,
): PiSubmissionAttestationReadResult {
  if (
    entry.type !== "custom" ||
    !isPiSubmissionAttestationType(entry.customType)
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

/**
 * Returns the one authenticated attestation that agrees with Pi's existing
 * submission lifecycle correlation for this exact persisted user entry.
 */
export function findAuthenticatedPiSubmissionAttestation(
  entries: readonly SessionEntry[],
  userEntryId: string,
  authentication?: PiToolIdentityAuthentication,
): PiSubmissionAttestation | undefined {
  if (!authentication) return undefined;
  const correlated = [...correlatePiSubmissions(entries).values()].find(
    (candidate) => candidate.userEntryId === userEntryId && !candidate.invalid,
  );
  if (!correlated) return undefined;
  const matches = entries.flatMap((entry) => {
    if (
      entry.type !== "custom" ||
      !isPiSubmissionAttestationType(entry.customType)
    ) {
      return [];
    }
    const result = readPiSubmissionAttestation(entry, authentication);
    return result.status === "authenticated" &&
      result.marker.userEntryId === userEntryId &&
      result.marker.applicationOperationId ===
        correlated.marker.applicationOperationId &&
      result.marker.requestFingerprint === correlated.marker.requestFingerprint
      ? [result.marker]
      : [];
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Repairs the narrow crash window after Pi persists a task-bearing user entry
 * but before the live event callback appends its per-entry attestation.
 *
 * Recovery signs only an exact native sequence emitted by this backend:
 * one authenticated task marker, the immediately following submission intent,
 * and its positionally correlated user entry whose exact envelope projects the
 * same task snapshots. A copied, displaced, duplicated, or lookalike carrier
 * therefore cannot acquire new authenticated evidence during reattachment.
 */
export function recoverPiTaskSubmissionAttestations(
  entries: readonly SessionEntry[],
  append: (marker: PiSubmissionAttestation) => void,
  authentication: PiToolIdentityAuthentication,
): number {
  assertPiToolIdentityAuthentication(authentication);
  const correlations = [...correlatePiSubmissions(entries).values()];
  let recovered = 0;
  for (const correlation of correlations) {
    if (
      correlation.invalid ||
      correlation.rejected ||
      !correlation.userEntryId ||
      findAuthenticatedPiSubmissionAttestation(
        entries,
        correlation.userEntryId,
        authentication,
      )
    ) {
      continue;
    }
    const matchingTaskMarkers = entries.flatMap((entry, index) => {
      if (
        entry.type !== "custom" ||
        !isPiTaskContextMarkerType(entry.customType)
      ) {
        return [];
      }
      const result = readPiTaskContextMarker(entry, authentication);
      return result.status === "authenticated" &&
        result.marker.applicationOperationId ===
          correlation.marker.applicationOperationId &&
        result.marker.requestFingerprint ===
          correlation.marker.requestFingerprint
        ? [{ index, marker: result.marker }]
        : [];
    });
    if (matchingTaskMarkers.length !== 1) continue;
    const taskEvidence = matchingTaskMarkers[0]!;
    const submissionEntry = entries[taskEvidence.index + 1];
    const submissionIntent = submissionEntry
      ? piSubmissionMarker(submissionEntry)
      : undefined;
    if (
      !submissionIntent ||
      submissionIntent.phase !== "intent" ||
      submissionIntent.applicationOperationId !==
        correlation.marker.applicationOperationId ||
      submissionIntent.requestFingerprint !==
        correlation.marker.requestFingerprint ||
      submissionIntent.reconciliationToken !==
        correlation.marker.reconciliationToken ||
      submissionIntent.mutationId !== correlation.marker.mutationId ||
      submissionIntent.mode !== correlation.marker.mode
    ) {
      continue;
    }
    const userEntry = entries.find(
      (entry) =>
        entry.type === "message" && entry.id === correlation.userEntryId,
    );
    if (userEntry?.type !== "message" || userEntry.message.role !== "user") {
      continue;
    }
    const excerpts = findPiContextExcerptsForSubmission(
      entries,
      correlation.marker.applicationOperationId,
      correlation.marker.requestFingerprint,
      authentication,
    );
    const projected = projectPiUserMessageContent(
      userEntry.message.content,
      excerpts ?? [],
      {
        key: authentication.installationKey,
        correlation: correlation.marker.applicationOperationId,
      },
      taskEvidence.marker.taskContexts,
    );
    const projectedTasks = projected.flatMap((part) =>
      part.kind === "task_context" ? [part.task] : [],
    );
    if (
      JSON.stringify(projectedTasks) !==
      JSON.stringify(taskEvidence.marker.taskContexts)
    ) {
      continue;
    }
    append(
      createPiSubmissionAttestation(
        {
          applicationOperationId: correlation.marker.applicationOperationId,
          requestFingerprint: correlation.marker.requestFingerprint,
          userEntryId: correlation.userEntryId,
        },
        authentication,
      ),
    );
    recovered += 1;
  }
  return recovered;
}
