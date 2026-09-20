import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  SidecarOperationError,
  SidecarProtocolDeliveryError,
  workspaceFilesMutationInspectOperation,
  workspaceFilesWriteOperation,
} from "../../src/internal/sidecar-protocol/index.js";
import { SidecarOperationReceipts } from "../../src/server/sidecar/sidecar-operation-receipts.js";
import { WorkspaceFilesSidecarHost } from "../../src/server/sidecar/workspace-files-sidecar-host.js";
import type { WorkspaceFilesEngine } from "../../src/server/workspace-files/workspace-files-engine.js";
import { recoverSidecarOperation } from "../../src/server/sidecar/sidecar-operation-recovery.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import { SidecarOperationRecoveryClient } from "../../src/server/sidecar/sidecar-operation-recovery-client.js";

describe("persistent remote operation ownership", () => {
  it("does not turn an unclassified post-commit failure into proof that a mutation failed", async () => {
    const receipts = new SidecarOperationReceipts();
    const id = randomUUID();
    let published = false;
    await expect(
      receipts.run(id, {}, async () => {
        published = true;
        throw new Error("directory_sync_failed_after_rename");
      }),
    ).rejects.toThrow("directory_sync_failed_after_rename");
    expect(published).toBe(true);
    expect(receipts.inspect(id)).toEqual({ state: "unknown", settled: true });
    expect(() => receipts.assertSettled()).toThrow(
      "sidecar_resource_handoff_pending",
    );
    // Only an explicit disposition after inspecting the affected workspace
    // may discard this result. Normal error delivery is not an acknowledgment.
    expect(receipts.acknowledge(id)).toBe(true);
  });
  it("reserves capacity before effects, rejects conflicting replay, and releases only settled acknowledged receipts", async () => {
    const receipts = new SidecarOperationReceipts(1);
    const id = randomUUID();
    const gate = deferred<{ done: true }>();
    const effect = vi.fn(() => gate.promise);
    const first = receipts.run(id, { operation: "write", path: "a" }, effect);
    const duplicate = receipts.run(
      id,
      { operation: "write", path: "a" },
      effect,
    );
    await Promise.resolve();
    expect(effect).toHaveBeenCalledOnce();
    expect(receipts.inspect(id)).toEqual({ state: "pending" });
    expect(receipts.acknowledge(id)).toBe(false);
    const rejectedEffect = vi.fn(async () => undefined);
    await expect(
      receipts.run(randomUUID(), {}, rejectedEffect),
    ).rejects.toMatchObject({ code: "sidecar_receipt_capacity" });
    await expect(
      receipts.run(id, { operation: "write", path: "b" }, rejectedEffect),
    ).rejects.toMatchObject({ code: "sidecar_operation_id_reused" });
    expect(rejectedEffect).not.toHaveBeenCalled();
    const revision = receipts.snapshot().revision;
    gate.resolve({ done: true });
    await expect(first).resolves.toEqual({ done: true });
    await expect(duplicate).resolves.toEqual({ done: true });
    expect(receipts.snapshot().revision).not.toBe(revision);
    expect(() => receipts.assertSettled()).toThrow(
      "sidecar_resource_handoff_pending",
    );
    expect(receipts.inspect(id)).toEqual({
      state: "succeeded",
      result: { done: true },
    });
    expect(receipts.acknowledge(id)).toBe(true);
    await receipts.run(randomUUID(), {}, rejectedEffect);
    expect(rejectedEffect).toHaveBeenCalledOnce();
  });

  it("retains a file mutation across detach while revoking old filesystem handles and closing watches", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-receipt-"));
    const gate = deferred<{
      path: string;
      sizeBytes: number;
      revision: string;
    }>();
    const invoked = deferred<void>();
    const write = vi.fn(() => {
      invoked.resolve();
      return gate.promise;
    });
    const watchClosed = vi.fn();
    const host = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      engine: {
        validateRoot: async () => undefined,
        close: vi.fn(),
        write,
        watch: async () => ({
          close: watchClosed,
          failed: new Promise<void>(() => undefined),
        }),
      } as unknown as WorkspaceFilesEngine,
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unused");
      },
      onDownloadCleanupFailure: vi.fn(),
    });
    try {
      const context = {
        requestId: randomUUID(),
        signal: new AbortController().signal,
      };
      const { rootHandle } = await host.handlers.rootOpen(
        {
          admissionId: randomUUID(),
          rootId: "primary",
          rootKind: "primary",
          declaredPath: root,
          policyRootPath: root,
        },
        context,
      );
      await host.handlers.watchOpen({ rootHandle }, context);
      const operationId = randomUUID();
      const request = {
        operationId,
        rootHandle,
        path: "note",
        content: "new",
        expectedRevision: "old",
      };
      const pending = host.handlers.write(request, context);
      await invoked.promise;
      host.detach();
      expect(watchClosed).toHaveBeenCalledOnce();
      expect(host.snapshot().blockers).toContain("unsettled_outcome");
      const result = { path: "note", sizeBytes: 3, revision: "new" };
      gate.resolve(result);
      await pending;
      expect(
        await host.handlers.mutationInspect({ operationId }, context),
      ).toEqual({ state: "succeeded", result });
      await expect(host.handlers.write(request, context)).resolves.toEqual(
        result,
      );
      expect(write).toHaveBeenCalledOnce();
      await expect(
        host.handlers.read({ rootHandle, path: "note" }, context),
      ).rejects.toMatchObject({ code: "sidecar_root_handle_invalid" });
      await expect(host.stop()).rejects.toThrow(
        "sidecar_resource_handoff_pending",
      );
      await host.handlers.mutationAcknowledge({ operationId }, context);
      await expect(host.stop()).resolves.toBeUndefined();
    } finally {
      host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a proven result by inspection without retrying a mutation and keeps other service receipts isolated", async () => {
    const receipts = new SidecarOperationReceipts();
    const otherService = new SidecarOperationReceipts();
    const operationId = randomUUID();
    const result = { path: "note", sizeBytes: 3, revision: "known" };
    await receipts.run(operationId, {}, async () => result);
    expect(otherService.inspect(operationId)).toEqual({
      state: "unknown",
      settled: false,
    });
    const call = vi.fn(async (definition, request) => {
      expect(definition).toBe(workspaceFilesMutationInspectOperation);
      return receipts.inspect(request.operationId);
    });
    const release = vi.fn();
    await expect(
      recoverSidecarOperation({
        error: new SidecarProtocolDeliveryError(
          "broken",
          "sent_outcome_unknown",
        ),
        operationId,
        resultSchema: workspaceFilesWriteOperation.responseSchema,
        inspect: workspaceFilesMutationInspectOperation,
        acquire: async () => ({
          session: { call } as unknown as SidecarClientSession,
          release,
        }),
      }),
    ).resolves.toEqual(result);
    expect(call).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(receipts.inspect(operationId).state).toBe("succeeded");
  });

  it("retains failure codes and requires a separate explicit administration disposition", async () => {
    const receipts = new SidecarOperationReceipts();
    const operationId = randomUUID();
    await expect(
      receipts.run(operationId, {}, async () => {
        throw new SidecarOperationError("workspace_file_revision_conflict");
      }),
    ).rejects.toThrow();
    const client = new SidecarOperationRecoveryClient({
      call: async (definition: { operation: string }) => {
        if (definition.operation === "mutation.list")
          return { operationIds: [operationId] };
        if (definition.operation === "mutation.inspect")
          return receipts.inspect(operationId);
        if (definition.operation === "mutation.acknowledge")
          return { acknowledged: receipts.acknowledge(operationId) };
        throw new Error("unexpected_operation");
      },
    } as unknown as SidecarClientSession);
    await expect(client.list(["file"])).resolves.toEqual({
      receipts: [
        {
          kind: "file",
          receiptId: operationId,
          state: "failed",
          summary: "Operation failed (workspace_file_revision_conflict).",
          acknowledgeable: true,
        },
      ],
    });
    expect(receipts.snapshot().blockers).toContain("unsettled_outcome");
    await client.acknowledge({ kind: "file", receiptId: operationId });
    expect(receipts.snapshot().blockers).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
