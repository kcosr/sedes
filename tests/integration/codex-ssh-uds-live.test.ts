import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexModelListMethod,
  codexThreadSettingsUpdateMethod,
  codexThreadStartMethod,
  codexTurnStartMethod,
} from "../../src/server/backends/codex/codex-c2-protocol.js";
import { CodexDaemonSupervisor } from "../../src/server/backends/codex/codex-daemon-supervisor.js";
import type { ProviderTransportScope } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { UnixWebSocketTransportFactory } from "../../src/server/backends/codex/transport/unix-websocket-transport.js";
import { SshEnvironmentChannelProvider } from "../../src/server/execution/ssh-environment-channel.js";
import { RemoteExecutionEnvironment } from "../../src/server/execution/remote-execution-environment.js";

const requestOptions = Object.freeze({ timeoutMilliseconds: 15_000 });
const turnRequestOptions = Object.freeze({ timeoutMilliseconds: 180_000 });
const configuredEndpoint = readConfiguredEndpoint();

describe.sequential("Codex over a real SSH UDS carrier", () => {
  it.skipIf(!configuredEndpoint)(
    "creates one disposable Luna-low thread without inspecting existing threads",
    async () => {
      const configured = configuredEndpoint!;
      const scope = Object.freeze({
        tenantId: "tenant-codex-ssh-uds-live",
        principalId: "principal-codex-ssh-uds-live",
      });
      const runtimeScope: ProviderTransportScope = Object.freeze({
        ...scope,
        backendInstanceId: "codex-ssh-uds-live",
        executionEnvironmentId: "codex-ssh-uds-live-environment",
      });
      const environment = new RemoteExecutionEnvironment({
        kind: "ssh",
        platform: "linux",
        environmentId: runtimeScope.executionEnvironmentId,
        scope,
        allowedRoots: [configured.workspace],
        configurationRevision: 1,
        activeConfigurationRevision: () => 1,
        directoryBrowser: () => undefined,
      });
      const channels = new SshEnvironmentChannelProvider({
        scope,
        executionEnvironmentId: runtimeScope.executionEnvironmentId,
        host: configured.host,
        configurationRevision: 1,
        activeConfigurationRevision: () => 1,
        availability: {
          reportBackendObservation: async (_backendInstanceId, observation) =>
            await environment.observeAvailability(
              observation.availability === "available",
              observation.availability === "unavailable"
                ? observation.diagnosticCode
                : undefined,
            ),
        },
      });
      let supervisor: CodexDaemonSupervisor | undefined;

      try {
        await expect(
          environment.validateWorkspace(
            scope,
            runtimeScope.executionEnvironmentId,
            configured.workspace,
          ),
        ).resolves.toMatchObject({
          canonicalPath: configured.workspace,
          summary: {
            environmentId: runtimeScope.executionEnvironmentId,
            displayPath: configured.workspace,
            availability: "available",
          },
        });

        supervisor = createSupervisor({
          scope: runtimeScope,
          socketPath: configured.socketPath,
          channels,
        });
        await supervisor.start();

        await assertAuthenticatedLunaLow(supervisor);
        const started = await supervisor.client.request(
          codexThreadStartMethod,
          {
            model: configured.model,
            cwd: configured.workspace,
            approvalPolicy: "never",
            sandbox: "read-only",
            ephemeral: true,
            threadSource: "sedes_ssh_uds_real_luna_live",
          },
          requestOptions,
        );
        const threadId = started.thread.id;
        expect(threadId).toMatch(/^[0-9a-f-]{36}$/i);

        const settingsUpdated = nextNotification(
          supervisor,
          "thread/settings/updated",
          (params) => {
            const notification = optionalRecord(params);
            const settings = optionalRecord(notification?.threadSettings);
            const sandbox = optionalRecord(settings?.sandboxPolicy);
            return (
              notification?.threadId === threadId &&
              settings?.model === configured.model &&
              settings.effort === "low" &&
              settings.approvalPolicy === "never" &&
              sandbox?.type === "readOnly" &&
              sandbox.networkAccess === false
            );
          },
          30_000,
        );
        await supervisor.client.request(
          codexThreadSettingsUpdateMethod,
          {
            threadId,
            model: configured.model,
            effort: "low",
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
          requestOptions,
        );
        await settingsUpdated;

        const toolItems: string[] = [];
        let assistantReply = "";
        const stopCollecting = supervisor.client.subscribeNotifications(
          (notification) => {
            if (notification.kind !== "decoded_notification") return;
            if (notification.method === "item/agentMessage/delta") {
              const params = optionalRecord(notification.params);
              if (
                params?.threadId === threadId &&
                typeof params.delta === "string"
              ) {
                assistantReply += params.delta;
              }
              return;
            }
            if (
              notification.method !== "item/started" &&
              notification.method !== "item/completed"
            ) {
              return;
            }
            const params = optionalRecord(notification.params);
            if (params?.threadId !== threadId) return;
            const item = optionalRecord(params.item);
            const type = typeof item?.type === "string" ? item.type : "";
            if (isToolItemType(type)) toolItems.push(type);
          },
        );
        const streamed = nextNotification(
          supervisor,
          "item/agentMessage/delta",
          (params) => optionalRecord(params)?.threadId === threadId,
          180_000,
        );
        const completed = nextNotification(
          supervisor,
          "turn/completed",
          (params) => optionalRecord(params)?.threadId === threadId,
          180_000,
        );
        await supervisor.client.request(
          codexTurnStartMethod,
          {
            threadId,
            clientUserMessageId: `sedes-ssh-uds-${randomUUID()}`,
            input: [
              {
                type: "text",
                text: "Reply exactly SSH_UDS_LUNA_READY. Do not use tools.",
                text_elements: [],
              },
            ],
            model: configured.model,
            effort: "low",
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          },
          turnRequestOptions,
        );
        await Promise.all([streamed, completed]);
        stopCollecting();
        expect(toolItems).toEqual([]);
        expect(assistantReply).toBe("SSH_UDS_LUNA_READY");

        await supervisor.close();
        supervisor = undefined;

        // A fresh carrier must still reach the same externally managed daemon.
        // Closing Sedes must neither remove the remote socket nor stop Codex.
        const reopened = createSupervisor({
          scope: runtimeScope,
          socketPath: configured.socketPath,
          channels,
        });
        supervisor = reopened;
        await reopened.start();
        await assertAuthenticatedLunaLow(reopened);
      } finally {
        await supervisor?.close().catch(() => undefined);
        try {
          await channels.close();
        } finally {
          environment.close();
        }
      }
    },
    300_000,
  );
});

function createSupervisor(input: {
  readonly scope: ProviderTransportScope;
  readonly socketPath: string;
  readonly channels: SshEnvironmentChannelProvider;
}): CodexDaemonSupervisor {
  return new CodexDaemonSupervisor({
    scope: input.scope,
    transportFactory: new UnixWebSocketTransportFactory({
      scope: input.scope,
      channels: input.channels,
      socketPath: input.socketPath,
    }),
    restartDelaysMilliseconds: [100, 250, 500],
    maximumRestartAttempts: 3,
    initializationTimeoutMilliseconds: 30_000,
    shutdownTimeoutMilliseconds: 3_000,
  });
}

async function assertAuthenticatedLunaLow(
  supervisor: CodexDaemonSupervisor,
): Promise<void> {
  const catalog = await supervisor.client.request(
    codexModelListMethod,
    { limit: 100, includeHidden: true },
    requestOptions,
  );
  const luna = catalog.data.filter((model) => model.id === "gpt-5.6-luna");
  if (
    luna.length !== 1 ||
    !luna[0]?.supportedReasoningEfforts.some(
      ({ reasoningEffort }) => reasoningEffort === "low",
    )
  ) {
    throw new Error("codex_ssh_uds_luna_low_gate_failed");
  }
}

async function nextNotification(
  supervisor: CodexDaemonSupervisor,
  method: string,
  predicate: (params: unknown) => boolean,
  timeoutMilliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`codex_ssh_uds_notification_timeout:${method}`));
    }, timeoutMilliseconds);
    const unsubscribe = supervisor.client.subscribeNotifications(
      (notification) => {
        if (
          notification.kind !== "decoded_notification" ||
          notification.method !== method ||
          !predicate(notification.params)
        ) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      },
    );
  });
}

