import {
  CODEX_APP_SERVER_RELEASE,
  codexClientNotificationRegistry,
  codexClientRequestRegistry,
  codexOfficialServerNotificationMethods,
  codexOfficialServerNotificationRegistry,
  codexServerNotificationRegistry,
  codexServerRequestRegistry,
  type CodexAdoptedServerNotificationMethod,
  type CodexClientNotificationMap,
  type CodexClientNotificationMethod,
  type CodexClientRequestMap,
  type CodexClientRequestMethod,
  type CodexServerNotificationMap,
  type CodexServerNotificationMethod,
  type CodexServerRequestMap,
  type CodexServerRequestMethod,
} from "./generated/0.153.0/route-registry.js";
import {
  BoundedJsonSnapshotError,
  snapshotBoundedJson,
  type BoundedJsonValue,
} from "../../json/bounded-json-snapshot.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../transport/framed-message-limits.js";
import {
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  maximumBase64Characters,
} from "../../../../shared/output-artifact-limits.js";

const CODEX_ORDINARY_MAXIMUM_STRING_BYTES = 8 * 1024 * 1024;
const CODEX_IMAGE_GENERATION_RESULT_MAXIMUM_STRING_BYTES =
  maximumBase64Characters(MAXIMUM_OUTPUT_IMAGE_BYTES);

const CODEX_BINDING_SNAPSHOT_LIMITS = Object.freeze({
  maximumArrayItems: 65_536,
  maximumDepth: 64,
  maximumEncodedBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
  maximumObjectProperties: 10_000,
  // Carrier bound only. C1/C2/C4 retain their established UTF-16 code-unit
  // field limits; the snapshot must not reinterpret those as UTF-8 bytes.
  maximumStringBytes: CODEX_IMAGE_GENERATION_RESULT_MAXIMUM_STRING_BYTES,
  maximumTotalNodes: 200_000,
});

type JsonPathSegment = string | number;

function isIndex(value: JsonPathSegment | undefined): value is number {
  return typeof value === "number";
}

function isOfficialThreadItemResultPath(
  path: readonly JsonPathSegment[],
): boolean {
  if (path.length === 2) {
    return path[0] === "item" && path[1] === "result";
  }
  if (path.length === 4) {
    return (
      (path[0] === "turn" &&
        path[1] === "items" &&
        isIndex(path[2]) &&
        path[3] === "result") ||
      (path[0] === "data" &&
        isIndex(path[1]) &&
        path[2] === "item" &&
        path[3] === "result")
    );
  }
  if (path.length === 5) {
    return (
      path[0] === "data" &&
      isIndex(path[1]) &&
      path[2] === "items" &&
      isIndex(path[3]) &&
      path[4] === "result"
    );
  }
  if (path.length === 6) {
    return (
      ((path[0] === "thread" && path[1] === "turns") ||
        (path[0] === "initialTurnsPage" && path[1] === "data")) &&
      isIndex(path[2]) &&
      path[3] === "items" &&
      isIndex(path[4]) &&
      path[5] === "result"
    );
  }
  if (path.length === 7) {
    return (
      path[0] === "data" &&
      isIndex(path[1]) &&
      path[2] === "turns" &&
      isIndex(path[3]) &&
      path[4] === "items" &&
      isIndex(path[5]) &&
      path[6] === "result"
    );
  }
  return false;
}

function assertCodexStringBounds(
  value: BoundedJsonValue,
  path: readonly JsonPathSegment[] = [],
): void {
  if (typeof value === "string") {
    if (
      Buffer.byteLength(value, "utf8") > CODEX_ORDINARY_MAXIMUM_STRING_BYTES
    ) {
      throw new BoundedJsonSnapshotError("string_bytes_exceeded");
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertCodexStringBounds(entry, [...path, index]),
    );
    return;
  }
  const record = value as Readonly<Record<string, BoundedJsonValue>>;
  for (const [key, entry] of Object.entries(record)) {
    if (Buffer.byteLength(key, "utf8") > CODEX_ORDINARY_MAXIMUM_STRING_BYTES) {
      throw new BoundedJsonSnapshotError("string_bytes_exceeded");
    }
    if (
      typeof entry === "string" &&
      Buffer.byteLength(entry, "utf8") > CODEX_ORDINARY_MAXIMUM_STRING_BYTES &&
      isOfficialThreadItemResultPath([...path, key]) &&
      record.type === "imageGeneration"
    ) {
      continue;
    }
    assertCodexStringBounds(entry, [...path, key]);
  }
}

