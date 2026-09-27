import { acknowledgeOpenCodeTerminalOperation, openCodeMutationWasNotSent, openCodeOperationControl } from "./opencode-operation-control.js";
import type { OpenCodeNativePort } from "./opencode-native-port.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { BackendError, type CreateConversationInput, type CreateConversationResult } from "../contracts.js";
import { DomainError } from "../../domain/errors.js";
import { serializeOpenCodeBindingDetail } from "./opencode-binding-detail.js";
import { assertOpenCodeWorkspace, openCodeConversationError, type OpenCodeDriverContext } from "./opencode-conversation-context.js";
import { mapOpenCodeConversationError } from "./opencode-conversation-error.js";
import { waitOpenCode } from "./opencode-conversation-handle.js";
import { qualifiedOpenCodeModelId, resolveOpenCodeSelection, sameOpenCodeSelection } from "./opencode-model-selection.js";
import { OpenCodeNativeApi, type OpenCodeNativeSession } from "./opencode-native-api.js";
import { OpenCodeNativeMutations, OpenCodeNativeMutationInputError } from "./opencode-native-mutations.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";
import type { OpenCodeOperationReceipt } from "./opencode-thread-repository.js";

const sourceSchema = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("user") }),
  z.strictObject({ kind: z.literal("automation"), automationId: z.string().min(1).max(1_024), automationRunId: z.string().min(1).max(1_024) })]);
const requestSchema = z.strictObject({ applicationThreadId: z.string().min(1).max(1_024), applicationOperationId: z.string().min(1).max(1_024),
  requestedBackendConversationId: z.string().min(5).max(128).regex(/^ses_[A-Za-z0-9_-]+$/u),
  source: sourceSchema, title: z.string().max(16_384).optional() });
const CREATE_MARKER = "sedes_create";

