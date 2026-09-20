import type { ConfigurationLifecycleRequest, ConfigurationRuntimeState } from "../../../shared/protocol/configuration-admin.js";

export type RuntimeAction = ConfigurationLifecycleRequest["action"];

export const actionLabels: Record<RuntimeAction, string> = {
  connect: "Connect", disconnect: "Disconnect", start: "Start", stop: "Stop", restart: "Restart", upgrade: "Upgrade and restart",
};
export const preferenceLabels: Record<ConfigurationRuntimeState["preference"], string> = {
  automatic: "Reconnect automatically", disconnected: "Do not reconnect automatically", stopped: "Do not start automatically",
};
export const applyLabels: Record<ConfigurationRuntimeState["applyState"], string> = {
  pending: "Pending application", applied: "Applied", rejected: "Application rejected", unavailable: "Application unavailable",
};
export const upgradeLabels: Record<ConfigurationRuntimeState["upgradeState"], string> = {
  unknown: "Upgrade status unknown", current: "Up to date", pending: "Upgrade available", required: "Upgrade required",
};
const connectionLabels: Record<ConfigurationRuntimeState["connectionState"], string> = {
  unknown: "Status unknown", connected: "Connected", disconnected: "Disconnected", unreachable: "Unreachable", stopped: "Confirmed stopped", reconciling: "Reconciling", recovery_required: "Recovery required",
};

export function runtimeConnectionLabel(runtime?: ConfigurationRuntimeState): string {
  if (!runtime) return "Status not reported";
  if (runtime.connectionState === "disconnected" && runtime.preference === "disconnected") return "Intentionally disconnected";
  if (runtime.connectionState === "stopped" && runtime.preference === "stopped") return "Intentionally stopped";
  return connectionLabels[runtime.connectionState];
}

export interface RuntimeActionPresentation {
  readonly action: RuntimeAction;
  /** Visible label; differs from actionLabels when the same operation serves a clearer purpose. */
  readonly label: string;
  readonly emphasis: "default" | "destructive";
}

export interface RuntimePresentation {
  /** Always equals the inventory's connection label. */
  readonly headline: string;
  /** Short badge naming the one condition that most needs attention. */
  readonly qualifier?: string;
  readonly detail: string;
  readonly tone: "neutral" | "connected" | "attention";
  /** The action the operator most plausibly wants now; absent when none is likely. */
  readonly primary?: RuntimeActionPresentation;
  /** Rarer actions, shown behind a menu in menu order. */
  readonly secondary: readonly RuntimeActionPresentation[];
  /** Retained results probably need recovery before lifecycle actions can succeed. */
  readonly recoveryEmphasis: boolean;
}

export interface RuntimePresentationOptions {
  readonly resourceKind: "environment" | "backend";
  /** The resource runs a managed remote sidecar with its own software version. */
  readonly sidecar: boolean;
  /** A backend definition may be disabled while its runtime still exists. */
  readonly enabled?: boolean;
}

/**
 * Derives what to show and offer for one runtime. Only actions the server
 * advertises survive; an action is never offered twice. Overlays for busy,
 * unsettled and page-level states are applied by the component.
 */
