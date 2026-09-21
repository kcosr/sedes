import path from "node:path";
import { readFileSync } from "node:fs";
import { app } from "electron";
import { nativeCredentialStore } from "@sedes/electron-client-credentials/electron/dist/plugin.mjs";
import { LocalServerManager } from "./local-server-manager.mjs";
import { SshPortStore } from "./ssh-port-store.mjs";
import { SshTunnelManager, validateDisconnectInput } from "./ssh-tunnel-manager.mjs";

// This immutable build manifest is native-owned. Renderer preferences and
// environment variables never grant local process authority.
export function readDistribution(appPath) {
  const value = JSON.parse(readFileSync(path.join(appPath, "generated", "distribution.json"), "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !["client", "full"].includes(value.profile)) {
    throw new Error("electron_distribution_invalid");
  }
  return Object.freeze({ profile: value.profile });
}

export class ConnectionRuntimeManager {
  #local;
  #ssh;

  constructor(input) {
    this.#local = input.local;
    this.#ssh = input.ssh;
  }

  connectSsh(input) {
    return this.#ssh.connect(input);
  }

  async startLocal(input) {
    if (!this.#local) throw Object.assign(new Error("Local is unavailable in this Sedes client distribution."), { code: "local_server_unavailable" });
    return this.#local.start(input);
  }

  getCapabilities() {
    return Object.freeze({ localServer: Boolean(this.#local) });
  }

  async disconnect(input) {
    const connectionId = validateDisconnectInput(input);
    await Promise.all([
      this.#local?.disconnect({ connectionId }),
      this.#ssh.disconnect({ connectionId }),
    ]);
  }

  getStatus() {
    return Object.freeze({
      local: this.#local?.getStatus() ?? Object.freeze({ status: "disconnected" }),
      ssh: this.#ssh.getStatus(),
    });
  }

  async disconnectAll() {
    const outcomes = await Promise.allSettled([
      this.#local?.disconnectAll(),
      this.#ssh.disconnectAll(),
    ]);
    const failures = outcomes
      .filter((outcome) => outcome.status === "rejected")
      .map((outcome) => outcome.reason);
    if (failures.length) {
      throw new AggregateError(
        failures,
        "The managed Electron connection resources could not be stopped.",
      );
    }
  }
}

class ElectronConnectionRuntimeImpl {
  #allowQuit = false;
  #app;
  #manager;
  #quitPromise;

  constructor(context, dependencies = {}) {
    this.#app = dependencies.app ?? app;
    const notify = (kind) => (state) =>
      context.notifyListeners(
        "stateChange",
        Object.freeze({ kind, ...state }),
      );
    const distribution = dependencies.manager ? undefined : readDistribution(this.#app.getAppPath());
    this.#manager =
      dependencies.manager ??
      new ConnectionRuntimeManager({
        local: distribution.profile === "full" ? new LocalServerManager({
          electronExecutable: process.execPath,
          resourceRoot: this.#app.isPackaged
            ? path.join(process.resourcesPath, "local-server")
            : path.join(this.#app.getAppPath(), "generated", "local-server"),
          userDataDirectory: this.#app.getPath("userData"),
          notify: notify("local"),
          saveCredential: (input) => nativeCredentialStore().setCredential(input),
        }) : null,
        ssh: new SshTunnelManager({
          notify: notify("ssh"),
          reservePort: (input) => new SshPortStore(path.join(this.#app.getPath("userData"), "ssh-ports")).portFor(input),
        }),
      });
    this.#app.on("before-quit", (event) => {
      if (this.#allowQuit) return;
      if (!this.#hasResources() && !this.#quitPromise) return;
      event.preventDefault();
      this.#beginOwnedQuit();
    });
    this.#app.on("browser-window-created", (_event, window) => {
      window.webContents.once("render-process-gone", () =>
        this.#beginOwnedQuit(),
      );
      window.once("closed", () => this.#beginOwnedQuit());
    });
  }

  connectSsh(input) {
    return this.#manager.connectSsh(input);
  }

  startLocal(input) {
    return this.#manager.startLocal(input);
  }

  disconnect(input) {
    return this.#manager.disconnect(input);
  }

  getStatus() {
    return this.#manager.getStatus();
  }

  getCapabilities() {
    return this.#manager.getCapabilities();
  }

  #hasResources() {
    const status = this.#manager.getStatus();
    return (
      status.local.status !== "disconnected" ||
      status.ssh.status !== "disconnected"
    );
  }

  #beginOwnedQuit() {
    if (this.#allowQuit || this.#quitPromise) return;
    this.#quitPromise = this.#manager
      .disconnectAll()
      .then(() => {
        this.#allowQuit = true;
        this.#app.quit();
      })
      .catch((error) => {
        this.#quitPromise = undefined;
        console.error(
          "[sedes] Refusing to quit while managed connection resources could not be stopped.",
          error,
        );
      });
  }
}

ElectronConnectionRuntimeImpl.__capacitorElectronPlugin = {
  name: "ElectronConnectionRuntime",
  methods: ["connectSsh", "startLocal", "disconnect", "getStatus", "getCapabilities"],
};

export { ElectronConnectionRuntimeImpl as ElectronConnectionRuntime };