/** Only this receipt-backed path can create or recover a reserved native ID. */
export async function createOpenCodeConversation(context: OpenCodeDriverContext, input: CreateConversationInput): Promise<CreateConversationResult> {
  let crossed = false;
  let receipt: Readonly<OpenCodeOperationReceipt> | undefined;
  let mutationPort: OpenCodeNativePort | undefined;
  try {
    assertOpenCodeWorkspace(context, input);
    context.executionEnvironment.assertDefinitionSupport(input.scope, input.applicationThreadId);
    if (input.creationCorrelation !== undefined) throw rejected();
    const request = requestSchema.parse({ applicationThreadId: input.applicationThreadId, applicationOperationId: input.applicationOperationId,
      requestedBackendConversationId: input.requestedBackendConversationId, source: input.source, ...(input.title !== undefined ? { title: input.title } : {}) });
    const id = request.requestedBackendConversationId;
    receipt = context.repository.readOperation(input.scope, request.applicationThreadId, request.applicationOperationId, "create");
    crossed = receipt !== undefined && !["prepared", "not_applied"].includes(receipt.disposition);
    assertAuthority(context, input, id);
    const frozen = context.settings.captureOperation(input.scope, { applicationThreadId: request.applicationThreadId,
      applicationOperationId: request.applicationOperationId, operationKind: "create", now: Date.now() });
    const fingerprint = digest(["sedes.opencode.create.v1", input.scope, context.instance.id, context.connection.id,
      context.nativeNamespaceKey, input.workspace.summary.id, input.workspace.canonicalPath, request, frozen.settingsRevision, frozen.selection]);
    receipt = context.repository.reserveOperation(input.scope, { applicationThreadId: request.applicationThreadId,
      applicationOperationId: request.applicationOperationId, operationKind: "create", connectionProfileId: context.connection.id,
      executionEnvironmentId: context.connection.executionEnvironmentId, nativeSessionId: id, nativeInputId: null,
      requestFingerprint: fingerprint, requestSource: request.source, deadlineAt: null }, Date.now());
    const result: CreateConversationResult = { backendConversationId: id,
      reconciliationToken: `oc_create_${digest([input.scope, context.nativeNamespaceKey, request.applicationThreadId, request.applicationOperationId, id])}`,
      opaqueBindingDetail: serializeOpenCodeBindingDetail({ version: 1, tenantId: input.scope.tenantId, principalId: input.scope.principalId,
        backendInstanceId: context.instance.id, connectionProfileId: context.connection.id, executionEnvironmentId: context.connection.executionEnvironmentId,
        canonicalWorkspacePath: input.workspace.canonicalPath, nativeNamespaceKey: context.nativeNamespaceKey, sessionId: id }) };
    if (receipt.disposition === "accepted" || receipt.disposition === "not_applied") {
      // Retry a lost ACK against an already-ready owner without starting one.
      try {
        const runtime = await context.runtime();
        if (runtime.nativeNamespaceKey === context.nativeNamespaceKey && runtime.snapshot().state === "ready") {
          const lease = runtime.acquire({ directory: input.workspace.canonicalPath });
          try { await acknowledgeOpenCodeTerminalOperation(lease.client, () => receipt); }
          finally { lease.release(); }
        }
      } catch { /* A retained durable result does not depend on ACK delivery. */ }
      if (receipt.disposition === "accepted") return result;
      throw rejected();
    }
    const budget = AbortSignal.timeout(30_000);
    // Reconciliation is read-only; a changed catalog cannot erase an existing effect.
    if (receipt.disposition === "prepared") {
      const catalog = await waitOpenCode(context.catalog.read({ connection: context.connection, workspace: input.workspace, signal: budget }), budget);
      resolveOpenCodeSelection({ connection: context.connection, catalog: catalog.catalog,
        modelId: qualifiedOpenCodeModelId(frozen.selection), variant: frozen.selection.variant, modelPolicy: context.modelPolicy });
    }
    const runtime = await waitOpenCode(context.runtime(), budget);
    if (runtime.nativeNamespaceKey !== context.nativeNamespaceKey) throw rejected();
    await waitOpenCode(runtime.start(), budget);
    const lease = runtime.acquire({ directory: input.workspace.canonicalPath });
    mutationPort = lease.client;
    try {
      const api = new OpenCodeNativeApi(lease.client);
      const native = new OpenCodeNativeMutations(lease.client);
      const signal = AbortSignal.any([budget, lease.client.lifetime]);
      const prove = async (session: OpenCodeNativeSession, requireRequestedModel = false): Promise<CreateConversationResult> => {
        await runtime.assertCurrent(signal); signal.throwIfAborted(); assertAuthority(context, input, id);
        assertNativeCreation(session, id, input.workspace.canonicalPath, fingerprint);
        if (requireRequestedModel && !sameOpenCodeSelection(session.model ?? null, frozen.selection)) throw unknown();
        const evidence = digest(["sedes.opencode.created.v1", context.nativeNamespaceKey, id, input.workspace.canonicalPath,
          frozen.selection, fingerprint, session.time.created]);
        const current = context.repository.requireOperation(input.scope, request.applicationThreadId, request.applicationOperationId, "create");
        if (current.disposition === "accepted") {
          if (current.nativeEvidenceFingerprint !== evidence) throw unknown();
        } else if (current.disposition !== "dispatched" && current.disposition !== "unknown") throw unknown();
        else if (!context.repository.recordOutcome(input.scope, request.applicationThreadId, request.applicationOperationId, "create",
          { expected: current.disposition, disposition: "accepted", nativeEvidenceFingerprint: evidence, now: Date.now() })) throw unknown();
        return result;
      };
      if (receipt.disposition !== "prepared") return await prove(await api.getSession(id, signal));
      // Native create is first-writer-wins. Never adopt a session that predates our dispatch.
      try { await api.getSession(id, signal); throw rejected(); }
      catch (error) { if (!(error instanceof OpenCodeRuntimeError) || error.code !== "opencode_native_not_found") throw error; }
      await runtime.assertCurrent(signal); signal.throwIfAborted(); assertAuthority(context, input, id);
      if (!context.repository.markDispatched(input.scope, request.applicationThreadId, request.applicationOperationId, "create", Date.now())) {
        crossed = true; return await prove(await api.getSession(id, signal));
      }
      crossed = true;
      let session: OpenCodeNativeSession;
      try {
        session = await native.createSession({ id, model: frozen.selection, location: { directory: input.workspace.canonicalPath },
          ...(request.title === undefined ? {} : { title: request.title }), metadata: { [CREATE_MARKER]: { version: 1, fingerprint } } }, openCodeOperationControl(receipt, "create-session"), signal);
      } catch (error) {
        if (openCodeMutationWasNotSent(error)) {
          context.repository.recordOutcome(input.scope, request.applicationThreadId, request.applicationOperationId, "create",
            { expected: "dispatched", disposition: "not_applied", nativeEvidenceFingerprint: null, now: Date.now() });
          crossed = false; throw rejected();
        }
        // The one POST may already have committed, including after a lost response.
        return await prove(await api.getSession(id, signal));
      }
      return await prove(session, true);
    } finally { lease.release(); }
  } catch (error) {
    // Another caller may have dispatched the same prepared receipt while this
    // caller was awaiting catalog/GET preflight. Its effect must survive our
    // admission failure; local absence or rejection cannot abort that attempt.
    if (!crossed && receipt) {
      try {
        const current = context.repository.readOperation(input.scope, receipt.applicationThreadId, receipt.applicationOperationId, "create");
        crossed = current !== undefined && !["prepared", "not_applied"].includes(current.disposition);
      } catch { /* The caller still has no additional positive effect evidence. */ }
    }
    if (crossed) {
      try {
        const current = context.repository.readOperation(input.scope, input.applicationThreadId, input.applicationOperationId, "create");
        if (current?.disposition === "dispatched") context.repository.recordOutcome(input.scope, input.applicationThreadId, input.applicationOperationId, "create",
          { expected: "dispatched", disposition: "unknown", nativeEvidenceFingerprint: null, now: Date.now() });
      } catch { /* Lost local authority cannot turn an external effect into a negative result. */ }
      throw unknown();
    }
    if (error instanceof DomainError || error instanceof z.ZodError || openCodeMutationWasNotSent(error)) throw rejected();
    throw mapOpenCodeConversationError(error);
  } finally {
    if (mutationPort) await acknowledgeOpenCodeTerminalOperation(mutationPort,
      () => context.repository.readOperation(input.scope, input.applicationThreadId, input.applicationOperationId, "create"));
  }
}

