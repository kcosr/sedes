import path from "node:path";
import type { OpenCodeNativeMessage } from "../../src/server/backends/opencode/opencode-native-api.js";
export const LIVE_GATE_LIMITS = { deadlineMs: 45_000, outputTokens: 256, outputBytes: 16_384 } as const;
// Stock provider plugins select by native ID and may replace transport or request
// settings. Keep this qualification on the rehearsed OpenAI-compatible HTTP path.
export const LIVE_GATE_PROVIDER_ID = "sedes-live-gate";

/** Synchronous admission fence, including a delayed timer callback under load. */
export function assertLiveGateBudget(deadlineAt: number, signal: AbortSignal, now = Date.now()): void {
  if (signal.aborted || now >= deadlineAt) throw new Error("Live-gate deadline or observation failure");
}

/** Pure preflight. The credential reference is admitted without reading its value. */
export function parseLiveInput(env: Readonly<Record<string, string | undefined>>) {
  if (env.SEDES_RUN_LIVE_OPENCODE !== "1") throw new Error("Live OpenCode gate requires explicit opt-in");
  const required = (key: string) => {
    const value = env[key];
    if (!value || value.length > 4096 || /\p{Cc}/u.test(value)) throw new Error(`Invalid live-gate setting: ${key}`);
    return value;
  };
  const executable = required("SEDES_REAL_OPENCODE_EXECUTABLE");
  if (!path.isAbsolute(executable)) throw new Error("Live gate requires an absolute reviewed executable");
  const model = required("SEDES_LIVE_OPENCODE_MODEL_ID");
  if (model.length > 120) throw new Error("Invalid exact model");
  let url: URL;
  try { url = new URL(required("SEDES_LIVE_OPENCODE_BASE_URL")); }
  catch { throw new Error("Invalid provider HTTPS base URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid provider HTTPS base URL");
  const tokenField = env["SEDES_LIVE_OPENCODE_TOKEN_FIELD"] ?? "max_tokens";
  if (tokenField !== "max_tokens" && tokenField !== "max_completion_tokens") throw new Error("Unsupported completion limit field");
  const keyName = required("SEDES_LIVE_OPENCODE_API_KEY_ENV");
  if (!/^[A-Z_][A-Z0-9_]{0,127}$/u.test(keyName)) throw new Error("Invalid provider credential environment reference");
  return { executable, model, baseURL: url.href.replace(/\/$/u, ""), tokenField, keyName };
}
export function readLiveCredential(input: ReturnType<typeof parseLiveInput>, read: (name: string) => string | undefined): string {
  const value = read(input.keyName);
  if (!value || value.length > 65_536 || /[\r\n\0]/u.test(value)) throw new Error("Provider credential is unavailable");
  return value;
}
export function liveConfiguration(input: ReturnType<typeof parseLiveInput>, canaryFile: string) {
  return {
    update: "disable", share: "disabled", snapshots: false, compaction: { auto: false },
    model: `${LIVE_GATE_PROVIDER_ID}/${input.model}`,
    // Stock file permissions use location-relative resources for internal files.
    // The runner creates this single file directly beneath its isolated location.
    permissions: [{ action: "*", resource: "*", effect: "deny" }, { action: "read", resource: path.basename(canaryFile), effect: "allow" }],
    agents: { build: { steps: 2, system: "Read the one requested canary file and return its contents. Do nothing else." } },
    providers: { [LIVE_GATE_PROVIDER_ID]: {
      package: "aisdk:@ai-sdk/openai-compatible",
      settings: { apiKey: "{env:OPENCODE_LIVE_GATE_API_KEY}", baseURL: input.baseURL, timeout: 20_000, chunkTimeout: 10_000 },
      models: { [input.model]: { capabilities: { tools: true, input: ["text"], output: ["text"] },
        limit: { context: 32_768, output: LIVE_GATE_LIMITS.outputTokens }, body: { [input.tokenField]: LIVE_GATE_LIMITS.outputTokens } } },
    } },
  };
}

/** History authority must first prove this exact input was consumed. Earlier idle records cannot settle it. */
export function settledCanaryPeriod(messages: readonly OpenCodeNativeMessage[], inputId: string) {
  const index = messages.findIndex(message => message.id === inputId && message.type === "user");
  if (index < 0) return undefined;
  if (messages.filter(message => message.id === inputId).length !== 1) throw new Error("Duplicate canary input");
  let opening = index;
  while (opening > 0 && messages[opening - 1]!.type !== "idle") opening--;
  let end = index + 1;
  while (end < messages.length && messages[end]!.type !== "idle") end++;
  if (end === messages.length) return undefined;
  const boundary = messages[end]!;
  if (boundary.type !== "idle" || boundary.outcome !== "succeeded") throw new Error("Canary period did not succeed");
  const period = messages.slice(opening, end);
  if (period.filter(message => message.type === "user").length !== 1) throw new Error("Foreign input shared the canary period");
  return { openingId: period[0]!.id, messages: period };
}

/** Bounds the caller's wait; closing the runtime in cleanup aborts an unfinished read. */
export function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Live-gate deadline or observation failure"));
    if (signal.aborted) { void work.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    void work.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

/** Test-only cleanup ordering; every stage is attempted and errors stay independent. */
export async function cleanupLiveGate(input: {
  observer(): Promise<unknown>;
  handle(): Promise<unknown>;
  stopRuntime(): Promise<unknown>;
  pendingReads(): Promise<unknown>;
  disposeSqlite(): Promise<unknown>;
  removeRoot(): Promise<unknown>;
}) {
  const failures: Error[] = [];
  const stages = ["observation", "handle", "owned runtime"] as const;
  // Scheduling through Promise.resolve catches synchronous cleanup throws too.
  const first = await Promise.allSettled([
    Promise.resolve().then(input.observer), Promise.resolve().then(input.handle), Promise.resolve().then(input.stopRuntime),
  ]);
  first.forEach((value, index) => { if (value.status === "rejected") failures.push(new Error(`Live-gate ${stages[index]} cleanup failed`, { cause: value.reason })); });
  // Runtime shutdown releases outstanding native readers before SQLite disposal.
  for (const [label, action] of [["pending reads", input.pendingReads], ["SQLite", input.disposeSqlite]] as const) {
    const [result] = await Promise.allSettled([Promise.resolve().then(action)]);
    if (result!.status === "rejected") failures.push(new Error(`Live-gate ${label} cleanup failed`, { cause: result!.reason }));
  }
  const runtimeProved = first[2]!.status === "fulfilled";
  let rootRetained = !runtimeProved;
  if (runtimeProved) {
    const [removed] = await Promise.allSettled([Promise.resolve().then(input.removeRoot)]);
    if (removed!.status === "rejected") {
      rootRetained = true;
      failures.push(new Error("Live-gate root cleanup failed", { cause: removed!.reason }));
    }
  }
  return { failures, rootRetained };
}
