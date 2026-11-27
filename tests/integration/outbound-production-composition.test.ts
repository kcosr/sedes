import { buildProductionSidecarArtifact, buildProductionOutboundConnector, productionOpenSshAvailable, startProductionSshServer, terminateChild } from "../support/production-carrier-fixture.js";
import { AuthenticationRepository } from "../../src/server/authentication/authentication-repository.js";
import Database from "better-sqlite3";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { loadOrCreateToolProvenanceKey, deriveSidecarInstallationIdentity } from "../../src/server/security/installation-secret.js";
import { PrincipalBackendRuntimeCollection } from "../../src/server/runtime/principal-backend-runtime-collection.js";
import { once } from "node:events";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import { LIVE_CLAUDE_MODEL } from "../support/live-claude-model.js";
import { buildToolDisabledWorker } from "../support/live-claude-worker.js";
import path from "node:path";
import { promisify } from "node:util";
import { OUTBOUND_CLAUDE_AUTH_STATUS, type OutboundClaudeFixtureEvent } from "../support/outbound-claude-sdk-fixture.js";
import { normalizedThreadSnapshotSchema, threadEventEnvelopeSchema } from "../../src/shared/protocol/conversation.js";
import { OutboundCodexFixture } from "../support/outbound-codex-fixture.js";
import { decodeCodexModelSetting } from "../../src/server/backends/codex/codex-setting-values.js";
import { CodexAccountUsageSource } from "../../src/server/backends/codex/codex-account-usage.js";
import { terminalAdmissionSchema, terminalMutationResultSchema, terminalResourceSchema, terminalServerFrameSchema, decodeTerminalBinaryFrame, encodeTerminalBinaryFrame, TERMINAL_WEBSOCKET_PATH, TERMINAL_WEBSOCKET_PROTOCOL, type TerminalServerFrame, type TerminalResource } from "../../src/shared/protocol/terminals.js";
import { WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OUTBOUND_CONTROL_PATH, OUTBOUND_CONTROL_PROTOCOL, OUTBOUND_RUNTIME_PATH, OUTBOUND_RUNTIME_PROTOCOL } from "../../src/internal/outbound-protocol.js";
import { readSidecarManagementRecord, writeSidecarManagementRecord } from "../../src/internal/sidecar-protocol/service-management-channel.js";
import { sidecarManagementResponseSchema, type SidecarServiceScope } from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { startProductionApplication, type RunningApplication } from "../../src/server/production-application.js";
import { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";
import { HostPairingRepository } from "../../src/server/host-pairing/host-pairing-repository.js";
import { OutboundConnectionRegistry } from "../../src/server/outbound/outbound-connection-registry.js";
import { ViewedImageCaptureService } from "../../src/server/output-artifacts/viewed-image-capture.js";
import { loadSidecarArtifactRegistration, type SidecarArtifactRegistration } from "../../src/server/sidecar/sidecar-artifact.js";
import { inspectAtEndpoint } from "../../src/server/sidecar/persistent-sidecar-bootstrap.js";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import { normalizedApplicationSessionSchema, normalizedApplicationSnapshotSchema } from "../../src/shared/protocol/application.js";
import { configurationSnapshotSchema, configurationLifecycleImpactSchema, configurationLifecycleResultSchema } from "../../src/shared/protocol/configuration-admin.js";
import { acceptHostRegistrationResultSchema, hostPairingListSchema } from "../../src/shared/protocol/host-pairing.js";
import { workspaceFileContentResultSchema, workspaceFileListResultSchema, workspaceFileWriteResultSchema } from "../../src/shared/protocol/workspace-files.js";
import { terminateProcessesReferencing } from "../support/process-cleanup.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) throw failures[0];
}, 60_000);

function parseCompleteClaudeEvents(content: string): OutboundClaudeFixtureEvent[] {
  // The worker appends newline-delimited records. A concurrent read can stop
  // during the last append, so only its newline makes a record complete.
  return content.split("\n").slice(0, -1).filter(Boolean)
    .map(line => JSON.parse(line) as OutboundClaudeFixtureEvent);
}

describe("outbound fixture event framing", () => {
  it("waits for the trailing newline before parsing an appended event", () => {
    const event: OutboundClaudeFixtureEvent = {
      event: "send", pid: 42, queryId: "query", sessionId: "session", sendCount: 1,
    };
    const record = JSON.stringify(event);
    expect(parseCompleteClaudeEvents(`${record}\n${record.slice(0, 18)}`)).toEqual([event]);
    expect(parseCompleteClaudeEvents(`${record}\n${record}`)).toEqual([event]);
    expect(parseCompleteClaudeEvents(`${record}\n${record}\n`)).toEqual([event, event]);
  });

  it("still rejects malformed records that have a terminating newline", () => {
    expect(() => parseCompleteClaudeEvents('{"event":"send\n')).toThrow(SyntaxError);
  });
});

