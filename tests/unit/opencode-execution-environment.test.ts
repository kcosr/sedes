import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeExecutionEnvironment } from "../../src/server/backends/opencode/opencode-execution-environment.js";
import { OpenCodeHttpClient } from "../../src/server/backends/opencode/opencode-http-client.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { environmentVariableOverridesSchema, type EnvironmentVariableOverrides } from "../../src/shared/protocol/environment-variables.js";
import { createOpenCodeApiFixture } from "../support/opencode-api-fixture.js";
import { createOpenCodeConversationFixture, scope, threadID } from "../support/opencode-conversation-fixture.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });
function fixture(definitions: EnvironmentVariableOverrides = { TEST_VALUE: { kind: "literal", value: "resolved" } }, ownership: "owned" | "external" = "owned") {
  const wire = createOpenCodeApiFixture(), effects: { kind: string; value: unknown }[] = [];
  const state = { loseAck: false, generation: "native-generation" };
  const client = new OpenCodeHttpClient({ endpoint: "http://127.0.0.1:4096", password: "fixture", fetch: async (value, init) => {
    const url = new URL(String(value)), method = init?.method ?? "GET";
    if (url.pathname === `/api/session/${wire.sessionID}` && method === "PATCH") {
      const body = JSON.parse(String(init?.body)); effects.push({ kind: "permissions", value: body });
      wire.session.permissions = body.permissions; return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/environment") && method === "PUT") {
      effects.push({ kind: "environment", value: JSON.parse(String(init?.body)) });
      if (state.loseAck) throw new Error("fixture dropped response");
      return new Response(null, { status: 204 });
    }
    return wire.fetch(value, init);
  } });
  const base = createOpenCodeConversationFixture({ native: { client, sessionID: wire.sessionID, directory: wire.directory } });
  const originalSnapshot = base.runtime.snapshot;
  base.runtime.snapshot = () => ({ ...originalSnapshot(), generation: state.generation, ownership });
  const resolve = vi.fn(async (_definitions: EnvironmentVariableOverrides) => ({ TEST_VALUE: "resolved" }));
  vi.mocked(base.hostHooks.installSessionEnvironment).mockImplementation(async (_authority, input, signal) => {
    const values = await resolve(input.definitions);
    signal.throwIfAborted();
    await base.adapter.setEnvironmentVariables({ sessionID: input.sessionID, variables: values }, signal);
  });
  const environment = new OpenCodeExecutionEnvironment({ scope, ownership, readDefinitions: () => definitions });
  const context = { ...base.context, executionEnvironment: environment };
  const prepare = (operation: "submit" | "steer" | "compact" = "submit", signal = new AbortController().signal) =>
    environment.prepare({ context, input: base.target, runtime: base.runtime, operation, signal, control: openCodeTestMutationControl() });
  closes.push(base.dispose);
  return { ...base, context, wire, effects, state, resolve, environment, prepare };
}

