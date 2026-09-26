import { AuthenticationRepository } from "../../src/server/authentication/authentication-repository.js";
import { once } from "node:events";
import { execFile as execFileCallback, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import type { OutboundClaudeFixtureEvent } from "../support/outbound-claude-sdk-fixture.js";
import { normalizedThreadSnapshotSchema, threadEventEnvelopeSchema } from "../../src/shared/protocol/conversation.js";
import { OutboundCodexFixture } from "../support/outbound-codex-fixture.js";
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

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

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
    const forbidden = await fixture.request("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: pending.connectorId });
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
    const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId }) as { id: string };
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
    const created = await fixture.json("/api/threads", "POST", { workspaceId: workspace.id, title: "Outbound terminal fixture", executionWorkspace: { kind: "direct" }, configuration: { kind: "custom", targetId } }) as { threadId: string };
    const terminal = terminalMutationResultSchema.parse(await fixture.json(`/api/threads/${created.threadId}/terminals`, "POST", { mutationId: randomUUID(), displayName: "Retained shell", rows: 24, columns: 80 })).terminal!;
    fixture.terminalIds.push(terminal.terminalId);
    expect(terminal.lifecycle).toBe("running");
    let viewer = await TerminalViewer.open(fixture, terminal);
    await viewer.command("printf 'OUTBOUND_PID=%s\\n' \"$$\"\n");
    await fixture.waitFor(async () => /OUTBOUND_PID=[0-9]+/.test(viewer.output));
    const shellPid = /OUTBOUND_PID=([0-9]+)/.exec(viewer.output)![1]!;
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
    await fixture.stopBackend();
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

  it("keeps the same Claude worker and pending permission through outbound reconnect and main restart", async () => {
    const fixture = await OutboundFixture.create(true);
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
    const workspace = await fixture.json("/api/workspaces/open", "POST", { path: fixture.workspace, environmentId: fixture.environmentId }) as { id: string };
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
});