function snapshotCodexBoundedJson(value: unknown): BoundedJsonValue {
  const snapshot = snapshotBoundedJson(value, CODEX_BINDING_SNAPSHOT_LIMITS);
  assertCodexStringBounds(snapshot);
  return snapshot;
}

type CodexInboundAttestation = Readonly<{
  direction: "server_request" | "server_notification";
  method: string;
}>;
const codexInboundAttestations = new WeakMap<
  object,
  CodexInboundAttestation[]
>();

export {
  CODEX_APP_SERVER_RELEASE,
  type CodexAdoptedServerNotificationMethod,
  type CodexClientNotificationMap,
  type CodexClientNotificationMethod,
  type CodexClientRequestMap,
  type CodexClientRequestMethod,
  type CodexServerNotificationMap,
  type CodexServerNotificationMethod,
  type CodexServerRequestMap,
  type CodexServerRequestMethod,
};

export type OfficialCodexClientRequestParams<
  Method extends CodexClientRequestMethod,
> = CodexClientRequestMap[Method]["params"];

export type OfficialCodexClientRequestResult<
  Method extends CodexClientRequestMethod,
> = CodexClientRequestMap[Method]["result"];

export type OfficialCodexServerRequestParams<
  Method extends CodexServerRequestMethod,
> = CodexServerRequestMap[Method]["params"];

export type OfficialCodexServerRequestResult<
  Method extends CodexServerRequestMethod,
> = CodexServerRequestMap[Method]["result"];

export type OfficialCodexServerNotificationParams<
  Method extends CodexAdoptedServerNotificationMethod,
> = CodexServerNotificationMap[Method]["params"];

export type CodexServerNotificationAdmission =
  | Readonly<{ readonly status: "decoded"; readonly params: unknown }>
  | Readonly<{
      readonly status: "undecodable";
      readonly nativeThreadId: string;
    }>;

export interface CodexAppServerMethod<Params, Result> {
  readonly method: CodexClientRequestMethod;
  encodeParams(params: Params): unknown;
  decodeResult(result: unknown): Result;
}

export class CodexAppServerBindingError extends Error {
  readonly code: string;
  readonly direction:
    | "client_request_params"
    | "client_request_result"
    | "client_notification"
    | "server_request_params"
    | "server_request_result"
    | "server_notification";
  readonly method: string;

  constructor(input: {
    readonly code: string;
    readonly direction: CodexAppServerBindingError["direction"];
    readonly method: string;
  }) {
    super(input.code);
    this.name = "CodexAppServerBindingError";
    this.code = input.code;
    this.direction = input.direction;
    this.method = input.method;
  }
}

export const CODEX_CLIENT_REQUEST_METHODS = Object.freeze(
  Object.keys(codexClientRequestRegistry) as CodexClientRequestMethod[],
);
export const CODEX_EXPERIMENTAL_CLIENT_REQUEST_METHODS = Object.freeze([
  ...Object.entries(codexClientRequestRegistry)
    .filter(([, codec]) => codec.stability === "experimental")
    .map(([method]) => method as CodexClientRequestMethod),
]);
export const CODEX_SERVER_REQUEST_METHODS = Object.freeze(
  Object.keys(codexServerRequestRegistry) as CodexServerRequestMethod[],
);
export const CODEX_SERVER_NOTIFICATION_METHODS = Object.freeze([
  ...codexOfficialServerNotificationMethods,
]);
export const CODEX_ADOPTED_SERVER_NOTIFICATION_METHODS = Object.freeze(
  Object.keys(
    codexServerNotificationRegistry,
  ) as CodexAdoptedServerNotificationMethod[],
);
export const CODEX_CLIENT_NOTIFICATION_METHODS = Object.freeze(
  Object.keys(
    codexClientNotificationRegistry,
  ) as CodexClientNotificationMethod[],
);