describe("OpenCode scoped execution environment", () => {
  it("preserves an imported empty snapshot without reading native state, adopting defaults, or resolving secrets", async () => {
    const f = fixture({});
    await f.prepare();
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.wire.requests.map(request => request.pathname)).toEqual(["/api/event"]); expect(f.effects).toEqual([]);
  });
  it("rejects nonempty external definitions before resolving secrets or acquiring native authority", async () => {
    const f = fixture({ TOKEN: { kind: "secret", source: { kind: "environment", name: "SOURCE_TOKEN" } } }, "external");
    await expect(f.prepare()).rejects.toMatchObject({ backendCode: "opencode_environment_unsupported" });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.wire.requests.map(request => request.pathname)).toEqual(["/api/event"]); expect(f.effects).toEqual([]);
  });
  it("installs an imported idle root map after preserving operator rules and proving child denial", async () => {
    const f = fixture(); f.wire.session.permissions = [{ action: "shell", resource: "*", effect: "ask" }];
    await f.prepare();
    expect(f.effects.map(item => item.kind)).toEqual(["permissions", "environment"]);
    expect(f.wire.session.permissions).toEqual([{ action: "shell", resource: "*", effect: "ask" }, { action: "subagent", resource: "*", effect: "deny" }]);
    expect(f.effects[1]!.value).toEqual({ variables: { TEST_VALUE: "resolved" } });
    expect(f.resolve).toHaveBeenCalledWith({ TEST_VALUE: { kind: "literal", value: "resolved" } });
  });
  it.each(["active", "pending", "shell", "child", "permission"])("does not install during native %s work", async kind => {
    const f = fixture();
    if (kind === "active") f.wire.setResponse("/api/session/active", 200, { data: { [f.wire.sessionID]: { type: "running" } } });
    if (kind === "pending") f.wire.setResponse(`/api/session/${f.wire.sessionID}/inbox`, 200, { data: [{ type: "user", id: "msg_pending", sessionID: f.wire.sessionID,
      payload: { text: "pending" }, delivery: "queue", time: { created: 1 } }] });
    if (kind === "shell") f.wire.setResponse("/api/shell", 200, { location: { directory: f.wire.directory }, data: [{ id: "sh_running", command: "work", cwd: f.wire.directory,
      shell: "/bin/sh", file: "/tmp/fixture.out", status: "running", metadata: { sessionID: f.wire.sessionID }, time: { started: 1 } }] });
    if (kind === "child") { f.wire.sessions.push({ ...f.wire.session, id: "ses_child", parentID: f.wire.sessionID });
      f.wire.setResponse("/api/session/active", 200, { data: { ses_child: { type: "running" } } }); }
    if (kind === "permission") f.wire.setResponse(`/api/session/${f.wire.sessionID}/permission`, 200, { data: [{ id: "per_pending", sessionID: f.wire.sessionID, action: "shell", resources: ["*"] }] });
    await expect(f.prepare()).rejects.toMatchObject({ backendCode: "opencode_environment_unavailable" }); expect(f.resolve).not.toHaveBeenCalled(); expect(f.effects).toEqual([]);
  });
  it("rejects child/fork injection before secret resolution", async () => {
    const f = fixture(); f.wire.session.parentID = "ses_parent";
    await expect(f.prepare()).rejects.toMatchObject({ backendCode: "opencode_environment_unsupported" });
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.effects).toEqual([]);
  });
  it("uses a previously installed incarnation for Steer without rotating secrets, but not after restart/release", async () => {
    const f = fixture();
    await expect(f.prepare("steer")).rejects.toMatchObject({ backendCode: "opencode_environment_unavailable" });
    await f.prepare(); await f.prepare("steer");
    expect(f.resolve).toHaveBeenCalledTimes(1); expect(f.effects.filter(effect => effect.kind === "environment")).toHaveLength(1);
    f.environment.release(threadID);
    await expect(f.prepare("steer")).rejects.toMatchObject({ backendCode: "opencode_environment_unavailable" });
    await f.prepare(); f.state.generation = "replacement";
    await expect(f.prepare("steer")).rejects.toMatchObject({ backendCode: "opencode_environment_unavailable" });
  });
  it("does not mark a lost PUT acknowledgement as installed and allows idempotent idle reinstallation", async () => {
    const f = fixture(); f.state.loseAck = true;
    await expect(f.prepare()).rejects.toBeDefined();
    await expect(f.prepare("steer")).rejects.toMatchObject({ backendCode: "opencode_environment_unavailable" });
    f.state.loseAck = false; await f.prepare(); await f.prepare("steer");
    expect(f.effects.filter(effect => effect.kind === "environment")).toHaveLength(2);
  });
  it("rejects wrong scope and cancelled preparation before native effects", async () => {
    const f = fixture();
    expect(() => f.environment.assertDefinitionSupport({ ...scope, principalId: "other" }, threadID)).toThrow();
    await expect(f.prepare("submit", AbortSignal.abort())).rejects.toBeDefined();
    expect(f.resolve).not.toHaveBeenCalled(); expect(f.effects).toEqual([]);
  });
  it("protects OpenCode identity/auth settings without prohibiting ordinary provider keys", () => {
    for (const key of ["OPENCODE_DB", "OPENCODE_CONFIG_DIR", "OPENCODE_PASSWORD", "OPENCODE_CONFIG_CONTENT", "SEDES_OPENCODE_MCP_CREDENTIAL"]) {
      expect(environmentVariableOverridesSchema.safeParse({ [key]: { kind: "literal", value: "x" } }).success).toBe(false);
    }
    expect(environmentVariableOverridesSchema.safeParse({ OPENAI_API_KEY: { kind: "literal", value: "fixture" }, OPENCODE_EXPERIMENTAL: { kind: "unset" } }).success).toBe(true);
  });
  it.each(["close", "release"] as const)("ends the caller wait without claiming an admitted host environment write was cancelled when %s ends preparation authority", async ending => {
    const f = fixture(); let finish!: (value: { TEST_VALUE: string }) => void;
    f.resolve.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const work = f.prepare(); const rejected = expect(work).rejects.toBeDefined();
    await vi.waitFor(() => expect(f.resolve).toHaveBeenCalledTimes(1));
    if (ending === "close") f.environment.close(); else f.environment.release(threadID);
    finish({ TEST_VALUE: "late-secret" }); await rejected;
    await vi.waitFor(() => expect(f.effects.map(effect => effect.kind)).toEqual(["permissions", "environment"]));
    expect(f.effects.at(-1)!.value).toEqual({ variables: { TEST_VALUE: "late-secret" } });
    if (ending === "close") {
      await expect(f.prepare()).rejects.toBeDefined(); expect(f.resolve).toHaveBeenCalledTimes(1);
    } else {
      await expect(f.prepare("steer")).rejects.toMatchObject({ backendCode: "opencode_environment_unavailable" });
      await f.prepare(); expect(f.hostHooks.installSessionEnvironment).toHaveBeenCalledTimes(2);
      expect(f.effects.at(-1)!.value).toEqual({ variables: { TEST_VALUE: "resolved" } });
    }
  });
});
