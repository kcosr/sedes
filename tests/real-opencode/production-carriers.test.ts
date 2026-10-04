import path from "node:path";
import { createOpenCodeRuntimeOwnershipLifecycle, inspectOpenCodeRuntimeOwner, type OpenCodeRuntimeOwnerTarget, type OpenCodeRuntimeOwnershipLease } from "../../src/server/backends/opencode/opencode-runtime-ownership.js";
import { shellQuote } from "../support/production-carrier-fixture.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import * as nativeIdentity from "../../src/server/backends/opencode/opencode-native-identity.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeProductionFixture, fixtureProcessAlive, type OpenCodeProductionTopology, type OpenCodeProductionOwnership } from "../support/opencode-production-fixture.js";
import { RUN_REAL_OPENCODE } from "../support/opencode-native-fixture.js";
import { productionOpenSshAvailable } from "../support/production-carrier-fixture.js";

const fixtures: OpenCodeProductionFixture[] = [];
afterEach(async () => { try { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); } finally { vi.restoreAllMocks(); } }, 90_000);
const cells = (["local", "ssh", "outbound"] as const).flatMap(topology => (["owned", "external"] as const).map(ownership => ({ topology, ownership })));

describe.skipIf(!RUN_REAL_OPENCODE || process.platform !== "linux")("stock OpenCode through production carriers", () => {
  for (const { topology, ownership } of cells) {
    it.skipIf(topology === "ssh" && !productionOpenSshAvailable)(`${topology}/${ownership}: Settings, Send, native history, model selection, reconnect, and ownership cleanup`, async () => {
      if (topology !== "local") {
        // Main and host share a UID in this container. Deny the main-side
        // native path/secret seams so namespace coincidence cannot pass.
        vi.spyOn(LocalEnvironmentChannelProvider.prototype, "resolveSecret").mockRejectedValue(new Error("fixture_main_secret_resolution_denied"));
        vi.spyOn(nativeIdentity, "readOpenCodeNativeIdentity").mockRejectedValue(new Error("fixture_main_native_identity_denied"));
      }
      const fixture = await OpenCodeProductionFixture.create(topology, ownership); fixtures.push(fixture);
      const pid = await fixture.nativePid();
      expect(await fixtureProcessAlive(pid)).toBe(true);
      if (topology !== "local") expect(await fixture.hostNodeVersion()).toBe(process.env.SEDES_REAL_OPENCODE_HOST_NODE_VERSION ?? process.version);
      const threadId = await fixture.createThread();
      const sent = await fixture.send(threadId, `first-${topology}-${ownership}`);
      expect(sent).toMatchObject({ status: "delivery_accepted" });
      await fixture.waitFor(async () => fixture.model.requests.some(request => request.lastText?.includes(`first-${topology}-${ownership}`)));
      await fixture.waitFor(async () => JSON.stringify((await fixture.thread(threadId)).itemsById).includes("Fixture response"));
      await fixture.waitFor(async () => (await fixture.thread(threadId)).runState === "idle");
      await assertBackendApplied(fixture);
      const first = await fixture.thread(threadId);
      const option = first.capabilities.settings.find(item => item.id === "model")?.options.find(item => item.available && item.label.text.includes("second-model"));
      expect(option).toBeDefined();
      if (!option) throw new Error("fixture_second_model_missing");
      await fixture.json(`/api/threads/${threadId}/operations`, "POST", { kind: "perform", mutationId: crypto.randomUUID(),
        expectedThreadRevision: first.thread.threadRevision, expectedSettingsRevision: first.settings.revision,
        operation: { action: "set_setting", settingId: "model", value: option.value } });
      await fixture.waitFor(async () => (await fixture.thread(threadId)).settings.values.some(item => item.id === "model" && item.effectiveValue === option.value));

      if (topology !== "local") await qualifyRetainedCarrier(fixture, threadId, topology, ownership, pid);
      else {
        await fixture.closeStreams();
        await fixture.openStream(threadId);
        expect(JSON.stringify((await fixture.thread(threadId)).itemsById)).toContain(`first-${topology}-${ownership}`);
      }
      if (topology === "outbound") await qualifyPersistedOutboundStartup(fixture, threadId, pid);
      await qualifyTools(fixture, threadId);
      await assertBackendApplied(fixture);
      if (topology === "outbound") {
        await fixture.closeStreams();
        await fixture.lifecycle("disconnect", "environment");
        expect(await fixtureProcessAlive(pid)).toBe(true);
        await fixture.lifecycle("stop", "environment");
        expect(fixture.lifecycleAttempts.at(-1)).toEqual({ action: "stop", attempts: 1 });
      } else await fixture.lifecycle(topology === "local" && ownership === "external" ? "disconnect" : "stop");
      if (ownership === "owned") await fixture.waitFor(async () => !(await fixtureProcessAlive(pid)));
      else {
        expect(await fixtureProcessAlive(pid)).toBe(true);
        expect((await fixture.native!.api("GET", "/api/info")).status).toBe(200);
      }
      expect(fixture.streamErrors).toEqual([]);
    }, 180_000);
  }

  it("outbound/external: a fenced runtime authority reports safe recovery guidance without replacing its owner or daemon", async () => {
    let held: OpenCodeRuntimeOwnershipLease | undefined;
    let ownerTarget: OpenCodeRuntimeOwnerTarget;
    let original: Awaited<ReturnType<typeof inspectOpenCodeRuntimeOwner>> | undefined;
    try {
      const fixture = await OpenCodeProductionFixture.create("outbound", "external", {
        waitReady: false,
        beforeBackend: async value => {
          const lifecycle = createOpenCodeRuntimeOwnershipLifecycle({
            authority: { tenantId: value.serviceScope!.tenantId, principalId: value.serviceScope!.principalId,
              executionEnvironmentId: value.environmentId, backendInstanceId: value.backendId },
            // The artifact installer admits HOME but not the connector's
            // provider-specific XDG overrides into the persistent host.
            ownershipDirectory: path.join(value.hostHome, ".local", "state", "sedes", "opencode-owners"),
            label: "Fixture-held external authority", ownership: "external", hostIncarnation: "fixture-held-owner" });
          ownerTarget = { authorityKey: lifecycle.authorityKey, ownershipDirectory: lifecycle.ownershipDirectory };
          held = await lifecycle.acquire();
          original = await inspectOpenCodeRuntimeOwner(ownerTarget);
        },
      });
      fixtures.push(fixture);
      // Saving configuration eagerly attempts startup and publishes the owner
      // fence. Administrative inspection must not replace its retained owner.
      await fixture.snapshot();
      await fixture.waitFor(async () => (await fixture.configuration()).runtimes.some(runtime =>
        runtime.resourceKind === "backend" && runtime.resourceId === fixture.backendId && runtime.connectionState === "recovery_required"));
      const configuration = await fixture.configuration();
      const runtime = configuration.runtimes.find(item => item.resourceKind === "backend" && item.resourceId === fixture.backendId)!;
      expect(runtime).toMatchObject({ connectionState: "recovery_required", applyState: "unavailable" });
      expect(runtime.lastError).toContain("sedes opencode-owner inspect --authority-key KEY");
      expect(runtime.lastError).toContain("leave external OpenCode daemons running");
      expect(runtime.lastError!.length).toBeLessThan(1_024);
      expect(JSON.stringify(configuration)).not.toContain(fixture.account.password);
      expect(JSON.stringify(configuration)).not.toContain(original!.record.token);
      expect(await inspectOpenCodeRuntimeOwner(ownerTarget!)).toEqual(original);
      expect(await fixtureProcessAlive(fixture.native!.pid)).toBe(true);
      expect((await fixture.native!.api("GET", "/api/info")).status).toBe(200);
      expect(fixture.model.requests).toHaveLength(0);
      // Legitimate release by the fixture owner models completed host repair.
      // Explicit Connect retries startup after repair. A Settings inspection
      // does not acquire an owner or register a failed backend module.
      await held!.release(); held = undefined;
      await fixture.lifecycle("connect");
      await fixture.waitReady();
      const recovered = (await fixture.configuration()).runtimes.find(item => item.resourceKind === "backend" && item.resourceId === fixture.backendId)!;
      expect(recovered).toMatchObject({ connectionState: "connected", applyState: "applied" });
      expect(recovered.lastError).toBeNull();
      expect(await fixture.nativePid()).toBe(fixture.native!.pid);
      expect(await fixtureProcessAlive(fixture.native!.pid)).toBe(true);
      expect((await fixture.native!.api("GET", "/api/info")).status).toBe(200);
      expect(fixture.model.requests).toHaveLength(0);
    } finally { await held?.release(); }
  }, 90_000);
});

