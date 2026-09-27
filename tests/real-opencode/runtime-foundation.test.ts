import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { startOpenCodeOwnedProcess } from "../../src/server/backends/opencode/opencode-owned-process.js";
import { boundedOpenCodeProcessFile, readOpenCodeNativeIdentity } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";

import * as ownedProcesses from "../../src/server/backends/opencode/opencode-owned-process.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
afterEach(() => vi.restoreAllMocks());

const enabled = process.platform === "linux" && process.env.SEDES_RUN_REAL_OPENCODE === "1";

it.skipIf(!enabled)("rejects a conflicting observed native default database without OPENCODE_DB", async () => {
  const fixture = await startOpencodeNativeFixture();
  try {
    const environment = await boundedOpenCodeProcessFile(`/proc/${fixture.pid}/environ`, 1_048_576);
    expect(environment.toString("utf8").split("\0").some(entry => entry.startsWith("OPENCODE_DB="))).toBe(false);
    const nativeStorePath = path.join(fixture.rootDirectory, "data", "opencode", "opencode.db");
    const wrongStorePath = path.join(fixture.rootDirectory, "wrong.db");
    await writeFile(wrongStorePath, "unrelated database canary");
    await expect(readOpenCodeNativeIdentity({ pid: fixture.pid, nativeStorePath: wrongStorePath }))
      .rejects.toThrow("opencode_local_process_identity_unproved");
    await expect(readOpenCodeNativeIdentity({ pid: fixture.pid, nativeStorePath }))
      .resolves.toMatchObject({ nativeStorePath, storeObservation: "open_file" });
    await unlink(nativeStorePath);
    await writeFile(nativeStorePath, "replacement database canary");
    await expect(readOpenCodeNativeIdentity({ pid: fixture.pid, nativeStorePath }))
      .rejects.toThrow("opencode_local_process_identity_unproved");
    expect((await fixture.api("GET", "/api/info")).status).toBe(200);
  } finally { await fixture.stop(); }
});

it.skipIf(!enabled).each(["opencode.db", "opencode.db (deleted)"])("rejects replacement of explicit native database %s while its original descriptor remains open", async name => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-replaced-database-"));
  const configDirectory = path.join(root, "config");
  const nativeStorePath = path.join(root, name);
  let native: Awaited<ReturnType<typeof startOpenCodeOwnedProcess>> | undefined;
  let proved = false;
  try {
    await mkdir(configDirectory);
    await writeFile(path.join(root, "models.json"), "{}");
    await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({ update: "disable" }));
    native = await startOpenCodeOwnedProcess({ processMarker: randomBytes(32).toString("hex"),
      executablePath: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2",
      workingDirectory: root, nativeStorePath, configDirectory,
      environment: { HOME: root, PATH: process.env.PATH, SHELL: "/bin/sh",
        XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"), OPENCODE_DISABLE_FFF: "1", OPENCODE_FILEWATCHER_DISABLE: "1" },
    });
    // Literal suffixes must remain intact when their pathname and FD inode
    // agree. A same-spelling literal sibling cannot hide a different deleted
    // native inode merely because that literal pathname also exists.
    const literalSibling = await open(`${nativeStorePath} (deleted)`, "wx");
    try {
      await expect(readOpenCodeNativeIdentity({ pid: native.pid, nativeStorePath }))
        .resolves.toMatchObject({ nativeStorePath, storeObservation: "open_file" });
      await unlink(nativeStorePath);
      await writeFile(nativeStorePath, "replacement database canary");
      await expect(readOpenCodeNativeIdentity({ pid: native.pid, nativeStorePath }))
        .rejects.toThrow("opencode_local_process_identity_unproved");
      expect(await readFile(nativeStorePath, "utf8")).toBe("replacement database canary");
    } finally { await literalSibling.close(); }
    await native.stop(); proved = true;
  } finally {
    if (native && !proved) { await native.stop(); proved = true; }
    if (proved || !native) await rm(root, { recursive: true, force: true });
  }
});

