import {
  defineCodexAppServerMethod,
  isCodexClientRequestMethod,
  type CodexClientRequestMethod,
} from "../../../provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";
import type { ProviderTransportScope } from "../../../provider-protocol/transport/assured-framed-transport.js";
import type { CodexClientLifecycleSnapshot } from "../codex-client-facade.js";
import type { VerifiedCodexRuntimeVersion } from "../codex-release-guard.js";
import type {
  CodexInboundServerRequest, CodexRpcNotification, CodexRpcRequestReceipt,
} from "../rpc/codex-rpc-client.js";

/** Provider-private payload; the sidecar carrier never interprets native methods. */
export const CODEX_RUNTIME_PROTOCOL_VERSION = 1;
export type CodexRuntimeAuthority = Readonly<{
  scope: ProviderTransportScope;
  runtimeId: string;
  controllerId: string;
}>;
export type CodexRuntimePendingRequest = Omit<CodexInboundServerRequest, "signal">;
export type CodexRuntimeFailure =
  | Readonly<{ kind: "delivery"; code: string; delivery: "not_sent" | "sent_outcome_unknown"; generation: number; method: string }>
  | Readonly<{ kind: "remote"; code: number; message: string; generation: number; method: string; data?: unknown }>;
export type CodexRuntimeOutcome =
  | Readonly<{ status: "pending"; operationId: string; method: CodexClientRequestMethod }>
  | Readonly<{ status: "completed"; operationId: string; method: CodexClientRequestMethod; receipt: CodexRpcRequestReceipt<unknown> }>
  | Readonly<{ status: "failed"; operationId: string; method: CodexClientRequestMethod; failure: CodexRuntimeFailure }>;
export type CodexRuntimeSnapshot = Readonly<{
  protocolVersion: typeof CODEX_RUNTIME_PROTOCOL_VERSION;
  runtimeId: string;
  lifecycle: CodexClientLifecycleSnapshot;
  runtimeAssessment: VerifiedCodexRuntimeVersion | null;
  pendingRequests: readonly CodexRuntimePendingRequest[];
  outcomes: readonly Pick<CodexRuntimeOutcome, "operationId" | "method" | "status">[];
}>;
export type CodexRuntimeEvent =
  | Readonly<{ type: "runtime_assessment"; assessment: VerifiedCodexRuntimeVersion }>
  | Readonly<{ type: "lifecycle"; lifecycle: CodexClientLifecycleSnapshot }>
  | Readonly<{ type: "notification"; notification: CodexRpcNotification }>
  | Readonly<{ type: "server_request"; request: CodexRuntimePendingRequest }>
  | Readonly<{ type: "server_request_settled"; generation: number; requestId: string | number }>
  | Readonly<{ type: "outcome"; outcome: CodexRuntimeOutcome }>;

/** Implemented by a typed sidecar capability, or an in-process test carrier.
 * Attachment loss must reject carrier calls, but never cancel host operations.
 * Events and receipts preserve each native thread's order; lifecycle and
 * unclassified events fence all threads. Attach snapshot and event install
 * are one atomic subscription boundary. Authority is supplied by authenticated
 * composition and checked by the host on every operation.
 */
export interface CodexRuntimeConnection {
  attach(authority: CodexRuntimeAuthority, listener: (event: CodexRuntimeEvent) => void): Promise<CodexRuntimeSnapshot>;
  detach(authority: CodexRuntimeAuthority): Promise<void>;
  evictThread(authority: CodexRuntimeAuthority, threadId: string, generation: number): Promise<void>;
  submit(authority: CodexRuntimeAuthority, input: Readonly<{
    operationId: string; generation: number; method: CodexClientRequestMethod;
    params: unknown; timeoutMilliseconds: number; environmentVariablesFingerprint?: string;
  }>): Promise<CodexRuntimeOutcome>;
  outcome(authority: CodexRuntimeAuthority, operationId: string): Promise<CodexRuntimeOutcome>;
  acknowledge(authority: CodexRuntimeAuthority, operationId: string): Promise<void>;
  respond(authority: CodexRuntimeAuthority, input: Readonly<{
    generation: number; requestId: string | number; result: unknown;
  }>): Promise<void>;
  reattachThread(authority: CodexRuntimeAuthority, threadId: string, timeoutMilliseconds: number): Promise<CodexRpcRequestReceipt<unknown> | undefined>;
  retire(authority: CodexRuntimeAuthority, generation: number, reason: string): Promise<void>;
}

export function codexRuntimeMethod(method: string) {
  if (!isCodexClientRequestMethod(method) || method === "initialize") {
    throw new Error("codex_runtime_method_not_admitted");
  }
  return defineCodexAppServerMethod({ method, refineParams: value => value, refineResult: value => value });
}

// These methods have no provider effect to recover. Keeping their full results
// in the mutation ledger duplicates native history and reserves a maximum-size
// frame for even a tiny metadata read. All other admitted methods retain the
// mutation handoff contract, including resume and settings changes.
const readMethods: ReadonlySet<string> = new Set<CodexClientRequestMethod>([
  "thread/list", "thread/loaded/list", "thread/read", "thread/turns/list",
  "thread/items/list", "thread/goal/get", "model/list",
  "experimentalFeature/list", "skills/list", "permissionProfile/list",
]);
export function isCodexRuntimeRead(method: string): boolean { return readMethods.has(method); }
export function codexRuntimeRequestKey(generation: number, id: string | number): string {
  return JSON.stringify([generation, typeof id, id]);
}