// These tests start real disposable connector/daemon processes with offline providers.
describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("outbound production composition", () => {
  it("pairs through HTTP, serves Files and terminals, preserves processes across reconnects, and revokes/reapproves access", async () => {
    const fixture = await OutboundFixture.create();
    cleanups.push(() => fixture.close());
    await fixture.startMain();
    fixture.startConnector();
    await fixture.waitFor(async () => (await fixture.pairings()).registrations.length === 1);
    const pending = (await fixture.pairings()).registrations[0]!;
    const identity = JSON.parse(await readFile(path.join(fixture.hostHome, "connector", "identity.json"), "utf8")) as { credential: string };
    expect((await fetch(`${fixture.url}/api/application/snapshot`)).status).toBe(401);
    expect((await fetch(`${fixture.url}/api/configuration`, { headers: { Authorization: `Bearer ${identity.credential}` } })).status).toBe(403);
    const impostor = new WebSocket(fixture.url.replace("http:", "ws:") + OUTBOUND_CONTROL_PATH, OUTBOUND_CONTROL_PROTOCOL, { headers: { Authorization: `Bearer ${identity.credential}` } });
    await once(impostor, "open");
    const impostorClosed = once(impostor, "close");
    impostor.send(JSON.stringify({ type: "hello", protocolVersion: 1, connectorId: randomUUID(), registrationAttemptId: randomUUID(), metadata: { hostname: "wrong", platform: process.platform, architecture: process.arch, account: "fixture", connectorVersion: "test" } }));
    expect((await impostorClosed)[1].toString()).toBe("outbound_authenticated_connector_mismatch");
    expect(pending).toMatchObject({ state: "pending", connected: true });
    expect((await fixture.configuration()).configuration.executionEnvironments).toHaveLength(0);
    expect(await lstat(path.join(fixture.hostHome, ".local/state/sedes/sidecar")).catch(() => undefined)).toBeUndefined();
    const forbidden = await fixture.request("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: pending.connectorId, project: { kind: "new", name: "workspace" } });
    expect(forbidden.status).not.toBe(200);
    expect(await rejectUnissuedRuntime(fixture.url, identity.credential)).toBe(true);

    const before = await fixture.configuration();
    const accepted = acceptHostRegistrationResultSchema.parse(await fixture.json("/api/host-registrations/accept", "POST", {
      mutationId: randomUUID(), registrationId: pending.id, expectedRegistrationRevision: pending.revision,
      expectedConfigurationRevision: before.revision, label: "Outbound production host", workspaceRoots: [fixture.workspace],
      operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "workspace_skills", "composer_attachments", "agent_tools_cli", "interactive_terminal"] },
    }));
    fixture.environmentId = accepted.pairing.executionEnvironmentId;
    await fixture.waitFor(async () => { try { await fixture.readBinding(); return true; } catch { return false; } });
    await fixture.waitFor(async () => (await fixture.snapshot()).environments.some(environment => environment.id === fixture.environmentId && environment.available));
    await fixture.readBinding();
    const original = await fixture.serviceStatus();
    expect(original?.state).toBe("ready");
    const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId, project: { kind: "new", name: "workspace" } }) as { id: string };
    const fileUrl = `/api/workspaces/${workspace.id}/files`;
    const listed = workspaceFileListResultSchema.parse(await fixture.json(`${fileUrl}?rootId=primary`));
    expect(JSON.stringify(listed)).toContain("example.txt");
    const first = workspaceFileContentResultSchema.parse(await fixture.json(`${fileUrl}/content?rootId=primary&path=example.txt`));
    expect(first).toMatchObject({ availability: "available", content: "before\n" });
    if (first.availability !== "available" || !("revision" in first)) throw new Error("fixture_file_not_readable");
    const saved = workspaceFileWriteResultSchema.parse(await fixture.json(`${fileUrl}/content`, "PUT", {
      rootId: "primary", path: "example.txt", content: "after\n", expectedRevision: first.revision,
    }));
    expect(saved.availability).toBe("available");
    if (saved.availability !== "available") throw new Error("fixture_write_unavailable");
    expect(await readFile(path.join(fixture.workspace, "example.txt"), "utf8")).toBe("after\n");
    const downloaded = await fixture.request(`${fileUrl}/download?rootId=primary&path=example.txt&expectedRevision=${encodeURIComponent(saved.revision)}`);
    expect(downloaded.status).toBe(200);
    expect(await downloaded.text()).toBe("after\n");

    const browsing = await fixture.json(`/api/execution-environments/${fixture.environmentId}/directories/browse`, "POST", { location: { kind: "directory", path: fixture.workspace } });
    expect(JSON.stringify(browsing)).toContain(fixture.workspace);
    const roots = await fixture.json(`/api/workspaces/${workspace.id}/file-roots`, "POST", { mutationId: randomUUID(), path: path.join(fixture.workspace, "extra"), displayLabel: "Extra" }) as { root: { rootId: string; revision: number } };
    expect(await fixture.json(`${fileUrl}/content?rootId=${roots.root.rootId}&path=nested.txt`)).toMatchObject({ availability: "available", content: "supplemental\n" });
    await fixture.json(`/api/workspaces/${workspace.id}/file-roots/${roots.root.rootId}`, "DELETE", { mutationId: randomUUID(), expectedRevision: roots.root.revision });
    expect(JSON.stringify(await fixture.json(`${fileUrl}/status`))).toContain("example.txt");

    const targetId = await fixture.addCodexBackend();
    await fixture.waitFor(async () => (await fixture.snapshot()).accountUsages.length === 1);
    expect((await fixture.snapshot()).accountUsages).toEqual([
      expect.objectContaining({
        backendInstanceId: "outbound-codex-backend",
        executionEnvironmentId: fixture.environmentId,
        accountId: "account-1",
        plan: "Pro Max",
        windows: [{ scope: { kind: "account" }, remainingPercent: 28, durationMinutes: 10_080, resetsAt: 1_800_000_000_000 }],
      }),
    ]);
    const created = await fixture.json("/api/threads", "POST", { workspaceId: workspace.id, title: "Outbound terminal fixture", executionWorkspace: { kind: "direct" }, configuration: { kind: "custom", targetId } }) as { threadId: string };
    const terminal = terminalMutationResultSchema.parse(await fixture.json(`/api/threads/${created.threadId}/terminals`, "POST", { mutationId: randomUUID(), displayName: "Retained shell", rows: 24, columns: 80 })).terminal!;
    fixture.terminalIds.push(terminal.terminalId);
    expect(terminal.lifecycle).toBe("running");
    let viewer = await TerminalViewer.open(fixture, terminal);
    await viewer.command("printf 'OUTBOUND_PID=%s\\n' \"$$\"\n");
    await fixture.waitFor(async () => /OUTBOUND_PID=[0-9]+/.test(viewer.output));
    const shellPid = /OUTBOUND_PID=([0-9]+)/.exec(viewer.output)![1]!;
    const attached = await fixture.serviceStatus();
    for (const connectionCompression of [false, true]) {
      const beforePolicy = await fixture.configuration();
      const configured = beforePolicy.configuration.executionEnvironments.find(environment => environment.id === fixture.environmentId)!;
      if (configured.kind !== "outbound") throw new Error("Expected outbound fixture");
      configured.connectionCompression = connectionCompression;
      const afterPolicy = configurationSnapshotSchema.parse(await fixture.json("/api/configuration", "PUT", {
        mutationId: randomUUID(), expectedRevision: beforePolicy.revision, configuration: beforePolicy.configuration,
      }));
      expect(afterPolicy.runtimes.find(runtime => runtime.resourceId === fixture.environmentId)?.effects).toContainEqual(
        expect.objectContaining({ component: "connection_compression", state: "next_attachment", desiredRevision: afterPolicy.revision }));
      expect(afterPolicy.runtimes.filter(runtime => runtime.resourceKind === "backend"))
        .toEqual(beforePolicy.runtimes.filter(runtime => runtime.resourceKind === "backend"));
      expect(await fixture.serviceStatus()).toMatchObject({ serviceIncarnation: attached!.serviceIncarnation, controllerEpoch: attached!.controllerEpoch });
      await viewer.command(`printf 'COMPRESSION_${connectionCompression}=%s\\n' "$$"\n`);
      await fixture.waitFor(async () => viewer.output.includes(`COMPRESSION_${connectionCompression}=${shellPid}`));
    }
    await viewer.close();

    const attachmentId = randomUUID();
    const csrf = normalizedApplicationSessionSchema.parse(await fixture.json("/api/application/session")).csrfToken;
    const upload = await fetch(`${fixture.url}/api/threads/${created.threadId}/composer-attachments/${attachmentId}?fileName=fixture.txt`, { method: "PUT", headers: { Authorization: `Bearer ${fixture.credential}`, "X-CSRF-Token": csrf, "Content-Type": "application/octet-stream" }, body: "outbound attachment" });
    expect(upload.status, await upload.text()).toBe(201);
    await fixture.json(`/api/threads/${created.threadId}/draft`, "PUT", { text: "", contextExcerpts: [], attachmentIds: [attachmentId], taskReferenceIds: [], expectedRevision: 0 });
    const attachment = await fixture.request(`/api/threads/${created.threadId}/composer-attachments/${attachmentId}/content`);
    expect(attachment.status).toBe(200);
    expect(await attachment.text()).toBe("outbound attachment");

    await fixture.stopConnector();
    await fixture.waitFor(async () => !(await fixture.pairings()).pairings[0]!.connected);
    await fixture.waitFor(async () => !(await fixture.snapshot()).environments.find(environment => environment.id === fixture.environmentId)?.available);
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);
    const offline = workspaceFileContentResultSchema.parse(await fixture.json(`${fileUrl}/content?rootId=primary&path=example.txt`));
    expect(offline.availability).toBe("unavailable");
    fixture.startConnector();
    await fixture.waitFor(async () => (await fixture.snapshot()).environments.find(environment => environment.id === fixture.environmentId)?.available === true);
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);
    expect((await fixture.pairings()).registrations).toHaveLength(1);
    viewer = await TerminalViewer.open(fixture, terminal);
    await viewer.command("printf 'RECONNECTED_PID=%s\\n' \"$$\"\n");
    await fixture.waitFor(async () => viewer.output.includes(`RECONNECTED_PID=${shellPid}`));
    await viewer.close();

    await fixture.stopMain();
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);
    await fixture.startMain();
    await fixture.waitFor(async () => (await fixture.snapshot()).environments.find(environment => environment.id === fixture.environmentId)?.available === true);
    expect((await fixture.pairings()).pairings[0]!.id).toBe(accepted.pairing.id);
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);
    expect(await fixture.json(`${fileUrl}/content?rootId=primary&path=example.txt`)).toMatchObject({ availability: "available", content: "after\n" });


    const restored = terminalResourceSchema.parse(await fixture.json(`/api/terminals/${terminal.terminalId}`));
    expect(restored.incarnationId).toBe(terminal.incarnationId);
    viewer = await TerminalViewer.open(fixture, restored);
    await viewer.command("printf 'MAIN_RESTART_PID=%s\\n' \"$$\"\n");
    await fixture.waitFor(async () => viewer.output.includes(`MAIN_RESTART_PID=${shellPid}`));
    await viewer.close();
    await fixture.json(`/api/terminals/${terminal.terminalId}/actions/end`, "POST", { mutationId: randomUUID(), expectedRevision: restored.lifecycleRevision });
    expect(fixture.codex?.requests.filter(request => request.method === "initialize")).toHaveLength(1);
    expect(fixture.codex?.errors).toEqual([]);
    expect(fixture.codex?.requests.some(request => request.method === "turn/start")).toBe(false);

    const activePairing = (await fixture.pairings()).pairings[0]!;
    const revoke = vi.spyOn(HostPairingRepository.prototype, "revoke");
    const refresh = vi.spyOn(OutboundConnectionRegistry.prototype, "refresh");
    const cancelEnvironment = vi.spyOn(ViewedImageCaptureService.prototype, "cancelEnvironment");
    cleanups.push(async () => { revoke.mockRestore(); refresh.mockRestore(); cancelEnvironment.mockRestore(); });
    await fixture.json("/api/host-pairings/revoke", "POST", { mutationId: randomUUID(), pairingId: activePairing.id,
      expectedPairingRevision: activePairing.revision, expectedConfigurationRevision: (await fixture.configuration()).revision });
    // Viewed-image captures are fenced in the revoke commit, before carriers are refreshed.
    const revokedAt = revoke.mock.invocationCallOrder[0]!;
    const fencedAt = cancelEnvironment.mock.invocationCallOrder.find((order, index) =>
      order > revokedAt && cancelEnvironment.mock.calls[index]![1] === fixture.environmentId);
    expect(fencedAt).toBeLessThan(refresh.mock.invocationCallOrder.find(order => order > revokedAt)!);
    await fixture.waitFor(async () => (await fixture.pairings()).pairings[0]!.state === "revoked" && !(await fixture.pairings()).pairings[0]!.connected);
    await fixture.waitFor(async () => !(await fixture.snapshot()).environments.find(environment => environment.id === fixture.environmentId)?.available);
    const revoked = workspaceFileContentResultSchema.parse(await fixture.json(`${fileUrl}/content?rootId=primary&path=example.txt`));
    expect(revoked.availability).toBe("unavailable");
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);

    await fixture.stopConnector();
    const revokedPairing = (await fixture.pairings()).pairings[0]!;
    await fixture.json("/api/host-pairings/reapprove", "POST", { mutationId: randomUUID(), pairingId: revokedPairing.id, expectedPairingRevision: revokedPairing.revision, expectedConfigurationRevision: (await fixture.configuration()).revision });
    expect(fixture.authentication.authenticate(identity.credential)).toBeUndefined();
    const copiedIdentityPairing = fixture.authentication.createPairing({ kind: "sidecar" });
    const copiedIdentity = await fetch(`${fixture.url}/api/auth/pair`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: copiedIdentityPairing.token, kind: "sidecar", connectorId: pending.connectorId, clientName: "Copied public identity" }) });
    expect(copiedIdentity.status).toBe(401);
    fixture.startConnector(true);
    await fixture.waitFor(async () => (await fixture.snapshot()).environments.some(environment => environment.id === fixture.environmentId && environment.available));
    expect((await fixture.pairings()).pairings[0]!.executionEnvironmentId).toBe(fixture.environmentId);
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);
    expect(await fixture.json(`${fileUrl}/content?rootId=primary&path=example.txt`)).toMatchObject({ availability: "available", content: "after\n" });
    const closeQuota = vi.spyOn(CodexAccountUsageSource.prototype, "close");
    const stopActors = vi.spyOn(ThreadRuntimeCoordinator.prototype, "runWithRuntimesStopped");
    cleanups.push(async () => { closeQuota.mockRestore(); stopActors.mockRestore(); });
    await fixture.stopBackend();
    // Independent polling is cancelled before actor cleanup can await remote
    // shutdown, while transport retirement retains its existing order.
    expect(closeQuota.mock.invocationCallOrder[0]).toBeLessThan(stopActors.mock.invocationCallOrder[0]!);
    const retiredBackend = await fixture.configuration();
    await fixture.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: retiredBackend.revision, configuration: { ...retiredBackend.configuration, backends: [], targets: [], defaultTargetId: null } });
    const reapproved = (await fixture.pairings()).pairings[0]!;
    await fixture.json("/api/host-pairings/revoke", "POST", { mutationId: randomUUID(), pairingId: reapproved.id, expectedPairingRevision: reapproved.revision, expectedConfigurationRevision: (await fixture.configuration()).revision });
    await fixture.waitFor(async () => !(await fixture.pairings()).pairings[0]!.connected);
    const removal = await fixture.configuration();
    await fixture.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: removal.revision, configuration: { ...removal.configuration, executionEnvironments: [], backends: [], targets: [], defaultTargetId: null } });
    await fixture.waitFor(async () => (await fixture.configuration()).runtimes.every(runtime => runtime.resourceId !== fixture.environmentId));
    expect((await fixture.configuration()).configuration.executionEnvironments).toHaveLength(0);
    expect((await fixture.pairings()).pairings[0]!.state).toBe("revoked");
  }, 120_000);

  for (const carrier of ["outbound", "ssh"] as const) {
    it.skipIf(carrier === "ssh" && !productionOpenSshAvailable)(`adds Claude during a streaming Codex turn and a live terminal over ${carrier}`, async () => {
      const fixture = await OutboundFixture.create("offline");
      cleanups.push(() => fixture.close());
      await fixture.startBusyHost(carrier);
      const codexTarget = await fixture.addCodexBackend();
      const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId,
        project: { kind: "new", name: "Live settings" } }) as { id: string };
      const codexThread = await fixture.submit(workspace.id, codexTarget, "Hold this Codex turn during settings apply.");
      await fixture.waitFor(async () => (await fixture.thread(codexThread)).runState === "running");
      fixture.codex!.appendOutput("Before settings update.");
      await fixture.waitFor(async () => JSON.stringify((await fixture.thread(codexThread)).itemsById).includes("Before settings update."));

      const terminal = terminalMutationResultSchema.parse(await fixture.json(`/api/threads/${codexThread}/terminals`, "POST", {
        mutationId: randomUUID(), displayName: "Settings continuity", rows: 24, columns: 80,
      })).terminal!;
      fixture.terminalIds.push(terminal.terminalId);
      const viewer = await TerminalViewer.open(fixture, terminal);
      await viewer.command(`printf 'BEFORE_PID=%s\\n' "$$"\n`);
      await fixture.waitFor(async () => /BEFORE_PID=\d+/.test(viewer.output));
      const shellPid = /BEFORE_PID=(\d+)/.exec(viewer.output)![1]!;
      const attached = await fixture.serviceStatus();
      expect(attached).toMatchObject({ state: "ready", attached: true });
      const descriptor = persistentSidecarPaths(fixture.hostHome, process.getuid!(), fixture.serviceScope!).descriptorPath;
      const originalProcess = JSON.parse(await readFile(descriptor, "utf8")).process;
      const providerId = attached!.resources.find(resource => resource.kind === "provider" && resource.state === "active")?.resourceId;
      expect(providerId).toBeTruthy();
      const before = await fixture.configuration();
      const impact = configurationLifecycleImpactSchema.parse(await fixture.json("/api/configuration/lifecycle/impact", "POST", {
        resourceKind: "backend", resourceId: "outbound-codex-backend", action: "stop", expectedRevision: before.revision,
      }));
      expect(impact.incarnation).toBe(providerId);
      const remove = vi.spyOn(PrincipalBackendRuntimeCollection.prototype, "remove");
      cleanups.push(async () => { remove.mockRestore(); });
      const files = `/api/workspaces/${workspace.id}/files/content?rootId=primary&path=example.txt`;
      expect(await fixture.json(files)).toMatchObject({ availability: "unavailable" });
      const newTarget = await fixture.addClaudeBackend();
      const claudeThread = await fixture.submit(workspace.id, newTarget, "Confirm that the new backend is ready.");
      await fixture.waitFor(async () => JSON.stringify((await fixture.thread(claudeThread)).itemsById).includes("Offline outbound Claude response."));
      const backendId = (await fixture.snapshot()).executionTargets.find(target => target.id === newTarget)!.backendInstanceId;
      await fixture.waitFor(async () => (await fixture.snapshot()).accountUsages.some(usage => usage.backendInstanceId === backendId));
      expect((await fixture.snapshot()).accountUsages.find(usage => usage.backendInstanceId === backendId)).toMatchObject({
        executionEnvironmentId: fixture.environmentId, eligibleThreadIds: [claudeThread], windows: [
          { scope: { kind: "account" }, remainingPercent: 47 },
          { scope: { kind: "model", label: "Fable" }, remainingPercent: 35 },
        ],
      });
      expect((await fixture.claudeEvents()).filter(event => event.event === "send")).toHaveLength(1);
      const secondTarget = await fixture.addCodexBackend("second-codex");
      const second = await fixture.json("/api/threads", "POST", { workspaceId: workspace.id, title: "Second Codex", executionWorkspace: { kind: "direct" },
        configuration: { kind: "custom", targetId: secondTarget } }) as { threadId: string };
      expect((await fixture.thread(second.threadId)).thread.targetId).toBe(secondTarget);
      const document = await fixture.configuration();
      const existing = document.configuration.targets.find(target => target.id === "outbound-codex")!;
      const host = document.configuration.executionEnvironments.find(environment => environment.id === fixture.environmentId)!;
      if (host.kind === "local" || host.operations.kind !== "sidecar") throw new Error("expected_remote_sidecar");
      host.operations.enabledCapabilities.push("workspace_files");
      document.configuration.targets.push({ ...existing, id: "named-codex", label: "Named Codex connection" });
      await fixture.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: document.revision, configuration: document.configuration });
      await fixture.waitFor(async () => (await fixture.snapshot()).executionTargets.some(target => target.label.text === "Named Codex connection" && target.available));
      await fixture.waitFor(async () => workspaceFileContentResultSchema.parse(await fixture.json(files)).availability === "available");
      expect(await fixture.json(files)).toMatchObject({ availability: "available", content: "before\n" });
      expect((await fixture.thread(claudeThread)).agentTools.runtimeAvailability.availability).toBe("unavailable");
      const tools = await fixture.configuration();
      const toolHost = tools.configuration.executionEnvironments.find(environment => environment.id === fixture.environmentId)!;
      if (toolHost.kind === "local" || toolHost.operations.kind !== "sidecar") throw new Error("expected_remote_sidecar");
      toolHost.operations.enabledCapabilities.push("agent_tools_cli");
      await fixture.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: tools.revision, configuration: tools.configuration });
      await fixture.waitFor(async () => (await fixture.configuration()).runtimes.some(runtime => runtime.resourceId === "outbound-claude-backend"
        && runtime.effects?.some(effect => effect.subjectId === "route:outbound-claude-backend" && effect.state === "applied")));
      await fixture.waitFor(async () => (await fixture.thread(claudeThread)).agentTools.runtimeAvailability.availability === "available");
      expect((await fixture.thread(codexThread)).runState).toBe("running");
      expect(await fixture.serviceStatus()).toMatchObject({
        serviceIncarnation: attached!.serviceIncarnation, controllerEpoch: attached!.controllerEpoch, attached: true, attachmentMode: "normal",
      });
      expect(JSON.parse(await readFile(descriptor, "utf8")).process).toEqual(originalProcess);
      expect((await fixture.serviceStatus())?.resources).toContainEqual(expect.objectContaining({ kind: "provider", resourceId: providerId, state: "active" }));
      expect((await fixture.configuration()).runtimes.find(runtime => runtime.resourceId === "outbound-codex-backend"))
        .toMatchObject({ incarnation: providerId, connectionState: "connected" });
      expect(remove).not.toHaveBeenCalled();
      await viewer.command(`printf 'AFTER_PID=%s\\n' "$$"\n`);
      await fixture.waitFor(async () => viewer.output.includes(`AFTER_PID=${shellPid}`));
      const output = viewer.frames.filter(frame => frame.type === "output").map(frame => frame.seq);
      expect(output).toEqual([...new Set(output)].sort((a, b) => a - b));
      fixture.codex!.appendOutput("After settings update.");
      fixture.codex!.completeTurn();
      await fixture.waitFor(async () => (await fixture.thread(codexThread)).runState === "idle");
      const history = await fixture.thread(codexThread);
      const messages = history.orderedTurnIds.flatMap(id => history.turnsById[id]!.orderedItemIds)
        .map(id => history.itemsById[id]!).filter(item => item.kind === "assistant_message");
      expect(messages.map(message => message.markdown.text)).toEqual(["Before settings update.", "After settings update."]);
      expect(fixture.codex!.requests.filter(request => request.method === "initialize")).toHaveLength(1);
      expect(fixture.codex!.requests.filter(request => request.method === "turn/start")).toHaveLength(1);
      expect(fixture.codex!.errors).toEqual([]);
      expect(fixture.threadStreamErrors).toEqual([]);
      await viewer.close();
    }, 120_000);
  }

  it.skipIf(process.env.SEDES_LIVE_EXECUTION_SETTINGS !== "1" || !productionOpenSshAvailable)(
    "adds the first Claude backend while authenticated Luna streams over disposable SSH", async () => {
      const socket = process.env.SEDES_REAL_CODEX_UDS_SOCKET;
      expect(process.env.SEDES_REAL_CODEX_UDS_MODEL).toBe("gpt-5.6-luna");
      if (!socket || !path.isAbsolute(socket) || path.resolve(socket) !== socket) throw new Error("live_settings_socket_invalid");
      const existing = await stat(socket, { bigint: true });
      expect(existing.isSocket()).toBe(true);
      expect(existing.mode & 0o777n).toBe(0o600n);
      const executablePath = process.env.SEDES_REAL_CLAUDE_EXECUTABLE;
      if (!executablePath || !path.isAbsolute(executablePath)) throw new Error("live_settings_claude_executable_required");
      const configDirectory = process.env.SEDES_REAL_CLAUDE_CONFIG_DIRECTORY ?? path.join(homedir(), ".claude");
      if (!path.isAbsolute(configDirectory)) throw new Error("live_settings_claude_config_directory_invalid");
      const fixture = await OutboundFixture.create("live");
      cleanups.push(() => fixture.close());
      await fixture.startBusyHost("ssh");
      const target = await fixture.addCodexBackend("live-luna", socket);
      const service = await fixture.serviceStatus();
      const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId,
        project: { kind: "new", name: "Live settings canary" } }) as { id: string };
      const marker = `LIVE_SETTINGS_${randomUUID().replaceAll("-", "")}`;
      const threadId = await fixture.submit(workspace.id, target,
        `Write 192 numbered lines. Each line must include ${marker} and its line number. End with ${marker}_DONE. Do not use tools.`, "luna");
      await fixture.waitFor(async () => {
        const thread = await fixture.thread(threadId);
        return thread.runState === "running" && Object.values(thread.itemsById).some(item => item.kind === "assistant_message" && item.markdown.text.includes(marker));
      }, 50, 120_000);
      const claudeTarget = await fixture.addClaudeBackend({ executablePath: await realpath(executablePath), configDirectory: await realpath(configDirectory) });
      const claudeThread = await fixture.submit(workspace.id, claudeTarget, `Reply with exactly ${marker}_CLAUDE. Use no tools.`, "haiku");
      await fixture.waitFor(async () => {
        const thread = await fixture.thread(claudeThread);
        return thread.runState === "idle" && Object.values(thread.itemsById).some(item => item.kind === "assistant_message" && item.markdown.text.includes(`${marker}_CLAUDE`));
      }, 150, 120_000);
      expect((await fixture.thread(threadId)).runState).toBe("running");
      await fixture.waitFor(async () => (await fixture.thread(threadId)).runState === "idle", 300, 180_000);
      const history = await fixture.thread(threadId);
      expect(Object.values(history.itemsById).some(item => item.kind === "assistant_message" && item.markdown.text.includes(`${marker}_DONE`))).toBe(true);
      expect(await fixture.serviceStatus()).toMatchObject({ serviceIncarnation: service!.serviceIncarnation, controllerEpoch: service!.controllerEpoch });
      expect((await stat(socket, { bigint: true })).ino).toBe(existing.ino);
    }, 360_000);

  it("keeps the same Claude worker and pending permission through outbound reconnect and main restart", async () => {
    const fixture = await OutboundFixture.create("offline");
    cleanups.push(() => fixture.close());
    await fixture.startMain();
    fixture.startConnector();
    await fixture.waitFor(async () => (await fixture.pairings()).registrations.length === 1);
    const pending = (await fixture.pairings()).registrations[0]!;
    expect(pending).toMatchObject({ state: "pending", connected: true });
    const accepted = acceptHostRegistrationResultSchema.parse(await fixture.json("/api/host-registrations/accept", "POST", {
      mutationId: randomUUID(), registrationId: pending.id, expectedRegistrationRevision: pending.revision,
      expectedConfigurationRevision: (await fixture.configuration()).revision, label: "Outbound Claude host", workspaceRoots: [fixture.workspace],
      operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files", "workspace_tools", "workspace_context", "workspace_skills", "composer_attachments", "agent_tools_cli"] },
    }));
    fixture.environmentId = accepted.pairing.executionEnvironmentId;
    await fixture.waitFor(async () => { try { await fixture.readBinding(); return true; } catch { return false; } });
    await fixture.waitFor(async () => (await fixture.snapshot()).environments.some(environment => environment.id === fixture.environmentId && environment.available));
    const original = await fixture.serviceStatus();
    const targetId = await fixture.addClaudeBackend();
    const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId, project: { kind: "new", name: "workspace" } }) as { id: string };
    const created = await fixture.json("/api/threads", "POST", { workspaceId: workspace.id, title: "Outbound Claude permission", executionWorkspace: { kind: "direct" }, configuration: { kind: "custom", targetId } }) as { threadId: string };
    let snapshot = await fixture.thread(created.threadId);
    expect(snapshot.thread.targetId).toBe(targetId);
    expect(snapshot.thread.backend.brand).toBe("claude");
    for (const settingId of ["model", "thinking_level"] as const) {
      const option = snapshot.capabilities.settings.find(setting => setting.id === settingId)?.options.find(option => option.available);
      expect(option, `Missing available ${settingId}`).toBeDefined();
      await fixture.json(`/api/threads/${created.threadId}/operations`, "POST", { kind: "perform", mutationId: randomUUID(), expectedThreadRevision: snapshot.thread.threadRevision, expectedSettingsRevision: snapshot.settings.revision, operation: { action: "set_setting", settingId, value: option!.value } });
      snapshot = await fixture.thread(created.threadId);
    }
    await fixture.json(`/api/threads/${created.threadId}/draft`, "PUT", { text: "[outbound-permission]", contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: snapshot.draft.revision });
    snapshot = await fixture.thread(created.threadId);
    await fixture.openThreadEvents(created.threadId);
    const delivery = await fixture.json(`/api/threads/${created.threadId}/operations`, "POST", { kind: "deliver", mode: "submit", mutationId: randomUUID(), expectedThreadRevision: snapshot.thread.threadRevision, expectedDraftRevision: snapshot.draft.revision });
    expect(delivery).toMatchObject({ status: "delivery_accepted" });
    // Open the bound runtime stream while the original draft viewer remains.
    await fixture.openThreadEvents(created.threadId);
    await fixture.waitFor(async () => (await fixture.thread(created.threadId)).interactions.length === 1, 250);
    const interaction = (await fixture.thread(created.threadId)).interactions[0]!;
    expect(interaction.kind).toBe("decision");
    const send = (await fixture.claudeEvents()).find(event => event.event === "send")!;
    expect(send).toBeDefined();
    expect((await fixture.claudeEvents()).filter(event => event.event === "permission_pending")).toHaveLength(1);

    await fixture.stopConnector();
    await fixture.waitFor(async () => !(await fixture.pairings()).pairings[0]!.connected);
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);
    process.kill(send.pid, 0);
    // Cross the client's one-second retry boundary: transient loss must not
    // acquire the meaning of an explicit operator Disconnect.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    process.kill(send.pid, 0);
    fixture.startConnector();
    await fixture.waitFor(async () => (await fixture.snapshot()).environments.some(environment => environment.id === fixture.environmentId && environment.available));
    await fixture.waitFor(async () => (await fixture.thread(created.threadId)).interactions.some(value => value.id === interaction.id), 250);
    expect((await fixture.claudeEvents()).filter(event => event.event === "send")).toEqual([send]);

    await fixture.stopMain();
    process.kill(send.pid, 0);
    await fixture.startMain();
    await fixture.waitFor(async () => (await fixture.snapshot()).environments.some(environment => environment.id === fixture.environmentId && environment.available));
    await fixture.openThreadEvents(created.threadId);
    await fixture.waitFor(async () => (await fixture.thread(created.threadId)).interactions.length === 1, 250);
    expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(original!.serviceIncarnation);
    expect((await fixture.pairings()).pairings[0]!.id).toBe(accepted.pairing.id);
    snapshot = await fixture.thread(created.threadId);
    // Browser decision IDs are scoped to the current broker; the provider's
    // query/PID and one send marker prove recovery of the same native request.
    const restored = snapshot.interactions[0]!;
    expect(restored).toMatchObject({ kind: interaction.kind, title: interaction.title });
    if (restored.kind !== "decision") throw new Error("fixture_permission_not_decision");
    const allow = restored.actions.find(action => action.role === "primary")!;
    expect(allow).toBeDefined();
    await fixture.json(`/api/threads/${created.threadId}/operations`, "POST", { kind: "respond", operationId: randomUUID(), interactionId: restored.id, response: { kind: "decision", selectedActionId: allow.id } });
    await fixture.waitFor(async () => (await fixture.thread(created.threadId)).runState === "idle" && (await fixture.claudeEvents()).some(event => event.event === "result" && event.queryId === send.queryId), 250);
    expect(JSON.stringify((await fixture.thread(created.threadId)).itemsById)).toContain("Offline permission approved.");
    const events = await fixture.claudeEvents();
    expect(events.filter(event => event.event === "send")).toEqual([send]);
    expect(events.filter(event => event.event === "permission_resolved")).toEqual([expect.objectContaining({ pid: send.pid, queryId: send.queryId, sessionId: send.sessionId, behavior: "allow" })]);
    expect(events.filter(event => event.event === "query_close" && event.queryId === send.queryId)).toHaveLength(0);
    expect(fixture.threadStreamErrors).toEqual([]);
    const cancelThread = vi.spyOn(ViewedImageCaptureService.prototype, "cancelThread");
    const stopRuntimes = vi.spyOn(ThreadRuntimeCoordinator.prototype, "runWithRuntimesStopped");
    cleanups.push(async () => { cancelThread.mockRestore(); stopRuntimes.mockRestore(); });
    await fixture.stopBackend("outbound-claude-backend");
    // Stop fences the thread's viewed-image captures before its provider effect runs.
    const fencedAt = cancelThread.mock.invocationCallOrder.find((_order, index) =>
      cancelThread.mock.calls[index]![1] === created.threadId);
    expect(fencedAt).toBeLessThan(stopRuntimes.mock.invocationCallOrder[0]!);
  }, 120_000);

  it("shows Codex turns that ran or ended while main was down without a client opening their threads", async () => {
    const fixture = await OutboundFixture.create("offline");
    cleanups.push(() => fixture.close());
    await fixture.startBusyHost("outbound");
    const targetId = await fixture.addCodexBackend();
    const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId,
      project: { kind: "new", name: "Restart recovery" } }) as { id: string };
    const codex = fixture.codex!;
    // After each restart only the application snapshot is read: a sidebar
    // read never opens a thread, so any running or unread state comes from
    // main's own recovery of the unresolved submission.
    const summary = async (threadId: string) => (await fixture.snapshot()).threads.find(thread => thread.id === threadId);
    const turnStarts = () => codex.requests.filter(request => request.method === "turn/start");

    // A turn still running in the retained provider shows as running again.
    const running = await fixture.submit(workspace.id, targetId, "Keep running while main restarts.");
    await fixture.waitFor(async () => (await fixture.thread(running)).runState === "running");
    await fixture.stopMain();
    expect(codex.activeTurnConnected).toBe(true);
    await fixture.startMain();
    await fixture.waitFor(async () => (await summary(running))?.runState === "running");
    expect((await summary(running))?.attention.unseenCompletion).toBe(false);
    codex.completeTurn();
    await fixture.waitFor(async () => {
      const thread = await summary(running);
      return thread?.runState === "idle" && thread.attention.unseenCompletion;
    });
    expect(turnStarts()).toHaveLength(1);

    // A turn that ends while main is away becomes an unread completion.
    const ended = await fixture.submit(workspace.id, targetId, "Finish while main is down.");
    await fixture.waitFor(async () => (await fixture.thread(ended)).runState === "running");
    await fixture.stopMain();
    expect(codex.activeTurnConnected).toBe(true);
    codex.completeTurn();
    await fixture.startMain();
    await fixture.waitFor(async () => (await summary(ended))?.attention.unseenCompletion === true);
    expect(await summary(ended)).toMatchObject({ runState: "idle", attention: { unseenCompletion: true } });
    expect(await summary(running)).toMatchObject({ runState: "idle", attention: { unseenCompletion: true } });
    // Recovery observes the provider; it never resubmits or reconnects it.
    expect(turnStarts()).toHaveLength(2);
    expect(codex.requests.filter(request => request.method === "initialize")).toHaveLength(1);
    expect(codex.errors).toEqual([]);
  }, 120_000);
});

