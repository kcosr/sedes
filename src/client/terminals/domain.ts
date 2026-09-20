import type { TerminalResource } from "../../shared/index.js";

export type { TerminalResource } from "../../shared/index.js";

export function isTerminalProcessLive(
  lifecycle: TerminalResource["lifecycle"],
): boolean {
  return (
    lifecycle === "reserved" ||
    lifecycle === "starting" ||
    lifecycle === "running" ||
    lifecycle === "stopping"
  );
}

export function terminalStatusLabel(resource: TerminalResource): string {
  switch (resource.lifecycle) {
    case "reserved":
      return "Preparing";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "exited":
      return resource.exitCode === null ? "Exited" : `Exited (${resource.exitCode})`;
    case "failed":
      return "Failed";
    case "interrupted":
      return "Interrupted";
  }
}

/** Describes only the cleanup guaranteed by the terminal's execution transport. */
export function terminalTerminationLabel(resource: TerminalResource): string {
  return resource.terminationEffect === "disconnect_transport"
    ? "Disconnect and remove"
    : "End terminal";
}

export function terminalTerminationDescription(resource: TerminalResource): string {
  return resource.terminationEffect === "disconnect_transport"
    ? `Disconnect ${resource.displayName} and permanently remove its retained history? Remote processes may continue running.`
    : `End ${resource.displayName} and permanently remove its retained history?`;
}

export function terminalTerminationPendingLabel(resource: TerminalResource): string {
  return resource.terminationEffect === "disconnect_transport"
    ? "Disconnecting…"
    : "Ending…";
}
