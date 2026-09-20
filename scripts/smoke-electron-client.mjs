import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { connect as connectSocket } from "node:net";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { WebSocketServer } from "ws";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../dist/shared/protocol/application.js";
import { SEDES_VERSION } from "../dist/shared/version.js";
import { electronBuilderUnpackedDirectory } from "./electron-package-layout.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electronRoot = path.join(root, "electron");
const mode = process.argv[2] ?? "--source";
if (mode !== "--source" && mode !== "--packaged") {
  throw new Error("Usage: smoke-electron-client.mjs [--source|--packaged]");
}
const packaged = mode === "--packaged";
const expectedOrigin = "capacitor-electron://localhost";
const lifecycle = [];
const userDataDirectory = await mkdtemp(
  path.join(os.tmpdir(), "sedes-electron-smoke-user-data-"),
);
const fakeSshDirectory = await mkdtemp(
  path.join(os.tmpdir(), "sedes-electron-smoke-ssh-"),
);
const launchHomeDirectory = await mkdtemp(
  path.join(os.tmpdir(), "sedes-electron-smoke-home-"),
);
const fakeSshLog = path.join(fakeSshDirectory, "invocations.ndjson");
const electronProcessIds = new Set();
const progress = (message) =>
  process.stdout.write(`Electron smoke: ${message}\n`);
// Managed Local owns a production server whose graceful application drain has
// a 30-second upper bound. The smoke must observe that contract rather than
// killing Electron during an otherwise valid shutdown.
const PROCESS_EXIT_TIMEOUT_MILLISECONDS = 40_000;
const PROCESS_TERM_TIMEOUT_MILLISECONDS = 1_000;
const PROCESS_KILL_TIMEOUT_MILLISECONDS = 1_000;

function sessionFor(label) {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken: `electron-smoke-${label}-csrf-token`,
    providerPulseEnabled: true,
  };
}

function snapshotFor(label) {
  return {
    advisories: [],
    environments: [
      {
        id: `${label}-environment`,
        kind: "local",
        label: { text: `Smoke ${label}` },
        available: true,
        directoryBrowsing: "available",
      },
    ],
    workspaces: [],
    executionTargets: [
      {
        id: `${label}-target`,
        environmentId: `${label}-environment`,
        label: { text: `Smoke ${label}` },
        backend: { label: { text: "Smoke" }, brand: "pi" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ],
    defaultNewThreadTargetId: `${label}-target`,
    threads: [],
    groups: [],
    forkOrigins: [],
    lineagePlacements: [],
    lineageFamilies: [],
    counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
  };
}

function createSmokeBackend(label, { webSocket = false } = {}) {
  const observed = {
    sessionOrigins: [],
    downloadOrigins: [],
    eventOrigins: [],
    webSocketOrigins: [],
  };
  const credentials = new Map();
  const pairingCodes = new Set();
  const socketTickets = new Set();
  let pairedCount = 0;
  const openEventStreams = new Set();
  const webSockets = new WebSocketServer({ noServer: true });
  let sessionFailure = false;
  const server = createServer((request, response) => {
    const origin = request.headers.origin;
    if (request.method === "OPTIONS") {
      if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, POST, DELETE, OPTIONS");
      response.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Last-Event-ID, X-CSRF-Token, Authorization",
      );
      response.statusCode = 204;
      response.end();
      return;
    }
    if (origin) response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, Content-Length, X-Sedes-Workspace-File-Revision",
    );
    const credential = request.headers.authorization?.replace(/^Bearer /u, "");
    const client = credentials.get(credential);
    const json = (status, value) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(value));
    };
    if (request.url === "/api/auth/status") {
      json(200, client ? { required: true, authenticated: true, client } : { required: true, authenticated: false });
      return;
    }
    if (request.url === "/api/auth/pair" && request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => { body += chunk; if (body.length > 4096) request.destroy(); });
      request.on("end", () => {
        let input;
        try { input = JSON.parse(body); } catch { json(400, { error: "invalid_pairing" }); return; }
        if (input.kind !== "device" || !pairingCodes.delete(input.token)) {
          json(401, { error: "invalid_pairing" }); return;
        }
        const token = randomBytes(32).toString("base64url");
        const pairedClient = { id: randomUUID(), name: input.clientName, kind: "management",
          createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400000).toISOString() };
        credentials.set(token, pairedClient);
        pairedCount += 1;
        json(200, { client: pairedClient, credential: token });
      });
      return;
    }
    if (!client) { json(401, { error: "authentication_required" }); return; }
    if (request.url === "/api/auth/clients") { json(200, { clients: [...credentials.values()] }); return; }
    if (request.url === "/api/electron-smoke-ws-ticket") {
      const ticket = randomBytes(32).toString("base64url");
      socketTickets.add(ticket);
      json(200, { ticket }); return;
    }
    if (request.url === "/api/application/session") {
      observed.sessionOrigins.push(origin);
      lifecycle.push(`${label}:session`);
      response.setHeader("Content-Type", "application/json");
      response.statusCode = sessionFailure ? 503 : 200;
      response.end(
        JSON.stringify(
          sessionFailure
            ? { error: "electron_smoke_unavailable" }
            : sessionFor(label),
        ),
      );
      return;
    }
    if (request.url?.startsWith("/api/application/events")) {
      observed.eventOrigins.push(origin);
      lifecycle.push(`${label}:events-open`);
      response.setHeader("Content-Type", "text/event-stream");
      response.setHeader("Cache-Control", "no-cache");
      response.flushHeaders();
      const generation = "10000000-0000-4000-8000-000000000001";
      const eventId = `${generation}.1`;
      response.write(
        [
          `id: ${eventId}`,
          "event: application",
          `data: ${JSON.stringify({
            eventId,
            applicationGeneration: generation,
            event: {
              type: "snapshot",
              generation,
              snapshot: snapshotFor(label),
            },
          })}`,
          "",
          "event: application-live",
          "data: {}",
          "",
          "",
        ].join("\n"),
      );
      openEventStreams.add(response);
      response.on("close", () => {
        openEventStreams.delete(response);
        lifecycle.push(`${label}:events-close`);
      });
      return;
    }
    if (
      request.url === "/api/electron-smoke-download" ||
      request.url === "/api/electron-smoke-stale-download"
    ) {
      observed.downloadOrigins.push(origin);
      const content = Buffer.from("electron smoke download\n");
      response.setHeader("Content-Type", "application/octet-stream");
      response.setHeader(
        "Content-Disposition",
        'attachment; filename="electron-smoke.txt"',
      );
      response.setHeader(
        "X-Sedes-Workspace-File-Revision",
        request.url.includes("stale")
          ? "electron-smoke-stale-revision"
          : "electron-smoke-revision",
      );
      response.setHeader("Content-Length", String(content.byteLength));
      response.end(content);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url, "http://localhost");
    if (!webSocket || requestUrl.pathname !== "/electron-smoke" || !socketTickets.delete(requestUrl.searchParams.get("ticket"))) {
      socket.destroy();
      return;
    }
    observed.webSocketOrigins.push(request.headers.origin);
    webSockets.handleUpgrade(request, socket, head, (ws) => {
      ws.send("ready");
      ws.close();
    });
  });
  return {
    label,
    server,
    observed,
    openEventStreams,
    webSockets,
    origin: undefined,
    get pairedCount() { return pairedCount; },
    issuePairingCode() {
      const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
      const letters = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
      const token = `${letters.slice(0, 4)}-${letters.slice(4)}`;
      pairingCodes.add(token);
      return token;
    },
    setSessionFailure(value) {
      sessionFailure = value;
    },
  };
}