export function isCodexClientRequestMethod(
  value: string,
): value is CodexClientRequestMethod {
  return Object.hasOwn(codexClientRequestRegistry, value);
}

export function isCodexServerRequestMethod(
  value: string,
): value is CodexServerRequestMethod {
  return Object.hasOwn(codexServerRequestRegistry, value);
}

export function isCodexServerNotificationMethod(
  value: string,
): value is CodexServerNotificationMethod {
  return (CODEX_SERVER_NOTIFICATION_METHODS as readonly string[]).includes(
    value,
  );
}

export function isCodexAdoptedServerNotificationMethod(
  value: string,
): value is CodexAdoptedServerNotificationMethod {
  return Object.hasOwn(codexServerNotificationRegistry, value);
}

/**
 * Compose one official structural codec with one backend-owned semantic/bound
 * refinement. Inbound results are officially validated before refinement.
 * Outbound params are bounded-snapshotted, refined, snapshotted again, and
 * then officially validated exactly once as the value that will reach wire.
 */
export function defineCodexAppServerMethod<
  Method extends CodexClientRequestMethod,
  Params,
  Result,
>(input: {
  readonly method: Method;
  refineParams(
    value: OfficialCodexClientRequestParams<Method>,
  ): OfficialCodexClientRequestParams<Method>;
  refineResult(value: OfficialCodexClientRequestResult<Method>): Result;
}): CodexAppServerMethod<Params, Result> & { readonly method: Method } {
  const codec = codexClientRequestRegistry[input.method];
  return Object.freeze({
    method: input.method,
    encodeParams(params: Params): unknown {
      let canonical: unknown;
      try {
        canonical = snapshotCodexBoundedJson(params);
      } catch {
        throw new CodexAppServerBindingError({
          code: "codex_app_server_client_request_params_invalid",
          direction: "client_request_params",
          method: input.method,
        });
      }
      const official = canonical as OfficialCodexClientRequestParams<Method>;
      let refined: OfficialCodexClientRequestParams<Method>;
      try {
        refined = input.refineParams(official);
      } catch {
        throw new CodexAppServerBindingError({
          code: "codex_app_server_client_request_params_invalid",
          direction: "client_request_params",
          method: input.method,
        });
      }
      let refinedSnapshot: unknown;
      try {
        refinedSnapshot = snapshotCodexBoundedJson(refined);
      } catch {
        throw new CodexAppServerBindingError({
          code: "codex_app_server_client_request_params_invalid",
          direction: "client_request_params",
          method: input.method,
        });
      }
      assertValid(
        codec.params,
        refinedSnapshot,
        "codex_app_server_client_request_params_invalid",
        "client_request_params",
        input.method,
      );
      return refinedSnapshot;
    },
    decodeResult(result: unknown): Result {
      let canonical: unknown;
      try {
        canonical = snapshotCodexBoundedJson(result);
      } catch {
        throw new CodexAppServerBindingError({
          code: "codex_app_server_client_request_result_invalid",
          direction: "client_request_result",
          method: input.method,
        });
      }
      assertValid(
        codec.result,
        canonical,
        "codex_app_server_client_request_result_invalid",
        "client_request_result",
        input.method,
      );
      try {
        return input.refineResult(
          canonical as OfficialCodexClientRequestResult<Method>,
        );
      } catch {
        throw new CodexAppServerBindingError({
          code: "codex_app_server_client_request_result_invalid",
          direction: "client_request_result",
          method: input.method,
        });
      }
    },
  });
}

export function encodeCodexClientNotification(
  method: CodexClientNotificationMethod,
): Readonly<{ readonly method: CodexClientNotificationMethod }> {
  const envelope = Object.freeze({ method });
  assertValid(
    codexClientNotificationRegistry[method],
    envelope,
    "codex_app_server_client_notification_invalid",
    "client_notification",
    method,
  );
  return envelope;
}

export function decodeCodexServerRequestParams<
  Method extends CodexServerRequestMethod,