class OutboundFixture {
  sshServer?: Awaited<ReturnType<typeof startProductionSshServer>>;
  application: RunningApplication | undefined;
  connector: ChildProcess | undefined;
  codex: OutboundCodexFixture | undefined;
  readonly codexFixtures: OutboundCodexFixture[] = [];
  environmentId = "";
  readonly terminalIds: string[] = [];
  readonly terminalProducerId = randomUUID();
  readonly viewers = new Set<WebSocket>();
  readonly threadStreams = new Set<AbortController>();
  readonly threadStreamTasks = new Set<Promise<void>>();
  readonly threadStreamErrors: string[] = [];
  readonly threadStreamDiagnostics: string[] = [];
  serviceScope: SidecarServiceScope | undefined;
  port = 0;
  logs = "";
  readonly authentication: AuthenticationRepository;
  readonly credential: string;
  private enrolledConnector = false;
  private constructor(readonly directory: string, readonly hostHome: string, readonly workspace: string,
    readonly configurationPath: string, readonly stateDirectory: string, readonly connectorPath: string, readonly artifact: SidecarArtifactRegistration) {
      this.authentication = new AuthenticationRepository(stateDirectory);
      const pairing = this.authentication.createPairing({ kind: "management" });
      this.credential = this.authentication.exchangePairing({ token: pairing.token, clientName: "Outbound fixture", kind: "device" })!.credential;
    }
  get url() { return `http://127.0.0.1:${this.port}`; }
  static async create(worker: "release" | "offline" | "live" = "release") {
    // Keep the fake provider UDS short on macOS too; the host HOME remains
    // long enough to cover the old agent CLI endpoint length regression.
    const directory = await mkdtemp(path.join(await realpath("/tmp"), "sedes-out-prod-"));
    try {
      const hostHome = path.join(directory, "host");
      const workspace = path.join(hostHome, "workspace");
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      await chmod(hostHome, 0o700);
      await writeFile(path.join(workspace, "example.txt"), "before\n");
      await mkdir(path.join(workspace, "extra"));
      await writeFile(path.join(workspace, "extra", "nested.txt"), "supplemental\n");
      await execFile("git", ["init", "--quiet", workspace]);
      await execFile("git", ["-C", workspace, "add", "."]);
      await execFile("git", ["-C", workspace, "-c", "user.name=Outbound Fixture", "-c", "user.email=fixture@example.test", "commit", "--quiet", "-m", "Fixture"]);
      const configurationPath = path.join(directory, "server.json");
      await writeFile(configurationPath, JSON.stringify({ schemaVersion: 11, packagedClients: [] }));
      const artifactDirectory = path.join(directory, "artifact");
      const artifact = worker !== "release" ? await (async () => {
        const { NODE_ENV: _nodeEnvironment, ...buildEnvironment } = process.env;
        const installed = worker === "live" ? await buildToolDisabledWorker(directory, path.join(directory, "claude-audit.jsonl")) : undefined;
        await execFile(process.execPath, ["tests/support/build-outbound-claude-sidecar-fixture.mjs", artifactDirectory, ...(installed ? [installed.executablePath] : [])], { cwd: process.cwd(), env: buildEnvironment, maxBuffer: 2 * 1024 * 1024 });
        return loadSidecarArtifactRegistration(path.join(artifactDirectory, "manifest.json"));
      })() : await buildProductionSidecarArtifact(artifactDirectory);
      const connectorPath = path.join(directory, "connector.mjs");
      await buildProductionOutboundConnector(connectorPath);
      return new OutboundFixture(directory, hostHome, workspace, configurationPath, path.join(directory, "main"), connectorPath, artifact);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async startBusyHost(carrier: "outbound" | "ssh") {
    const operations = { kind: "sidecar" as const, enabledCapabilities: ["interactive_terminal" as const] };
    if (carrier === "ssh") {
      const binDirectory = path.join(this.directory, "bin");
      await mkdir(binDirectory);
      this.sshServer = await startProductionSshServer({ directory: this.directory, binDirectory, remoteHome: this.hostHome });
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDirectory}${path.delimiter}${originalPath ?? ""}`;
      cleanups.push(async () => { if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath; });
      await this.startMain();
      const saved = await this.configuration();
      this.environmentId = randomUUID();
      const database = new Database(path.join(this.stateDirectory, "overlay.sqlite"), { readonly: true });
      try {
        this.serviceScope = { ...new SingleUserIdentityProvider(database).getScope(),
          installationId: deriveSidecarInstallationIdentity(await loadOrCreateToolProvenanceKey(this.stateDirectory)), executionEnvironmentId: this.environmentId };
      } finally { database.close(); }
      saved.configuration.executionEnvironments.push({ kind: "ssh", id: this.environmentId, label: "Disposable SSH host",
        hostAlias: "sedes-production-fixture", connectionCompression: true, workspaceRoots: [this.workspace], operations });
      await this.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: saved.revision, configuration: saved.configuration });
      await this.waitFor(async () => (await this.configuration()).runtimes.some(runtime =>
        runtime.resourceId === this.environmentId && runtime.supportedActions.includes("connect")));
      const current = await this.configuration();
      const environment = current.runtimes.find(runtime => runtime.resourceId === this.environmentId)!;
      if (environment.connectionState !== "connected") await this.json("/api/configuration/lifecycle", "POST", {
        mutationId: randomUUID(), resourceKind: "environment", resourceId: this.environmentId, action: "connect",
        expectedRevision: current.revision, expectedIncarnation: environment.incarnation, impactToken: null,
      });
    } else {
      await this.startMain();
      this.startConnector();
      await this.waitFor(async () => (await this.pairings()).registrations.length === 1);
      const pending = (await this.pairings()).registrations[0]!;
      const accepted = acceptHostRegistrationResultSchema.parse(await this.json("/api/host-registrations/accept", "POST", {
        mutationId: randomUUID(), registrationId: pending.id, expectedRegistrationRevision: pending.revision,
        expectedConfigurationRevision: (await this.configuration()).revision, label: "Disposable paired host", workspaceRoots: [this.workspace], operations,
      }));
      this.environmentId = accepted.pairing.executionEnvironmentId;
      await this.waitFor(async () => { try { await this.readBinding(); return true; } catch { return false; } });
    }
    await this.waitFor(async () => (await this.snapshot()).environments.some(environment => environment.id === this.environmentId && environment.available));
  }

  async submit(workspaceId: string, targetId: string, text: string, live?: "luna" | "haiku") {
    const created = await this.json("/api/threads", "POST", { workspaceId, title: text, executionWorkspace: { kind: "direct" },
      configuration: { kind: "custom", targetId } }) as { threadId: string };
    const route = `/api/threads/${created.threadId}`;
    let snapshot = await this.thread(created.threadId);
    for (const settingId of ["model", "thinking_level"] as const) {
      const options = snapshot.capabilities.settings.find(setting => setting.id === settingId)?.options.filter(option => option.available) ?? [];
      const option = options.find(option => !live || (settingId === "model"
        ? (live === "haiku" ? option.value === LIVE_CLAUDE_MODEL : decodeCodexModelSetting(option.value).modelId === "gpt-5.6-luna")
        : option.value === "low"));
      if (!option) {
        if (live) throw new Error(`live_settings_missing_${settingId}`);
        continue;
      }
      await this.json(`${route}/operations`, "POST", { kind: "perform", mutationId: randomUUID(), expectedThreadRevision: snapshot.thread.threadRevision,
        expectedSettingsRevision: snapshot.settings.revision, operation: { action: "set_setting", settingId, value: option.value } });
      snapshot = await this.thread(created.threadId);
    }
    await this.json(`${route}/draft`, "PUT", { text, contextExcerpts: [], attachmentIds: [], taskReferenceIds: [], expectedRevision: snapshot.draft.revision });
    snapshot = await this.thread(created.threadId);
    await this.openThreadEvents(created.threadId);
    const delivery = await this.json(`${route}/operations`, "POST", { kind: "deliver", mode: "submit", mutationId: randomUUID(),
      expectedThreadRevision: snapshot.thread.threadRevision, expectedDraftRevision: snapshot.draft.revision });
    expect(delivery, `Delivery: ${JSON.stringify(delivery)}; fixture: ${JSON.stringify(this.codex?.requests.map(request => request.method))} ${this.codex?.errors.map(String).join(",")}`).toMatchObject({ status: "delivery_accepted" });
    await this.openThreadEvents(created.threadId);
    return created.threadId;
  }
  async startMain() {
    this.application = await startProductionApplication({ ...process.env, APP_STATE_DIR: this.stateDirectory,
      SEDES_CONFIG_FILE: this.configurationPath, PORT: String(this.port) }, { sidecarArtifactRegistration: this.artifact, ...(this.sshServer ? { sidecarAccountHomeForTests: this.hostHome } : {}) });
    this.port = this.application.listening.port;
  }
  async addCodexBackend(id = "outbound-codex", liveSocket?: string) {
    const socketPath = liveSocket ?? path.join(this.hostHome, `${id}.sock`);
    if (!liveSocket) {
      const codex = await OutboundCodexFixture.start(socketPath, { codexHome: path.join(this.hostHome, `.${id}`), workspacePath: this.workspace });
      this.codex ??= codex;
      this.codexFixtures.push(codex);
    }
    const backendId = `${id}-backend`;
    const snapshot = await this.configuration();
    const configuration = snapshot.configuration;
    configuration.backends.push({ id: backendId, kind: "codex_app_server", label: id, enabled: true, modelPolicy: liveSocket ? { type: "allowlist", allowed: [{ modelIds: ["gpt-5.6-luna"], reasoningEfforts: ["low"] }] } : { type: "catalog" }, moduleConfiguration: {
      connection: { ownership: "external", channel: { type: "unix_websocket", socketPath } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["never"], allowedApprovalReviewers: ["user"] },
    } });
    configuration.targets.push({ id, kind: "codex_app_server", label: id, backendInstanceId: backendId, executionEnvironmentId: this.environmentId, enabled: true, moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", model: liveSocket ? { type: "fixed", modelId: "gpt-5.6-luna" } : { type: "catalogDefault" } } } });
    configuration.defaultTargetId = id;
    await this.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await this.waitFor(async () => (await this.snapshot()).executionTargets.some(target => target.backendInstanceId === backendId && target.available));
    return (await this.snapshot()).executionTargets.find(target => target.backendInstanceId === backendId && target.available)!.id;
  }
  async addClaudeBackend(live?: { executablePath: string; configDirectory: string }) {
    const configDirectory = live?.configDirectory ?? path.join(this.hostHome, "claude-config");
    const executablePath = live?.executablePath ?? path.join(this.hostHome, "claude-fixture");
    if (!live) {
      await mkdir(configDirectory, { mode: 0o700 });
      // Only the documented version/auth commands are supplied by this executable.
      await writeFile(executablePath, `#!${process.execPath}
if (process.argv.slice(2).join(" ") === "--version") console.log("2.1.287 (Claude Code)");
else if (process.argv.slice(2).join(" ") === "auth status --json") console.log(JSON.stringify(${JSON.stringify(OUTBOUND_CLAUDE_AUTH_STATUS)}));
else process.exit(64);
`, { mode: 0o700 });
    }
    const snapshot = await this.configuration();
    const configuration = snapshot.configuration;
    configuration.backends.push({ id: "outbound-claude-backend", kind: "claude_agent_sdk", label: "Remote Claude", enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      executablePath, configDirectory, initializationTimeoutMs: live ? 30_000 : 10_000, permissionPolicy: { allowedModes: [live ? "dontAsk" : "default"] },
    } });
    configuration.targets.push({ id: "outbound-claude", kind: "claude_agent_sdk", label: "Remote Claude fixture", backendInstanceId: "outbound-claude-backend", executionEnvironmentId: this.environmentId, enabled: true, moduleConfiguration: { defaults: { permissionMode: live ? "dontAsk" : "default" } } });
    configuration.defaultTargetId = "outbound-claude";
    await this.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await this.waitFor(async () => {
      const state = await this.snapshot();
      return state.executionTargets.some(target => target.id === state.defaultNewThreadTargetId && target.backend.brand === "claude" && target.available);
    });
    return (await this.snapshot()).defaultNewThreadTargetId!;
  }
  async claudeEvents(): Promise<OutboundClaudeFixtureEvent[]> {
    const content = await readFile(path.join(this.hostHome, "claude-config", ".outbound-claude-events.jsonl"), "utf8").catch(() => "");
    return parseCompleteClaudeEvents(content);
  }
  async thread(threadId: string) { return normalizedThreadSnapshotSchema.parse(await this.json(`/api/threads/${threadId}?activityDetail=full`)); }
  async stopBackend(resourceId = "outbound-codex-backend") {
    for (let attempt = 0; attempt < 3; attempt++) {
      const expectedRevision = (await this.configuration()).revision;
      const identity = { resourceKind: "backend", resourceId, action: "stop", expectedRevision };
      const impact = configurationLifecycleImpactSchema.parse(await this.json("/api/configuration/lifecycle/impact", "POST", identity));
      const mutationId = randomUUID();
      const result = configurationLifecycleResultSchema.parse(await this.json("/api/configuration/lifecycle", "POST", { ...identity, mutationId, expectedIncarnation: impact.incarnation, impactToken: impact.token }));
      expect(await this.json(`/api/configuration/lifecycle/${mutationId}`)).toEqual(result);
      if (result.state === "rejected") continue;
      expect(result.state, JSON.stringify({ result, service: result.state === "applied" ? undefined : await this.serviceStatus(), claudeEvents: result.state === "applied" ? undefined : (await this.claudeEvents()).filter(event => event.sendCount > 0) })).toBe("applied");
      return;
    }
    throw new Error("fixture_backend_stop_confirmation_unstable");
  }
  async openThreadEvents(threadId: string) {
    const controller = new AbortController();
    this.threadStreams.add(controller);
    const response = await fetch(`${this.url}/api/threads/${threadId}/events?activityDetail=full`, { signal: controller.signal, headers: { Authorization: `Bearer ${this.credential}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    // Keep the same runtime subscription a browser owns while its thread is open.
    // GET snapshots alone are ephemeral readers and do not retain live events.
    const task = (async () => { try {
      let pending = "";
      const decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > 2 * 1024 * 1024) throw new Error("fixture_thread_sse_frame_too_large");
        while (pending.includes("\n\n")) {
          const end = pending.indexOf("\n\n");
          const frame = pending.slice(0, end); pending = pending.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "))?.slice(6);
          if (data && frame.split("\n").includes("event: thread")) {
            const { event } = threadEventEnvelopeSchema.parse(JSON.parse(data));
            const detail = event.type === "snapshot" ? { type: event.type, runState: event.snapshot.runState, interactions: event.snapshot.interactions } : event;
            this.threadStreamDiagnostics.push(JSON.stringify(detail).slice(0, 2000));
            if (this.threadStreamDiagnostics.length > 32) this.threadStreamDiagnostics.shift();
          } else if (data && frame.includes("event: thread-load-error")) {
            throw new Error(`fixture_thread_stream_load_failed: ${data.slice(0, 2000)}`);
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        this.threadStreamErrors.push(String(error).slice(0, 2000));
        if (this.threadStreamErrors.length > 16) this.threadStreamErrors.shift();
      }
    } finally { reader.releaseLock(); this.threadStreams.delete(controller); } })();
    const tracked = task.finally(() => { this.threadStreamTasks.delete(tracked); });
    this.threadStreamTasks.add(tracked);
  }
  async closeThreadEvents() {
    for (const controller of this.threadStreams) controller.abort();
    this.threadStreams.clear();
    await Promise.all([...this.threadStreamTasks]);
  }
  async stopMain() { await this.closeThreadEvents(); const application = this.application; this.application = undefined; await application?.close(); }
  startConnector(resumePairing = false) {
    if (this.connector) throw new Error("fixture_connector_already_running");
    const enrollment = !this.enrolledConnector || resumePairing ? ["--pairing-code", this.authentication.createPairing({ kind: "sidecar" }).token] : [];
    this.enrolledConnector = true;
    const child = spawn(process.execPath, [this.connectorPath, "connect", "--server", this.url, "--state-directory", path.join(this.hostHome, "connector"), ...enrollment, ...(resumePairing ? ["--resume-pairing"] : [])],
      { env: { ...process.env, HOME: this.hostHome, USERPROFILE: this.hostHome }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", data => { this.logs += data.toString(); });
    child.stderr?.on("data", data => { this.logs += data.toString(); });
    this.connector = child;
  }
  async stopConnector() {
    const child = this.connector; this.connector = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  async request(route: string, method = "GET", body?: unknown) {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.credential}` };
    if (method !== "GET") {
      const session = normalizedApplicationSessionSchema.parse(await (await fetch(`${this.url}/api/application/session`, { headers })).json());
      headers["X-CSRF-Token"] = session.csrfToken; headers["Content-Type"] = "application/json";
    }
    return fetch(`${this.url}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15_000) });
  }
  async json(route: string, method = "GET", body?: unknown): Promise<unknown> {
    const response = await this.request(route, method, body);
    const value: unknown = await response.json();
    expect([200, 201], `${route}: ${response.status} ${JSON.stringify(value)}\nConnector: ${this.logs}\nThread SSE: ${this.threadStreamDiagnostics.join("\n")}\nClaude: ${JSON.stringify((await this.claudeEvents()).filter(event => !["startup_probe", "query_open", "query_close"].includes(event.event)))}`).toContain(response.status);
    return value;
  }
  async pairings() { return hostPairingListSchema.parse(await this.json("/api/host-registrations")); }
  async configuration() { return configurationSnapshotSchema.parse(await this.json("/api/configuration")); }
  async snapshot() { return normalizedApplicationSnapshotSchema.parse(await this.json("/api/application/snapshot")); }
  async readBinding() {
    const value = JSON.parse(await readFile(path.join(this.hostHome, "connector", "identity.json"), "utf8")) as { binding: { scope: SidecarServiceScope } };
    this.serviceScope = value.binding.scope;
  }
  async serviceStatus() {
    if (!this.serviceScope) return undefined;
    return inspectAtEndpoint(persistentSidecarPaths(this.hostHome, process.getuid!(), this.serviceScope).endpointPath, this.serviceScope);
  }
  async waitFor(predicate: () => Promise<boolean>, pollMilliseconds = 50, timeoutMilliseconds = 20_000) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, pollMilliseconds)); }
    throw new Error(`outbound_fixture_timeout\n${this.logs}\nThread SSE: ${this.threadStreamDiagnostics.join("\n")}\nThread stream errors: ${this.threadStreamErrors.join("\n")}\nCodex:${JSON.stringify(this.codex?.requests.slice(-32).map(request => request.method))} Errors:${this.codex?.errors.map(String).join(", ")}\nService:${JSON.stringify(await this.serviceStatus())}\nSnapshot:${JSON.stringify(await this.snapshot())}\n${JSON.stringify(await this.configuration())}`);
  }
  async close() {
    const failures: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>) => {
      try { await step(); } catch (error) { failures.push(error); }
    };
    await this.readBinding().catch(() => undefined);
    for (const socket of this.viewers) socket.terminate();
    if (this.application) for (const id of this.terminalIds) {
      try {
        const current = terminalResourceSchema.parse(await this.json(`/api/terminals/${id}`));
        await this.json(`/api/terminals/${id}/actions/end`, "POST", { mutationId: randomUUID(), expectedRevision: current.lifecycleRevision });
      } catch { /* Already ended terminals have no live owned process. */ }
    }
    await attempt(() => this.stopConnector());
    await attempt(() => this.stopMain());
    const scope = this.serviceScope;
    if (scope) await attempt(async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
      const status = await this.serviceStatus();
      if (!status || status.state === "stopped") break;
      {
        const stream = sidecarSocketByteStream(connect(persistentSidecarPaths(this.hostHome, process.getuid!(), scope).endpointPath));
        try {
          const requestId = randomUUID();
          await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId, scope, operation: "stop",
            expectedServiceIncarnation: status.serviceIncarnation, controllerEpoch: status.controllerEpoch,
            expectedConfiguration: status.desiredConfiguration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true });
          const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(5_000));
          if (response.value.outcome === "ok") break;
          if (response.value.outcome !== "error" || response.value.code !== "sidecar_service_confirmation_stale" || attempt === 19) throw new Error(`fixture_stop_failed:${JSON.stringify(response.value)}`);
        } finally { await stream.close("fixture_cleanup"); }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      }
    });
    // A failed, unconfirmed, or never-attempted stop (the binding may not have
    // been written yet) must not leave the detached `sedes service daemon`
    // running with ppid 1: every fixture process runs from this directory.
    await attempt(() => terminateProcessesReferencing(this.directory));
    if (scope) await attempt(() => rm(persistentSidecarPaths(this.hostHome, process.getuid!(), scope).socketDirectory, { recursive: true, force: true }));
    if (this.sshServer) await attempt(() => terminateChild(this.sshServer!.child));
    for (const codex of this.codexFixtures) await attempt(() => codex.close());
    await attempt(async () => this.authentication.close());
    await attempt(() => rm(this.directory, { recursive: true, force: true }));
    if (failures.length > 0) throw failures[0];
  }
}

