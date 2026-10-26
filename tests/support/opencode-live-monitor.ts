import type { OpenCodeNativeApi, OpenCodeNativeEvent, OpenCodeNativeObservation } from "../../src/server/backends/opencode/opencode-native-api.js";

type Observation = Pick<OpenCodeNativeObservation, "ready" | "ended" | "close">;

/** Test-only checks run in the observation pump, before its discard-on-close
 * queue. This covers events delivered to the parser before close, not a native
 * event replay/barrier or proof about the provider's final bill.
 */
export function monitorLiveGate(input: {
  observe(options: Parameters<OpenCodeNativeApi["observe"]>[0]): Observation;
  sessionID: string;
  signal: AbortSignal;
  onFailure(error: Error): void;
}) {
  let bytes = 0, steps = 0, toolCalls = 0, toolResults = 0, toolFailures = 0;
  let failure: Error | undefined, closing: Promise<void> | undefined;
  const stepIDs = new Set<string>();
  const finishes: string[] = [];
  // Report only bounded counts and protocol enums. Step identities stay private
  // to distinct-attempt counting; no identifiers, prompts, reasoning, tool
  // arguments/results, credentials, or native error bodies enter diagnostics.
  const diagnostic = () => ({ steps, distinctSteps: stepIDs.size, finishes: [...finishes], toolCalls, toolResults, toolFailures });
  let closeRequested = false;
  const fail = (cause: unknown) => {
    if (failure) return;
    failure = new Error(`Live-gate native observation failed: ${cause instanceof Error ? cause.message : "unknown failure"}`, { cause });
    input.onFailure(failure);
  };
  const inspect = (event: OpenCodeNativeEvent): false => {
    if (!("sessionID" in event.data) || event.data.sessionID !== input.sessionID) return false;
    try {
      bytes += Buffer.byteLength(JSON.stringify(event));
      if (bytes > 262_144) throw new Error("Live-gate event limit exceeded");
      if (event.type === "session.retry.scheduled") throw new Error(`Native provider retry attempt ${event.data.attempt} is outside this smoke gate`);
      if (event.type === "session.step.ended" && finishes.length < 3) finishes.push(event.data.finish);
      if (event.type === "session.tool.called") toolCalls++;
      if (event.type === "session.tool.success") toolResults++;
      if (event.type === "session.tool.failed") toolFailures++;
      if (event.type === "session.step.started") {
        steps++;
        if (stepIDs.size < 3) stepIDs.add(event.data.assistantMessageID);
        if (steps > 2) throw new Error(`Live-gate step limit exceeded: ${JSON.stringify(diagnostic())}`);
      }
    } catch (error) { fail(error); }
    // No queued event remains for an asynchronous consumer to miss at close.
    return false;
  };
  const observation = input.observe({ signal: input.signal, include: inspect });
  const monitoring = observation.ended.then(end => {
    if (end.reason === "closed" && closeRequested) return;
    if (end.reason === "aborted" && input.signal.aborted) return;
    fail(end.error ?? new Error(`Unexpected native observation end: ${end.reason}`));
  });
  const close = (): Promise<void> => {
    if (!closing) {
      closeRequested = true;
      closing = (async () => {
        try { await observation.close(); }
        finally { await monitoring; }
      })();
    }
    return closing;
  };
  return {
    ready: observation.ready,
    close,
    async finish(): Promise<void> {
      await close();
      if (failure) throw failure;
      input.signal.throwIfAborted();
    },
  };
}