>(method: Method, params: unknown): OfficialCodexServerRequestParams<Method> {
  const snapshot = snapshotInboundValue(
    params,
    "server_request_params",
    method,
  );
  assertValid(
    codexServerRequestRegistry[method].params,
    snapshot,
    "codex_app_server_server_request_params_invalid",
    "server_request_params",
    method,
  );
  recordInboundAttestation(snapshot, "server_request", method);
  return snapshot as OfficialCodexServerRequestParams<Method>;
}

export function assertCodexAttestedServerRequestParams<
  Method extends CodexServerRequestMethod,
>(method: Method, params: unknown): OfficialCodexServerRequestParams<Method> {
  assertInboundAttestation(params, "server_request", method);
  return params as OfficialCodexServerRequestParams<Method>;
}

export function encodeCodexServerRequestResult<
  Method extends CodexServerRequestMethod,
>(method: Method, result: unknown): OfficialCodexServerRequestResult<Method> {
  let canonical: unknown;
  try {
    canonical = snapshotCodexBoundedJson(result);
  } catch {
    throw new CodexAppServerBindingError({
      code: "codex_app_server_server_request_result_invalid",
      direction: "server_request_result",
      method,
    });
  }
  assertValid(
    codexServerRequestRegistry[method].result,
    canonical,
    "codex_app_server_server_request_result_invalid",
    "server_request_result",
    method,
  );
  return canonical as OfficialCodexServerRequestResult<Method>;
}

export function decodeCodexServerNotificationParams<
  Method extends CodexAdoptedServerNotificationMethod,
>(
  method: Method,
  params: unknown,
): OfficialCodexServerNotificationParams<Method> {
  const snapshot = snapshotInboundValue(params, "server_notification", method);
  assertValid(
    codexServerNotificationRegistry[method].params,
    snapshot,
    "codex_app_server_server_notification_invalid",
    "server_notification",
    method,
  );
  recordInboundAttestation(snapshot, "server_notification", method);
  return snapshot as OfficialCodexServerNotificationParams<Method>;
}

export function assertCodexAttestedServerNotificationParams<
  Method extends CodexAdoptedServerNotificationMethod,
>(
  method: Method,
  params: unknown,
): OfficialCodexServerNotificationParams<Method> {
  assertInboundAttestation(params, "server_notification", method);
  return params as OfficialCodexServerNotificationParams<Method>;
}

export function validateCodexServerNotificationEnvelope(
  method: CodexServerNotificationMethod,
  params: unknown,
): boolean {
  try {
    decodeCodexServerNotificationEnvelope(method, params);
    return true;
  } catch {
    return false;
  }
}

export function decodeCodexServerNotificationEnvelope(
  method: CodexServerNotificationMethod,
  params: unknown,
): unknown {
  const admission = admitCodexServerNotification(method, params);
  if (admission.status === "decoded") return admission.params;
  throw new CodexAppServerBindingError({
    code: "codex_app_server_server_notification_invalid",
    direction: "server_notification",
    method,
  });
}

/**
 * Validate a selected notification profile exactly once. A structurally
 * invalid payload is recoverable only when its selected, reviewed route still
 * yields one bounded native thread identity. Snapshot failures and unroutable
 * payloads remain binding errors; callers must treat them as connection-fatal.
 */
export function admitCodexServerNotification(
  method: CodexServerNotificationMethod,
  params: unknown,
): CodexServerNotificationAdmission {
  const snapshot = snapshotInboundValue(params, "server_notification", method);
  let valid = false;
  try {
    if (isCodexAdoptedServerNotificationMethod(method)) {
      valid = codexServerNotificationRegistry[method].params(snapshot);
    } else {
      valid = codexOfficialServerNotificationRegistry[method].params(snapshot);
    }
  } catch {
    throw new CodexAppServerBindingError({
      code: "codex_app_server_server_notification_invalid",
      direction: "server_notification",
      method,
    });
  }
  if (valid) {
    recordInboundAttestation(snapshot, "server_notification", method);
    return Object.freeze({ status: "decoded", params: snapshot });
  }
  const nativeThreadId = extractReviewedNotificationThreadRoute(
    method,
    snapshot,
  );
  if (nativeThreadId !== undefined) {
    return Object.freeze({ status: "undecodable", nativeThreadId });
  }
  throw new CodexAppServerBindingError({
    code: "codex_app_server_server_notification_invalid",
    direction: "server_notification",
    method,
  });
}

