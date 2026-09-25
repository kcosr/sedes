#!/usr/bin/env node
import { environmentVariablesResolveOperation } from "../../internal/sidecar-protocol/environment-variables-v1.js";
import { resolveEnvironmentVariables } from "../environment-variables/runtime-environment.js";
import { createHash } from "node:crypto";
import { windowsSidecarIpc } from "./sidecar-windows-ipc.js";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  agentToolsCatalogOperation,
  agentToolsDescribeOperation,
  agentToolsInvokeOperation,
  registerDirectoryBrowserV1Operations,
  INTERACTIVE_TERMINAL_V2_EVIDENCE,
  registerComposerAttachmentsV1Operations,
  SidecarProtocolDeliveryError,
  registerControlV2Operations,
  registerWorkspaceFilesV8Operations,
  registerWorkspaceToolsV2Operations,
  registerWorkspaceToolsShellV2Operations,
  registerWorkspaceContextV1Operations,
  registerWorkspaceSkillsV1Operations,
  supportsSidecarNodeVersion,
  workspaceFilesInvalidatedEventSchema,
  workspaceFilesWatchFailedEventSchema,
  WORKSPACE_TOOLS_V2_LIMITS,
  WORKSPACE_TOOLS_SHELL_V2_LIMITS,
  WORKSPACE_CONTEXT_V1_LIMITS,
  WORKSPACE_SKILLS_V1_LIMITS,
} from "../../internal/sidecar-protocol/index.js";
import type {
  AgentToolCliRequest,
  AgentToolCliResult,
} from "../../internal/agent-tool-cli-protocol/index.js";
import { runSedesCli } from "../../cli/sedes-cli.js";
import { ComposerAttachmentsSidecarHost } from "./composer-attachments-sidecar-host.js";
import { DirectoryBrowserSidecarHost } from "./directory-browser-sidecar-host.js";
import {
  AgentToolCliIngressError,
  AgentToolCliLocalIngress,
} from "./agent-tool-cli-local-ingress.js";
import { WorkspaceFilesSidecarHost } from "./workspace-files-sidecar-host.js";
import { WorkspaceToolsSidecarHost } from "./workspace-tools-sidecar-host.js";
import { WorkspaceToolsShellHost } from "./workspace-tools-shell-host.js";
import { WorkspaceContextSidecarHost } from "./workspace-context-sidecar-host.js";
import { WorkspaceSkillsSidecarHost } from "./workspace-skills-sidecar-host.js";
import { CanonicalMutationSerializer } from "../workspace-files/canonical-mutation-serializer.js";
import { WorkspaceFilesEngine } from "../workspace-files/workspace-files-engine.js";

import { z } from "zod";
import { SIDECAR_WIRE_VERSION } from "../../internal/sidecar-protocol/envelopes.js";
import { sidecarServiceScopeSchema, sidecarServiceConfigurationSchema } from "../../internal/sidecar-protocol/service-management-v1.js";
import { ensurePersistentSidecar, preparePersistentSidecarNamespace, recordPersistentSidecar } from "./persistent-sidecar-bootstrap.js";
import { persistentSidecarDiagnosticOptions } from "./persistent-sidecar-diagnostics.js";
import { startDeliveryDiagnostics } from "../diagnostics/event-loop-diagnostics.js";
import { createSidecarAbandonmentArchive } from "./sidecar-abandonment-archive.js";
import { PersistentSidecarServiceRegistry } from "./persistent-sidecar-service-registry.js";
import { PersistentSidecarServiceServer } from "./persistent-sidecar-service-server.js";
import { PersistentSidecarManagementReceipts } from "./persistent-sidecar-management-receipts.js";
import { SidecarRuntimeAttachment, SidecarUpstreamUnavailableError } from "./sidecar-runtime-attachment.js";
import { SidecarRuntimeChannel } from "./runtime-channel.js";
import { LocalEnvironmentChannelProvider } from "../execution/local-environment-channel.js";
import { CodexRuntimeHostRegistry } from "../backends/codex/runtime/codex-runtime-host-registry.js";
import { registerCodexRuntimeHost } from "../backends/codex/runtime/codex-sidecar-runtime.js";
import { registerCodexManagedTuiHost } from "../backends/codex/runtime/codex-runtime-managed-tui.js";
import { ClaudePersistentRuntimeRegistry } from "../backends/claude/runtime/claude-persistent-runtime-registry.js";
import { registerClaudePersistentRuntimeHost } from "../backends/claude/runtime/claude-sidecar-runtime.js";
import { installEmbeddedClaudeWorker } from "../backends/claude/worker/claude-sidecar-worker-artifact.js";
import { supportsClaudeRuntimeHost } from "../backends/claude/worker/claude-runtime-host-support.js";
import { PersistentTerminalHost } from "./persistent-terminal-host.js";

