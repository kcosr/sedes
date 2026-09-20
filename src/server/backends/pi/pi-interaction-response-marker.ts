import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { InteractionResponseInput } from "../contracts.js";

export const piInteractionResponseMarkerType = "sedes.interaction_response.v1";
const legacyPiInteractionResponseMarkerType = "harness.interaction_response.v1";

export function isPiInteractionResponseMarkerType(value: string): boolean {
  return (
    value === piInteractionResponseMarkerType ||
    value === legacyPiInteractionResponseMarkerType
  );
}

export type PiInteractionResponseMarker = {
  readonly version: 1;
  readonly applicationOperationId: string;
  readonly backendInteractionId: string;
  readonly requestFingerprint: string;
  readonly phase: "started" | "completed";
};

export type PiInteractionResponseState =
  | { readonly state: "none" }
  | {
      readonly state: "started" | "completed";
      readonly marker: PiInteractionResponseMarker;
    };

export function piInteractionResponseFingerprint(
  input: InteractionResponseInput,
): string {
  const { applicationOperationId: _applicationOperationId, ...response } =
    input;
  return createHash("sha256").update(JSON.stringify(response)).digest("hex");
}

export function piInteractionResponseMarker(
  entry: SessionEntry,
): PiInteractionResponseMarker | undefined {
  if (
    entry.type !== "custom" ||
    !isPiInteractionResponseMarkerType(entry.customType) ||
    typeof entry.data !== "object" ||
    entry.data === null
  ) {
    return undefined;
  }
  const data = entry.data as Partial<PiInteractionResponseMarker>;
  if (
    Object.keys(data).sort().join("\0") !==
      [
        "applicationOperationId",
        "backendInteractionId",
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
    typeof data.backendInteractionId !== "string" ||
    data.backendInteractionId.length === 0 ||
    data.backendInteractionId.length > 512 ||
    typeof data.requestFingerprint !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.requestFingerprint) ||
    (data.phase !== "started" && data.phase !== "completed")
  ) {
    return undefined;
  }
  return data as PiInteractionResponseMarker;
}

export function createPiInteractionResponseMarker(
  input: InteractionResponseInput,
  phase: PiInteractionResponseMarker["phase"],
): PiInteractionResponseMarker {
  return {
    version: 1,
    applicationOperationId: input.applicationOperationId,
    backendInteractionId: input.interactionId,
    requestFingerprint: piInteractionResponseFingerprint(input),
    phase,
  };
}

export function findPiInteractionResponseState(
  entries: readonly SessionEntry[],
  input: InteractionResponseInput,
): PiInteractionResponseState {
  const expectedFingerprint = piInteractionResponseFingerprint(input);
  let started: PiInteractionResponseMarker | undefined;
  let completed: PiInteractionResponseMarker | undefined;
  for (const entry of entries) {
    const marker = piInteractionResponseMarker(entry);
    if (
      !marker ||
      marker.applicationOperationId !== input.applicationOperationId
    ) {
      continue;
    }
    if (
      marker.backendInteractionId !== input.interactionId ||
      marker.requestFingerprint !== expectedFingerprint
    ) {
      throw new Error("pi_interaction_response_replay_mismatch");
    }
    if (marker.phase === "started") {
      if (started || completed) {
        throw new Error("pi_interaction_response_started_marker_invalid");
      }
      started = marker;
    } else {
      if (!started || completed) {
        throw new Error("pi_interaction_response_completed_marker_invalid");
      }
      completed = marker;
    }
  }
  if (!started) return { state: "none" };
  return {
    state: completed ? "completed" : "started",
    marker: completed ?? started,
  };
}
