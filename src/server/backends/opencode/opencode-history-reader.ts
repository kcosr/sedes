import { createHash } from "node:crypto";
import { BackendError } from "../contracts.js";
import { OpenCodeNativeReadLimitError, OpenCodeNativeProtocolError, type OpenCodeNativeApi, type OpenCodeNativeMessage } from "./opencode-native-api.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export interface OpenCodeHistoryLimits { readonly decodedBytes: number; readonly records: number; readonly milliseconds: number; }
export const OPENCODE_HISTORY_LIMITS: OpenCodeHistoryLimits = Object.freeze({ decodedBytes: 64 * 1024 * 1024, records: 100_000, milliseconds: 60_000 });
export type OpenCodeHistoryFailure = "bytes" | "response_bytes" | "records" | "time" | "turn_bytes" | "turn_items" | "invalidated" | "invalid" | "cancelled" | "cursor";

export class OpenCodeHistoryError extends BackendError {
  constructor(readonly reason: OpenCodeHistoryFailure) {
    const limit = ["bytes", "response_bytes", "records", "time", "turn_bytes", "turn_items"].includes(reason);
    super({ category: reason === "invalid" ? "incompatible_protocol" : reason === "cursor" ? "invalid_state" : "unavailable",
      retryable: reason === "invalidated", crossedSubmissionBoundary: false,
      ...(limit || reason === "invalid" ? { projectionRecovery: "futile" as const } : {}),
      backendCode: `opencode_history_${limit ? "limit_" : ""}${reason}`,
      safeMessage: limit ? `OpenCode history exceeds the ${reason.replaceAll("_", " ")} acquisition limit.`
        : reason === "cancelled" ? "OpenCode history acquisition was cancelled."
          : reason === "cursor" ? "OpenCode history changed; reload its timeline."
            : reason === "invalidated" ? "OpenCode history changed during acquisition."
              : "OpenCode history could not be validated." });
  }
}

export interface OpenCodeRetainedHistory {
  readonly sessionId: string;
  readonly messages: readonly OpenCodeNativeMessage[];
  readonly headId?: string;
  readonly forwardCursor?: string;
  readonly frontier: string;
  /** Cumulative decoded acquisition, including validation and buffered replacements. */
  readonly decodedBytes: number;
  readonly records: number;
  /** Actual native DTO storage; unlike acquisition work this does not include rereads. */
  readonly retainedDecodedBytes: number;
}

/** Begin a new bounded acquisition while retaining the previously validated native cut. */
export function restartOpenCodeHistoryAcquisition(prior: OpenCodeRetainedHistory): OpenCodeRetainedHistory {
  return { ...prior, decodedBytes: prior.retainedDecodedBytes, records: prior.messages.length };
}

const messageBytes = new WeakMap<object, number>();
function nativeMessageBytes(message: OpenCodeNativeMessage): number {
  let size = messageBytes.get(message);
  if (size === undefined) { size = Buffer.byteLength(JSON.stringify(message)); messageBytes.set(message, size); }
  return size;
}

export function openCodeHistoryFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

export function openCodeHistoryLimits(input: Partial<OpenCodeHistoryLimits> = {}): OpenCodeHistoryLimits {
  const result = { ...OPENCODE_HISTORY_LIMITS, ...input };
  for (const key of ["decodedBytes", "records", "milliseconds"] as const) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > OPENCODE_HISTORY_LIMITS[key]) throw new OpenCodeHistoryError("invalid");
  }
  return result;
}

export interface OpenCodeHistoryReadInput {
  readonly sessionId: string;
  readonly signal?: AbortSignal;
  readonly pageSize?: number;
  readonly limits?: Partial<OpenCodeHistoryLimits>;
  readonly assertCurrent?: () => void;
  readonly additionalUsage?: () => { readonly decodedBytes: number; readonly records: number };
  /** Exact retained records changed by durable events in this finite acquisition. */
  readonly dirtyMessageIds?: ReadonlySet<string>;
}
type OpenCodeHistoryApi = Pick<OpenCodeNativeApi, "getHistoryPage" | "getMessage">;

