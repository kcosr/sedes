import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeNativeHost } from "../../src/server/backends/opencode/opencode-native-host.js";
import type { OpenCodeNativePort } from "../../src/server/backends/opencode/opencode-native-port.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";

const clients: OpenCodeHttpClient[] = [];
afterEach(() => { for (const client of clients.splice(0)) client.close(); });
function fixture() {
  const wire = createOpenCodeApiFixture();
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: wire.fetch }); clients.push(client);
  const host = new OpenCodeNativeHost({ tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment",
    backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation" }, new OpenCodeHttpNativeAdapter(client), {
    assertCurrent: async () => {}, installSessionEnvironment: async () => { throw new Error("unexpected environment write"); },
    ensureMcpRegistration: async () => { throw new Error("unexpected MCP write"); },
  }, client.lifetime);
  const directory = host.acquire({ directory: wire.directory });
  const session = host.acquire({ directory: wire.directory, session: {
    applicationThreadId: "thread", nativeSessionID: wire.sessionID, bindingFingerprint: "binding",
  } });
  return { wire, client, host, directory, session };
}

const sessionReads: { name: string; read(port: OpenCodeNativePort): Promise<unknown> }[] = [
  { name: "history", read: port => port.read("getHistoryPage", { sessionID: "ses_foreign" }) },
  { name: "message", read: port => port.read("getMessage", { sessionID: "ses_foreign", messageID: "msg_foreign" }) },
  { name: "pending", read: port => port.read("getPending", { sessionID: "ses_foreign" }) },
  { name: "interactions", read: port => port.read("getInteractions", { sessionID: "ses_foreign" }) },
  { name: "permission", read: port => port.read("getPermission", { sessionID: "ses_foreign", requestID: "per_foreign" }) },
  { name: "form", read: port => port.read("getForm", { sessionID: "ses_foreign", formID: "frm_foreign" }) },
  { name: "native log", read: port => port.read("readLog", { sessionID: "ses_foreign" }) },
  { name: "activity", read: port => port.read("getActivity", { sessionID: "ses_foreign", directory: port.authority.directory }) },
];

describe("OpenCode native host authority", () => {
  it("admits creation preflight only after proving the returned workspace", async () => {
    const f = fixture();
    await expect(f.directory.read("getSession", { sessionID: f.wire.sessionID })).resolves.toEqual(f.wire.session);
    f.wire.session.location = { directory: "/another-workspace" };
    await expect(f.directory.read("getSession", { sessionID: f.wire.sessionID })).rejects.toMatchObject({ code: "opencode_session_location_changed" });
  });
  it.each(sessionReads)("refuses directory-only $name access before native I/O", async ({ read }) => {
    const f = fixture();
    await expect(read(f.directory)).rejects.toMatchObject({ code: "opencode_request_authority_mismatch" });
    expect(f.wire.requests).toEqual([]);
  });
  it("does not let a bound session create another session", async () => {
    const f = fixture();
    await expect(f.session.mutate("createSession", { id: "ses_foreign", location: { directory: f.wire.directory } },
      openCodeTestMutationControl("create"))).rejects.toMatchObject({ delivery: "not_sent", code: "opencode_request_authority_mismatch" });
    expect(f.wire.requests).toEqual([]);
  });
  it("keeps a completed effect unknown after owner loss instead of manufacturing a not-sent proof", async () => {
    const f = fixture(), control = openCodeTestMutationControl("interrupt");
    await expect(f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, control)).resolves.toEqual({ interrupted: true });
    f.host.close();
    await expect(f.session.mutate("interruptSession", { sessionID: f.wire.sessionID }, control))
      .rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(f.wire.requests.filter(request => request.pathname.endsWith("/interrupt"))).toHaveLength(1);
  });
});