declare const __SEDES_SIDECAR_BUILD_ID__: string;

const compiledSidecarCapabilities = Object.freeze([
  Object.freeze({ capabilityId: "environment_variables", majorVersion: 1 }),
  Object.freeze({ capabilityId: "directory_browser", majorVersion: 1 }),
  Object.freeze({ capabilityId: "workspace_files", majorVersion: 8 }),
  Object.freeze({ capabilityId: "workspace_tools", majorVersion: 2 }),
  Object.freeze({ capabilityId: "workspace_context", majorVersion: 1 }),
  Object.freeze({ capabilityId: "workspace_skills", majorVersion: 1 }),
  Object.freeze({ capabilityId: "composer_attachments", majorVersion: 1 }),
  Object.freeze({ capabilityId: "interactive_terminal", majorVersion: 2 }),
  Object.freeze({ capabilityId: "runtime_bodies", majorVersion: 1 }),
  Object.freeze({ capabilityId: "codex_runtime", majorVersion: 1 }),
  Object.freeze({ capabilityId: "claude_persistent_runtime", majorVersion: 1 }),
  Object.freeze({ capabilityId: "codex_managed_tui", majorVersion: 1 }),
]);
const enabledSedesCapabilities = Object.freeze([
  Object.freeze({ capabilityId: "runtime_bodies", majorVersion: 1, operations: Object.freeze(["body.offer"]) }),
  Object.freeze({
    capabilityId: "agent_tools_cli",
    majorVersion: 3,
    operations: Object.freeze([
      agentToolsDescribeOperation.operation,
      agentToolsCatalogOperation.operation,
      agentToolsInvokeOperation.operation,
    ]),
  }),
]);

