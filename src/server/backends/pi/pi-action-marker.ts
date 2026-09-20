import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { RegisteredBackendActionInput } from "../contracts.js";

export const piActionMarkerType = "sedes.backend_action.v1";
const legacyPiActionMarkerType = "harness.backend_action.v1";

export function isPiActionMarkerType(value: string): boolean {
  return value === piActionMarkerType || value === legacyPiActionMarkerType;
}

export type PiActionMarker = {
  readonly version: 1;
  readonly applicationOperationId: string;
  readonly action: RegisteredBackendActionInput["action"];
  readonly requestFingerprint: string;
  readonly phase: "started" | "completed";
};

export type PiActionState =
  | { readonly state: "none" }
  | {
      readonly state: "started" | "completed";
      readonly marker: PiActionMarker;
      /** Branch index of the started marker; suffix evidence starts after it. */
      readonly startedIndex: number;
      readonly compactObserved: boolean;
    };

export function piActionFingerprint(
  input: RegisteredBackendActionInput,
): string {
  const { applicationOperationId: _applicationOperationId, ...action } = input;
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

export function piActionMarker(
  entry: SessionEntry,
): PiActionMarker | undefined {
  if (
    entry.type !== "custom" ||
    !isPiActionMarkerType(entry.customType) ||
    typeof entry.data !== "object" ||
    entry.data === null
  ) {
    return undefined;
  }
  const data = entry.data as Partial<PiActionMarker>;
  const keys = Object.keys(data).sort();
  if (
    keys.join("\0") !==
      [
        "action",
        "applicationOperationId",
        "phase",
        "requestFingerprint",
        "version",
      ]
        .sort()
        .join("\0") ||
    data.version !== 1 ||
    typeof data.applicationOperationId !== "string" ||
    data.applicationOperationId.length === 0 ||
    data.applicationOperationId.length > 160 ||
    (data.action !== "rename" &&
      data.action !== "compact" &&
      data.action !== "set_model" &&
      data.action !== "set_thinking_level" &&
      data.action !== "set_tool_access") ||
    typeof data.requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.requestFingerprint) ||
    (data.phase !== "started" && data.phase !== "completed")
  ) {
    return undefined;
  }
  return data as PiActionMarker;
}

export function findPiActionState(
  entries: readonly SessionEntry[],
  input: RegisteredBackendActionInput,
): PiActionState {
  const expectedFingerprint = piActionFingerprint(input);
  let started:
    { readonly marker: PiActionMarker; readonly index: number } | undefined;
  let completed: PiActionMarker | undefined;
  for (const [index, entry] of entries.entries()) {
    const marker = piActionMarker(entry);
    if (
      !marker ||
      marker.applicationOperationId !== input.applicationOperationId
    ) {
      continue;
    }
    if (
      marker.action !== input.action ||
      marker.requestFingerprint !== expectedFingerprint
    ) {
      throw new Error("pi_action_replay_mismatch");
    }
    if (marker.phase === "started") {
      if (started) throw new Error("pi_action_started_marker_duplicate");
      if (completed) throw new Error("pi_action_marker_order_invalid");
      started = { marker, index };
    } else {
      if (!started || completed) {
        throw new Error("pi_action_completed_marker_invalid");
      }
      completed = marker;
    }
  }
  if (!started) return { state: "none" };
  const compactObserved =
    input.action === "compact" &&
    entries
      .slice(started.index + 1)
      .some((entry) => entry.type === "compaction");
  return {
    state: completed ? "completed" : "started",
    marker: completed ?? started.marker,
    startedIndex: started.index,
    compactObserved,
  };
}

export function createPiActionMarker(
  input: RegisteredBackendActionInput,
  phase: PiActionMarker["phase"],
): PiActionMarker {
  return {
    version: 1,
    applicationOperationId: input.applicationOperationId,
    action: input.action,
    requestFingerprint: piActionFingerprint(input),
    phase,
  };
}
