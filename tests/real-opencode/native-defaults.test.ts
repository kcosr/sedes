import { randomUUID } from "node:crypto";
import { mkdir, readlink, realpath, rename, stat, symlink } from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeNativeMutations } from "../../src/server/backends/opencode/opencode-native-mutations.js";
import { openCodeTestMutationControl } from "../helpers/opencode-native-port-fixture.js";
import { prepareOpencodeNativeAccount, RUN_REAL_OPENCODE, startOpencodeNativeFixture } from "../support/opencode-native-fixture.js";
import { startOpencodeModelFixture } from "../support/opencode-model-fixture.js";

async function isolatedAccount() {
  const model = await startOpencodeModelFixture();
  const account = await prepareOpencodeNativeAccount({ config: model.config }).catch(async error => {
    await model.stop(); throw error;
  });
  try {
    const bin = path.join(account.rootDirectory, "bin");
    await mkdir(bin);
    await symlink(account.executable, path.join(bin, "opencode2"));
    const environment: NodeJS.ProcessEnv = { ...account.environment, PATH: `${bin}:/usr/bin:/bin` };
    delete environment.OPENCODE_CONFIG_DIR;
    delete environment.OPENCODE_PASSWORD;
    return { account, model, environment };
  } catch (error) {
    try { await account.close(); } finally { await model.stop(); }
    throw error;
  }
}

function runtime(root: string, environment: NodeJS.ProcessEnv, backendInstanceId = randomUUID()) {
  return new OpenCodeRuntime({
    hostIncarnation: randomUUID(),
    ownershipDirectory: path.join(root, "owners"),
    authority: { tenantId: "native-defaults", principalId: "native-defaults", backendInstanceId, executionEnvironmentId: "local" },
    environment,
    connection: { ownership: "owned", channel: { type: "process_stdio" } },
  });
}

async function processEnvironment(pid: number) {
  const bytes = await boundedOpenCodeProcessFile(`/proc/${pid}/environ`, 1_048_576);
  return Object.fromEntries(bytes.toString("utf8").split("\0").filter(Boolean).map(entry => {
    const equals = entry.indexOf("=");
    return [entry.slice(0, equals), entry.slice(equals + 1)];
  }));
}

it.runIf(RUN_REAL_OPENCODE).each([false, true])("launches stock native defaults with native environment overrides=%s and no explicit paths", async overrides => {
  const { account, model, environment } = await isolatedAccount();
  let owner: OpenCodeRuntime | undefined;
  try {
    let expectedStore = account.nativeStorePath;
    if (overrides) {
      // A native relative DB override is relative to OpenCode's own data root,
      // not the Sedes working directory. No Sedes path field selects it.
      environment.OPENCODE_DB = "operator-selected.db";
      environment.OPENCODE_CONFIG_DIR = path.join(account.rootDirectory, "operator-config");
      await rename(account.configDirectory, environment.OPENCODE_CONFIG_DIR);
      expectedStore = path.join(environment.XDG_DATA_HOME!, "opencode", "operator-selected.db");
    }
    owner = runtime(account.rootDirectory, environment);
    await owner.start();
    const identity = owner.snapshot().identity!;
    expect(identity).toMatchObject({ nativeStorePath: expectedStore, executablePath: account.executable, storeObservation: "open_file" });
    expect(await readlink(`/proc/${identity.pid}/cwd`)).toBe(await realpath(process.cwd()));
    const observed = await processEnvironment(identity.pid);
    expect(observed.PATH).toBe(environment.PATH);
    expect(observed.HOME).toBe(environment.HOME);
    expect(observed.XDG_CONFIG_HOME).toBe(environment.XDG_CONFIG_HOME);
    expect(observed.XDG_DATA_HOME).toBe(environment.XDG_DATA_HOME);
    expect(observed.OPENCODE_DB).toBe(environment.OPENCODE_DB);
    expect(observed.OPENCODE_CONFIG_DIR).toBe(environment.OPENCODE_CONFIG_DIR);
    const lease = owner.acquire({ directory: account.workspace });
    try {
      const native = new OpenCodeNativeMutations(lease.client);
      await vi.waitFor(async () => expect(await native.getDefaultModel(account.workspace))
        .toMatchObject({ providerID: "probe", id: "probe-model" }), { timeout: 20_000, interval: 25 });
    } finally { lease.release(); }
    expect(model.requestCount).toBe(0);
    await expect(owner.stop()).resolves.toMatchObject({ cleanup: "proved" });
    expect((await stat(expectedStore)).isFile()).toBe(true);
  } finally {
    try { await owner?.close(); } finally {
      try { await account.close(); } finally { await model.stop(); }
    }
  }
});

