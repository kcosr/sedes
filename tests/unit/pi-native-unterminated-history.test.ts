import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AttachConversationInput } from "../../src/server/backends/contracts.js";
import { compileBackendModelPolicy } from "../../src/server/backends/model-policy.js";
import { PiNativeConversationDriver, serializePiNativeBindingDetail, type PiNativeOperations } from "../../src/server/backends/pi/native/driver/driver.js";
import { PiNativeHost } from "../../src/server/backends/pi/native/host/native-host.js";
import { PI_MANAGED_INPUT_MARKER, signPiManagedOperation, type PiManagedOperation } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import type { ExecutionEnvironmentChannelProvider } from "../../src/server/execution/environment-channel.js";
import { NO_USAGE_SINK } from "../../src/server/usage/contracts.js";

describe("unterminated native Pi records", () => {
  it.each(["assistant", "input marker"])("projects history and reconciles accepted input with a final %s and no newline", async terminal => {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-no-newline-")));
    const cwd = path.join(root, "project"), sessionDirectory = path.join(root, "sessions");
    await mkdir(cwd); await mkdir(sessionDirectory);
    const identity = { cwd, sessionId: "session", sessionFile: path.join(sessionDirectory, "session.jsonl") };
    const authenticationKey = randomBytes(32), timestamp = "2026-10-26T00:00:00.000Z";
    const operation: PiManagedOperation = { input: { operationId: "submit", mutationId: "mutation", reconciliationToken: "token",
      fingerprint: "a".repeat(64), mode: "submit", text: "Hello" }, phase: "accepted", userEntryId: "user" };
    const marker = { type: "custom", id: "proof", parentId: terminal === "input marker" ? "answer" : "user", timestamp,
      customType: PI_MANAGED_INPUT_MARKER, data: { version: 1, operation,
        authentication: signPiManagedOperation(identity.sessionId, operation, authenticationKey) } };
    const answer = { type: "message", id: "answer", parentId: terminal === "assistant" ? "proof" : "user", timestamp,
      message: { role: "assistant", timestamp: 1, content: [{ type: "text", text: "Final answer" }], provider: "provider",
        model: "model", api: "openai-completions", stopReason: "stop", usage: {} } };
    const content = [
      { type: "session", version: 3, id: identity.sessionId, timestamp, cwd },
      { type: "message", id: "user", parentId: null, timestamp, message: { role: "user", timestamp: 1, content: "Hello" } },
      ...(terminal === "assistant" ? [marker, answer] : [answer, marker]),
    ].map(entry => JSON.stringify(entry)).join("\n");
    await writeFile(identity.sessionFile, content);
    const instance = { id: "native", tenantId: "tenant", kind: "pi_native" as const, label: "Pi", enabled: true, configurationRevision: 1, protocolRelease: "1.4.0" };
    const connection = { id: "connection", tenantId: instance.tenantId, ownerPrincipalId: "principal", templateId: "template", kind: "pi_rpc" as const,
      backendInstanceId: instance.id, executionEnvironmentId: "environment", label: "Pi", enabled: true, configurationRevision: 1 };
    const launch = vi.fn(async (): Promise<never> => { throw new Error("Detached history must not launch Pi"); });
    const host = new PiNativeHost({ configuration: { tenantId: instance.tenantId, principalId: connection.ownerPrincipalId,
      backendInstanceId: instance.id, executionEnvironmentId: connection.executionEnvironmentId, sessionDirectory,
      initializationTimeoutMs: 1000, projectTrusted: false }, authenticationKey, environment: {},
      channels: {} as ExecutionEnvironmentChannelProvider, launch });
    const unexpectedOperation = (): never => { throw new Error("Detached reconciliation must not prepare or dispatch input"); };
    let record: ReturnType<PiNativeOperations["prepareOperation"]> = { requestHash: "a".repeat(64),
      state: "sent", prepareAttempt: 0, dispatchStarted: true, receiptJson: null };
    const operations: PiNativeOperations = { prepareOperation: unexpectedOperation,
      getOperation: () => record,
      completeOperation: vi.fn((_scope, _threadId, _operationId, input) => {
        record = { ...record, ...input, receiptJson: input.receiptJson ?? null }; return record;
      }),
      resetUnsentOperation: unexpectedOperation, markSubmissionDispatched: unexpectedOperation };
    const driver = new PiNativeConversationDriver({ instance, connection, port: host, usage: NO_USAGE_SINK,
      modelPolicy: compileBackendModelPolicy({ type: "catalog" }, "provider_model_effort"),
      settings: { getSettings: () => ({ modelProvider: "provider", modelId: "model", thinkingLevel: "low", toolMode: "read_only", revision: 0 }) },
      operations });
    const conversation: AttachConversationInput = { scope: { tenantId: instance.tenantId, principalId: connection.ownerPrincipalId },
      workspace: { canonicalPath: cwd, authorityRevision: 0, summary: { id: "workspace", environmentId: connection.executionEnvironmentId,
        displayName: "Project", displayPath: cwd, availability: "available", trustState: "trusted", revision: 0 } },
      binding: { tenantId: instance.tenantId, ownerPrincipalId: connection.ownerPrincipalId, applicationThreadId: "thread",
        backendConversationId: identity.sessionId, backendInstanceId: instance.id, connectionProfileId: connection.id,
        executionEnvironmentId: connection.executionEnvironmentId, createdAt: timestamp }, opaqueBindingDetail: serializePiNativeBindingDetail(identity) };
    try {
      const reader = await driver.openHistory(conversation);
      try {
        const page = await reader.history({ limit: 10 });
        expect(page.orderedBackendTurnIds).toEqual(["user"]);
        expect(Object.values(page.itemsById)).toContainEqual(expect.objectContaining({ semanticKind: "assistant_message", markdown: { text: "Final answer" } }));
      } finally { await reader.close(); }
      await expect(driver.reconcileSubmission({ ...conversation, applicationOperationId: operation.input.operationId }))
        .resolves.toEqual({ status: "accepted", completionIdentity: operation.input.operationId });
      expect(operations.completeOperation).toHaveBeenCalledWith(conversation.scope, "thread", "submit",
        { state: "completed", receiptJson: expect.any(String) });
      expect(JSON.parse(record.receiptJson!)).toEqual(operation);
      expect(record.dispatchStarted).toBe(true);
      expect(launch).not.toHaveBeenCalled();
      expect(await readFile(identity.sessionFile, "utf8")).toBe(content);
    } finally {
      await driver.close(); await host.close(); await rm(root, { recursive: true, force: true });
    }
  });
});
