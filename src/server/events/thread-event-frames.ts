import type {
  ActivityDetailMode,
  ThreadCheckpoint,
  ThreadEventEnvelope,
} from "../../shared/protocol/conversation.js";
import {
  projectThreadEventEnvelopeActivity,
  projectThreadSnapshotActivity,
} from "../conversations/thread-activity-projection.js";

/** An encoded SSE frame and its exact UTF-8 size; never bounds-checked here. */
export interface ThreadFrame {
  readonly frame: string;
  readonly bytes: number;
}

function threadFrame(frame: string): ThreadFrame {
  return { frame, bytes: Buffer.byteLength(frame, "utf8") };
}

// A publication fans out synchronously: the hub and every subscriber encode
// the same frozen envelope back to back. One entry shares those frames
// without retaining encoded copies of the replay buffer.
let lastEnvelope: ThreadEventEnvelope | undefined;
const lastEnvelopeFrames = new Map<ActivityDetailMode, ThreadFrame>();

/**
 * Encodes a hub-published (already validated, immutable) envelope for one
 * activity mode. Summary projection never alters the shared envelope.
 */
export function threadEventFrame(
  envelope: ThreadEventEnvelope,
  activityDetail: ActivityDetailMode,
): ThreadFrame {
  if (envelope !== lastEnvelope) {
    lastEnvelope = envelope;
    lastEnvelopeFrames.clear();
  }
  let encoded = lastEnvelopeFrames.get(activityDetail);
  if (encoded === undefined) {
    const projected = projectThreadEventEnvelopeActivity(envelope, activityDetail);
    encoded = projected === envelope && lastEnvelopeFrames.get("full")
      || threadFrame(`id: ${projected.eventId}\nevent: thread\ndata: ${JSON.stringify(projected)}\n\n`);
    lastEnvelopeFrames.set(activityDetail, encoded);
  }
  return encoded;
}

// The hub caches one checkpoint per watermark and every attach at that
// watermark receives the same object, so its frames live exactly as long.
const checkpointFrames = new WeakMap<ThreadCheckpoint, Map<ActivityDetailMode, ThreadFrame>>();

/** Encodes a hub-captured (already validated) checkpoint for one activity mode. */
export function threadCheckpointFrame(
  checkpoint: ThreadCheckpoint,
  activityDetail: ActivityDetailMode,
): ThreadFrame {
  let frames = checkpointFrames.get(checkpoint);
  if (!frames) {
    frames = new Map();
    checkpointFrames.set(checkpoint, frames);
  }
  let encoded = frames.get(activityDetail);
  if (encoded === undefined) {
    const snapshot = projectThreadSnapshotActivity(checkpoint.snapshot, activityDetail);
    const projected = snapshot === checkpoint.snapshot ? checkpoint : { ...checkpoint, snapshot };
    encoded = threadFrame(`id: ${projected.eventId}\nevent: thread-checkpoint\ndata: ${JSON.stringify(projected)}\n\n`);
    frames.set(activityDetail, encoded);
  }
  return encoded;
}