it.runIf(RUN_REAL_OPENCODE)("allows distinct Sedes runtime authorities to share the native database and Stop preserves the other authority's active turn", async () => {
  const { account, model, environment } = await isolatedAccount();
  const first = runtime(account.rootDirectory, environment), second = runtime(account.rootDirectory, environment);
  let hold: ReturnType<typeof model.holdNextStream> | undefined;
  try {
    await first.start();
    await second.start();
    const firstIdentity = first.snapshot().identity!, secondIdentity = second.snapshot().identity!;
    expect(firstIdentity.pid).not.toBe(secondIdentity.pid);
    expect(firstIdentity.nativeStorePath).toBe(account.nativeStorePath);
    expect(secondIdentity.nativeStorePath).toBe(account.nativeStorePath);
    expect(firstIdentity.store).toEqual(secondIdentity.store);
    let lease = second.acquire({ directory: account.workspace });
    try {
      const catalog = new OpenCodeNativeMutations(lease.client);
      await vi.waitFor(async () => expect(await catalog.getDefaultModel(account.workspace))
        .toMatchObject({ providerID: "probe", id: "probe-model" }), { timeout: 20_000, interval: 25 });
      const session = await catalog.createSession({ id: "ses_shared_owner", title: "Shared native account", location: { directory: account.workspace },
        model: { providerID: "probe", id: "probe-model" } }, openCodeTestMutationControl("shared-create"));
      lease.release();
      lease = second.acquire({ directory: account.workspace, session: { applicationThreadId: "shared-owner",
        nativeSessionID: session.id, bindingFingerprint: configurationFingerprint(session.id) } });
      const api = new OpenCodeNativeApi(lease.client), native = new OpenCodeNativeMutations(lease.client);
      hold = model.holdNextStream("shared-account-active-turn");
      await native.prompt({ sessionID: session.id, id: "msg_shared_owner", text: "shared-account-active-turn", delivery: "queue", resume: true },
        openCodeTestMutationControl("shared-prompt"));
      await hold.started;
      await expect(api.getActivity(session.id, account.workspace)).resolves.toMatchObject({ active: true });
      await expect(first.stop()).resolves.toMatchObject({ cleanup: "proved" });
      expect(second.snapshot()).toMatchObject({ state: "ready", identity: secondIdentity });
      await second.assertCurrent();
      await expect(api.getActivity(session.id, account.workspace)).resolves.toMatchObject({ active: true });
      hold.release();
      await vi.waitFor(async () => {
        const page = await api.getHistoryPage(session.id, { order: "asc", limit: 64 });
        expect(page.data.at(-1)).toMatchObject({ type: "idle", outcome: "succeeded" });
        expect(JSON.stringify(page.data)).toContain("PREFIXSUFFIX");
      }, { timeout: 20_000, interval: 25 });
      await native.renameSession(session.id, "Still usable after other owner Stop", openCodeTestMutationControl("shared-rename"));
      await expect(api.getSession(session.id)).resolves.toMatchObject({ title: "Still usable after other owner Stop" });
    } finally { lease.release(); }
    await expect(second.stop()).resolves.toMatchObject({ cleanup: "proved" });
  } finally {
    hold?.release();
    try { await first.close(); } finally {
      try { await second.close(); } finally {
        try { await account.close(); } finally { await model.stop(); }
      }
    }
  }
});

it.runIf(RUN_REAL_OPENCODE)("discovers an external daemon's native database without a configured path and leaves it running on Disconnect", async () => {
  const native = await startOpencodeNativeFixture();
  const owner = new OpenCodeRuntime({
    hostIncarnation: randomUUID(),
    ownershipDirectory: path.join(native.rootDirectory, "owners"),
    authority: { tenantId: "native-defaults", principalId: "native-defaults", backendInstanceId: randomUUID(), executionEnvironmentId: "local" },
    // External database identity comes from the authenticated daemon's process,
    // never Sedes's unrelated HOME/XDG environment.
    environment: {},
    connection: { ownership: "external", channel: { type: "http", url: native.url } },
    externalPassword: async () => native.account.password,
  });
  try {
    await owner.start();
    expect(owner.snapshot().identity).toMatchObject({ pid: native.pid, nativeStorePath: native.account.nativeStorePath, storeObservation: "open_file" });
    const lease = owner.acquire({ directory: native.workspace });
    try { expect((await new OpenCodeNativeApi(lease.client).listSessions({ directory: native.workspace })).data).toEqual([]); }
    finally { lease.release(); }
    await expect(owner.stop()).rejects.toThrow("opencode_external_stop_forbidden");
    await expect(owner.close()).resolves.toMatchObject({ cleanup: "proved" });
    expect((await native.api("GET", "/api/info")).status).toBe(200);
  } finally {
    try { await owner.close(); } finally { await native.stop(); }
  }
});