const directA = createSmokeBackend("direct-a", { webSocket: true });
const directB = createSmokeBackend("direct-b");
const sshRemote = createSmokeBackend("ssh-remote");
const backends = [directA, directB, sshRemote];

async function listen(backend) {
  await new Promise((resolve, reject) => {
    backend.server.once("error", reject);
    backend.server.listen(0, "127.0.0.1", resolve);
  });
  const address = backend.server.address();
  if (!address || typeof address === "string")
    throw new Error(`electron_smoke_${backend.label}_address_unavailable`);
  backend.origin = `http://127.0.0.1:${address.port}`;
}

async function closeBackend(backend) {
  for (const response of backend.openEventStreams) response.destroy();
  for (const socket of backend.webSockets.clients) socket.terminate();
  backend.webSockets.close();
  backend.server.close();
  backend.server.closeAllConnections();
}

async function installFakeSsh() {
  const executable = path.join(fakeSshDirectory, "ssh");
  await writeFile(
    executable,
    `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const { connect, createServer } = require("node:net");
const record = (entry) => appendFileSync(process.env.SEDES_ELECTRON_SMOKE_SSH_LOG, JSON.stringify({ ...entry, pid: process.pid }) + "\\n");
const args = process.argv.slice(2);
const alias = args.at(-1);
record({ event: "start", args, alias });
if (alias === "fail-auth") {
  process.stderr.write("Permission denied (publickey).\\n");
  record({ event: "failure", code: 255, alias });
  process.exit(255);
}
let forward;
for (let index = 0; index < args.length - 1; index += 1) if (args[index] === "-L") forward = args[index + 1];
const match = /^127\\.0\\.0\\.1:(\\d+):127\\.0\\.0\\.1:(\\d+)$/.exec(forward ?? "");
if (!match) { process.stderr.write("invalid forward\\n"); process.exit(2); }
const localPort = Number(match[1]);
const remotePort = Number(match[2]);
let server;
const stop = (signal) => {
  record({ event: "signal", signal, localPort, remotePort, alias });
  if (!server) process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 250).unref();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));
if (alias === "slow-host") {
  record({ event: "waiting", localPort, remotePort, alias });
  setInterval(() => undefined, 1000);
} else {
  server = createServer((local) => {
    const remote = connect(remotePort, "127.0.0.1");
    local.pipe(remote).pipe(local);
    const close = () => { local.destroy(); remote.destroy(); };
    local.on("error", close);
    remote.on("error", close);
  });
  server.listen(localPort, "127.0.0.1", () => record({ event: "listening", localPort, remotePort, alias }));
  server.on("error", (error) => { process.stderr.write(String(error.message) + "\\n"); process.exit(255); });
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);
}

async function readSshLog() {
  try {
    return (await readFile(fakeSshLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function waitForSshLog(predicate, description) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const match = (await readSshLog()).find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`electron_smoke_ssh_log_timeout:${description}`);
}

async function waitForSshTermination(processId, description) {
  if (process.platform === "win32") {
    await waitForProcessExit(processId, 10_000);
    return;
  }
  await waitForSshLog(
    (entry) => entry.event === "signal" && entry.pid === processId,
    description,
  );
}

async function expectPortClosed(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = connectSocket(port, "127.0.0.1");
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 1_000);
      socket.once("connect", () => {
        clearTimeout(timeout);
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
    if (!open) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`electron_smoke_managed_port_still_open:${port}`);
}

function assertOldStreamClosedBeforeSession(oldLabel, newLabel) {
  const closeIndex = lifecycle.lastIndexOf(`${oldLabel}:events-close`);
  const sessionIndex = lifecycle.lastIndexOf(`${newLabel}:session`);
  if (closeIndex < 0 || sessionIndex < 0 || closeIndex > sessionIndex) {
    throw new Error(
      `electron_smoke_stream_teardown_order_invalid:${oldLabel}:${newLabel}:${JSON.stringify(lifecycle)}`,
    );
  }
}

async function launchElectron() {
  const unpackedRoot = path.join(
    electronRoot,
    "dist",
    electronBuilderUnpackedDirectory(process.platform, process.arch),
  );
  const executablePath = packaged
    ? process.platform === "darwin"
      ? path.join(unpackedRoot, "Sedes.app", "Contents", "MacOS", "Sedes")
      : path.join(
          unpackedRoot,
          process.platform === "win32" ? "Sedes.exe" : "sedes-electron",
        )
    : path.join(
        electronRoot,
        "node_modules",
        "electron",
        "dist",
        process.platform === "win32" ? "electron.exe" : "electron",
      );
  const app = await electron.launch({
    executablePath,
    args: [
      ...(packaged ? [] : [electronRoot]),
      `--user-data-dir=${userDataDirectory}`,
    ],
    cwd: packaged ? launchHomeDirectory : electronRoot,
    env: {
      ...process.env,
      HOME: launchHomeDirectory,
      PATH: `${fakeSshDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      SEDES_ELECTRON_SMOKE_SSH_LOG: fakeSshLog,
      ...(process.platform === "win32"
        ? {
            SEDES_ELECTRON_SMOKE_SSH_SCRIPT: path.join(fakeSshDirectory, "ssh"),
          }
        : {}),
      ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    },
  });
  const processId = app.process().pid;
  if (!processId) throw new Error("electron_smoke_process_id_unavailable");
  electronProcessIds.add(processId);
  return { app, page: await app.firstWindow() };
}