/** SSE must already be subscribed; the caller invalidates this read on conflicting historical events. */
export function readOpenCodeHistory(api: OpenCodeHistoryApi, input: OpenCodeHistoryReadInput): Promise<OpenCodeRetainedHistory> {
  return acquireOpenCodeHistory(api, input);
}

/** Finite catch-up within the same acquisition/generation; never resets the cumulative acquisition budget. */
export function refreshOpenCodeHistory(api: OpenCodeHistoryApi, prior: OpenCodeRetainedHistory, input: OpenCodeHistoryReadInput): Promise<OpenCodeRetainedHistory> {
  if (prior.sessionId !== input.sessionId) return Promise.reject(new OpenCodeHistoryError("invalidated"));
  return acquireOpenCodeHistory(api, input, prior);
}

async function acquireOpenCodeHistory(api: OpenCodeHistoryApi, input: OpenCodeHistoryReadInput, prior?: OpenCodeRetainedHistory): Promise<OpenCodeRetainedHistory> {
  const limits = openCodeHistoryLimits(input.limits);
  const pageSize = input.pageSize ?? 50;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200 || !input.sessionId) throw new OpenCodeHistoryError("invalid");
  const deadline = Date.now() + limits.milliseconds;
  const timerController = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, timerController.signal]) : timerController.signal;
  const timer = setTimeout(() => timerController.abort(), limits.milliseconds);
  timer.unref?.();
  let decodedBytes = prior?.decodedBytes ?? 0, records = prior?.records ?? 0;
  const check = () => {
    if (input.signal?.aborted) throw new OpenCodeHistoryError("cancelled");
    if (Date.now() >= deadline || timerController.signal.aborted) throw new OpenCodeHistoryError("time");
    input.assertCurrent?.();
    const extra = input.additionalUsage?.() ?? { decodedBytes: 0, records: 0 };
    if (!Number.isSafeInteger(extra.decodedBytes) || extra.decodedBytes < 0 || !Number.isSafeInteger(extra.records) || extra.records < 0) throw new OpenCodeHistoryError("invalid");
    if (decodedBytes + extra.decodedBytes > limits.decodedBytes) throw new OpenCodeHistoryError("bytes");
    if (records + extra.records > limits.records) throw new OpenCodeHistoryError("records");
    return extra;
  };
  const wait = async <T>(work: () => Promise<T>): Promise<T> => {
    check();
    const result = await new Promise<T>((resolve, reject) => {
      const aborted = () => {
        try { check(); } catch (error) { reject(error); }
      };
      signal.addEventListener("abort", aborted, { once: true });
      void Promise.resolve().then(work).then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
      if (signal.aborted) aborted();
    });
    check();
    return result;
  };
  const page = async (query: { cursor?: string; order?: "asc" | "desc"; limit: number }) => {
    const value = await wait(() => api.getHistoryPage(input.sessionId, { ...query, signal }));
    if (!Array.isArray(value.data) || value.data.length > query.limit || !Number.isSafeInteger(value.decodedBytes) || value.decodedBytes < 0) throw new OpenCodeHistoryError("invalid");
    decodedBytes += Math.max(value.decodedBytes, 2 + Math.max(0, value.data.length - 1) + value.data.reduce((sum, message) => sum + nativeMessageBytes(message), 0));
    records += value.data.length;
    check();
    return value;
  };
  const anchor = async (message: OpenCodeNativeMessage) => {
    const value = await wait(() => api.getMessage(input.sessionId, message.id, signal));
    decodedBytes += nativeMessageBytes(value); records++;
    check();
    if (value.id !== message.id || value.type !== message.type || value.time.created !== message.time.created) throw new OpenCodeHistoryError("invalidated");
    // The active head may legitimately acquire full text/tool values while this
    // read is in progress. SSE reconciliation owns those replacements.
    return value;
  };
  try {
    check();
    const headPage = await page({ order: "desc", limit: 1 });
    const head = headPage.data[0];
    const messages: OpenCodeNativeMessage[] = prior ? [...prior.messages] : [];
    if (prior?.headId) {
      if (!head || messages.at(-1)?.id !== prior.headId || !prior.forwardCursor) throw new OpenCodeHistoryError("invalidated");
      // Most settled records can be retained by reference, but durable events
      // can reopen an assistant or replace its content after step completion.
      // Running tools and background records can also precede an idle boundary.
      for (let index = 0; index < messages.length; index++) {
        const message = messages[index]!;
        const mutable = message.type === "assistant" && (message.time.completed === undefined ||
          message.content.some(part => part.type === "tool" && (part.state.status === "running" || part.state.status === "streaming"))) ||
          message.type === "shell" && message.status === "running" || message.type === "compaction" && message.status === "running";
        if (mutable || input.dirtyMessageIds?.has(message.id) || index === messages.length - 1) messages[index] = await anchor(message);
      }
      if (head.id !== prior.headId) {
        const seen = new Set(messages.map(message => message.id));
        const cursors = new Set<string>();
        let cursor = prior.forwardCursor;
        let reached = false;
        while (!reached) {
          if (cursors.has(cursor)) throw new OpenCodeHistoryError("invalidated");
          cursors.add(cursor);
          const next = await page({ cursor, limit: pageSize });
          if (!next.data.length) throw new OpenCodeHistoryError("invalidated");
          // previous on a DESC native cursor selects ascending neighbors, then
          // reverses its response back to DESC (pinned SessionStore.messages).
          for (const message of next.data.toReversed()) {
            if (seen.has(message.id)) throw new OpenCodeHistoryError("invalidated");
            seen.add(message.id); messages.push(message);
            if (message.id === head.id) { reached = true; break; }
          }
          await anchor(messages.at(-1)!);
          if (!reached) {
            if (!next.cursor.previous) throw new OpenCodeHistoryError("invalidated");
            cursor = next.cursor.previous;
          }
        }
      }
    } else
    if (head) {
      let cursor: string | undefined;
      const seen = new Set<string>();
      const cursors = new Set<string>();
      let reached = false;
      while (!reached) {
        const next = await page(cursor ? { cursor, limit: pageSize } : { order: "asc", limit: pageSize });
        if (!next.data.length) throw new OpenCodeHistoryError("invalidated");
        for (const message of next.data) {
          if (seen.has(message.id)) throw new OpenCodeHistoryError("invalidated");
          seen.add(message.id); messages.push(message);
          if (message.id === head.id) { reached = true; break; }
        }
        await anchor(messages.at(-1)!);
        if (!reached) {
          if (!next.cursor.next || cursors.has(next.cursor.next)) throw new OpenCodeHistoryError("invalidated");
          cursors.add(next.cursor.next); cursor = next.cursor.next;
        }
      }
    } else {
      // An empty first read is a valid finite cut only if no history appeared
      // before it can be installed. Buffered live events remain caller-owned.
      if ((await page({ order: "desc", limit: 1 })).data.length) throw new OpenCodeHistoryError("invalidated");
    }
    const extra = check();
    return Object.freeze({ sessionId: input.sessionId, messages: Object.freeze(messages),
      ...(head ? { headId: head.id } : {}), frontier: openCodeHistoryFingerprint(messages.map(message => [message.id, message.type])),
      ...(headPage.cursor.previous ? { forwardCursor: headPage.cursor.previous } : {}),
      decodedBytes: decodedBytes + extra.decodedBytes, records: records + extra.records,
      retainedDecodedBytes: 2 + Math.max(0, messages.length - 1) + messages.reduce((sum, message) => sum + nativeMessageBytes(message), 0) });
  } catch (error) {
    if (input.signal?.aborted) throw new OpenCodeHistoryError("cancelled");
    if (timerController.signal.aborted || Date.now() >= deadline) throw new OpenCodeHistoryError("time");
    if (error instanceof OpenCodeNativeReadLimitError) throw new OpenCodeHistoryError(error.limit === "response_bytes" ? "response_bytes" : "records");
    if (error instanceof OpenCodeNativeProtocolError) throw new OpenCodeHistoryError("invalid");
    if (error instanceof OpenCodeRuntimeError && ["opencode_native_not_found", "opencode_native_cursor_invalid"].includes(error.code)) throw new OpenCodeHistoryError("invalidated");
    throw error;
  } finally { clearTimeout(timer); }
}
