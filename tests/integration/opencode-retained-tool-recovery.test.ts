import { afterEach, describe, expect, it, vi } from "vitest";
import { createPersistentOpenCodeFixture } from "../helpers/persistent-opencode-fixture.js";
import type { OpenCodeMutationControl } from "../../src/server/backends/opencode/opencode-native-port.js";

const fixtures: ReturnType<typeof createPersistentOpenCodeFixture>[] = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); });
function fixture() { const value = createPersistentOpenCodeFixture(); fixtures.push(value); return value; }
const control = (id: string): OpenCodeMutationControl => ({
  identity: { origin: "application", applicationOperationId: id, operationKind: "submit", step: "prompt" }, deadlineAt: null,
});

describe("OpenCode retained tool owner recovery", () => {
  it("never creates a missing owner when enabled configuration requests retained startup", async () => {
    const f = fixture(); await f.attach();
    const client = f.client();
    await expect(client.startRetained()).rejects.toBeDefined();
    expect(f.acquireExisting).toHaveBeenCalledOnce();
    expect(f.acquireRecovery).not.toHaveBeenCalled();
    expect(f.provider.acquire).not.toHaveBeenCalled();
    expect(f.owners).toHaveLength(0);
    expect(f.wire.requests).toHaveLength(0);
  });

  it("promotes a retained attachment through current admission without creating another owner", async () => {
    const f = fixture(), first = await f.attach(), original = f.client(); await original.start();
    const initial = original.acquire(f.target);
    await initial.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_retained", text: "already running", delivery: "queue", resume: true }, control("retained"));
    await first.close(); await f.attach();
    const replacement = f.client(); await replacement.startRetained();
    const retained = replacement.acquire(f.target);
    await expect(retained.client.read("getSession", { sessionID: f.wire.sessionID })).resolves.toMatchObject({ id: f.wire.sessionID });
    const callsBefore = vi.mocked(f.provider.acquire).mock.calls.length;
    await replacement.start();
    expect(f.provider.acquire).toHaveBeenCalledTimes(callsBefore + 1);
    expect(f.owners).toHaveLength(1); expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    const current = replacement.acquire(f.target);
    await expect(current.client.mutate("prompt", { sessionID: f.wire.sessionID, id: "msg_promoted", text: "new work", delivery: "queue", resume: true }, control("promoted")))
      .resolves.toMatchObject({ id: "msg_promoted" });
    expect(f.promptCount()).toBe(2);
    current.release(); retained.release(); initial.release();
  });

  it("refuses ordinary promotion through a stale configuration carrier", async () => {
    const f = fixture(), first = await f.attach(), original = f.client(); await original.start();
    await first.close(); await f.attach({ recovery: true, environmentRevision: 2 });
    const replacement = f.client(); await replacement.startRetained();
    f.setNormalError(new Error("sidecar_revision_changed"));
    await expect(replacement.start()).rejects.toThrow("sidecar_revision_changed");
    expect(f.owners).toHaveLength(1); expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    expect(f.promptCount()).toBe(0);
  });

  it("refuses promotion when current configuration has disabled the retained native owner", async () => {
    const f = fixture(), first = await f.attach(), original = f.client(); await original.start();
    await first.close(); await f.attach();
    const replacement = f.client({ ...f.configuration, instance: { ...f.configuration.instance, enabled: false } });
    await replacement.startRetained();
    await expect(replacement.start()).rejects.toBeDefined();
    expect(f.owners).toHaveLength(1); expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    expect(f.promptCount()).toBe(0);
  });

  it("refuses changed native configuration before either retained or normal attachment", async () => {
    const f = fixture(), first = await f.attach(), original = f.client(); await original.start();
    await first.close(); await f.attach();
    const replacement = f.client({ ...f.configuration, configDirectory: "/changed/native/config" });
    await expect(replacement.startRetained()).rejects.toBeDefined();
    await expect(replacement.start()).rejects.toBeDefined();
    expect(f.owners).toHaveLength(1); expect(f.owners[0]!.start).toHaveBeenCalledOnce();
    expect(f.promptCount()).toBe(0);
  });
});