class OutboundFixture {
  application: RunningApplication | undefined;
  connector: ChildProcess | undefined;
  codex: OutboundCodexFixture | undefined;
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
  static async create(offlineClaude = false) {
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
      const { NODE_ENV: _nodeEnvironment, ...buildEnvironment } = process.env;
      await execFile(process.execPath, (offlineClaude ? ["tests/support/build-outbound-claude-sidecar-fixture.mjs", artifactDirectory] : ["scripts/build-sidecar.mjs", "--output-directory", artifactDirectory]), { cwd: process.cwd(), env: buildEnvironment, maxBuffer: 2 * 1024 * 1024 });
      const artifact = await loadSidecarArtifactRegistration(path.join(artifactDirectory, "manifest.json"));
      const connectorPath = path.join(directory, "connector.mjs");
      await build({ entryPoints: [path.resolve("src/server/sidecar/outbound-connector-main.ts")], outfile: connectorPath,
        bundle: true, platform: "node", format: "esm", target: "node22", packages: "bundle", logLevel: "silent",
        banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
        define: { __SEDES_CONNECTOR_VERSION__: JSON.stringify("production-test"), "process.env.WS_NO_BUFFER_UTIL": "true", "process.env.WS_NO_UTF_8_VALIDATE": "true" } });
      return new OutboundFixture(directory, hostHome, workspace, configurationPath, path.join(directory, "main"), connectorPath, artifact);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }
  async startMain() {
    this.application = await startProductionApplication({ ...process.env, APP_STATE_DIR: this.stateDirectory,
      SEDES_CONFIG_FILE: this.configurationPath, PORT: String(this.port) }, { sidecarArtifactRegistration: this.artifact });
    this.port = this.application.listening.port;
  }
  async addCodexBackend() {
    const socketPath = path.join(this.hostHome, "codex.sock");
    this.codex = await OutboundCodexFixture.start(socketPath, { codexHome: path.join(this.hostHome, ".codex"), workspacePath: this.workspace });
    const snapshot = await this.configuration();
    const configuration = snapshot.configuration;
    configuration.backends.push({ id: "outbound-codex-backend", kind: "codex_app_server", label: "Fake remote Codex", enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      connection: { ownership: "external", channel: { type: "unix_websocket", socketPath } },
      policy: { allowedSandboxModes: ["read-only"], allowedNetworkAccess: ["disabled"], allowedApprovalPolicies: ["never"], allowedApprovalReviewers: ["user"] },
    } });
    configuration.targets.push({ id: "outbound-codex", kind: "codex_app_server", label: "Remote fixture", backendInstanceId: "outbound-codex-backend", executionEnvironmentId: this.environmentId, enabled: true, moduleConfiguration: { defaults: { sandboxMode: "read-only", networkAccess: "disabled", approvalPolicy: "never", approvalReviewer: "user", model: { type: "catalogDefault" } } } });
    configuration.defaultTargetId = "outbound-codex";
    await this.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await this.waitFor(async () => (await this.snapshot()).executionTargets.some(target => target.environmentId === this.environmentId && target.available));
    return (await this.snapshot()).defaultNewThreadTargetId!;
  }
  async addClaudeBackend() {
    const configDirectory = path.join(this.hostHome, "claude-config");
    await mkdir(configDirectory, { mode: 0o700 });
    // Only documented version/auth commands are supplied by this executable;
    // the test SDK runs inside the real managed worker, without a live provider.
    const executablePath = path.join(this.hostHome, "claude-fixture");
    await writeFile(executablePath, `#!${process.execPath}
if (process.argv.slice(2).join(" ") === "--version") console.log("2.1.274 (Claude Code)");
else if (process.argv.slice(2).join(" ") === "auth status --json") console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "Claude Max" }));
else process.exit(64);
`, { mode: 0o700 });
    const snapshot = await this.configuration();
    const configuration = snapshot.configuration;
    configuration.backends.push({ id: "outbound-claude-backend", kind: "claude_agent_sdk", label: "Offline remote Claude", enabled: true, modelPolicy: { type: "catalog" }, moduleConfiguration: {
      executablePath, configDirectory, initializationTimeoutMs: 10_000, permissionPolicy: { allowedModes: ["default"] },
    } });
    configuration.targets.push({ id: "outbound-claude", kind: "claude_agent_sdk", label: "Remote Claude fixture", backendInstanceId: "outbound-claude-backend", executionEnvironmentId: this.environmentId, enabled: true, moduleConfiguration: { defaults: { permissionMode: "default" } } });
    configuration.defaultTargetId = "outbound-claude";
    await this.json("/api/configuration", "PUT", { mutationId: randomUUID(), expectedRevision: snapshot.revision, configuration });
    await this.waitFor(async () => {
      const state = await this.snapshot();
      return state.executionTargets.some(target => target.id === state.defaultNewThreadTargetId && target.available);
    });
    return (await this.snapshot()).defaultNewThreadTargetId!;
  }
  async claudeEvents(): Promise<OutboundClaudeFixtureEvent[]> {
    const content = await readFile(path.join(this.hostHome, "claude-config", ".outbound-claude-events.jsonl"), "utf8").catch(() => "");
    return content.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as OutboundClaudeFixtureEvent);
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
  async waitFor(predicate: () => Promise<boolean>, pollMilliseconds = 50) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, pollMilliseconds)); }
    throw new Error(`outbound_fixture_timeout\n${this.logs}\nThread SSE: ${this.threadStreamDiagnostics.join("\n")}\nCodex:${JSON.stringify(this.codex?.requests)} Errors:${JSON.stringify(this.codex?.errors)}\nService:${JSON.stringify(await this.serviceStatus())}\nSnapshot:${JSON.stringify(await this.snapshot())}\n${JSON.stringify(await this.configuration())}`);
  }
  async close() {
    await this.readBinding().catch(() => undefined);
    for (const socket of this.viewers) socket.terminate();
    if (this.application) for (const id of this.terminalIds) {
      try {
        const current = terminalResourceSchema.parse(await this.json(`/api/terminals/${id}`));
        await this.json(`/api/terminals/${id}/actions/end`, "POST", { mutationId: randomUUID(), expectedRevision: current.lifecycleRevision });
      } catch { /* Already ended terminals have no live owned process. */ }
    }
    await this.stopConnector();
    await this.stopMain();
    if (this.serviceScope) {
      const paths = persistentSidecarPaths(this.hostHome, process.getuid!(), this.serviceScope);
      for (let attempt = 0; attempt < 20; attempt++) {
      const status = await this.serviceStatus();
      if (!status || status.state === "stopped") break;
      {
        const stream = sidecarSocketByteStream(connect(paths.endpointPath));
        try {
          const requestId = randomUUID();
          await writeSidecarManagementRecord(stream, { managementVersion: 1, requestId, scope: this.serviceScope, operation: "stop",
            expectedServiceIncarnation: status.serviceIncarnation, controllerEpoch: status.controllerEpoch,
            expectedConfiguration: status.desiredConfiguration, expectedResourcesFingerprint: status.resourcesFingerprint, force: true });
          const response = await readSidecarManagementRecord(stream, sidecarManagementResponseSchema, AbortSignal.timeout(5_000));
          if (response.value.outcome === "ok") break;
          if (response.value.outcome !== "error" || response.value.code !== "sidecar_service_confirmation_stale" || attempt === 19) throw new Error(`fixture_stop_failed:${JSON.stringify(response.value)}`);
        } finally { await stream.close("fixture_cleanup"); }
      }
      await new Promise(resolve => setTimeout(resolve, 50));
      }
      await rm(paths.socketDirectory, { recursive: true, force: true });
    }
    await this.codex?.close();
    this.authentication.close();
    await rm(this.directory, { recursive: true, force: true });
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
    this.socket.send(encodeTerminalBinaryFrame("input", { v: 2, type: "input", terminalId: this.terminal.terminalId, incarnationId: this.terminal.incarnationId, controllerEpoch: control.controllerEpoch, producerId: this.producerId, inputSeq: control.lastAcceptedInputSeq + 1 }, Buffer.from(command)));
    await this.fixture.waitFor(async () => this.frames.some(frame => frame.type === "input_result"));
    expect(this.frames.filter(frame => frame.type === "input_result" || frame.type === "attached" || frame.type === "control_changed"), this.fixture.logs).toEqual(expect.arrayContaining([expect.objectContaining({ type: "input_result", outcome: "accepted" })]));
  }
  async close() {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    const closed = new Promise<void>(resolve => this.socket.once("close", () => resolve()));
    this.socket.close();
    await closed;
  }
}
