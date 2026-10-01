import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeHttpNativeAdapter } from "../../src/server/backends/opencode/opencode-http-native-adapter.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import * as ownedProcesses from "../../src/server/backends/opencode/opencode-owned-process.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import type { EnvironmentVariableOverrides } from "../../src/shared/protocol/environment-variables.js";
import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { RUN_REAL_OPENCODE } from "../support/opencode-native-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("installs complete isolated shell maps with cleanup ownership and reinjects after owned restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-env-"));
  const workspace = path.join(root, "workspace"), configDirectory = path.join(root, "config"), nativeStorePath = path.join(root, "store", "opencode.db");
  const environment: NodeJS.ProcessEnv = { HOME: path.join(root, "home"), PATH: process.env.PATH, SHELL: "/bin/sh",
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"), OPENCODE_DISABLE_FFF: "1", OPENCODE_FILEWATCHER_DISABLE: "1",
    INHERITED: "startup-fixed", REMOVE_ME: "remove", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "ambient-source-canary", SEDES_OPENCODE_MCP_CREDENTIAL: "ambient-bridge-canary" };
  const launched = vi.spyOn(ownedProcesses, "startOpenCodeOwnedProcess");
  const target = (sessionID: string) => ({ directory: workspace, session: { applicationThreadId: sessionID,
    nativeSessionID: sessionID, bindingFingerprint: configurationFingerprint(sessionID) } });
  let runtime: OpenCodeRuntime | undefined, cleaned = false;
  try {
    await Promise.all([workspace, configDirectory, environment.HOME!, path.dirname(nativeStorePath)].map(directory => mkdir(directory, { recursive: true })));
    await writeFile(environment.OPENCODE_MODELS_PATH!, "{}");
    await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({ update: "disable", permission: { shell: "allow" } }));
    const probe = path.join(workspace, "probe.mjs");
    await writeFile(probe, `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(['INHERITED','REMOVE_ME','EMPTY','TOKEN','PATH','OPENCODE_PASSWORD','OPENCODE_SERVER_PASSWORD','SEDES_AGENT_TOOL_SOURCE_CAPABILITY','SEDES_OPENCODE_MCP_CREDENTIAL','SEDES_OPENCODE_RUNTIME_OWNER'].map(key=>[key,process.env[key]??null]))));`);
    runtime = new OpenCodeRuntime({ ownershipDirectory: path.join(root, "owners"), hostIncarnation: "fixture-host", authority: { tenantId: "fixture", principalId: "fixture", backendInstanceId: "fixture", executionEnvironmentId: "local" },
      nativeStorePath, configDirectory, environment,
      agentTools: { cli: () => ({ endpoint: "http://127.0.0.1:4784", executableDirectory: "/fixture/helper" }),
        invoke: async () => { throw new Error("fixture has no tool calls"); } }, connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: workspace,
        executablePath: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2" } } });
    await runtime.start();
    let lease = runtime.acquire({ directory: workspace });
    const native = new OpenCodeNativeMutations(lease.client);
    await native.createSession({ id: "ses_environment_a", location: { directory: workspace }, title: "A" }, openCodeTestMutationControl("create-a"));
    await native.createSession({ id: "ses_environment_b", location: { directory: workspace }, title: "B" }, openCodeTestMutationControl("create-b"));
    const read = async (sessionID: string, filename: string) => {
      const output = path.join(workspace, filename);
      await (await (launched.mock.results.at(-1)!.value as ReturnType<typeof ownedProcesses.startOpenCodeOwnedProcess>)).client.call((client, signal) => client.session.shell({ sessionID, command: `${quote(process.execPath)} ${quote(probe)} ${quote(output)}` }, { signal }), value => {
        expect(value).toBeUndefined();
      });
      let parsed: Record<string, string | null> | undefined;
      await vi.waitFor(async () => { parsed = JSON.parse(await readFile(output, "utf8")); expect(parsed).toBeDefined(); }, { timeout: 10_000, interval: 25 });
      return parsed!;
    };
    lease.release(); lease = runtime.acquire(target("ses_environment_a"));
    const secretPath = path.join(root, "thread-secret");
    await writeFile(secretPath, "scoped-secret-canary", { mode: 0o600 });
    const toolInput = { sourceCapability: "fixture-native-source", catalog: [],
      cli: { sourceCapability: "exact-thread-canary", mode: "progressive" as const } };
    let admission = await runtime.admitToolSession(target("ses_environment_a"), toolInput);
    expect(await runtime.admitToolSession(target("ses_environment_a"), toolInput)).toEqual(admission);
    lease.release(); expect(lease.client.lifetime.aborted).toBe(false);
    runtime.releaseToolSession(target("ses_environment_a")); expect(lease.client.lifetime.aborted).toBe(true);
    lease = runtime.acquire(target("ses_environment_a"));
    admission = await runtime.admitToolSession(target("ses_environment_a"), toolInput);
    const definitions: EnvironmentVariableOverrides = { REMOVE_ME: { kind: "unset" }, EMPTY: { kind: "literal", value: "" },
      TOKEN: { kind: "secret", source: { kind: "protected_file", path: secretPath } } };
    const nativeWrite = OpenCodeHttpNativeAdapter.prototype.setEnvironmentVariables;
    const writing = vi.spyOn(OpenCodeHttpNativeAdapter.prototype, "setEnvironmentVariables");
    try {
      const missing: EnvironmentVariableOverrides = { TOKEN: { kind: "secret", source: { kind: "protected_file", path: path.join(root, "missing-secret") } } };
      await expect(lease.client.mutate("installSessionEnvironment", { sessionID: "ses_environment_a", definitions: missing,
        definitionFingerprint: configurationFingerprint(missing), cliAdmissionId: null }, openCodeTestMutationControl("missing-secret")))
        .rejects.toMatchObject({ delivery: "not_sent", code: "opencode_environment_resolution_failed" });
      await expect(lease.client.mutate("installSessionEnvironment", { sessionID: "ses_environment_a", definitions,
        definitionFingerprint: configurationFingerprint(definitions), cliAdmissionId: "stale-admission" }, openCodeTestMutationControl("stale-cli")))
        .rejects.toMatchObject({ delivery: "not_sent" });
      expect(writing).not.toHaveBeenCalled();
      writing.mockImplementationOnce(async function (this: OpenCodeHttpNativeAdapter, input, signal) {
        await nativeWrite.call(this, input, signal);
        throw new OpenCodeRuntimeError("opencode_request_failed");
      });
      await expect(lease.client.mutate("installSessionEnvironment", { sessionID: "ses_environment_a", definitions,
        definitionFingerprint: configurationFingerprint(definitions), cliAdmissionId: admission.cliAdmissionId }, openCodeTestMutationControl("write-response-lost")))
        .rejects.toMatchObject({ delivery: "sent_outcome_unknown", code: "opencode_request_failed" });
      expect(writing).toHaveBeenCalledOnce();
      expect(await read("ses_environment_a", "unknown-write.json")).toMatchObject({ TOKEN: "scoped-secret-canary" });
    } finally { writing.mockRestore(); }
    await lease.client.mutate("installSessionEnvironment", { sessionID: "ses_environment_a", definitions,
      definitionFingerprint: configurationFingerprint(definitions), cliAdmissionId: admission.cliAdmissionId }, openCodeTestMutationControl("install"));
    const first = await read("ses_environment_a", "a.json");
    expect(first).toMatchObject({ INHERITED: "startup-fixed", REMOVE_ME: null, EMPTY: "", TOKEN: "scoped-secret-canary",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "exact-thread-canary", SEDES_OPENCODE_MCP_CREDENTIAL: null, OPENCODE_PASSWORD: null, OPENCODE_SERVER_PASSWORD: null });
    expect(first.PATH).toMatch(/^\/fixture\/helper:/u); expect(first.SEDES_OPENCODE_RUNTIME_OWNER).toMatch(/^[0-9a-f]{64}$/u);
    expect(await read("ses_environment_b", "b.json")).toMatchObject({ INHERITED: "startup-fixed", REMOVE_ME: "remove", EMPTY: null, TOKEN: null,
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: null, SEDES_OPENCODE_MCP_CREDENTIAL: null });
    const history = await new OpenCodeNativeApi(lease.client).getHistoryPage("ses_environment_a", { order: "asc", limit: 200 });
    expect(JSON.stringify(history.data)).not.toContain("scoped-secret-canary");
    const generation = lease.generation, previous = lease.client; lease.release(); await runtime.stop();
    // The immutable original launch input is retained even if an external object changes.
    environment.INHERITED = "pending-startup";
    await runtime.start(); lease = runtime.acquire(target("ses_environment_a")); expect(lease.generation).not.toBe(generation);
    expect(await read("ses_environment_a", "restarted-before.json")).toMatchObject({ INHERITED: "startup-fixed", TOKEN: null, REMOVE_ME: "remove", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: null });
    await expect(previous.mutate("installSessionEnvironment", { sessionID: "ses_environment_a", definitions: {},
      definitionFingerprint: configurationFingerprint({}), cliAdmissionId: null }, openCodeTestMutationControl("stale"))).rejects.toThrow();
    await writeFile(secretPath, "rotated-secret-canary", { mode: 0o600 });
    const rotated: EnvironmentVariableOverrides = { TOKEN: { kind: "secret", source: { kind: "protected_file", path: secretPath } } };
    await lease.client.mutate("installSessionEnvironment", { sessionID: "ses_environment_a", definitions: rotated,
      definitionFingerprint: configurationFingerprint(rotated), cliAdmissionId: null }, openCodeTestMutationControl("reinstall"));
    expect(await read("ses_environment_a", "restarted-after.json")).toMatchObject({ INHERITED: "startup-fixed", TOKEN: "rotated-secret-canary" });
    lease.release(); await runtime.stop(); cleaned = true;
    expect((await readFile(nativeStorePath)).includes(Buffer.from("scoped-secret-canary"))).toBe(false);
    expect((await readFile(nativeStorePath)).includes(Buffer.from("rotated-secret-canary"))).toBe(false);
  } finally {
    launched.mockRestore();
    if (runtime && !cleaned) { await runtime.stop(); cleaned = true; }
    if (cleaned || !runtime) await rm(root, { recursive: true, force: true });
  }
}, 90_000);
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