export function presentRuntime(runtime: ConfigurationRuntimeState | undefined, options: RuntimePresentationOptions): RuntimePresentation {
  const environment = options.resourceKind === "environment";
  const noun = environment ? "sidecar" : "provider";
  if (!runtime) {
    return { headline: runtimeConnectionLabel(undefined), detail: `The server has not reported status for this ${environment ? "environment" : "backend"} yet.`, tone: "neutral", secondary: [], recoveryEmphasis: false };
  }
  const enabled = options.enabled ?? true;
  const headline = runtimeConnectionLabel(runtime);
  const automatic = runtime.preference === "automatic";
  const upgrade = options.sidecar ? runtime.upgradeState : "current";
  const upgradeQualifier = upgrade === "required" ? "Upgrade required" : upgrade === "pending" ? "Upgrade available" : undefined;
  const version = runtime.softwareVersion ?? "unknown version";
  const active = runtime.activeResources;
  const interruption = active > 0 ? ` ${active} resource${active === 1 ? "" : "s"} may be affected; review the interruption details before continuing.` : "";
  const act = (action: RuntimeAction, label = actionLabels[action], emphasis: RuntimeActionPresentation["emphasis"] = "default"): RuntimeActionPresentation => ({ action, label, emphasis });
  const retry = act("connect", "Retry connection");
  const disconnectable = runtime.supportedActions.includes("disconnect");
  const unconfirmedStop = (until: string) => ` Stop only records that the ${noun} should not start automatically; shutdown on the host is unconfirmed until ${until}.`;
  let qualifier: string | undefined;
  let detail: string;
  let tone: RuntimePresentation["tone"] = "neutral";
  let primary: RuntimeActionPresentation | undefined;
  let secondary: RuntimeActionPresentation[] = [];
  switch (runtime.connectionState) {
    case "recovery_required":
      tone = "attention";
      detail = (environment
        ? "Sedes could not confirm ownership of a previous sidecar. Retry checks the host again; Stop checks whether this environment's owned processes can be ended."
        : "Sedes could not confirm the previous provider's state. Retry checks it again; Stop checks whether its owned runtime can be ended.") +
        (disconnectable ? " Disconnect pauses automatic retries." : "") + " Shutdown is unconfirmed until ownership can be verified.";
      primary = retry;
      secondary = [act("stop", undefined, "destructive"), act("disconnect")];
      break;
    case "unreachable":
      tone = "attention";
      detail = (environment
        ? `The remote host could not be reached; retained work on the host is kept.${automatic ? " Reconnection is retried automatically." : ""}`
        : "The provider could not be reached.") + unconfirmedStop("it is reachable");
      primary = retry;
      secondary = [act("stop", undefined, "destructive"), act("disconnect")];
      break;
    case "reconciling":
      detail = "Sedes is checking the runtime's state. Stop remains available when the current command can be safely withdrawn.";
      secondary = [act("stop", undefined, "destructive"), act("disconnect")];
      break;
    case "unknown":
      qualifier = runtime.applyState === "pending" ? runtime.startupEnvironmentPending ? "Pending restart" : "Changes pending" : undefined;
      detail = runtime.lifecycleOperation?.state === "unknown"
        ? `The previous ${actionLabels[runtime.lifecycleOperation.action].toLowerCase()} command has no confirmed outcome. Sedes is checking its original status.${runtime.supportedActions.includes("stop") ? " Stop checks the earlier command before ending this runtime." : ""}`
        : environment
          ? "No status has been observed from this host since the server started. Connect to check it."
          : "Provider state has not been observed. Connect to check it.";
      primary = act("connect");
      secondary = [act("stop", undefined, "destructive"), ...(automatic || !environment ? [act("disconnect")] : [])];
      break;
    case "stopped":
      if (!enabled) {
        qualifier = "Backend disabled";
        detail = "This backend is disabled in its configuration.";
      } else {
        detail = runtime.preference === "stopped" ? `The ${noun} is stopped and will not start automatically.` : `The ${noun} is not running.`;
        primary = act("start");
      }
      break;
    case "disconnected":
      qualifier = !enabled ? "Backend disabled" : upgradeQualifier;
      if (!enabled) {
        detail = "This backend is disabled. A provider process may still exist on its host; stop it to release it.";
        secondary = [act("stop", undefined, "destructive")];
      } else if (environment) {
        detail = automatic
          ? "The sidecar is not attached; reconnection is attempted automatically."
          : "Sedes is not connected to this host's sidecar and will not reconnect automatically.";
        primary = act("connect");
        secondary = [...(automatic ? [act("disconnect")] : []), act("stop", undefined, "destructive"), ...(upgradeQualifier ? [act("upgrade")] : [])];
      } else {
        detail = "Sedes is not connected to the provider; it may still be running on its host.";
        primary = act("connect");
        secondary = [act("stop", undefined, "destructive")];
      }
      break;
    case "connected":
      tone = "connected";
      if (upgrade === "required") {
        tone = "attention";
        qualifier = "Upgrade required";
        detail = `The installed sidecar (${version}) is incompatible with this server; remote operations are unavailable until it is upgraded. Upgrading restarts the sidecar.${interruption}`;
        primary = act("upgrade");
        secondary = [act("stop", undefined, "destructive"), act("disconnect")];
      } else if (runtime.applyState === "unavailable" || runtime.applyState === "rejected") {
        tone = "attention";
        qualifier = "Configuration not applied";
        detail = `The saved configuration (revision ${runtime.desiredRevision}) could not be applied.`;
        primary = act("connect", "Reapply configuration");
        secondary = [act("restart"), act("stop", undefined, "destructive"), act("disconnect")];
      } else if (!enabled) {
        tone = "attention";
        qualifier = "Backend disabled";
        detail = "This backend is disabled but its runtime is still running. Stop it to release it.";
        primary = act("stop", undefined, "destructive");
        secondary = [act("disconnect")];
      } else if (upgrade === "pending") {
        qualifier = "Upgrade available";
        detail = `A newer sidecar is available. It installs automatically when the host is idle, or upgrade now to restart the sidecar.${interruption}`;
        primary = act("upgrade");
        secondary = [act("stop", undefined, "destructive"), act("disconnect")];
      } else if (runtime.applyState === "pending") {
        qualifier = runtime.startupEnvironmentPending ? "Pending restart" : "Changes pending";
        detail = runtime.startupEnvironmentPending
          ? `Saved startup variables will apply when this provider restarts. Saving did not restart the running provider.${interruption}`
          : `Saved revision ${runtime.desiredRevision} is not applied yet (applied: ${runtime.effectiveRevision ?? "none"}). Non-disruptive changes apply automatically; restart to apply everything now.${interruption}`;
        primary = act("restart");
        secondary = [act("stop", undefined, "destructive"), act("disconnect")];
      } else {
        detail = environment
          ? `Sidecar ${version} is up to date.${active > 0 ? ` ${active} active or unconfirmed resource${active === 1 ? "" : "s"}.` : ""}`
          : `The provider is running.${active > 0 ? ` ${active} active or unconfirmed resource${active === 1 ? "" : "s"}.` : ""}`;
        secondary = [act("restart"), act("stop", undefined, "destructive"), act("disconnect")];
      }
      break;
  }
  const supported = new Set(runtime.supportedActions);
  if (primary && !supported.has(primary.action)) primary = undefined;
  const offered = new Set(primary ? [primary.action] : []);
  secondary = secondary.filter((candidate) => supported.has(candidate.action) && !offered.has(candidate.action) && offered.add(candidate.action));
  const recoveryEmphasis = runtime.connectionState === "recovery_required" || /recover/iu.test(runtime.lastError ?? "");
  return { headline, ...(qualifier ? { qualifier } : {}), detail, tone, ...(primary ? { primary } : {}), secondary, recoveryEmphasis };
}