async function rejectUnissuedRuntime(url: string, credential: string): Promise<boolean> {
  const socket = new WebSocket(url.replace("http:", "ws:") + OUTBOUND_RUNTIME_PATH, [OUTBOUND_RUNTIME_PROTOCOL, "x".repeat(43)], { headers: { Authorization: `Bearer ${credential}` } });
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 5_000);
    socket.once("open", () => { clearTimeout(timer); socket.close(); resolve(false); });
    socket.once("error", () => { clearTimeout(timer); resolve(true); });
  });
}

class TerminalViewer {
  output = "";
  readonly frames: TerminalServerFrame[] = [];
  private lastSentInputSeq = 0;
  private constructor(readonly fixture: OutboundFixture, readonly socket: WebSocket, readonly terminal: TerminalResource, readonly producerId: string) {}
  static async open(fixture: OutboundFixture, terminal: TerminalResource): Promise<TerminalViewer> {
    const deadline = Date.now() + 20_000;
    // A host becomes reachable before its retained terminal finishes
    // controller recovery; browser clients obtain a fresh admission on retry.
    while (true) {
      const viewer = await TerminalViewer.attempt(fixture, terminal);
      if (viewer.frames.some(frame => frame.type === "caught_up")) return viewer;
      await viewer.close();
      if (Date.now() >= deadline) throw new Error(`terminal_attach_failed:${fixture.logs}:${JSON.stringify(viewer.frames)}`);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  private static async attempt(fixture: OutboundFixture, terminal: TerminalResource) {
    const producerId = fixture.terminalProducerId;
    const admission = terminalAdmissionSchema.parse(await fixture.json(`/api/terminals/${terminal.terminalId}/admissions`, "POST", { producerId, requestedRole: "controller", emulator: { family: "ghostty-web", version: "0.4.0", unicodeVersion: "11", restoreFormat: "ansi-checkpoint-v1" }, restore: { kind: "checkpoint" } }));
    const socket = new WebSocket(fixture.url.replace("http:", "ws:") + TERMINAL_WEBSOCKET_PATH, [TERMINAL_WEBSOCKET_PROTOCOL, admission.token], { origin: fixture.url, headers: { Authorization: `Bearer ${fixture.credential}`, "Sec-Fetch-Mode": "websocket", "Sec-Fetch-Site": "same-origin" } });
    const viewer = new TerminalViewer(fixture, socket, terminal, producerId);
    fixture.viewers.add(socket);
    socket.once("close", (code, reason) => { fixture.viewers.delete(socket); fixture.logs += `terminal_close:${code}:${reason.toString()}\n`; });
    socket.on("message", (data, binary) => {
      const frame = binary ? (() => { const decoded = decodeTerminalBinaryFrame(Buffer.from(data as Buffer)); return terminalServerFrameSchema.parse({ ...(decoded.header as object), data: Buffer.from(decoded.payload).toString("base64url") }); })() : terminalServerFrameSchema.parse(JSON.parse(data.toString()));
      viewer.frames.push(frame);
      if (frame.type === "output" || frame.type === "snapshot_chunk") viewer.output += Buffer.from(frame.data, "base64url").toString();
      if (frame.type === "snapshot_chunk") viewer.send({ type: "ack_snapshot", checkpointSeq: frame.checkpointSeq, chunkIndex: frame.chunkIndex });
      if (frame.type === "output") viewer.send({ type: "ack_output", appliedSeq: frame.seq });
    });
    socket.on("error", error => { fixture.logs += `terminal:${error.message}\n`; });
    try { await fixture.waitFor(async () => socket.readyState === WebSocket.CLOSED || viewer.frames.some(frame => frame.type === "caught_up")); }
    catch (error) { throw new Error(`terminal_attach_failed:${JSON.stringify(viewer.frames)}`, { cause: error }); }
    return viewer;
  }
  send(frame: object) { this.socket.send(JSON.stringify({ v: 2, terminalId: this.terminal.terminalId, incarnationId: this.terminal.incarnationId, ...frame })); }
  async command(command: string) {
    const control = this.frames.findLast(frame => frame.type === "attached" || frame.type === "control_changed");
    if (!control || !("controllerEpoch" in control)) throw new Error("fixture_terminal_no_control");
    const inputSeq = Math.max(this.lastSentInputSeq, control.lastAcceptedInputSeq) + 1;
    this.lastSentInputSeq = inputSeq;
    this.socket.send(encodeTerminalBinaryFrame("input", { v: 2, type: "input", terminalId: this.terminal.terminalId, incarnationId: this.terminal.incarnationId, controllerEpoch: control.controllerEpoch, producerId: this.producerId, inputSeq }, Buffer.from(command)));
    await this.fixture.waitFor(async () => this.frames.some(frame => frame.type === "input_result" && frame.inputSeq === inputSeq));
    expect(this.frames.find(frame => frame.type === "input_result" && frame.inputSeq === inputSeq), this.fixture.logs).toMatchObject({ type: "input_result", inputSeq, outcome: "accepted" });
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>(resolve => this.socket.once("close", () => resolve()));
    this.socket.close();
    await closed;
  }
}