async function closeElectron(app) {
  const processId = app.process().pid;
  if (!processId) throw new Error("electron_smoke_process_id_unavailable");
  const ownedProcessIds = new Set([processId]);
  try {
    for (const ownedProcessId of await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().map(({ pid }) => pid),
    )) {
      if (ownedProcessId > 0) ownedProcessIds.add(ownedProcessId);
    }
  } catch (error) {
    if (isProcessAlive(processId)) throw error;
  }
  for (const ownedProcessId of ownedProcessIds) {
    electronProcessIds.add(ownedProcessId);
  }
  // Playwright's Electron close promise can remain pending when an app-owned
  // before-quit handler closes its Node debugging channel before the
  // dispatcher emits `close`. Initiate the supported close path, then make
  // the bounded exact-process checks below authoritative.
  void app.close().catch(() => undefined);
  try {
    await waitForProcessExit(processId, PROCESS_EXIT_TIMEOUT_MILLISECONDS);
  } catch (error) {
    await terminateProcess(processId, "Electron");
    throw new Error(`electron_smoke_close_timeout:${processId}`, {
      cause: error,
    });
  }
  const residualProcessIds = [];
  for (const ownedProcessId of ownedProcessIds) {
    try {
      await waitForProcessExit(
        ownedProcessId,
        PROCESS_TERM_TIMEOUT_MILLISECONDS,
      );
    } catch {
      residualProcessIds.push(ownedProcessId);
      await terminateProcess(ownedProcessId, "Electron descendant");
    } finally {
      electronProcessIds.delete(ownedProcessId);
    }
  }
  if (residualProcessIds.length > 0) {
    throw new Error(
      `electron_smoke_electron_descendants_leaked:${residualProcessIds.join(",")}`,
    );
  }
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(processId, timeoutMilliseconds) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    if (!isProcessAlive(processId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (isProcessAlive(processId)) {
    throw new Error(`electron_smoke_process_exit_timeout:${processId}`);
  }
}

async function terminateProcess(processId, label) {
  if (!isProcessAlive(processId)) return;
  signalProcess(processId, "SIGTERM");
  try {
    await waitForProcessExit(processId, PROCESS_TERM_TIMEOUT_MILLISECONDS);
    return;
  } catch {
    // Escalate only the exact fixture process after the bounded grace period.
  }
  signalProcess(processId, "SIGKILL");
  try {
    await waitForProcessExit(processId, PROCESS_KILL_TIMEOUT_MILLISECONDS);
  } catch (error) {
    throw new Error(
      `electron_smoke_${label.toLowerCase().replaceAll(" ", "_")}_process_leaked:${processId}`,
      { cause: error },
    );
  }
}

function signalProcess(processId, signal) {
  try {
    process.kill(processId, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function cleanupFixtureProcesses() {
  const failures = [];
  const sshProcessIds = new Set(
    (await readSshLog())
      .filter((entry) => entry.event === "start")
      .map((entry) => entry.pid),
  );
  for (const processId of sshProcessIds) {
    try {
      await terminateProcess(processId, "fake SSH");
    } catch (error) {
      failures.push(error);
    }
  }
  for (const processId of electronProcessIds) {
    try {
      await terminateProcess(processId, "Electron");
    } catch (error) {
      failures.push(error);
    } finally {
      electronProcessIds.delete(processId);
    }
  }
  const leaked = [...sshProcessIds, ...electronProcessIds].filter(
    (processId) => {
      try {
        return isProcessAlive(processId);
      } catch (error) {
        failures.push(error);
        return true;
      }
    },
  );
  if (leaked.length > 0) {
    failures.push(
      new Error(`electron_smoke_fixture_processes_leaked:${leaked.join(",")}`),
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "electron_smoke_fixture_process_cleanup_failed",
    );
  }
}

async function waitForConnected(page) {
  try {
    await page
      .getByRole("heading", { name: "What should the agent work on?" })
      .waitFor({ timeout: 75_000 });
  } catch (error) {
    const [body, runtime] = await Promise.all([
      page
        .locator("body")
        .innerText()
        .catch(() => "<body unavailable>"),
      connectionRuntimeStatus(page).catch((runtimeError) => ({
        unavailable: String(runtimeError),
      })),
    ]);
    throw new Error(
      `electron_smoke_connection_timeout:${JSON.stringify({ body, runtime })}`,
      { cause: error },
    );
  }
}

async function pairBackend(page, backend) {
  await page.getByRole("heading", { name: "Pair with this server" }).waitFor();
  const code = backend.issuePairingCode();
  await page.getByLabel("Pairing URL or code").fill(code);
  await page.getByRole("button", { name: "Pair connection", exact: true }).click();
  await waitForConnected(page);
  const replay = await fetch(`${backend.origin}/api/auth/pair`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: code, kind: "device", clientName: "Replay" }),
  });
  if (replay.status !== 401) throw new Error("electron_smoke_pairing_code_replay_accepted");
}

async function selectedProfileId(page) {
  return page.evaluate(async () => {
    const { value } = await window.Capacitor.Plugins.Preferences.get({ key: "sedes.electron.connections.v1" });
    return JSON.parse(value).selectedProfileId;
  });
}

async function openChooser(page) {
  await page.getByRole("button", { name: "Settings" }).click();
  const categoryPicker = page.getByLabel("Settings category", { exact: true });
  if (await categoryPicker.isVisible()) {
    await categoryPicker.selectOption("connection");
  } else {
    await page.getByRole("navigation", { name: "Settings pages" })
      .getByRole("button", { name: "Connection", exact: true }).click();
  }
  await page.getByRole("button", { name: "Switch connection" }).click();
  await page
    .getByRole("heading", { name: "Choose a Sedes connection" })
    .waitFor();
}

async function fillConnectionEditor(
  page,
  { name, kind = "direct", baseUrl, sshHost, remotePort },
) {
  await page.getByLabel("Name").fill(name);
  if (kind === "ssh") {
    await page.getByRole("radio", { name: /^SSH/u }).click();
    await page.getByLabel("SSH host alias").fill(sshHost);
    await page.getByLabel("Remote Sedes port").fill(String(remotePort));
  } else {
    await page.getByLabel("Sedes server URL").fill(baseUrl);
  }
  await page.getByRole("button", { name: "Save & connect" }).click();
}

async function addConnection(page, input) {
  await page.getByRole("button", { name: "Add connection" }).click();
  await fillConnectionEditor(page, input);
}

async function connectionRuntimeStatus(page) {
  return page.evaluate(() =>
    window.Capacitor.Plugins.ElectronConnectionRuntime.getStatus(),
  );
}

async function confirmSwitchFromLocal(page, connectionName) {
  await page
    .getByRole("heading", { name: "Switch away from Local?" })
    .waitFor();
  await page
    .getByRole("button", { name: `Connect to ${connectionName}` })
    .click();
}

function portFromLoopbackOrigin(baseUrl) {
  const port = Number(new URL(baseUrl).port);
  if (!Number.isInteger(port) || port < 1) {
    throw new Error(`electron_smoke_managed_origin_invalid:${baseUrl}`);
  }
  return port;
}

async function verifyElectronSecurity(app, page, backendOrigin) {
  const state = await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      count: BrowserWindow.getAllWindows().length,
      url: window?.webContents.getURL(),
      preferences: window?.webContents.getLastWebPreferences(),
    };
  });
  if (
    state.count !== 1 ||
    !state.url?.startsWith(expectedOrigin) ||
    state.preferences?.nodeIntegration !== false ||
    state.preferences?.contextIsolation !== true ||
    state.preferences?.sandbox !== true
  ) {
    throw new Error(
      `electron_smoke_web_preferences_invalid:${JSON.stringify(state)}`,
    );
  }
  const globals = await page.evaluate(() => ({
    process: typeof window.process,
    require: typeof window.require,
  }));
  if (globals.process !== "undefined" || globals.require !== "undefined")
    throw new Error("electron_smoke_node_globals_exposed");
  const popupDenied = await page.evaluate(
    () => window.open("https://attacker.invalid/popup") === null,
  );
  await page.waitForTimeout(100);
  if (!popupDenied || (await app.windows()).length !== 1)
    throw new Error("electron_smoke_popup_not_denied");
  const permission = await page.evaluate(async () =>
    navigator.permissions
      .query({ name: "geolocation" })
      .then(({ state: value }) => value),
  );
  if (permission !== "denied")
    throw new Error(`electron_smoke_geolocation_not_denied:${permission}`);

  const clipboardBefore = await app.evaluate(({ clipboard }) =>
    clipboard.readText(),
  );
  try {
    const marker = `sedes-electron-smoke-${Date.now()}`;
    const result = await page.evaluate(async (value) => {
      await navigator.clipboard.writeText(value);
      try {
        await navigator.clipboard.readText();
        return { denied: false };
      } catch (error) {
        return {
          denied: true,
          name:
            error instanceof DOMException
              ? error.name
              : error?.constructor?.name,
        };
      }
    }, marker);
    if (!result.denied || result.name !== "NotAllowedError")
      throw new Error("electron_smoke_clipboard_read_not_denied");
    if (
      (await app.evaluate(({ clipboard }) => clipboard.readText())) !== marker
    )
      throw new Error("electron_smoke_clipboard_write_failed");
  } finally {
    await app.evaluate(
      ({ clipboard }, previous) => clipboard.writeText(previous),
      clipboardBefore,
    );
  }
  const message = await page.evaluate(
    async (origin) => {
      const { value } = await window.Capacitor.Plugins.Preferences.get({ key: "sedes.electron.connections.v1" });
      const profileId = JSON.parse(value).selectedProfileId;
      const { credential } = await window.Capacitor.Plugins.ClientCredentials.getCredential({ profileId, serverUrl: origin });
      if (!credential || value.includes(credential)) throw new Error("electron_smoke_saved_credential_invalid");
      const wrongOrigin = await window.Capacitor.Plugins.ClientCredentials.getCredential({ profileId, serverUrl: "https://attacker.invalid" });
      const wrongProfile = await window.Capacitor.Plugins.ClientCredentials.getCredential({ profileId: "unrelated-profile", serverUrl: origin });
      if (wrongOrigin.credential || wrongProfile.credential) throw new Error("electron_smoke_credential_scope_leaked");
      const response = await fetch(`${origin}/api/electron-smoke-ws-ticket`, {
        headers: { Authorization: `Bearer ${credential}` }, redirect: "error",
      });
      if (!response.ok) throw new Error("electron_smoke_ws_ticket_refused");
      const { ticket } = await response.json();
      const url = `${origin.replace(/^http/u, "ws")}/electron-smoke?ticket=${ticket}`;
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timeout = setTimeout(
          () => reject(new Error("electron_smoke_websocket_timeout")),
          8_000,
        );
        socket.addEventListener("message", (event) => {
          clearTimeout(timeout);
          resolve(event.data);
        });
        socket.addEventListener("error", () => {
          clearTimeout(timeout);
          reject(new Error("electron_smoke_websocket_failed"));
        });
      });
    },
    backendOrigin,
  );
  if (message !== "ready")
    throw new Error("electron_smoke_websocket_message_invalid");
}