void main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "sidecar_failed";
  process.stderr.write(`${boundedDiagnostic(code)}\n`);
  process.exitCode = 1;
});

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_[0] !== "service") {
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error("interrupted"));
    process.once("SIGINT", interrupt);
    try { process.exitCode = await runSedesCli(arguments_, { signal: controller.signal }); }
    finally { process.removeListener("SIGINT", interrupt); }
    return;
  }
  const input = parseServiceArguments(arguments_);
  if (!supportsSidecarNodeVersion(process.versions.node)) throw new Error("sidecar_node_version_unsupported");
  if (typeof __SEDES_SIDECAR_BUILD_ID__ !== "string" || input.expectedBuild !== __SEDES_SIDECAR_BUILD_ID__) throw new Error("sidecar_build_identity_mismatch");
  const executablePath = process.argv[1];
  if (!executablePath) throw new Error("sidecar_executable_path_unavailable");
  const artifactSha256 = createHash("sha256").update(await readFile(executablePath)).digest("hex");
  if (artifactSha256 !== input.expectedDigest) throw new Error("sidecar_artifact_digest_mismatch");
  if (input.mode === "connect") {
    const endpointPath = await ensurePersistentSidecar({ ...input, executablePath });
    await proxyToService(endpointPath);
    return;
  }
  // Native PTY assets are optional. Probe only when starting the daemon, so
  // a missing/incompatible addon cannot remove Files, management or providers.
  let nativePtyAvailable = false;
  try { nativePtyAvailable = typeof (await import("node-pty")).spawn === "function"; }
  catch { /* The handshake omits capabilities whose native prerequisite failed. */ }
  const claudeRuntimeAvailable = supportsClaudeRuntimeHost(process.platform, process.versions.node);
  const enabledSidecarCapabilities = Object.freeze(compiledSidecarCapabilities.filter(capability =>
    (claudeRuntimeAvailable || capability.capabilityId !== "claude_persistent_runtime") &&
    (nativePtyAvailable || (capability.capabilityId !== "interactive_terminal" && capability.capabilityId !== "codex_managed_tui"))));
  const paths = await preparePersistentSidecarNamespace(input.scope);
  const diagnosticOptions = await persistentSidecarDiagnosticOptions(paths.serviceDirectory);
  const stopDiagnostics = startDeliveryDiagnostics("sidecar", diagnosticOptions ?? { enabled: false });
  try {
  const recordAbandonment = createSidecarAbandonmentArchive({
    directory: path.join(paths.serviceDirectory, "abandoned-work"), scope: input.scope,
    serviceIncarnation: () => serviceRegistry.serviceIncarnation,
    onError: error => process.stderr.write(`${boundedDiagnostic(error instanceof Error ? error.message : "sidecar_abandonment_archive_failed")}\n`),
  });
  const serviceRegistry = new PersistentSidecarServiceRegistry({ scope: input.scope, configuration: input.configuration,
    buildId: input.expectedBuild, artifactSha256, runtimeWireVersion: SIDECAR_WIRE_VERSION, recordAbandonment });
  await recordPersistentSidecar(input.scope, serviceRegistry.serviceIncarnation, "running");
  const server = new PersistentSidecarServiceServer({ registry: serviceRegistry, endpointPath: paths.endpointPath,
    receipts: new PersistentSidecarManagementReceipts(path.join(paths.serviceDirectory, "management-receipts")),
    onStopped: async () => {
      workspaceContext.close(); workspaceSkills.close(); directoryBrowser.close();
      await agentToolIngress?.close();
      await environmentChannel.close();
      await recordPersistentSidecar(input.scope, serviceRegistry.serviceIncarnation, "stopped");
    },
    onRuntimeAttachment: ({ registry, peer, controllerEpoch, assertAdmission, assertController }) => {
      const runtimeChannel = new SidecarRuntimeChannel(peer, registry);
      registry.register(environmentVariablesResolveOperation, async ({ overrides }) => {
        assertAdmission();
        const values = await resolveEnvironmentVariables(overrides);
        assertAdmission();
        return { values };
      });
      const detachCodex = registerCodexRuntimeHost({ registry, channel: runtimeChannel, hosts: codexHosts, services: serviceRegistry, controllerEpoch,
        onDetach: () => attachment.detach(controllerEpoch) });
      const detachClaude = claudeRuntimeAvailable ? registerClaudePersistentRuntimeHost({ registry, channel: runtimeChannel, hosts: claudeHosts, controllerEpoch,
        onDetach: () => attachment.detach(controllerEpoch) }) : () => undefined;
      const detachTui = nativePtyAvailable ? registerCodexManagedTuiHost({ registry, channel: runtimeChannel, hosts: codexHosts.managedTui, services: serviceRegistry, controllerEpoch }) : () => undefined;
      const unsubscribe = attachment.subscribe((event) => {
        if (event === "detached" && attachment.controllerEpoch === controllerEpoch) { detachTui(); detachCodex(); detachClaude(); runtimeChannel.close(); unsubscribe(); }
      });
  registerWorkspaceFilesV8Operations(registry, workspaceFiles.handlers);
  registerWorkspaceToolsV2Operations(registry, workspaceTools.handlers);
  registerWorkspaceToolsShellV2Operations(
    registry,
    workspaceToolsShell.handlers,
  );
  registerWorkspaceContextV1Operations(registry, workspaceContext.handlers);
  registerWorkspaceSkillsV1Operations(registry, workspaceSkills.handlers);
  registerDirectoryBrowserV1Operations(registry, directoryBrowser.handlers);
  registerComposerAttachmentsV1Operations(
    registry,
    composerAttachments.handlers,
  );
  if (nativePtyAvailable) terminals.registerOperations(registry, { assertAdmission, assertController });
  registerControlV2Operations(registry, {
    buildId: input.expectedBuild,
    artifactSha256,
    enabledSidecarCapabilities,
    enabledSedesCapabilities,
    capabilityEvidence: Object.freeze([
      Object.freeze({
        capabilityId: "workspace_tools" as const,
        majorVersion: 2 as const,
        limits: WORKSPACE_TOOLS_V2_LIMITS,
        streamLimits: WORKSPACE_TOOLS_SHELL_V2_LIMITS.streamLimits,
        processLimits: WORKSPACE_TOOLS_SHELL_V2_LIMITS.processLimits,
      }),
      Object.freeze({
        capabilityId: "workspace_context" as const,
        majorVersion: 1 as const,
        limits: WORKSPACE_CONTEXT_V1_LIMITS,
      }),
      Object.freeze({
        capabilityId: "workspace_skills" as const,
        majorVersion: 1 as const,
        limits: WORKSPACE_SKILLS_V1_LIMITS,
      }),
      ...(nativePtyAvailable ? [Object.freeze({
        capabilityId: "interactive_terminal" as const,
        majorVersion: 2 as const,
        ...INTERACTIVE_TERMINAL_V2_EVIDENCE,
      })] : []),
    ]),
    prepareSedesCapabilities: async () => {
      agentToolIngress ??= await AgentToolCliLocalIngress.start({
        endpointKey: input.agentToolEndpointKey,
        relay: {
          handle: async (request, options) =>
            await relayAgentToolRequest(attachment, request, options.signal),
        },
      });
      return {
        endpoint: agentToolIngress.endpointUrl,
        executableDirectory: path.dirname(executablePath),
        inheritedPath: process.env.PATH ?? "",
      };
    },
    onGoAway: (reason) => {
      const timer = setTimeout(() => {
        serviceRegistry.detach(controllerEpoch);
        attachment.detach(controllerEpoch);
        void peer.close(reason).catch(() => undefined);
      }, 10);
      timer.unref();
    },
  });
    },
  });
  const attachment = server.attachment;
  const currentPeer = () => {
    const peer = attachment.currentPeer;
    if (!peer) throw new SidecarUpstreamUnavailableError();
    return peer;
  };
  const captureAdmission = () => {
    const epoch = serviceRegistry.controllerEpoch;
    return () => serviceRegistry.assertAdmission(epoch);
  };

  const environmentChannel = new LocalEnvironmentChannelProvider({
    scope: { tenantId: input.scope.tenantId, principalId: input.scope.principalId },
    executionEnvironmentId: input.scope.executionEnvironmentId, environment: process.env,
  });
  const codexHosts = new CodexRuntimeHostRegistry({ scope: { tenantId: input.scope.tenantId, principalId: input.scope.principalId },
    executionEnvironmentId: input.scope.executionEnvironmentId, environment: process.env, environmentChannel, services: serviceRegistry });
  const claudeHosts = new ClaudePersistentRuntimeRegistry({
    scope: { tenantId: input.scope.tenantId, principalId: input.scope.principalId },
    executionEnvironmentId: input.scope.executionEnvironmentId, environment: process.env, environmentChannel, services: serviceRegistry,
    artifact: () => installEmbeddedClaudeWorker(paths.serviceDirectory),
    validateQueryEnvironment: (environment) => {
      if (Object.keys(environment).length === 0) return;
      const inheritedPath = process.env.PATH ?? "";
      const expectedPath = path.dirname(executablePath) + (inheritedPath ? `${path.delimiter}${inheritedPath}` : "");
      if (!agentToolIngress || environment.SEDES_AGENT_TOOL_ENDPOINT !== agentToolIngress.endpointUrl ||
          environment.PATH !== expectedPath) throw new Error("claude_persistent_query_environment_denied");
    },
    // Native tools run this binary as `sedes mcp` against the same ingress.
    validateAgentToolMcp: (agentToolMcp) => {
      if (!agentToolIngress || agentToolMcp.endpoint !== agentToolIngress.endpointUrl ||
          agentToolMcp.command !== path.join(path.dirname(executablePath), "sedes")) {
        throw new Error("claude_persistent_agent_tool_mcp_denied");
      }
    },
  });
  const terminals = new PersistentTerminalHost({
    scope: { tenantId: input.scope.tenantId, principalId: input.scope.principalId },
    environmentId: input.scope.executionEnvironmentId,
    environment: process.env,
    registerResource: (resource) => serviceRegistry.register(resource),
    recordAbandonment: (record) => serviceRegistry.recordAbandonment(record),
  });
  let agentToolIngress: AgentToolCliLocalIngress | undefined;
  const composerAttachments = new ComposerAttachmentsSidecarHost({
    baseDirectory: path.join(paths.serviceDirectory, "composer-attachments"),
    sessionNonce: serviceRegistry.serviceIncarnation,
    captureAdmission,
  });
  const directoryBrowser = new DirectoryBrowserSidecarHost({
    sessionNonce: serviceRegistry.serviceIncarnation,
  });
  const mutations = new CanonicalMutationSerializer();
  const workspaceFiles = new WorkspaceFilesSidecarHost({
    sessionNonce: serviceRegistry.serviceIncarnation,
    captureAdmission,
    engine: new WorkspaceFilesEngine({ mutations }),
    sendInvalidation: async (subscriptionHandle) => {
      await attachment.sendEvent({
        capabilityId: "workspace_files",
        majorVersion: 8,
        event: "files.invalidated",
        schema: workspaceFilesInvalidatedEventSchema,
        payload: { subscriptionHandle },
      });
    },
    sendWatchFailure: async (subscriptionHandle) => {
      try {
        await attachment.sendEvent({
          capabilityId: "workspace_files",
          majorVersion: 8,
          event: "files.watch_failed",
          schema: workspaceFilesWatchFailedEventSchema,
          payload: { subscriptionHandle },
        });
      } catch (error) {
        await currentPeer()
          .close("sidecar_watch_failure_delivery_failed")
          .catch(() => undefined);
        throw error;
      }
    },
    openDownloadStream: ({ streamId, initialCreditBytes }) =>
      currentPeer().openOutgoingStream({
        streamId,
        capabilityId: "workspace_files",
        majorVersion: 8,
        initialCreditBytes,
      }),
    onDownloadCleanupFailure: () => {
      void currentPeer()
        .close("workspace_files_download_cleanup_unproven")
        .catch(() => undefined);
    },
  });
  const workspaceTools = new WorkspaceToolsSidecarHost({
    sessionNonce: serviceRegistry.serviceIncarnation,
    captureAdmission,
    mutations,
  });
  const workspaceContext = new WorkspaceContextSidecarHost();
  const workspaceSkills = new WorkspaceSkillsSidecarHost();
  const workspaceToolsShell = new WorkspaceToolsShellHost({
    captureAdmission,
    acknowledgeOperation: (operationId) => { workspaceTools.handlers.mutationAcknowledge({ operationId }, { requestId: operationId, signal: new AbortController().signal }); },
    resolveWorkspace: (workspaceHandle) =>
      workspaceTools.resolveWorkspace(workspaceHandle),
    openStream: ({ streamId, initialCreditBytes }) =>
      currentPeer().openOutgoingStream({
        streamId,
        capabilityId: "workspace_tools",
        majorVersion: 2,
        initialCreditBytes,
      }),
    admitOperation: (workspaceHandle, operationId, payload, operation) =>
      workspaceTools.admitOperation(
        workspaceHandle,
        operationId,
        payload,
        operation,
      ),
    onCleanupFailure: () => {
      void currentPeer()
        .close("workspace_tools_shell_cleanup_unproven")
        .catch(() => undefined);
    },
  });

  serviceRegistry.register({ resourceId: "workspace-files", kind: "operation", snapshot: () => workspaceFiles.snapshot(),
    stop: async (reason, { force }) => {
      if (force) await serviceRegistry.recordAbandonment({ resourceId: "workspace-files", kind: "workspace_files", reason, evidence: { phase: "before_shutdown", ...workspaceFiles.abandonmentEvidence() } });
      await workspaceFiles.stop(force);
      if (force) await serviceRegistry.recordAbandonment({ resourceId: "workspace-files", kind: "workspace_files", reason, evidence: { phase: "after_shutdown", ...workspaceFiles.abandonmentEvidence() } });
    }, onDetach: () => workspaceFiles.detach() });
  serviceRegistry.register({ resourceId: "workspace-tools", kind: "operation", snapshot: () => workspaceTools.snapshot(),
    stop: async (reason, { force }) => {
      if (force) await serviceRegistry.recordAbandonment({ resourceId: "workspace-tools", kind: "workspace_tools", reason, evidence: { phase: "before_shutdown", ...workspaceTools.abandonmentEvidence() } });
      await workspaceTools.stop(force);
      if (force) await serviceRegistry.recordAbandonment({ resourceId: "workspace-tools", kind: "workspace_tools", reason, evidence: { phase: "after_shutdown", ...workspaceTools.abandonmentEvidence() } });
    }, onDetach: () => workspaceTools.detach() });
  serviceRegistry.register({ resourceId: "workspace-shells", kind: "operation", snapshot: () => workspaceToolsShell.snapshot(),
    stop: async (reason, { force }) => {
      if (force) await serviceRegistry.recordAbandonment({ resourceId: "workspace-shells", kind: "workspace_shell", reason, evidence: { phase: "before_shutdown", ...workspaceToolsShell.abandonmentEvidence() } });
      await workspaceToolsShell.stop(force);
      if (force) await serviceRegistry.recordAbandonment({ resourceId: "workspace-shells", kind: "workspace_shell", reason, evidence: { phase: "after_shutdown", ...workspaceToolsShell.abandonmentEvidence() } });
    }, onDetach: () => workspaceToolsShell.detach() });
  serviceRegistry.register({ resourceId: "composer-attachments", kind: "transfer", snapshot: () => composerAttachments.snapshot(), stop: () => composerAttachments.stop() });
  try { await server.listen(); }
  catch (error) {
    // No endpoint was exposed and no resource work was admitted, so this
    // incarnation retires truthfully instead of demanding ownership recovery.
    await recordPersistentSidecar(input.scope, serviceRegistry.serviceIncarnation, "stopped").catch(() => undefined);
    throw error;
  }
  let signals = 0;
  const stop = () => {
    signals += 1;
    if (signals > 1) {
      // The operator insists. The ownership record keeps whatever this service
      // last proved, so a later start still demands recovery when appropriate.
      process.stderr.write(`${boundedDiagnostic("sidecar_signal_forced_exit")}\n`);
      process.exit(1);
    }
    void server.stop(true, "sidecar_signal").catch((error: unknown) => {
      const code = error instanceof Error ? error.message : "sidecar_cleanup_failed";
      process.stderr.write(`${boundedDiagnostic(code)}\n`);
      // Unproven cleanup cannot improve by staying alive; exiting keeps the
      // record at "running" so replacement requires explicit recovery. Retained
      // handoff results stay reachable through management until a second signal.
      if (code === "sidecar_service_cleanup_unproven") process.exit(1);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try { await server.closed; }
  finally { process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); }
  // Proven cleanup leaves no owned work. A straggling handle must not keep this
  // retired incarnation alive past a replacement bootstrap's retirement wait.
  setTimeout(() => process.exit(process.exitCode ?? 0), 2_000).unref();
  } finally { await stopDiagnostics(); }
}

function parseServiceArguments(arguments_: readonly string[]) {
  if (arguments_.length !== 12 || arguments_[0] !== "service" || !["connect", "daemon"].includes(arguments_[1]!) ||
    arguments_[2] !== "--expected-digest" || arguments_[4] !== "--expected-build" || arguments_[6] !== "--service-scope" ||
    arguments_[8] !== "--configuration" || arguments_[10] !== "--agent-tool-endpoint-key") throw new Error("sidecar_arguments_invalid");
  const expectedDigest = z.string().regex(/^[a-f0-9]{64}$/u).parse(arguments_[3]);
  const expectedBuild = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u).parse(arguments_[5]);
  const agentToolEndpointKey = z.string().regex(/^[a-f0-9]{24}$/u).parse(arguments_[11]);
  const decode = (value: string | undefined) => {
    if (!value || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("sidecar_arguments_invalid");
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  };
  return { mode: arguments_[1] as "connect" | "daemon", expectedDigest, expectedBuild, agentToolEndpointKey,
    scope: sidecarServiceScopeSchema.parse(decode(arguments_[7])), configuration: sidecarServiceConfigurationSchema.parse(decode(arguments_[9])) };
}

async function proxyToService(endpointPath: string): Promise<void> {
  const endpointKey = process.platform === "win32" ? await windowsSidecarIpc.readKey(endpointPath) : undefined;
  const socket = connect(endpointPath);
  const stop = () => socket.destroy();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => {
        void (async () => {
          if (endpointKey) await windowsSidecarIpc.authenticate(socket, endpointKey, "client");
          process.stdin.pipe(socket); socket.pipe(process.stdout); socket.resume();
        })().catch(reject);
      });
      socket.once("error", reject);
      socket.once("close", resolve);
      process.stdin.once("error", stop);
      process.stdout.once("error", stop);
    });
  } finally {
    process.stdin.unpipe(socket); socket.unpipe(process.stdout); socket.destroy(); process.stdin.destroy();
    process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
  }
}

