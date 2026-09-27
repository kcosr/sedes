import type { SessionEventDurable, SessionLogItem } from "@opencode/client";
import { EventLog } from "@opencode/schema/event-log";
import { SessionEvent } from "@opencode/schema/session-event";
import { Schema } from "effect";
import { OpenCodeHttpClient } from "./opencode-http-client.js";
import { openCodeNativeParser } from "./opencode-native-api.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export type OpenCodeNativeDurableEvent = SessionEventDurable;
export interface OpenCodeNativeLogLimits { readonly decodedBytes: number; readonly records: number; readonly milliseconds: number; }
export const OPENCODE_NATIVE_LOG_LIMITS: OpenCodeNativeLogLimits = Object.freeze({ decodedBytes: 64 * 1_024 * 1_024,
  records: 100_000, milliseconds: 60_000 });
export interface OpenCodeNativeLogGap {
  /** Missing coordinates greater than after and less than or equal to through. */
  readonly after: number;
  readonly through: number;
}
export interface OpenCodeNativeLogCut {
  readonly sessionID: string;
  readonly after?: number;
  readonly watermark: number | undefined;
  readonly events: readonly OpenCodeNativeDurableEvent[];
  readonly sequenceGaps: readonly OpenCodeNativeLogGap[];
  readonly decodedBytes: number;
  /** Acquired frames, including the final synced marker. */
  readonly records: number;
}
export interface OpenCodeNativeLogReadInput {
  readonly sessionID: string;
  readonly after?: number;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
  readonly limits?: Partial<OpenCodeNativeLogLimits>;
}
export class OpenCodeNativeLogError extends OpenCodeRuntimeError {
  constructor(readonly reason: "input" | "bytes" | "records" | "time" | "cancelled" | "invalid" | "incomplete") {
    super(`opencode_native_log_${reason}`);
  }
}
const parseLog = openCodeNativeParser<SessionLogItem>(Schema.Union([SessionEvent.Durable, EventLog.Synced]), false);

/**
 * Finite experimental native log acquisition, never a replay guarantee. Stock
 * 2.0.18 CLI does not persist event payloads and normally returns only a synced
 * watermark. Missing coordinates are explicit gaps, never negative evidence.
 */
export async function readOpenCodeNativeLog(client: OpenCodeHttpClient, input: OpenCodeNativeLogReadInput): Promise<OpenCodeNativeLogCut> {
  const limits = { ...OPENCODE_NATIVE_LOG_LIMITS, ...input.limits };
  for (const key of ["decodedBytes", "records", "milliseconds"] as const) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > OPENCODE_NATIVE_LOG_LIMITS[key]) {
      throw new OpenCodeNativeLogError("input");
    }
  }
  if (!/^ses_[^\x00-\x20/\\]{1,252}$/u.test(input.sessionID) ||
      (input.after !== undefined && (!Number.isSafeInteger(input.after) || input.after < 0)) ||
      (input.deadlineAt !== undefined && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 0))) {
    throw new OpenCodeNativeLogError("input");
  }
  const deadline = Math.min(Date.now() + limits.milliseconds, input.deadlineAt ?? Infinity);
  const timerController = new AbortController();
  const signal = AbortSignal.any([client.lifetime, timerController.signal, ...(input.signal ? [input.signal] : [])]);
  const check = () => {
    if (input.signal?.aborted || client.lifetime.aborted) throw new OpenCodeNativeLogError("cancelled");
    if (Date.now() >= deadline || timerController.signal.aborted) throw new OpenCodeNativeLogError("time");
  };
  check();
  const timer = setTimeout(() => timerController.abort(), Math.max(1, deadline - Date.now()));
  timer.unref?.();
  const events: OpenCodeNativeDurableEvent[] = [];
  const sequenceGaps: OpenCodeNativeLogGap[] = [];
  const eventIds = new Set<string>();
  let frontier = input.after ?? -1;
  let watermark: number | undefined;
  let synced = false;
  let decodedBytes = 0;
  let records = 0;
  try {
    for await (const item of client.stream((sdk, budget) => sdk.session.log({ sessionID: input.sessionID,
      ...(input.after === undefined ? {} : { after: input.after }), follow: false }, { signal: budget }), parseLog, signal)) {
      check();
      decodedBytes += Buffer.byteLength(JSON.stringify(item));
      records++;
      if (decodedBytes > limits.decodedBytes) throw new OpenCodeNativeLogError("bytes");
      if (records > limits.records) throw new OpenCodeNativeLogError("records");
      if (synced) throw new OpenCodeNativeLogError("invalid");
      if (item.type === "log.synced") {
        if (item.aggregateID !== input.sessionID ||
            (item.seq === undefined ? frontier !== -1 : !Number.isSafeInteger(item.seq) || item.seq < frontier)) {
          throw new OpenCodeNativeLogError("invalid");
        }
        watermark = item.seq;
        if (watermark !== undefined && watermark > frontier) sequenceGaps.push({ after: frontier, through: watermark });
        synced = true;
      } else {
        const seq = item.durable.seq;
        if (item.durable.aggregateID !== input.sessionID || item.data.sessionID !== input.sessionID ||
            !Number.isSafeInteger(seq) || seq <= frontier || eventIds.has(item.id)) throw new OpenCodeNativeLogError("invalid");
        if (seq > frontier + 1) sequenceGaps.push({ after: frontier, through: seq - 1 });
        eventIds.add(item.id); frontier = seq; events.push(item);
      }
    }
    check();
    if (!synced) throw new OpenCodeNativeLogError("incomplete");
    return { sessionID: input.sessionID, ...(input.after === undefined ? {} : { after: input.after }),
      watermark, events, sequenceGaps, decodedBytes, records };
  } catch (error) {
    check();
    throw error;
  } finally { clearTimeout(timer); timerController.abort(); }
}
