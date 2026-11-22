import { parentPort, workerData } from "node:worker_threads";
import { AntigravityNativeHistoryStore } from "./native-history.js";
import type { NativeHistoryWorkerRequest, NativeHistoryWorkerResponse } from "./native-history-reader.js";
import type { AntigravityRuntimeConfiguration } from "./port.js";

if (!parentPort) throw new Error("antigravity_history_worker_parent_missing");
const port = parentPort;
const store = new AntigravityNativeHistoryStore(workerData as AntigravityRuntimeConfiguration);
let tail: Promise<void> = Promise.resolve();
port.on("message", (request: NativeHistoryWorkerRequest) => {
  tail = tail.then(async () => {
    let response: NativeHistoryWorkerResponse;
    try {
      if (request.kind === "close") { await store.close(); port.postMessage({ id: request.id, kind: "done" } satisfies NativeHistoryWorkerResponse); port.close(); return; }
      const cancelled = new Int32Array(request.cancellation);
      const signal = { throwIfAborted() { if (Atomics.load(cancelled, 0)) throw new DOMException("Aborted", "AbortError"); } };
      signal.throwIfAborted();
      if (request.kind === "forget") { await store.forget(request.identity); response = { id: request.id, kind: "done" }; }
      else {
        const history = await store.read(request.identity, signal); signal.throwIfAborted();
        response = { id: request.id, kind: "read", revision: history.native.revision,
          history: request.knownRevision === history.native.revision ? null : history,
          bytes: request.knownRevision === history.native.revision ? 0 : store.serializedBytes(history) };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      response = { id: request.id, kind: "error", code: /^antigravity_[a-z0-9_]{1,100}$/u.test(message) ? message : "antigravity_history_read_failed" };
    }
    port.postMessage(response);
  }).catch(() => { port.close(); });
});
