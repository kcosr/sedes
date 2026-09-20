import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { HistoricalForkContextBoundary } from "../fork-context-boundary.js";

export const piForkContextBoundaryType = "sedes.fork_context_boundary.v1";
const legacyPiForkContextBoundaryType = "harness.fork_context_boundary.v1";

export function isPiForkContextBoundaryType(value: string): boolean {
  return (
    value === piForkContextBoundaryType ||
    value === legacyPiForkContextBoundaryType
  );
}

interface PiForkContextBoundaryDetails {
  readonly version: 1;
  readonly applicationOperationId: string;
}

export function isExactPiForkContextBoundary(
  entry: SessionEntry | undefined,
  applicationOperationId: string,
  boundary: HistoricalForkContextBoundary,
): boolean {
  if (
    !entry ||
    entry.type !== "custom_message" ||
    !isPiForkContextBoundaryType(entry.customType) ||
    entry.display !== false ||
    entry.content !== boundary.content ||
    typeof entry.details !== "object" ||
    entry.details === null
  ) {
    return false;
  }
  const details = entry.details as Partial<PiForkContextBoundaryDetails>;
  return (
    Object.keys(entry.details).sort().join("\0") ===
      ["version", "applicationOperationId"].sort().join("\0") &&
    details.version === boundary.version &&
    details.applicationOperationId === applicationOperationId
  );
}