async function verifyRendererNavigationDenied(app, page) {
  await page.evaluate(() => {
    window.location.href = "https://attacker.invalid/navigation";
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  const url = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.getURL(),
  );
  if (!url?.startsWith(expectedOrigin)) {
    throw new Error(`electron_smoke_navigation_not_denied:${url}`);
  }
}

async function verifyDownload(app, page, backendOrigin) {
  const downloadPath = path.join(userDataDirectory, "electron-smoke.txt");
  await app.evaluate(({ dialog }, savePath) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: savePath,
    });
  }, downloadPath);
  const common = {
    profileId: await selectedProfileId(page),
    serverOrigin: backendOrigin,
    suggestedFileName: "electron-smoke.txt",
    expectedContentDisposition: 'attachment; filename="electron-smoke.txt"',
    expectedContentLength: Buffer.byteLength("electron smoke download\n"),
    expectedRevision: "electron-smoke-revision",
  };
  const download = await page.evaluate(
    async (input) =>
      window.Capacitor.Plugins.WorkspaceFileDownload.downloadFile(input),
    {
      ...common,
      transferId: "10000000-0000-4000-8000-000000000099",
      url: `${backendOrigin}/api/electron-smoke-download`,
    },
  );
  if (
    download.action !== "saved" ||
    (await readFile(downloadPath, "utf8")) !== "electron smoke download\n"
  )
    throw new Error("electron_smoke_download_failed");
  const mismatch = await page.evaluate(
    async (input) => {
      try {
        await window.Capacitor.Plugins.WorkspaceFileDownload.downloadFile(
          input,
        );
        return null;
      } catch (error) {
        return error?.code;
      }
    },
    {
      ...common,
      transferId: "10000000-0000-4000-8000-000000000097",
      url: `${backendOrigin}/api/electron-smoke-stale-download`,
    },
  );
  if (mismatch !== "download_revision_mismatch")
    throw new Error("electron_smoke_download_revision_mismatch_not_reported");
  const rejected = await page.evaluate(async () => {
    try {
      await window.Capacitor.Plugins.WorkspaceFileDownload.downloadFile({
        transferId: "10000000-0000-4000-8000-000000000098",
        serverOrigin: "http://127.0.0.1:1",
        url: "https://attacker.invalid/api/download",
        suggestedFileName: "attack.txt",
        expectedContentDisposition: 'attachment; filename="attack.txt"',
        expectedContentLength: 1,
        expectedRevision: "attacker-revision",
      });
      return null;
    } catch (error) {
      return error?.code;
    }
  });
  if (rejected !== "workspace_file_download_input_invalid")
    throw new Error("electron_smoke_download_origin_not_rejected");
}