function assertAuthority(context: OpenCodeDriverContext, input: CreateConversationInput, sessionId: string): void {
  context.repository.assertCreateAuthority(input.scope, input.applicationThreadId, input.applicationOperationId, sessionId, input.source);
  const target = context.repository.database.prepare(`SELECT thread.workspace_id AS workspaceId, workspace.canonical_path AS canonicalPath
    FROM application_threads AS thread JOIN workspaces AS workspace ON workspace.tenant_id=thread.tenant_id
      AND workspace.owner_principal_id=thread.owner_principal_id AND workspace.id=thread.workspace_id
    WHERE thread.tenant_id=? AND thread.owner_principal_id=? AND thread.id=? AND thread.backend_instance_id=?
      AND thread.connection_profile_id=? AND thread.environment_id=?`).get(input.scope.tenantId, input.scope.principalId,
        input.applicationThreadId, context.instance.id, context.connection.id, context.connection.executionEnvironmentId) as
        { workspaceId: string; canonicalPath: string } | undefined;
  if (!target || target.workspaceId !== input.workspace.summary.id || target.canonicalPath !== input.workspace.canonicalPath) throw rejected();
}
function assertNativeCreation(session: OpenCodeNativeSession, id: string, directory: string, fingerprint: string): void {
  const marker = session.metadata?.[CREATE_MARKER];
  // The exact private intent marker proves creation even if another client later changes settings.
  if (session.id !== id || session.location.directory !== directory ||
    !marker || typeof marker !== "object" || Array.isArray(marker) || marker.version !== 1 || marker.fingerprint !== fingerprint) throw unknown();
}
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function rejected(): BackendError { return openCodeConversationError("opencode_create_rejected", "The OpenCode creation request or reserved target is unavailable.", "rejected"); }
function unknown(): BackendError { return new BackendError({ category: "submission_unknown", retryable: false, crossedSubmissionBoundary: true,
  backendCode: "opencode_create_unknown", safeMessage: "OpenCode conversation creation is uncertain. Recover this operation before starting another conversation." }); }