function isToolItemType(type: string): boolean {
  return new Set([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "dynamicToolCall",
    "collabAgentToolCall",
    "subAgentActivity",
    "webSearch",
    "imageView",
    "sleep",
    "imageGeneration",
  ]).has(type);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("codex_ssh_uds_rpc_shape_invalid");
  }
  return value as Readonly<Record<string, unknown>>;
}

function optionalRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readConfiguredEndpoint():
  | Readonly<{
      host: string;
      socketPath: string;
      workspace: string;
      model: "gpt-5.6-luna";
    }>
  | undefined {
  const host = process.env.SEDES_REAL_CODEX_SSH_HOST;
  const socketPath = process.env.SEDES_REAL_CODEX_SSH_UDS_SOCKET;
  const workspace = process.env.SEDES_REAL_CODEX_SSH_WORKSPACE;
  const model = process.env.SEDES_REAL_CODEX_SSH_MODEL;
  if (!host && !socketPath && !workspace && !model) {
    return undefined;
  }
  if (
    !host ||
    !isCanonicalRemoteAbsolutePath(socketPath) ||
    !isCanonicalRemoteAbsolutePath(workspace) ||
    model !== "gpt-5.6-luna"
  ) {
    throw new Error("codex_ssh_uds_live_gate_invalid");
  }
  return Object.freeze({ host, socketPath, workspace, model });
}

function isCanonicalRemoteAbsolutePath(
  value: string | undefined,
): value is string {
  return (
    typeof value === "string" &&
    path.posix.isAbsolute(value) &&
    path.posix.normalize(value) === value &&
    !value.includes("\0") &&
    !value.includes("\n")
  );
}