async function alive(pid: number): Promise<boolean> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(value.slice(value.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

it.skipIf(!enabled)("owned opencode2 preserves native configuration, remains resident with background work after reference release, and cleans up only on explicit Stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-runtime-"));
  const workspace = path.join(root, "workspace");
  const configDirectory = path.join(root, "config", "opencode");
  const nativeStorePath = path.join(root, "data", "opencode.db");
  const evidence = path.join(workspace, "shell-evidence.json");
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SHELL: "/bin/sh", LANG: "C.UTF-8",
    HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"), XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"),
    OPENCODE_DISABLE_FFF: "1", OPENCODE_FILEWATCHER_DISABLE: "1",
    // Deliberately wrong inherited mode/auth overrides must not reach the native owner.
    OPENCODE_PASSWORD: "inherited-password-canary", OPENCODE_SERVER_PASSWORD: "inherited-password-canary",
    OPENCODE_SIMULATE: "1", OPENCODE_CONFIG_CONTENT: "invalid-canary",
  };
  const launched = vi.spyOn(ownedProcesses, "startOpenCodeOwnedProcess");
  let runtime: OpenCodeRuntime | undefined;
  let cleanupProved = false;
  try {
    await Promise.all([workspace, configDirectory, environment.HOME!, path.dirname(nativeStorePath)].map(directory => mkdir(directory, { recursive: true })));
    await writeFile(environment.OPENCODE_MODELS_PATH!, "{}");
    const config = JSON.stringify({ update: "disable", permission: { shell: "allow" } });
    await writeFile(path.join(configDirectory, "opencode.json"), config);
    runtime = new OpenCodeRuntime({ hostIncarnation: "fixture-host",
      authority: { tenantId: "qualification", principalId: "qualification", backendInstanceId: "fixture", executionEnvironmentId: "local" },
      nativeStorePath, environment,
      connection: { ownership: "owned", channel: { type: "process_stdio",
        executablePath: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2", workingDirectory: workspace } },
    });
    await runtime.start();
    const first = runtime.acquire({ directory: workspace });
    const second = runtime.acquire({ directory: workspace });
    const original = runtime.snapshot();
    expect(original.identity?.storeObservation).toBe("open_file");
    // Qualification alone uses the owned launch's native fixture handle for
    // shell setup; application leases expose only the closed native port.
    const nativeClient = (await (launched.mock.results.at(-1)!.value as ReturnType<typeof ownedProcesses.startOpenCodeOwnedProcess>)).client;
    await nativeClient.requireAuthentication();
    expect((await nativeClient.info()).version).toBe("2.0.18");
    expect((await new OpenCodeNativeApi(first.client).listSessions({ directory: workspace })).data).toEqual([]);
    const wrongAuth = await fetch(`${nativeClient.endpoint}/api/info`, {
      headers: { authorization: `Basic ${Buffer.from("opencode:inherited-password-canary").toString("base64")}` },
      signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    await wrongAuth.body?.cancel(); expect(wrongAuth.status).toBe(401);
    const shellCode = `require("node:fs").writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({pid:process.pid, passwordPresent:process.env.OPENCODE_PASSWORD!==undefined, legacyPasswordPresent:process.env.OPENCODE_SERVER_PASSWORD!==undefined, autoUpdate:process.env.OPENCODE_DISABLE_AUTOUPDATE,home:process.env.HOME}));setInterval(()=>{},1000)`;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const shell = await nativeClient.call((client, signal) => client.shell.create({
      location: { directory: workspace }, command: `${quote(process.execPath)} -e ${quote(shellCode)}`, cwd: workspace,
    }, { signal }), value => z.object({ data: z.object({ id: z.string(), status: z.literal("running") }) }).parse(value));
    const deadline = Date.now() + 5_000;
    let shellEvidence: { pid: number; passwordPresent: boolean; legacyPasswordPresent: boolean; autoUpdate: string; home: string };
    while (true) {
      try { shellEvidence = JSON.parse(await readFile(evidence, "utf8")); break; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT" || Date.now() > deadline) throw cause; await delay(10); }
    }
    expect(shellEvidence).toMatchObject({ passwordPresent: false, legacyPasswordPresent: false, autoUpdate: "1", home: environment.HOME });
    first.release(); second.release();
    expect(runtime.snapshot()).toMatchObject({ state: "ready", references: 0, generation: original.generation });
    expect(await alive(shellEvidence.pid)).toBe(true);
    const reacquired = runtime.acquire({ directory: workspace });
    await expect(nativeClient.call((client, signal) => client.shell.get({ id: shell.data.id, location: { directory: workspace } }, { signal }), value => z.object({ data: z.object({ status: z.string() }) }).parse(value))).resolves.toMatchObject({ data: { status: "running" } });
    reacquired.release();
    expect(await readFile(path.join(configDirectory, "opencode.json"), "utf8")).toBe(config);
    await expect(runtime.stop()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "complete" });
    cleanupProved = true;
    expect(await alive(original.identity!.pid)).toBe(false);
    expect(await alive(shellEvidence.pid)).toBe(false);
    expect((await stat(nativeStorePath)).isFile()).toBe(true);
    expect((await readdir(path.dirname(nativeStorePath))).some(name => name.endsWith(".lock"))).toBe(false);
    await runtime.start(); cleanupProved = false;
    expect(runtime.snapshot().generation).not.toBe(original.generation);
    expect(runtime.snapshot().identity?.store).toEqual(original.identity?.store);
    const secondPid = runtime.snapshot().identity!.pid;
    await rename(nativeStorePath, `${nativeStorePath}.original`);
    await writeFile(nativeStorePath, "replacement store canary");
    await expect(runtime.assertCurrent()).rejects.toThrow("opencode_runtime_identity_changed");
    expect(await alive(secondPid)).toBe(true);
    // The process remains ours to clean up, but its native interrupt sweep is
    // unproved after identity loss and must not be reported as completed.
    await expect(runtime.close()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "incomplete" });
    cleanupProved = true;
    expect(await alive(secondPid)).toBe(false);
    expect(await readFile(nativeStorePath, "utf8")).toBe("replacement store canary");
    await rename(`${nativeStorePath}.original`, nativeStorePath);
    await runtime.start(); cleanupProved = false;
    await expect(runtime.close()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "complete" });
    cleanupProved = true;
  } finally {
    if (runtime && !cleanupProved) { await runtime.close(); cleanupProved = true; }
    if (cleanupProved || !runtime) await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(!enabled)("external stock opencode2 keeps its daemon and background shell alive after Disconnect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-external-"));
  const configDirectory = path.join(root, "config");
  const nativeStorePath = path.join(root, "opencode.db");
  let native: Awaited<ReturnType<typeof startOpenCodeOwnedProcess>> | undefined;
  let runtime: OpenCodeRuntime | undefined;
  let proved = false;
  try {
    await mkdir(configDirectory);
    await writeFile(path.join(root, "models.json"), "{}");
    await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({ update: "disable" }));
    native = await startOpenCodeOwnedProcess({ processMarker: randomBytes(32).toString("hex"),
      executablePath: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2",
      workingDirectory: root, nativeStorePath, configDirectory,
      environment: { HOME: root, PATH: process.env.PATH, SHELL: "/bin/sh",
        XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"), OPENCODE_DISABLE_FFF: "1", OPENCODE_FILEWATCHER_DISABLE: "1" },
    });
    const shell = await native.client.call((client, signal) => client.shell.create({
      location: { directory: root }, cwd: root, command: "sleep 120",
    }, { signal }), value => z.object({ data: z.object({ id: z.string(), pid: z.number().int().positive() }) }).parse(value));
    // The fixture owns this daemon. Read only its generated canary privately to
    // simulate an operator-provided secret; no user HOME/auth is consulted.
    const processEnvironment = await boundedOpenCodeProcessFile(`/proc/${native.pid}/environ`, 1_048_576);
    const password = processEnvironment.toString("utf8").split("\0").find(value => value.startsWith("OPENCODE_PASSWORD="))?.slice("OPENCODE_PASSWORD=".length);
    if (!password) throw new Error("isolated fixture password unavailable");
    const wrongStorePath = path.join(root, "wrong.db");
    await writeFile(wrongStorePath, "unrelated database canary");
    const mismatched = new OpenCodeRuntime({ hostIncarnation: "fixture-host",
      authority: { tenantId: "qualification", principalId: "qualification", backendInstanceId: "mismatch", executionEnvironmentId: "local" },
      nativeStorePath: wrongStorePath, environment: {}, externalPassword: async () => password,
      connection: { ownership: "external", channel: { type: "http", url: native.endpoint } },
    });
    await expect(mismatched.start()).rejects.toThrow("opencode_local_process_identity_unproved");
    expect(mismatched.snapshot().state).toBe("stopped");
    expect(await readFile(wrongStorePath, "utf8")).toBe("unrelated database canary");
    expect((await readdir(root)).some(name => name.endsWith(".lock"))).toBe(false);
    expect(await alive(native.pid)).toBe(true);
    runtime = new OpenCodeRuntime({ hostIncarnation: "fixture-host",
      authority: { tenantId: "qualification", principalId: "qualification", backendInstanceId: "external", executionEnvironmentId: "local" },
      nativeStorePath, environment: {}, externalPassword: async () => password,
      connection: { ownership: "external", channel: { type: "http", url: native.endpoint } },
    });
    await runtime.start();
    const lease = runtime.acquire({ directory: root }); lease.release();
    expect(runtime.snapshot()).toMatchObject({ state: "ready", references: 0, identity: { pid: native.pid, storeObservation: "open_file" } });
    await expect(runtime.close()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "not_owned" });
    expect(await alive(native.pid)).toBe(true);
    expect(await alive(shell.data.pid)).toBe(true);
    await expect(native.client.info()).resolves.toMatchObject({ version: "2.0.18", pid: native.pid });
    await native.stop(); proved = true;
    expect(await alive(shell.data.pid)).toBe(false);
  } finally {
    await runtime?.close();
    if (native && !proved) { await native.stop(); proved = true; }
    if (proved || !native) await rm(root, { recursive: true, force: true });
  }
});
