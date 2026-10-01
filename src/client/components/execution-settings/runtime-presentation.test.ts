import { describe, expect, it } from "vitest";
import type { ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";
import { presentRuntime, worstStatus, type RuntimePresentationOptions } from "./runtime-presentation.js";
import { backendEditors, backendStopEffect } from "./backend-editors.js";

const environmentActions: ConfigurationRuntimeState["supportedActions"] = ["connect", "disconnect", "start", "stop", "restart", "upgrade"];
function runtime(overrides: Partial<ConfigurationRuntimeState> = {}): ConfigurationRuntimeState {
  return { resourceKind: "environment", resourceId: "environment-one", desiredRevision: 4, effectiveRevision: 4, applyState: "applied",
    preference: "automatic", connectionState: "connected", incarnation: "sidecar-one", softwareVersion: "build-1", upgradeState: "current",
    activeResources: 0, lastError: null, supportedActions: environmentActions, ...overrides };
}
const summarize = (state: ConfigurationRuntimeState | undefined, options: RuntimePresentationOptions = { resourceKind: "environment", sidecar: true }) => {
  const presented = presentRuntime(state, options);
  return { headline: presented.headline, qualifier: presented.qualifier, primary: presented.primary?.label, secondary: presented.secondary.map((entry) => entry.label), tone: presented.tone, pill: presented.pill.label };
};

describe("runtime presentation", () => {
  it("labels startup-only changes as pending restart while the provider stays connected", () => {
    const presented = presentRuntime(runtime({ resourceKind: "backend", startupEnvironmentPending: true, applyState: "pending", effectiveRevision: 3 }), { resourceKind: "backend", sidecar: false });
    expect(presented.headline).toBe("Connected");
    expect(presented.qualifier).toBe("Pending restart");
    expect(presented.detail).toContain("Saving did not restart the running provider");
    expect(presented.primary?.label).toBe("Restart");
  });
  it("explains an unknown command without incorrectly asking the user to connect again", () => {
    const presentation = presentRuntime(runtime({ connectionState: "unknown", lifecycleOperation: {
      mutationId: "31000000-0000-4000-8000-000000000002", action: "upgrade", state: "unknown",
    } }), { resourceKind: "environment", sidecar: true });
    expect(presentation.detail).toContain("previous upgrade and restart command has no confirmed outcome");
    expect(presentation.detail).toContain("Stop checks the earlier command");
    expect(presentation.detail).not.toContain("Connect to check it");
  });

  it.each([
    ["healthy", runtime(), { headline: "Connected", qualifier: undefined, primary: undefined, secondary: ["Restart", "Stop", "Disconnect"], tone: "success", pill: "Connected" }],
    ["upgrade required", runtime({ upgradeState: "required", applyState: "pending" }), { headline: "Connected", qualifier: "Upgrade required", primary: "Upgrade and restart", secondary: ["Stop", "Disconnect"], tone: "warning", pill: "Upgrade required" }],
    ["upgrade available", runtime({ upgradeState: "pending" }), { headline: "Connected", qualifier: "Upgrade available", primary: "Upgrade and restart", secondary: ["Stop", "Disconnect"], tone: "info", pill: "Upgrade available" }],
    ["changes pending", runtime({ applyState: "pending", effectiveRevision: 3 }), { headline: "Connected", qualifier: "Changes pending", primary: "Restart", secondary: ["Stop", "Disconnect"], tone: "warning", pill: "Changes pending" }],
    ["configuration not applied", runtime({ applyState: "unavailable" }), { headline: "Connected", qualifier: "Configuration not applied", primary: "Reapply configuration", secondary: ["Restart", "Stop", "Disconnect"], tone: "danger", pill: "Configuration not applied" }],
    ["intentionally disconnected", runtime({ connectionState: "disconnected", preference: "disconnected" }), { headline: "Intentionally disconnected", qualifier: undefined, primary: "Connect", secondary: ["Stop"], tone: "neutral", pill: "Intentionally disconnected" }],
    ["disconnected with upgrade", runtime({ connectionState: "disconnected", upgradeState: "pending" }), { headline: "Disconnected", qualifier: "Upgrade available", primary: "Connect", secondary: ["Disconnect", "Stop", "Upgrade and restart"], tone: "info", pill: "Upgrade available" }],
    ["intentionally stopped", runtime({ connectionState: "stopped", preference: "stopped" }), { headline: "Intentionally stopped", qualifier: undefined, primary: "Start", secondary: [], tone: "neutral", pill: "Intentionally stopped" }],
    ["unreachable", runtime({ connectionState: "unreachable", applyState: "unavailable" }), { headline: "Unreachable", qualifier: undefined, primary: "Retry connection", secondary: ["Stop", "Disconnect"], tone: "warning", pill: "Unreachable" }],
    ["recovery required", runtime({ connectionState: "recovery_required" }), { headline: "Recovery required", qualifier: undefined, primary: "Retry connection", secondary: ["Stop", "Disconnect"], tone: "danger", pill: "Recovery required" }],
    ["reconciling", runtime({ connectionState: "reconciling" }), { headline: "Reconciling", qualifier: undefined, primary: undefined, secondary: ["Stop", "Disconnect"], tone: "info", pill: "Reconciling" }],
    ["unknown", runtime({ connectionState: "unknown", applyState: "pending" }), { headline: "Status unknown", qualifier: "Changes pending", primary: "Connect", secondary: ["Stop", "Disconnect"], tone: "warning", pill: "Changes pending" }],
    ["not reported", undefined, { headline: "Status not reported", qualifier: undefined, primary: undefined, secondary: [], tone: "neutral", pill: "Status not reported" }],
  ] as const)("presents %s", (_name, state, expected) => {
    expect(summarize(state)).toEqual(expected);
  });

  it("offers only actions the server supports and never repeats one", () => {
    expect(summarize(runtime({ supportedActions: ["connect", "disconnect"] }))).toMatchObject({ primary: undefined, secondary: ["Disconnect"] });
    expect(summarize(runtime({ connectionState: "stopped", supportedActions: [] }))).toMatchObject({ primary: undefined, secondary: [] });
    expect(summarize(runtime({ connectionState: "recovery_required", supportedActions: ["connect", "disconnect", "start", "stop", "restart", "upgrade"] })).secondary).not.toContain("Retry connection");
  });

  it("offers Connect after retiring an external attachment without claiming its server stopped", () => {
    const state = runtime({ resourceKind: "backend", connectionState: "stopped", preference: "stopped", supportedActions: ["connect", "disconnect", "stop"] });
    const options: RuntimePresentationOptions = { resourceKind: "backend", sidecar: false, stopEffect: "attachment" };
    expect(presentRuntime(state, options)).toMatchObject({ headline: "Attachment retired", primary: { action: "connect" },
      detail: "Sedes is not attached to the external server. Connect to establish a new attachment." });
    expect(presentRuntime(state, { ...options, enabled: false }).primary).toBeUndefined();
    for (const connectionState of ["unreachable", "recovery_required"] as const) {
      const presentation = presentRuntime({ ...state, connectionState }, options);
      expect(presentation.detail).toContain(connectionState === "unreachable" ? "Stop only records" : "Shutdown is unconfirmed");
      expect(presentation.primary?.action).toBe("connect");
    }
  });

  it.each((["codex_app_server", "opencode"] as const).flatMap(kind => (["owned", "external"] as const).map(ownership => ({ kind, ownership }))))(
    "preserves truthful lifecycle guidance for $kind $ownership through the production effect helper", ({ kind, ownership }) => {
      const backend = backendEditors[kind].createBackend("backend");
      if (ownership === "external") {
        if (backend.kind === "opencode") backend.moduleConfiguration.connection = { ownership, channel: { type: "http", url: "http://127.0.0.1:4096",
          authentication: { type: "basic", username: "opencode", secret: { source: "protected_file", path: "/secrets/password" } } } };
        else if (backend.kind === "codex_app_server") backend.moduleConfiguration.connection = { ownership, channel: { type: "unix_websocket", socketPath: "/run/codex.sock" } };
      }
      const actions: ConfigurationRuntimeState["supportedActions"] = ownership === "external" && kind === "opencode"
        ? ["connect", "disconnect", "stop"] : ["connect", "disconnect", "start", "stop", "restart"];
      const options = { resourceKind: "backend" as const, sidecar: false, enabled: backend.enabled };
      const stopped = runtime({ resourceKind: "backend", resourceId: backend.id, connectionState: "stopped", preference: "stopped", supportedActions: actions });
      const stoppedPresentation = presentRuntime(stopped, { ...options, stopEffect: backendStopEffect(backend, stopped) });
      expect(stoppedPresentation.headline).toBe(ownership === "external" ? "Attachment retired" : "Intentionally stopped");
      expect(stoppedPresentation.primary?.action).toBe(ownership === "external" ? "connect" : "start");
      expect(stoppedPresentation.detail).not.toContain("Apply");
      expect(stoppedPresentation.detail).not.toContain("was left running");
      if (ownership === "owned") expect(stoppedPresentation.detail).toBe("The provider is stopped and will not start automatically.");

      for (const connectionState of ["unreachable", "recovery_required"] as const) {
        const unavailable = { ...stopped, preference: "automatic" as const, connectionState, applyState: "unavailable" as const };
        const presented = presentRuntime(unavailable, { ...options, stopEffect: backendStopEffect(backend, unavailable) });
        expect(presented.primary?.action).toBe("connect");
        expect(presented.secondary.map(action => action.action)).toEqual(["stop", "disconnect"]);
        expect(presented.detail).not.toContain("Stop ends");
        if (connectionState === "unreachable") {
          expect(presented.detail).toContain("Stop only records that the provider should not start automatically");
          expect(presented.detail).toContain("shutdown on the host is unconfirmed");
        } else {
          expect(presented.detail).toContain("Shutdown is unconfirmed until ownership can be verified");
          expect(presented.detail).toContain("Disconnect pauses automatic retries");
        }
      }
      const connected = { ...stopped, connectionState: "connected" as const, preference: "automatic" as const };
      expect(backendStopEffect(backend, connected)).toBe(ownership === "external" ? "attachment" : "service");
      expect(backendStopEffect(backend, { ...connected, applyState: "pending", effectiveRevision: 3 })).toBe("unknown");
      expect(backendStopEffect({ ...backend, enabled: false }, connected)).toBe("unknown");
    });

  it("offers Stop while a runtime is unreachable or awaiting ownership recovery", () => {
    const localBackend: ConfigurationRuntimeState["supportedActions"] = ["connect", "start", "stop", "restart"];
    const backend: RuntimePresentationOptions = { resourceKind: "backend", sidecar: false, enabled: true };
    const remote = presentRuntime(runtime({ connectionState: "unreachable", applyState: "unavailable" }), { resourceKind: "environment", sidecar: true });
    expect(remote.secondary).toEqual([{ action: "stop", label: "Stop", emphasis: "destructive" }, { action: "disconnect", label: "Disconnect", emphasis: "default" }]);
    expect(remote.detail).toBe("The remote host could not be reached; retained work on the host is kept. Reconnection is retried automatically. Stop only records that the sidecar should not start automatically; shutdown on the host is unconfirmed until it is reachable.");
    const local = presentRuntime(runtime({ resourceKind: "backend", connectionState: "unreachable", applyState: "unavailable", supportedActions: localBackend }), backend);
    expect(local.primary?.label).toBe("Retry connection");
    expect(local.secondary).toEqual([{ action: "stop", label: "Stop", emphasis: "destructive" }]);
    expect(local.detail).toBe("The provider could not be reached. Stop only records that the provider should not start automatically; shutdown on the host is unconfirmed until it is reachable.");
    const recovery = presentRuntime(runtime({ connectionState: "recovery_required" }), { resourceKind: "environment", sidecar: true });
    expect(recovery.secondary.map((entry) => entry.action)).toEqual(["stop", "disconnect"]);
    expect(recovery.detail).toBe("Sedes could not confirm ownership of a previous sidecar. Retry checks the host again; Stop checks whether this environment's owned processes can be ended. Disconnect pauses automatic retries. Shutdown is unconfirmed until ownership can be verified.");
    const localRecovery = presentRuntime(runtime({ resourceKind: "backend", connectionState: "recovery_required", supportedActions: localBackend }), backend);
    expect(localRecovery.secondary.map((entry) => entry.action)).toEqual(["stop"]);
    expect(localRecovery.detail).toBe("Sedes could not confirm the previous provider's state. Retry checks it again; Stop checks whether its owned runtime can be ended. Shutdown is unconfirmed until ownership can be verified.");
  });

  it("presents backend definitions that are disabled but still own a runtime", () => {
    const backend = { resourceKind: "backend" as const, sidecar: false, enabled: false };
    expect(summarize(runtime({ resourceKind: "backend", supportedActions: ["disconnect", "stop"] }), backend)).toMatchObject({ qualifier: "Backend disabled", primary: "Stop", secondary: ["Disconnect"], tone: "warning", pill: "Backend disabled" });
    expect(summarize(runtime({ resourceKind: "backend", connectionState: "stopped", supportedActions: ["disconnect", "stop"] }), backend)).toMatchObject({ qualifier: "Backend disabled", primary: undefined, secondary: [] });
    expect(summarize(runtime({ resourceKind: "backend", supportedActions: ["connect", "start", "stop", "restart"] }), { ...backend, enabled: true })).toMatchObject({ primary: undefined, secondary: ["Restart", "Stop"] });
  });

  it("names an unconfirmed command in the pill without hiding a failed apply", () => {
    const operation = { mutationId: "31000000-0000-4000-8000-000000000002", action: "connect" as const };
    expect(summarize(runtime({ connectionState: "unknown", lifecycleOperation: { ...operation, state: "unknown" } })))
      .toMatchObject({ headline: "Status unknown", qualifier: "Outcome unknown", tone: "warning", pill: "Outcome unknown" });
    expect(summarize(runtime({ lifecycleOperation: { ...operation, state: "pending" } })))
      .toMatchObject({ headline: "Connected", qualifier: "Checking outcome", tone: "info", pill: "Checking outcome" });
    expect(summarize(runtime({ applyState: "rejected", lifecycleOperation: { ...operation, state: "unknown" } })))
      .toMatchObject({ qualifier: "Configuration not applied", tone: "danger" });
  });

  it("lets the state that most needs attention win one pill, keeping the first on a tie", () => {
    expect(worstStatus({ label: "Host online", tone: "success" }, { label: "Status unknown", tone: "neutral" })).toEqual({ label: "Host online", tone: "success" });
    expect(worstStatus({ label: "Host online", tone: "success" }, { label: "Connected", tone: "success" })).toEqual({ label: "Host online", tone: "success" });
    expect(worstStatus({ label: "Host offline", tone: "warning" }, { label: "Recovery required", tone: "danger" })).toEqual({ label: "Recovery required", tone: "danger" });
    expect(worstStatus(undefined)).toEqual({ label: "Status not reported", tone: "neutral" });
  });

  it("flags retained results that need recovery", () => {
    expect(presentRuntime(runtime({ lastError: "Final terminal history or operation outcomes must be recovered before this service can stop." }), { resourceKind: "environment", sidecar: true }).recoveryEmphasis).toBe(true);
    expect(presentRuntime(runtime(), { resourceKind: "environment", sidecar: true }).recoveryEmphasis).toBe(false);
  });
});