async function assertBackendApplied(fixture: OpenCodeProductionFixture) {
  await fixture.waitFor(async () => (await fixture.configuration()).runtimes.some(runtime =>
    runtime.resourceKind === "backend" && runtime.resourceId === fixture.backendId &&
    runtime.connectionState === "connected" && runtime.applyState === "applied"));
  const runtime = (await fixture.configuration()).runtimes.find(item => item.resourceKind === "backend" && item.resourceId === fixture.backendId)!;
  expect(runtime).toMatchObject({ connectionState: "connected", applyState: "applied", lastError: null,
    effectiveRevision: runtime.desiredRevision, startupEnvironmentPending: false });
}

async function qualifyRetainedCarrier(fixture: OpenCodeProductionFixture, threadId: string,
  topology: OpenCodeProductionTopology, ownership: OpenCodeProductionOwnership, pid: number) {
  await fixture.waitFor(async () => (await fixture.thread(threadId)).runState === "idle");
  const marker = `retained-${topology}-${ownership}`;
  const held = fixture.model.holdNextStream(marker);
  expect(["delivery_accepted", "delivery_queued"]).toContain((await fixture.send(threadId, marker) as { status: string }).status);
  let started = false; void held.started.then(() => { started = true; });
  await fixture.waitFor(async () => started);
  const service = await fixture.serviceStatus(); expect(service?.state).toBe("ready");
  // Settings Disconnect revokes the main attachment without retiring the native host.
  await fixture.lifecycle("disconnect");
  expect(await fixtureProcessAlive(pid)).toBe(true);
  held.release();
  const reconnectAction = ownership === "owned" ? "start" : "connect";
  await fixture.lifecycle(reconnectAction);
  // Detached inspection must not create failed transient actors which
  // invalidate every fresh confirmation of the unchanged native owner.
  expect(fixture.lifecycleAttempts.at(-1)).toEqual({ action: reconnectAction, attempts: 1 });
  await fixture.waitReady();
  expect(await fixture.nativePid()).toBe(pid);
  await fixture.closeStreams(); await fixture.openStream(threadId);
  await fixture.waitFor(async () => JSON.stringify((await fixture.thread(threadId)).itemsById).includes("PREFIXSUFFIX"));
  expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(service?.serviceIncarnation);
  // The actual connector or main-side SSH carrier is then destroyed, while its
  // resident service/native owner remains independently alive.
  if (topology === "outbound") {
    await fixture.stopConnector();
    expect(await fixtureProcessAlive(pid)).toBe(true);
    fixture.startConnector();
  } else {
    await fixture.stopMain();
    expect(await fixtureProcessAlive(pid)).toBe(true);
    await fixture.startMain();
  }
  await fixture.waitReady();
  await fixture.closeStreams(); await fixture.openStream(threadId);
  expect(await fixture.nativePid()).toBe(pid);
  expect(JSON.stringify((await fixture.thread(threadId)).itemsById)).toContain("PREFIXSUFFIX");
  expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(service?.serviceIncarnation);
  expect(fixture.model.requests.filter(request => request.lastText === marker && request.lastRole === "user")).toHaveLength(1);
}