type CodexNotificationThreadRoute = Readonly<{
  artifactProfile: "stable" | "experimental";
  path: "threadId" | "thread.id";
}>;

const STABLE_THREAD_ID_ROUTE = Object.freeze({
  artifactProfile: "stable",
  path: "threadId",
} as const);
const EXPERIMENTAL_THREAD_ID_ROUTE = Object.freeze({
  artifactProfile: "experimental",
  path: "threadId",
} as const);
const EXPERIMENTAL_NESTED_THREAD_ID_ROUTE = Object.freeze({
  artifactProfile: "experimental",
  path: "thread.id",
} as const);

// This is an explicit review inventory for the artifact profile selected by
// the registries above. Absence is intentional and fail-closed. In particular,
// experimental thread/started is routed through thread.id while the other
// selected experimental notification uses the direct threadId member.
export const CODEX_NOTIFICATION_THREAD_ROUTE_REGISTRY: Readonly<
  Partial<Record<CodexServerNotificationMethod, CodexNotificationThreadRoute>>
> = Object.freeze({
  "autoApprovalReview/strictReviewRequired": STABLE_THREAD_ID_ROUTE,
  error: STABLE_THREAD_ID_ROUTE,
  guardianWarning: STABLE_THREAD_ID_ROUTE,
  "hook/completed": STABLE_THREAD_ID_ROUTE,
  "hook/started": STABLE_THREAD_ID_ROUTE,
  "item/agentMessage/delta": STABLE_THREAD_ID_ROUTE,
  "item/autoApprovalReview/completed": STABLE_THREAD_ID_ROUTE,
  "item/autoApprovalReview/started": STABLE_THREAD_ID_ROUTE,
  "item/commandExecution/outputDelta": STABLE_THREAD_ID_ROUTE,
  "item/commandExecution/terminalInteraction": STABLE_THREAD_ID_ROUTE,
  "item/completed": STABLE_THREAD_ID_ROUTE,
  "item/fileChange/outputDelta": STABLE_THREAD_ID_ROUTE,
  "item/fileChange/patchUpdated": STABLE_THREAD_ID_ROUTE,
  "item/mcpToolCall/progress": STABLE_THREAD_ID_ROUTE,
  "item/plan/delta": STABLE_THREAD_ID_ROUTE,
  "item/reasoning/summaryPartAdded": STABLE_THREAD_ID_ROUTE,
  "item/reasoning/summaryTextDelta": STABLE_THREAD_ID_ROUTE,
  "item/reasoning/textDelta": STABLE_THREAD_ID_ROUTE,
  "item/started": STABLE_THREAD_ID_ROUTE,
  "mcpServer/oauthLogin/completed": STABLE_THREAD_ID_ROUTE,
  "mcpServer/startupStatus/updated": STABLE_THREAD_ID_ROUTE,
  "modelProvider/authRecoveryCompleted": STABLE_THREAD_ID_ROUTE,
  "modelProvider/authRecoveryStarted": STABLE_THREAD_ID_ROUTE,
  "model/rerouted": STABLE_THREAD_ID_ROUTE,
  "model/safetyBuffering/updated": STABLE_THREAD_ID_ROUTE,
  "model/verification": STABLE_THREAD_ID_ROUTE,
  "rawResponse/completed": STABLE_THREAD_ID_ROUTE,
  "rawResponseItem/completed": STABLE_THREAD_ID_ROUTE,
  "serverRequest/resolved": STABLE_THREAD_ID_ROUTE,
  "thread/archived": STABLE_THREAD_ID_ROUTE,
  "thread/closed": STABLE_THREAD_ID_ROUTE,
  "thread/compacted": STABLE_THREAD_ID_ROUTE,
  "thread/deleted": STABLE_THREAD_ID_ROUTE,
  "thread/environment/connected": STABLE_THREAD_ID_ROUTE,
  "thread/environment/disconnected": STABLE_THREAD_ID_ROUTE,
  "thread/goal/cleared": STABLE_THREAD_ID_ROUTE,
  "thread/goal/updated": STABLE_THREAD_ID_ROUTE,
  "thread/name/updated": STABLE_THREAD_ID_ROUTE,
  "thread/project/updated": STABLE_THREAD_ID_ROUTE,
  "thread/queue/changed": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/closed": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/error": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/itemAdded": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/item/completed": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/item/started": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/item/transcript/delta": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/outputAudio/delta": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/sdp": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/started": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/transcript/delta": STABLE_THREAD_ID_ROUTE,
  "thread/realtime/transcript/done": STABLE_THREAD_ID_ROUTE,
  "thread/reverted": STABLE_THREAD_ID_ROUTE,
  "thread/settings/updated": EXPERIMENTAL_THREAD_ID_ROUTE,
  "thread/started": EXPERIMENTAL_NESTED_THREAD_ID_ROUTE,
  "thread/status/changed": STABLE_THREAD_ID_ROUTE,
  "thread/tokenUsage/updated": STABLE_THREAD_ID_ROUTE,
  "thread/unarchived": STABLE_THREAD_ID_ROUTE,
  "turn/completed": STABLE_THREAD_ID_ROUTE,
  "turn/diff/updated": STABLE_THREAD_ID_ROUTE,
  "turn/moderationMetadata": STABLE_THREAD_ID_ROUTE,
  "turn/plan/updated": STABLE_THREAD_ID_ROUTE,
  "turn/started": STABLE_THREAD_ID_ROUTE,
  warning: STABLE_THREAD_ID_ROUTE,
});