async function relayAgentToolRequest(
  peer: SidecarRuntimeAttachment,
  request: AgentToolCliRequest,
  signal: AbortSignal,
): Promise<AgentToolCliResult> {
  switch (request.operation.type) {
    case "list": {
      let response;
      try {
        response = await peer.call(
          agentToolsCatalogOperation,
          { sourceCapability: request.sourceCapability },
          { signal, deadlineMilliseconds: 30_000 },
        );
      } catch (error) {
        throw mapAgentToolDeliveryError(error, false);
      }
      if (response.outcome === "error") {
        throw new AgentToolCliIngressError(response.error);
      }
      return { type: "list", value: { tools: response.tools } };
    }
    case "describe": {
      let response;
      try {
        response = await peer.call(
          agentToolsDescribeOperation,
          {
            sourceCapability: request.sourceCapability,
            toolIds: request.operation.toolIds,
          },
          { signal, deadlineMilliseconds: 30_000 },
        );
      } catch (error) {
        throw mapAgentToolDeliveryError(error, false);
      }
      if (response.outcome === "error") {
        throw new AgentToolCliIngressError(response.error);
      }
      return { type: "describe", value: { tools: response.tools } };
    }
    case "invoke": {
      let response;
      try {
        response = await peer.call(
          agentToolsInvokeOperation,
          {
            sourceCapability: request.sourceCapability,
            ...request.operation.request,
          },
          { signal },
        );
      } catch (error) {
        throw mapAgentToolDeliveryError(error, true);
      }
      if (response.outcome === "error") {
        throw new AgentToolCliIngressError(response.error);
      }
      return { type: "invoke", value: response.result };
    }
  }
}

function mapAgentToolDeliveryError(
  error: unknown,
  invocation: boolean,
): unknown {
  if (error instanceof SidecarUpstreamUnavailableError) {
    return new AgentToolCliIngressError({ code: "unavailable", message: "Upstream Sedes is unavailable.", retryable: true });
  }
  if (!(error instanceof SidecarProtocolDeliveryError)) return error;
  if (invocation && error.delivery === "sent_outcome_unknown") {
    return new AgentToolCliIngressError({
      code: "uncertain_outcome",
      message: "The agent-tool invocation outcome is unknown.",
      retryable: false,
    });
  }
  return new AgentToolCliIngressError({
    code: "unavailable",
    message: "Agent tools are currently unavailable.",
    retryable: true,
  });
}

function boundedDiagnostic(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/gu, "_");
  return normalized.length <= 240 ? normalized : normalized.slice(0, 240);
}