async function qualifyPersistedOutboundStartup(fixture: OpenCodeProductionFixture, threadId: string, pid: number) {
  const service = await fixture.serviceStatus();
  const previousLifecycleAttempts = fixture.lifecycleAttempts.slice();
  await fixture.stopConnector();
  await fixture.stopMain();
  expect(await fixtureProcessAlive(pid)).toBe(true);
  // The persisted backend is enabled, but its connector cannot reconnect until
  // main is listening. Startup must expose HTTP without awaiting that backend.
  await fixture.startMain();
  expect(fixture.connector).toBeUndefined();
  const configuration = await fixture.configuration();
  expect(configuration.configuration.backends.find(backend => backend.id === fixture.backendId))
    .toMatchObject({ kind: "opencode", enabled: true });
  fixture.startConnector();
  await fixture.waitReady();
  await assertBackendApplied(fixture);
  expect(fixture.lifecycleAttempts).toEqual(previousLifecycleAttempts);
  expect(await fixture.nativePid()).toBe(pid);
  expect((await fixture.serviceStatus())?.serviceIncarnation).toBe(service?.serviceIncarnation);
  await fixture.closeStreams(); await fixture.openStream(threadId);
  expect(JSON.stringify((await fixture.thread(threadId)).itemsById)).toContain("PREFIXSUFFIX");
}

