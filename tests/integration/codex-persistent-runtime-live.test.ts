import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { expect, it, vi } from "vitest";
import { initializeEmptyBackendNormalizedDatabase } from "../../src/server/db/migrate.js";
import { CodexRuntimeReceiptStore } from "../../src/server/backends/codex/runtime/codex-runtime-receipt-store.js";
import { CodexRuntimeClient } from "../../src/server/backends/codex/runtime/codex-runtime-client.js";
import { CodexSidecarRuntimeConnection } from "../../src/server/backends/codex/runtime/codex-sidecar-runtime.js";
import { codexModelListMethod, codexThreadStartMethod, codexThreadSettingsUpdateMethod, codexTurnStartMethod } from "../../src/server/backends/codex/codex-c2-protocol.js";
import { codexThreadItemsListMethod, codexThreadTurnsListMethod, codexThreadUnsubscribeMethod, type CodexThreadTurnsListResponse } from "../../src/server/backends/codex/codex-c1-protocol.js";
import type { CodexRuntimeEvent } from "../../src/server/backends/codex/runtime/codex-runtime-protocol.js";
import { createPersistentCodexLiveSidecar } from "../helpers/persistent-codex-live-sidecar.js";

const enabled = process.env.SEDES_REAL_CODEX_PERSISTENT === "1";
const socketPath = process.env.SEDES_REAL_CODEX_UDS_SOCKET;
const model = process.env.SEDES_REAL_CODEX_UDS_MODEL;
if (enabled && (!socketPath || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath || model !== "gpt-5.6-luna")) throw new Error("codex_persistent_live_gate_invalid");
const options = { timeoutMilliseconds: 15_000 };