function extractReviewedNotificationThreadRoute(
  method: CodexServerNotificationMethod,
  params: unknown,
): string | undefined {
  const route = CODEX_NOTIFICATION_THREAD_ROUTE_REGISTRY[method];
  if (route === undefined || !isPlainRecord(params)) return undefined;
  const candidate =
    route.path === "threadId"
      ? params.threadId
      : isPlainRecord(params.thread)
        ? params.thread.id
        : undefined;
  return typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 512
    ? candidate
    : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordInboundAttestation(
  value: unknown,
  direction: CodexInboundAttestation["direction"],
  method: string,
): void {
  if (value === null || typeof value !== "object") return;
  const attestations = codexInboundAttestations.get(value) ?? [];
  if (
    !attestations.some(
      (attestation) =>
        attestation.direction === direction && attestation.method === method,
    )
  ) {
    attestations.push(Object.freeze({ direction, method }));
    codexInboundAttestations.set(value, attestations);
  }
}

function assertInboundAttestation(
  value: unknown,
  direction: CodexInboundAttestation["direction"],
  method: string,
): void {
  if (
    value === null ||
    typeof value !== "object" ||
    !codexInboundAttestations
      .get(value)
      ?.some(
        (attestation) =>
          attestation.direction === direction && attestation.method === method,
      )
  ) {
    throw new CodexAppServerBindingError({
      code: "codex_app_server_inbound_attestation_missing",
      direction:
        direction === "server_request"
          ? "server_request_params"
          : "server_notification",
      method,
    });
  }
}

function snapshotInboundValue(
  value: unknown,
  direction: CodexAppServerBindingError["direction"],
  method: string,
): unknown {
  try {
    return snapshotCodexBoundedJson(value);
  } catch {
    throw new CodexAppServerBindingError({
      code: "codex_app_server_inbound_snapshot_invalid",
      direction,
      method,
    });
  }
}

function assertValid(
  validator: (value: unknown) => boolean,
  value: unknown,
  code: string,
  direction: CodexAppServerBindingError["direction"],
  method: string,
): void {
  let valid = false;
  try {
    valid = validator(value);
  } catch {
    throw new CodexAppServerBindingError({
      code,
      direction,
      method,
    });
  }
  if (!valid) {
    // Ajv's mutable diagnostics can contain provider data. The binding exposes
    // only a stable bounded code, direction, and reviewed method identity.
    throw new CodexAppServerBindingError({ code, direction, method });
  }
}
