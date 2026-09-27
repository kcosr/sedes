import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { RUN_REAL_OPENCODE } from "../support/opencode-native-fixture.js";

it.runIf(RUN_REAL_OPENCODE)("installs complete isolated shell maps with cleanup ownership and reinjects after owned restart", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-env-"));
  const workspace = path.join(root, "workspace"), configDirectory = path.join(root, "config"), nativeStorePath = path.join(root, "store", "opencode.db");
  const environment: NodeJS.ProcessEnv = { HOME: path.join(root, "home"), PATH: process.env.PATH, SHELL: "/bin/sh",
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"), OPENCODE_DISABLE_FFF: "1", OPENCODE_FILEWATCHER_DISABLE: "1",
    INHERITED: "startup-fixed", REMOVE_ME: "remove", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "ambient-source-canary", SEDES_OPENCODE_MCP_CREDENTIAL: "ambient-bridge-canary" };
  let runtime: OpenCodeRuntime | undefined, cleaned = false;
  try {
    await Promise.all([workspace, configDirectory, environment.HOME!, path.dirname(nativeStorePath)].map(directory => mkdir(directory, { recursive: true })));
    await writeFile(environment.OPENCODE_MODELS_PATH!, "{}");
    await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({ update: "disable", permission: { shell: "allow" } }));
    const probe = path.join(workspace, "probe.mjs");
    await writeFile(probe, `import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], JSON.stringify(Object.fromEntries(['INHERITED','REMOVE_ME','EMPTY','TOKEN','PATH','OPENCODE_PASSWORD','OPENCODE_SERVER_PASSWORD','SEDES_AGENT_TOOL_SOURCE_CAPABILITY','SEDES_OPENCODE_MCP_CREDENTIAL','SEDES_OPENCODE_RUNTIME_OWNER'].map(key=>[key,process.env[key]??null]))));`);
    runtime = new OpenCodeRuntime({ authority: { tenantId: "fixture", principalId: "fixture", backendInstanceId: "fixture", executionEnvironmentId: "local" },
      nativeStorePath, configDirectory, environment, connection: { ownership: "owned", channel: { type: "process_stdio", workingDirectory: workspace,
        executablePath: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2" } } });
    await runtime.start();
    let lease = runtime.acquire();
    const native = new OpenCodeNativeMutations(lease.client);
    await native.createSession({ id: "ses_environment_a", location: { directory: workspace }, title: "A" });
    await native.createSession({ id: "ses_environment_b", location: { directory: workspace }, title: "B" });
    const read = async (sessionID: string, filename: string) => {
      const output = path.join(workspace, filename);
      await lease.client.call((client, signal) => client.session.shell({ sessionID, command: `${quote(process.execPath)} ${quote(probe)} ${quote(output)}` }, { signal }), value => {
        expect(value).toBeUndefined();
      });
      let parsed: Record<string, string | null> | undefined;
      await vi.waitFor(async () => { parsed = JSON.parse(await readFile(output, "utf8")); expect(parsed).toBeDefined(); }, { timeout: 10_000, interval: 25 });
      return parsed!;
    };
    await runtime.installSessionEnvironment({ expectedGeneration: lease.generation, sessionID: "ses_environment_a",
      overrides: { REMOVE_ME: null, EMPTY: "", TOKEN: "scoped-secret-canary" }, generated: { SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "exact-thread-canary" }, executableDirectory: "/fixture/helper" });
    const first = await read("ses_environment_a", "a.json");
    expect(first).toMatchObject({ INHERITED: "startup-fixed", REMOVE_ME: null, EMPTY: "", TOKEN: "scoped-secret-canary",
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "exact-thread-canary", SEDES_OPENCODE_MCP_CREDENTIAL: null, OPENCODE_PASSWORD: null, OPENCODE_SERVER_PASSWORD: null });
    expect(first.PATH).toMatch(/^\/fixture\/helper:/u); expect(first.SEDES_OPENCODE_RUNTIME_OWNER).toMatch(/^[0-9a-f]{64}$/u);
    expect(await read("ses_environment_b", "b.json")).toMatchObject({ INHERITED: "startup-fixed", REMOVE_ME: "remove", EMPTY: null, TOKEN: null,
      SEDES_AGENT_TOOL_SOURCE_CAPABILITY: null, SEDES_OPENCODE_MCP_CREDENTIAL: null });
    const history = await new OpenCodeNativeApi(lease.client).getHistoryPage("ses_environment_a", { order: "asc", limit: 200 });
    expect(JSON.stringify(history.data)).not.toContain("scoped-secret-canary");
    const generation = lease.generation; lease.release(); await runtime.stop();
    // The immutable original launch input is retained even if an external object changes.
    environment.INHERITED = "pending-startup";
    await runtime.start(); lease = runtime.acquire(); expect(lease.generation).not.toBe(generation);
    expect(await read("ses_environment_a", "restarted-before.json")).toMatchObject({ INHERITED: "startup-fixed", TOKEN: null, REMOVE_ME: "remove", SEDES_AGENT_TOOL_SOURCE_CAPABILITY: null });
    await expect(runtime.installSessionEnvironment({ expectedGeneration: generation, sessionID: "ses_environment_a", overrides: {}, generated: {} })).rejects.toThrow();
    await runtime.installSessionEnvironment({ expectedGeneration: lease.generation, sessionID: "ses_environment_a", overrides: { TOKEN: "rotated-secret-canary" }, generated: {} });
    expect(await read("ses_environment_a", "restarted-after.json")).toMatchObject({ INHERITED: "startup-fixed", TOKEN: "rotated-secret-canary" });
    lease.release(); await runtime.stop(); cleaned = true;
    expect((await readFile(nativeStorePath)).includes(Buffer.from("scoped-secret-canary"))).toBe(false);
    expect((await readFile(nativeStorePath)).includes(Buffer.from("rotated-secret-canary"))).toBe(false);
  } finally {
    if (runtime && !cleaned) { await runtime.stop(); cleaned = true; }
    if (cleaned || !runtime) await rm(root, { recursive: true, force: true });
  }
}, 90_000);
function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
