import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeHostAgentTools } from "../../src/server/backends/opencode/opencode-host-agent-tools.js";
import { callOpenCodeRemoteRuntime } from "../../src/server/backends/opencode/opencode-remote-runtime.js";
import { createPersistentOpenCodeFixture } from "../helpers/persistent-opencode-fixture.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(openCodeTools = true) {
  const f = createPersistentOpenCodeFixture(); cleanups.push(() => f.close());
  const carrier = await f.attach({ openCodeTools }), client = f.client(); await client.start();
  const owner = f.owners[0]!;
  const tools = new OpenCodeHostAgentTools({ adapter: f.adapter,
    cli: () => ({ endpoint: "unix:///execution-host/agent-tools.sock", executableDirectory: "/execution-host/bin" }),
    capture: target => owner.nativeHost.captureToolInvocation(target),
    invoke: async () => { throw new Error("no invocation expected"); }, assertCurrent: () => owner.assertCurrent() });
  cleanups.push(() => tools.close());
  const admit = vi.spyOn(tools, "admit");
  Object.assign(owner, { admitToolSession: tools.admit.bind(tools) });
  return { ...f, carrier, client, tools, admit, owner };
}
const admission = { sourceCapability: "mcp-source", catalog: [], cli: { sourceCapability: "cli-source", mode: "progressive" as const } };

describe("OpenCode sidecar tool admission", () => {
  it("reports the missing private relay without installing tools or losing native reads", async () => {
    const f = await fixture(false);
    const lease = f.client.acquire(f.target);
    await lease.client.read("getSession", { sessionID: f.wire.sessionID });
    await expect(f.client.admitToolSession(f.target, admission)).rejects.toMatchObject({ code: "opencode_tools_capability_unavailable" });
    expect(f.admit).not.toHaveBeenCalled();
    expect(f.wire.requests.some(request => request.method === "POST")).toBe(false);
    await expect(lease.client.read("getSession", { sessionID: f.wire.sessionID })).resolves.toMatchObject({ id: f.wire.sessionID });
    lease.release();
  });

  it("uses the admitted native host and returns opaque IDs with host-local CLI paths", async () => {
    const f = await fixture();
    const lease = f.client.acquire(f.target);
    await lease.client.read("getSession", { sessionID: f.wire.sessionID });
    const result = await f.client.admitToolSession(f.target, admission);
    expect(result.cliAdmissionId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(f.admit).toHaveBeenCalledOnce();
    expect(f.tools.cliEnvironment(f.target, result.cliAdmissionId!)).toMatchObject({
      executableDirectory: "/execution-host/bin", generated: { SEDES_AGENT_TOOL_ENDPOINT: "unix:///execution-host/agent-tools.sock" },
    });
    expect(JSON.stringify(result)).not.toContain("execution-host");
    expect(f.wire.requests.some(request => request.method === "POST")).toBe(false);
    f.client.releaseToolSession(f.target);
    expect(f.tools.ownsCliCapability("cli-source")).toBe(true);
  });

  it("rejects unbound, changed, stale-generation and recovery admissions before native tool effects", async () => {
    const f = await fixture();
    await expect(f.client.admitToolSession(f.target, admission)).rejects.toBeDefined();
    const lease = f.client.acquire(f.target);
    await lease.client.read("getSession", { sessionID: f.wire.sessionID });
    for (const target of [
      { ...f.target, directory: "/different" },
      { ...f.target, session: { ...f.target.session, applicationThreadId: "foreign" } },
      { ...f.target, session: { ...f.target.session, bindingFingerprint: "changed" } },
    ]) await expect(f.client.admitToolSession(target, admission)).rejects.toBeDefined();
    await expect(callOpenCodeRemoteRuntime(f.carrier.lease, { action: "tools_admit", runtimeId: f.client.runtimeId!,
      nativeGeneration: "stale", target: f.target, admission })).rejects.toBeDefined();
    await f.carrier.close(); await f.attach({ recovery: true });
    // Existing-only recovery never authorizes a fresh tool route.
    await f.client.startRetained();
    await expect(f.client.admitToolSession(f.target, admission)).rejects.toBeDefined();
    expect(f.admit).not.toHaveBeenCalled();
  });
});