it.skipIf(!enabled)("retains a real Luna turn, receipt and native history across a disposable sidecar attachment restart", async () => {
  const socketBefore = await lstat(socketPath!, { bigint: true });
  expect(socketBefore.isSocket()).toBe(true);
  const service = await createPersistentCodexLiveSidecar();
  const workspace = path.join(service.home, "workspace");
  await mkdir(workspace);
  const filename = path.join(service.home, "application.sqlite");
  let database = new Database(filename);
  initializeEmptyBackendNormalizedDatabase(database);
  let receipts = new CodexRuntimeReceiptStore(database);
  const scope = { tenantId: service.scope.tenantId, principalId: service.scope.principalId,
    executionEnvironmentId: service.scope.executionEnvironmentId, backendInstanceId: "codex-live" };
  const configuration = {
    instance: { id: scope.backendInstanceId, tenantId: scope.tenantId, kind: "codex_app_server" as const, label: "Persistent live canary", enabled: true, configurationRevision: 0, protocolRelease: "0.153.0" as const },
    connections: [{ id: "live-profile", tenantId: scope.tenantId, ownerPrincipalId: scope.principalId, templateId: "live-template", kind: "codex_app_server" as const, backendInstanceId: scope.backendInstanceId, executionEnvironmentId: scope.executionEnvironmentId, label: "Live canary", enabled: true, configurationRevision: 0 }],
    connection: { ownership: "external" as const, channel: { type: "unix_websocket" as const, socketPath: socketPath! } },
  };
  const sessions: Awaited<ReturnType<typeof service.attach>>[] = [];
  const clients: CodexRuntimeClient[] = [];
  let runtimeId: string | undefined;
  let nativeThreadId: string | undefined;
  try {
    const first = await service.attach(); sessions.push(first);
    const connection = new CodexSidecarRuntimeConnection(first.session.runtimeChannel);
    runtimeId = await connection.ensure(configuration);
    const authority = { scope, runtimeId, controllerId: String(first.status.controllerEpoch) };
    const client = new CodexRuntimeClient({ connection, authority, receipts }); clients.push(client);
    await client.start();
    const originalGeneration = client.client.lifecycleSnapshot().generation;
    const catalog = await client.client.request(codexModelListMethod, { limit: 100, includeHidden: true }, options);
    const luna = catalog.data.find(value => value.id === model);
    expect(luna?.supportedReasoningEfforts.some(value => value.reasoningEffort === "low")).toBe(true);
    const started = await client.client.request(codexThreadStartMethod, { model: model!, cwd: workspace,
      approvalPolicy: "on-request", sandbox: "read-only", ephemeral: false, historyMode: "paginated", threadSource: "sedes_persistent_sidecar_live_canary" },
      { ...options, runtimeCorrelation: { kind: "create", applicationOperationId: randomUUID(), applicationThreadId: "canary-thread" } });
    nativeThreadId = started.thread.id;
    expect(started.thread.historyMode).toBe("paginated");
    await expect(client.client.persistentSessions!.reattachThread(nativeThreadId, options)).rejects.toMatchObject({
      name: "CodexRpcRemoteError", generation: originalGeneration,
      method: "thread/turns/list", message: expect.stringContaining("not materialized yet"),
    });
    const effective = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { remove(); reject(new Error("readonly_settings_gate_timeout")); }, 15_000);
      const remove = client.client.subscribeNotifications(notification => {
        if (notification.kind !== "decoded_notification" || notification.method !== "thread/settings/updated") return;
        const value = notification.params as { threadId: string; threadSettings: { model: string; effort: string; approvalPolicy: string; sandboxPolicy: { type: string; networkAccess: boolean } } };
        if (value.threadId !== nativeThreadId) return;
        try {
          expect(value.threadSettings).toMatchObject({ model, effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } });
          clearTimeout(timer); remove(); resolve();
        } catch (error) { clearTimeout(timer); remove(); reject(error); }
      });
    });
    await client.client.request(codexThreadSettingsUpdateMethod, { threadId: nativeThreadId, model: model!, effort: "low",
      approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } }, options);
    await effective;
    await client.close();

    const operationId = randomUUID();
    const marker = `PERSISTENT_CANARY_${randomUUID().replaceAll("-", "")}`;
    const params = codexTurnStartMethod.encodeParams({ threadId: nativeThreadId, clientUserMessageId: operationId,
      model: model!, effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false },
      input: [{ type: "text", text: `Print 96 numbered lines. Each line must say: ${marker} persistent sidecar recovery check. End with ${marker}_DONE. Do not use tools.`, text_elements: [] }] });
    receipts.reserve(authority, { operationId, method: "turn/start", requestFingerprint: createHash("sha256").update(JSON.stringify(["turn/start", params])).digest("hex"),
      correlation: { kind: "start", applicationOperationId: operationId, applicationThreadId: "canary-thread" } });
    let completedBeforeDetach = false;
    let streaming!: () => void;
    const streamed = new Promise<void>(resolve => { streaming = resolve; });
    await connection.attach(authority, (event: CodexRuntimeEvent) => {
      if (event.type !== "notification" || event.notification.kind !== "decoded_notification") return;
      const value = event.notification.params as { threadId?: string; delta?: string };
      if (value.threadId !== nativeThreadId) return;
      if (event.notification.method === "item/agentMessage/delta" && value.delta) streaming();
      if (event.notification.method === "turn/completed") completedBeforeDetach = true;
    });
    await connection.submit(authority, { operationId, method: "turn/start", generation: originalGeneration, params, timeoutMilliseconds: 30_000 });
    await Promise.race([streamed, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error("live_stream_timeout")), 120_000); timer.unref(); })]);
    expect(completedBeforeDetach).toBe(false);
    await first.session.close("canary_main_process_restart");
    connection.close();
    database.close();
    const detached = await service.status();
    expect(detached.serviceIncarnation).toBe(first.status.serviceIncarnation);
    expect(detached.resources.find(value => value.resourceId === runtimeId)?.blockers).toContain("unsettled_outcome");

    database = new Database(filename);
    receipts = new CodexRuntimeReceiptStore(database);
    expect(receipts.pending(authority).find(value => value.operationId === operationId)?.state).toBe("reserved");
    const second = await service.attach(); sessions.push(second);
    expect(second.status.serviceIncarnation).toBe(first.status.serviceIncarnation);
    expect(second.status.controllerEpoch).toBeGreaterThan(first.status.controllerEpoch);
    const reconnected = new CodexSidecarRuntimeConnection(second.session.runtimeChannel);
    expect(await reconnected.lookup(configuration)).toBe(runtimeId);
    const restored = new CodexRuntimeClient({ connection: reconnected, authority: { ...authority, controllerId: String(second.status.controllerEpoch) }, receipts }); clients.push(restored);
    await restored.start();
    expect(restored.client.lifecycleSnapshot()).toEqual({ state: "ready", generation: originalGeneration });
    const turnReceipt = receipts.pending(authority).find(value => value.operationId === operationId);
    expect(turnReceipt).toMatchObject({ state: "recorded", outcome: { status: "completed", nativeTurnId: expect.any(String) } });
    expect(await reconnected.recoverOutcomes({ ...authority, controllerId: String(second.status.controllerEpoch) })).not.toContainEqual(expect.objectContaining({ operationId }));
    const attached = await restored.client.persistentSessions!.reattachThread(nativeThreadId, options);
    expect(attached?.result).toMatchObject({ model, reasoningEffort: "low", sandbox: { type: "readOnly", networkAccess: false }, thread: { id: nativeThreadId, historyMode: "paginated" } });
    let history: CodexThreadTurnsListResponse;
    await vi.waitFor(async () => {
      history = await restored.client.request(codexThreadTurnsListMethod, { threadId: nativeThreadId!, limit: 10, sortDirection: "desc", itemsView: "notLoaded" }, options);
      expect(history.data).toHaveLength(1);
      expect(history.data[0]?.status).toBe("completed");
    }, { timeout: 120_000, interval: 500 });
    const turn = history!.data[0]!;
    expect(turn.id).toBe(turnReceipt!.outcome!.status === "completed" ? turnReceipt!.outcome!.nativeTurnId : undefined);
    const items = await restored.client.request(codexThreadItemsListMethod, { threadId: nativeThreadId, turnId: turn.id, limit: 100, sortDirection: "asc" }, options);
    expect(items.nextCursor).toBeNull();
    expect(items.data.every(entry => ["userMessage", "agentMessage", "reasoning"].includes(entry.item.type))).toBe(true);
    expect(items.data.map(entry => entry.item).filter(item => item.type === "agentMessage").map(item => item.text).join("\n")).toContain(`${marker}_DONE`);
    await restored.drainAcknowledgements();
    const restoredAuthority = { ...authority, controllerId: String(second.status.controllerEpoch) };
    await reconnected.evictThread(restoredAuthority, nativeThreadId, originalGeneration);
    expect(await reconnected.idle(restoredAuthority, originalGeneration)).toBe(true);
    expect(restored.client.lifecycleSnapshot().state).toBe("idle");
    await reconnected.wake(restoredAuthority);
    expect(restored.client.lifecycleSnapshot().state).toBe("ready");
    expect(restored.client.lifecycleSnapshot().generation).toBeGreaterThan(originalGeneration);
    // Only the sidecar connection retired: the operator's server and exact
    // native history remain accessible through the fresh connection.
    const retainedHistory = await restored.client.request(codexThreadTurnsListMethod, { threadId: nativeThreadId, limit: 10, sortDirection: "desc", itemsView: "notLoaded" }, options);
    expect(retainedHistory.data[0]?.id).toBe(turn.id);
    await restored.client.request(codexThreadUnsubscribeMethod, { threadId: nativeThreadId }, options);
    await restored.close();
  } finally {
    for (const client of clients.reverse()) await client.close().catch(() => undefined);
    for (const attached of sessions.reverse()) await attached.session.close("canary_complete").catch(() => undefined);
    if (database.open) database.close();
    await service.close();
  }
  const socketAfter = await lstat(socketPath!, { bigint: true });
  expect({ dev: socketAfter.dev, ino: socketAfter.ino }).toEqual({ dev: socketBefore.dev, ino: socketBefore.ino });
}, 300_000);