async function qualifyTools(fixture: OpenCodeProductionFixture, threadId: string) {
  await fixture.waitFor(async () => (await fixture.thread(threadId)).runState === "idle");
  const nativeTool = fixture.model.requests.flatMap(request => request.toolNames).find(name => name.endsWith("_sedes_read"));
  expect(nativeTool).toBeDefined();
  if (!nativeTool) throw new Error("fixture_native_mcp_not_ready");
  const mcpStart = fixture.model.requests.length;
  const mcp = fixture.model.callToolNextStream("qualified-mcp", nativeTool, { toolId: "thread.status", schemaVersion: 3, input: { threadId } });
  expect(["delivery_accepted", "delivery_queued"]).toContain((await fixture.send(threadId, "qualified-mcp") as { status: string }).status);
  let mcpCalled = false; void mcp.called.then(() => { mcpCalled = true; });
  await fixture.waitFor(async () => mcpCalled);
  await fixture.waitFor(async () => fixture.model.requests.slice(mcpStart).some(request => request.toolResults.some(result => hasThreadStatus(result, threadId))));
  await fixture.waitFor(async () => (await fixture.thread(threadId)).runState === "idle");
  const policy = (await fixture.thread(threadId)).agentTools;
  expect(policy.presentationOptions.some(option => option.surface === "cli")).toBe(true);
  await fixture.json(`/api/threads/${threadId}/operations`, "POST", {
    kind: "set_agent_tool_policy", mutationId: crypto.randomUUID(), expectedPolicyRevision: policy.revision,
    enabled: true, enabledToolIds: ["thread.status"], accessBoundary: "thread", presentation: { surface: "cli", mode: "progressive" },
  });
  await fixture.closeStreams(); await fixture.openStream(threadId);
  const cliStart = fixture.model.requests.length;
  const command = fixture.ownership === "owned"
    ? `sedes tool invoke thread.status --input-json ${shellQuote(JSON.stringify({ threadId }))} --json`
    : `node -e ${shellQuote('process.stdout.write(JSON.stringify({fixtureExternalCliUnavailable: !process.env.SEDES_AGENT_TOOL_SOURCE_CAPABILITY && !process.env.SEDES_AGENT_TOOL_ENDPOINT}))')}`;
  const cli = fixture.model.callToolNextStream("qualified-cli", "shell", { command, workdir: fixture.workspace, timeout: 10_000 });
  expect(["delivery_accepted", "delivery_queued"]).toContain((await fixture.send(threadId, "qualified-cli") as { status: string }).status);
  let cliCalled = false; void cli.called.then(() => { cliCalled = true; });
  await fixture.waitFor(async () => cliCalled);
  await fixture.waitFor(async () => {
    const state = await fixture.thread(threadId);
    for (const interaction of state.interactions) {
      if (interaction.kind !== "decision") throw new Error("fixture_unexpected_cli_interaction");
      const allow = interaction.actions.find(action => action.role === "primary");
      if (!allow) throw new Error("fixture_cli_permission_missing");
      await fixture.json(`/api/threads/${threadId}/operations`, "POST", { kind: "respond", operationId: crypto.randomUUID(),
        interactionId: interaction.id, response: { kind: "decision", selectedActionId: allow.id } });
    }
    return fixture.model.requests.slice(cliStart).some(request => request.toolResults.some(result => fixture.ownership === "owned"
      ? hasThreadStatus(result, threadId) : hasExternalCliAbsence(result)));
  });
  await fixture.waitFor(async () => (await fixture.thread(threadId)).runState === "idle");
  if (fixture.ownership === "external") expect(fixture.streamText).toContain("CLI requires a Sedes-created root on an owned server");
}

function hasExternalCliAbsence(value: string): boolean {
  // Native shell tool output is a text envelope; the marker carries no secret.
  return value.includes('"fixtureExternalCliUnavailable":true') || value.includes('\\"fixtureExternalCliUnavailable\\":true');
}

function hasThreadStatus(value: unknown, threadId: string, depth = 0): boolean {
  if (depth > 8 || value === null) return false;
  if (typeof value === "string") {
    try { return hasThreadStatus(JSON.parse(value), threadId, depth + 1); } catch { return false; }
  }
  if (Array.isArray(value)) return value.some(item => hasThreadStatus(item, threadId, depth + 1));
  if (typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  return (object.threadId === threadId && object.backend === "opencode") || Object.values(object).some(item => hasThreadStatus(item, threadId, depth + 1));
}