function verifyOrigins() {
  for (const backend of backends)
    for (const [channel, origins] of Object.entries(backend.observed)) {
      if (origins.some((origin) => origin !== expectedOrigin))
        throw new Error(
          `electron_smoke_${backend.label}_${channel}_origin_invalid:${JSON.stringify(origins)}`,
        );
    }
  if (
    !directA.observed.sessionOrigins.length ||
    !directA.observed.eventOrigins.length ||
    !directA.observed.downloadOrigins.length ||
    !directA.observed.webSocketOrigins.length ||
    !directB.observed.sessionOrigins.length ||
    !directB.observed.eventOrigins.length ||
    !sshRemote.observed.sessionOrigins.length ||
    !sshRemote.observed.eventOrigins.length
  ) {
    throw new Error(
      `electron_smoke_expected_requests_missing:${JSON.stringify(backends.map(({ label, observed }) => ({ label, observed })))}`,
    );
  }
}

let electronApp;
try {
  await installFakeSsh();
  await Promise.all(backends.map(listen));
  for (const backend of backends) {
    const unauthorized = await fetch(`${backend.origin}/api/application/session`);
    if (unauthorized.status !== 401) throw new Error("electron_smoke_fixture_authentication_missing");
  }
  progress("launching fresh profile");
  let launched = await launchElectron();
  electronApp = launched.app;
  let page = launched.page;
  const credentialStorage = await electronApp.evaluate(({ safeStorage }) => ({
    available: safeStorage.isEncryptionAvailable(),
    backend: process.platform === "linux" ? safeStorage.getSelectedStorageBackend() : "platform-keychain",
  }));
  if (!credentialStorage.available || credentialStorage.backend === "basic_text") {
    throw new Error(`electron_smoke_secure_storage_unavailable:configure_OS_keyring:${credentialStorage.backend}`);
  }

  await page
    .getByRole("heading", { name: "Choose a Sedes connection" })
    .waitFor();
  const localCard = page.getByRole("listitem").filter({ hasText: "Local" });
  await localCard.getByRole("button", { name: "Connect" }).click();
  await waitForConnected(page);
  const firstLocalStatus = await connectionRuntimeStatus(page);
  if (firstLocalStatus.local.status !== "connected") {
    throw new Error(
      `electron_smoke_local_not_connected:${JSON.stringify(firstLocalStatus)}`,
    );
  }
  const firstLocalPort = portFromLoopbackOrigin(firstLocalStatus.local.baseUrl);
  const seededConfiguration = JSON.parse(
    await readFile(
      path.join(userDataDirectory, "managed-local", "config", "server.json"),
      "utf8",
    ),
  );
  if (
    seededConfiguration.schemaVersion !== 11 ||
    Object.keys(seededConfiguration).some(key => !["schemaVersion", "packagedClients", "listen"].includes(key)) ||
    JSON.stringify(seededConfiguration.packagedClients) !==
      JSON.stringify(["electron"])
  ) {
    throw new Error("electron_smoke_local_configuration_not_seeded");
  }
  progress("managed Local profile connected from packaged runtime");

  await openChooser(page);
  await page.getByText("Currently running", { exact: true }).waitFor();
  await addConnection(page, {
    name: "Direct A",
    baseUrl: directA.origin,
  });
  const retainedBeforeConfirmation = await connectionRuntimeStatus(page);
  if (
    retainedBeforeConfirmation.local.status !== "connected" ||
    retainedBeforeConfirmation.local.connectionId !==
      firstLocalStatus.local.connectionId
  ) {
    throw new Error("electron_smoke_local_not_retained_before_confirmation");
  }
  await confirmSwitchFromLocal(page, "Direct A");
  await pairBackend(page, directA);
  await waitForConnected(page);
  await expectPortClosed(firstLocalPort);
  progress("first direct profile connected");
  await verifyElectronSecurity(electronApp, page, directA.origin);
  await verifyDownload(electronApp, page, directA.origin);
  progress("security and download checks passed");

  await openChooser(page);
  await page.getByText("Direct A", { exact: true }).waitFor();
  await addConnection(page, { name: "Direct B", baseUrl: directB.origin });
  await pairBackend(page, directB);
  await waitForConnected(page);
  assertOldStreamClosedBeforeSession("direct-a", "direct-b");
  progress("second direct profile connected");

  await openChooser(page);
  await addConnection(page, {
    name: "SSH Remote",
    kind: "ssh",
    sshHost: "smoke-host",
    remotePort: new URL(sshRemote.origin).port,
  });
  await pairBackend(page, sshRemote);
  await waitForConnected(page);
  assertOldStreamClosedBeforeSession("direct-b", "ssh-remote");
  progress("managed SSH profile connected");
  const firstTunnel = await waitForSshLog(
    (entry) => entry.event === "listening" && entry.alias === "smoke-host",
    "first managed tunnel",
  );
  const firstInvocation = (await readSshLog()).find(
    (entry) => entry.event === "start" && entry.pid === firstTunnel.pid,
  );
  const requiredArguments = [
    "-T",
    "BatchMode=yes",
    "NumberOfPasswordPrompts=0",
    "ForwardAgent=no",
    "ForwardX11=no",
    "PermitLocalCommand=no",
    "ControlMaster=no",
    "ExitOnForwardFailure=yes",
    "GatewayPorts=no",
    "-N",
  ];
  if (
    !firstInvocation ||
    firstInvocation.args.at(-1) !== "smoke-host" ||
    !requiredArguments.every((value) => firstInvocation.args.includes(value)) ||
    !firstInvocation.args.includes(
      `127.0.0.1:${firstTunnel.localPort}:127.0.0.1:${new URL(sshRemote.origin).port}`,
    )
  )
    throw new Error(
      `electron_smoke_ssh_arguments_invalid:${JSON.stringify(firstInvocation)}`,
    );

  await closeElectron(electronApp);
  electronApp = undefined;
  await waitForSshTermination(firstTunnel.pid, "app-close tunnel teardown");
  await expectPortClosed(firstTunnel.localPort);

  launched = await launchElectron();
  electronApp = launched.app;
  page = launched.page;
  await waitForConnected(page);
  const secondTunnel = await waitForSshLog(
    (entry) =>
      entry.event === "listening" &&
      entry.alias === "smoke-host" &&
      entry.pid !== firstTunnel.pid,
    "relaunch selected SSH profile",
  );
  await openChooser(page);
  await waitForSshTermination(secondTunnel.pid, "switch tunnel teardown");
  await expectPortClosed(secondTunnel.localPort);

  await addConnection(page, {
    name: "Bad SSH",
    kind: "ssh",
    sshHost: "fail-auth",
    remotePort: new URL(sshRemote.origin).port,
  });
  await page.getByText("SSH authentication failed", { exact: false }).waitFor();
  await waitForSshLog(
    (entry) =>
      entry.event === "failure" &&
      entry.alias === "fail-auth" &&
      entry.code === 255,
    "SSH exit 255",
  );

  await addConnection(page, {
    name: "Slow SSH",
    kind: "ssh",
    sshHost: "slow-host",
    remotePort: new URL(sshRemote.origin).port,
  });
  const slowStart = await waitForSshLog(
    (entry) => entry.event === "waiting" && entry.alias === "slow-host",
    "cancellable SSH setup",
  );
  await page
    .getByRole("button", { name: "Cancel", exact: true })
    .first()
    .click();
  await waitForSshTermination(slowStart.pid, "cancelled SSH setup teardown");
  await page
    .getByRole("listitem")
    .filter({ hasText: "Slow SSH" })
    .getByRole("button", { name: "Connect" })
    .waitFor();

  const directBCard = page
    .getByRole("listitem")
    .filter({ hasText: "Direct B" });
  await directBCard.getByRole("button", { name: "Connect" }).click();
  await waitForConnected(page);
  await closeElectron(electronApp);
  electronApp = undefined;
  const sessionsBeforeRelaunch = directB.observed.sessionOrigins.length;

  launched = await launchElectron();
  electronApp = launched.app;
  page = launched.page;
  await waitForConnected(page);
  if (directB.observed.sessionOrigins.length <= sessionsBeforeRelaunch)
    throw new Error(
      "electron_smoke_direct_profile_not_reconnected_on_relaunch",
    );
  await closeElectron(electronApp);
  electronApp = undefined;

  directB.setSessionFailure(true);
  launched = await launchElectron();
  electronApp = launched.app;
  page = launched.page;
  await page
    .getByRole("heading", { name: "Choose a Sedes connection" })
    .waitFor({ timeout: 20_000 });
  const failedDirectCard = page
    .getByRole("listitem")
    .filter({ hasText: "Direct B" });
  await failedDirectCard.getByRole("alert").waitFor();
  directB.setSessionFailure(false);
  await failedDirectCard.getByRole("button", { name: "Connect" }).click();
  await waitForConnected(page);

  await openChooser(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Local" })
    .getByRole("button", { name: "Connect" })
    .click();
  await waitForConnected(page);
  const rollbackLocalStatus = await connectionRuntimeStatus(page);
  if (rollbackLocalStatus.local.status !== "connected") {
    throw new Error("electron_smoke_rollback_local_not_connected");
  }
  const rollbackLocalPort = portFromLoopbackOrigin(
    rollbackLocalStatus.local.baseUrl,
  );

  directB.setSessionFailure(true);
  await openChooser(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Direct B" })
    .getByRole("button", { name: "Connect" })
    .click();
  await confirmSwitchFromLocal(page, "Direct B");
  await waitForConnected(page);
  await page
    .getByRole("alert")
    .filter({ hasText: "Local is still running" })
    .waitFor();
  const restoredLocalStatus = await connectionRuntimeStatus(page);
  if (
    restoredLocalStatus.local.status !== "connected" ||
    restoredLocalStatus.local.connectionId !==
      rollbackLocalStatus.local.connectionId ||
    restoredLocalStatus.local.baseUrl !== rollbackLocalStatus.local.baseUrl
  ) {
    throw new Error("electron_smoke_failed_switch_did_not_restore_exact_local");
  }
  directB.setSessionFailure(false);
  progress("failed replacement restored the exact Local process");

  await openChooser(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Direct B" })
    .getByRole("button", { name: "Connect" })
    .click();
  await confirmSwitchFromLocal(page, "Direct B");
  await waitForConnected(page);
  await expectPortClosed(rollbackLocalPort);
  progress("confirmed successful replacement stopped Local");

  await openChooser(page);
  await page
    .getByRole("listitem")
    .filter({ hasText: "Local" })
    .getByRole("button", { name: "Connect" })
    .click();
  await waitForConnected(page);
  const quitLocalStatus = await connectionRuntimeStatus(page);
  if (quitLocalStatus.local.status !== "connected") {
    throw new Error("electron_smoke_quit_local_not_connected");
  }
  const quitLocalPort = portFromLoopbackOrigin(quitLocalStatus.local.baseUrl);
  await closeElectron(electronApp);
  electronApp = undefined;
  await expectPortClosed(quitLocalPort);

  launched = await launchElectron();
  electronApp = launched.app;
  page = launched.page;
  await waitForConnected(page);
  const relaunchedLocalStatus = await connectionRuntimeStatus(page);
  if (
    relaunchedLocalStatus.local.status !== "connected" ||
    relaunchedLocalStatus.local.connectionId ===
      quitLocalStatus.local.connectionId
  ) {
    throw new Error("electron_smoke_local_not_restarted_for_new_app_session");
  }

  await openChooser(page);
  const autoConnectAtStartup = page.getByRole("checkbox", {
    name: "Connect automatically at startup",
  });
  if ((await autoConnectAtStartup.getAttribute("aria-checked")) !== "true") {
    throw new Error("electron_smoke_auto_connect_not_defaulted_on");
  }
  if (/\bElectron\b/u.test(await page.locator("body").innerText())) {
    throw new Error("electron_smoke_implementation_stack_visible");
  }
  await autoConnectAtStartup.click();
  await page.waitForFunction(() =>
    Boolean(document.querySelector('[role="checkbox"][aria-checked="false"]')),
  );
  if ((await autoConnectAtStartup.getAttribute("aria-checked")) !== "false") {
    throw new Error("electron_smoke_auto_connect_not_disabled");
  }
  const optedOutLocalPort = portFromLoopbackOrigin(
    relaunchedLocalStatus.local.baseUrl,
  );
  await closeElectron(electronApp);
  electronApp = undefined;
  await expectPortClosed(optedOutLocalPort);

  launched = await launchElectron();
  electronApp = launched.app;
  page = launched.page;
  await page
    .getByRole("heading", { name: "Choose a Sedes connection" })
    .waitFor();
  const optedOutStatus = await connectionRuntimeStatus(page);
  if (optedOutStatus.local.status !== "disconnected") {
    throw new Error("electron_smoke_auto_connect_opt_out_started_local");
  }
  if (
    (await page
      .getByRole("checkbox", { name: "Connect automatically at startup" })
      .getAttribute("aria-checked")) !== "false"
  ) {
    throw new Error("electron_smoke_auto_connect_opt_out_not_persisted");
  }
  await page
    .getByRole("listitem")
    .filter({ hasText: "Local" })
    .getByRole("button", { name: "Connect" })
    .click();
  await waitForConnected(page);
  const manuallyStartedLocalStatus = await connectionRuntimeStatus(page);
  if (manuallyStartedLocalStatus.local.status !== "connected") {
    throw new Error("electron_smoke_manual_local_after_opt_out_failed");
  }
  progress(
    "startup auto-connect opt-out persisted and manual Local still connected",
  );

  if (directA.pairedCount !== 1 || directB.pairedCount !== 1 || sshRemote.pairedCount !== 1) {
    throw new Error("electron_smoke_saved_authentication_not_reused");
  }
  verifyOrigins();
  await verifyRendererNavigationDenied(electronApp, page);
  process.stdout.write(
    "Electron smoke passed: first-run managed Local startup, seeded private configuration, retained-Local confirmation, exact rollback and successful teardown, app-exit cleanup and next-session restart, persisted startup auto-connect opt-out with manual Local connection, single-use device pairing and encrypted per-profile credential reuse after relaunch, multiple Direct profiles with authenticated SSE teardown ordering, managed SSH forwarding/failure/cancellation/teardown, selected-profile relaunch and recovery, bundled-origin API/SSE/one-shot-WS/downloads, and Electron navigation/popup/permission/Node isolation all passed.\n",
  );
} catch (error) {
  console.error("Electron smoke failed before cleanup:", error);
  throw error;
} finally {
  const cleanupFailures = [];
  if (electronApp) {
    try {
      await closeElectron(electronApp);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  try {
    await cleanupFixtureProcesses();
  } catch (error) {
    cleanupFailures.push(error);
  }
  for (const backend of backends) {
    try {
      await closeBackend(backend);
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  for (const directory of [
    userDataDirectory,
    fakeSshDirectory,
    launchHomeDirectory,
  ]) {
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(error);
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, "electron_smoke_cleanup_failed");
  }
}

// Playwright can retain its in-process Electron dispatcher handle after an
// application-owned deferred quit even though the exact application and every
// tracked descendant are gone. This standalone smoke child reaches this point
// only after the cleanup contract above has completed successfully.
process.exit(0);
