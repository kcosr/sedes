import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstat, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { antigravityNativeHistorySchema, type AntigravityNativeHistory, type AntigravityNativeStep } from "./native-schema.js";
import { decodeAntigravityNativeMessage as decode, message, string, integer, repeated, bytes, type Message } from "./native-protobuf.js";
import { AntigravityError, type AntigravityHistory, type AntigravityIdentity, type AntigravityRuntimeConfiguration } from "./port.js";
import { assertAntigravityNativeSemantics } from "./native-guards.js";
import { antigravityNativeActivity } from "./host/native-activity.js";
import { antigravityCancelledExecutionHeads, antigravityNativeTerminalOutcome } from "./native-execution.js";
export { createAntigravityNativeHistoryReader, type AntigravityNativeHistoryReader } from "./native-history-reader.js";

const MAXIMUM_HISTORY_BYTES = 96 * 1024 * 1024;
const MAXIMUM_ROWS = 100_000;
const MAXIMUM_EXECUTOR_BYTES = 32 * 1024 * 1024;
const MAXIMUM_EXECUTOR_ROW_BYTES = 8 * 1024 * 1024;
const MAXIMUM_EXECUTOR_ROWS = 100_000;
type ChildReference = { sessionId: string; workspaceUris: readonly string[] };
type ReadBudget = { remainingBytes: number; remainingRows: number; remainingExecutorBytes: number; remainingExecutorRows: number;
  remainingSessions: number; ancestors: ReadonlySet<string> };
export type NativeReadCancellation = Pick<AbortSignal, "throwIfAborted">;
type Size = { count: number; bytes: number };
type ExecutorSize = Size & { maximum: number };
class NativeHistoryBudgetError extends Error {
  constructor() { super("antigravity_history_capacity_exceeded"); }
}
type OwnHistory = { native: AntigravityNativeHistory; childReferences: Map<number, readonly ChildReference[]>;
  size: Size; executionSize: ExecutorSize; includesExecutions: boolean; version: number;
  aggregate?: AntigravityNativeHistory; cachedBytes: number };
type Connection = { key: string; file: string; identity: string; database: DatabaseSync; own?: OwnHistory };
const MAXIMUM_CONNECTIONS = 64;
const MAXIMUM_CACHE_BYTES = 64 * 1024 * 1024;

/** Execution-host private state. Production owns this store inside its reader
 * worker; the explicit one-shot utility below owns a short-lived instance. */
export class AntigravityNativeHistoryStore {
  readonly #connections = new Map<string, Connection>();
  #closed = false;
  #cacheBytes = 0;
  #tail: Promise<unknown> = Promise.resolve();
  constructor(readonly configuration: AntigravityRuntimeConfiguration) {}
  read(identity: AntigravityIdentity, signal?: NativeReadCancellation): Promise<AntigravityHistory> {
    return this.#serialize(async () => {
      if (this.#closed) throw new AntigravityError("antigravity_history_reader_closed");
      return readNative(this, identity, signal, { remainingBytes: MAXIMUM_HISTORY_BYTES, remainingRows: MAXIMUM_ROWS,
        remainingExecutorBytes: MAXIMUM_EXECUTOR_BYTES, remainingExecutorRows: MAXIMUM_EXECUTOR_ROWS,
        remainingSessions: 32, ancestors: new Set() });
    });
  }
  forget(identity: AntigravityIdentity): Promise<void> {
    return this.#serialize(async () => { const entry = this.#connections.get(this.#key(identity)); if (entry) this.#remove(entry); });
  }
  async close(): Promise<void> {
    this.#closed = true;
    await this.#serialize(async () => { for (const entry of this.#connections.values()) this.#remove(entry); });
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.#tail.then(operation); this.#tail = work.catch(() => undefined); return work;
  }
  #key(identity: AntigravityIdentity) { return JSON.stringify([identity.sessionId, identity.cwd]); }
  async connection(identity: AntigravityIdentity): Promise<Connection> {
    const key = this.#key(identity), existing = this.#connections.get(key);
    let file: string, fingerprint: string;
    try {
      file = await nativePath(this.configuration, identity);
      const info = await lstat(file, { bigint: true });
      fingerprint = `${info.dev}:${info.ino}`;
      if (!info.isFile() || info.isSymbolicLink() || process.getuid && info.uid !== BigInt(process.getuid())) throw new Error("antigravity_history_file_invalid");
    } catch (error) { if (existing) this.#remove(existing); throw error; }
    if (existing && existing.file === file && existing.identity === fingerprint) {
      this.#connections.delete(key); this.#connections.set(key, existing); return existing;
    }
    if (existing) this.#remove(existing);
    const database = new DatabaseSync(file, { readOnly: true });
    try {
      // Connection-local settings only: never mutate the native database.
      database.exec("PRAGMA busy_timeout = 1000; PRAGMA query_only = ON; PRAGMA cache_size = -1024");
      const after = await lstat(file, { bigint: true });
      if (`${after.dev}:${after.ino}` !== fingerprint || !after.isFile() || after.isSymbolicLink() || process.getuid && after.uid !== BigInt(process.getuid()))
        throw new Error("antigravity_history_file_changed");
    } catch (error) { database.close(); throw error; }
    const entry = { key, file, identity: fingerprint, database };
    this.#connections.set(key, entry);
    while (this.#connections.size > MAXIMUM_CONNECTIONS) this.#remove(this.#connections.values().next().value!);
    return entry;
  }
  cache(entry: Connection, own: OwnHistory): void {
    if (this.#connections.get(entry.key) !== entry) return;
    this.#cacheBytes -= entry.own?.cachedBytes ?? 0;
    entry.own = undefined;
    own.cachedBytes = Buffer.byteLength(JSON.stringify(own.native)) + Buffer.byteLength(JSON.stringify([...own.childReferences])) + (own.aggregate && own.aggregate !== own.native
      ? Buffer.byteLength(JSON.stringify(own.aggregate)) : 0);
    if (own.cachedBytes > MAXIMUM_CACHE_BYTES) return;
    for (const previous of this.#connections.values()) {
      if (this.#cacheBytes + own.cachedBytes <= MAXIMUM_CACHE_BYTES) break;
      this.#cacheBytes -= previous.own?.cachedBytes ?? 0; previous.own = undefined;
    }
    entry.own = own; this.#cacheBytes += own.cachedBytes;
  }
  invalidate(entry: Connection): void { if (this.#connections.get(entry.key) === entry) this.#remove(entry); }
  #remove(entry: Connection) {
    this.#connections.delete(entry.key); this.#cacheBytes -= entry.own?.cachedBytes ?? 0; entry.database.close();
  }
}

export function antigravityConversationsDirectory(configuration: AntigravityRuntimeConfiguration): string {
  return path.join(configuration.geminiDirectory ?? path.join(homedir(), ".gemini"), "antigravity-cli", "conversations");
}

async function nativePath(configuration: AntigravityRuntimeConfiguration, identity: AntigravityIdentity): Promise<string> {
  if (!z.string().uuid().safeParse(identity.sessionId).success || !path.isAbsolute(identity.cwd) || identity.cwd.includes("\0"))
    throw new Error("antigravity_history_identity_invalid");
  const directory = await realpath(antigravityConversationsDirectory(configuration));
  const file = path.join(directory, `${identity.sessionId}.db`);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || await realpath(file) !== file)
    throw new Error("antigravity_history_file_invalid");
  return file;
}

/** Passive acquisition: no process, session/load, tools, credentials, or writes.
 * SQLite's read transaction pins one consistent snapshot including its WAL. */
export async function readAntigravityNativeHistory(configuration: AntigravityRuntimeConfiguration,
  identity: AntigravityIdentity, signal?: AbortSignal): Promise<AntigravityHistory> {
  const store = new AntigravityNativeHistoryStore(configuration);
  try { return await store.read(identity, signal); } finally { await store.close(); }
}
async function readNative(store: AntigravityNativeHistoryStore, identity: AntigravityIdentity, signal: NativeReadCancellation | undefined,
  budget: ReadBudget, expectedParent?: string): Promise<AntigravityHistory> {
  let cancelled = false;
  const checkCancellation = () => { try { signal?.throwIfAborted(); } catch (error) { cancelled = true; throw error; } };
  checkCancellation();
  if (budget.ancestors.has(identity.sessionId) || budget.ancestors.size >= 4 || --budget.remainingSessions < 0)
    throw new Error("antigravity_history_child_limit");
  const ancestors = new Set([...budget.ancestors, identity.sessionId]);
  const entry = await store.connection(identity), database = entry.database;
  checkCancellation();
  let transactionOpen = false;
  try {
    // Only values from this retained connection are comparable. Sample before
    // the transaction: a racing external commit must invalidate the next read,
    // never label an older snapshot with a later connection version.
    const version = (database.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    let own = entry.own;
    if (own && (own.version !== version || own.includesExecutions !== includesExecutions(own.executionSize, budget))) own = undefined;
    if (own) chargeBudget(own.size, own.executionSize, own.includesExecutions, budget);
    else {
    const childReferences = new Map<number, readonly ChildReference[]>();
    database.exec("BEGIN"); transactionOpen = true;
    let size!: Size, executionSize!: ExecutorSize, includeExecutions = false;
    const native = (() => {
      const identities = database.prepare("SELECT cascade_id FROM trajectory_meta").all() as { cascade_id: string }[];
      if (identities.length !== 1 || identities[0]?.cascade_id !== identity.sessionId)
        throw new Error("antigravity_history_session_mismatch");
      const row = database.prepare("SELECT data FROM trajectory_metadata_blob WHERE id = 'main' AND length(data) <= 1048576").get() as { data: Uint8Array } | undefined;
      if (!row || !(row.data instanceof Uint8Array)) throw new Error("antigravity_history_metadata_missing");
      const metadata = decode(row.data, ".exa.cortex_pb.CortexTrajectoryMetadata");
      if (expectedParent && string(metadata.parent_conversation_id) !== expectedParent)
        throw new Error("antigravity_history_child_parent_mismatch");
      const workspaces = repeated(metadata.workspaces).map(value => string(message(value).workspace_folder_absolute_uri));
      if (workspaces.length !== 1 || nativeWorkspace(workspaces[0]!) !== identity.cwd)
        throw new Error("antigravity_history_workspace_mismatch");
      size = database.prepare("SELECT count(*) AS count, coalesce(sum(length(step_payload)), 0) AS bytes FROM steps").get() as Size;
      if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'executor_metadata'").get())
        throw new AntigravityError("antigravity_history_executor_format_unsupported");
      executionSize = database.prepare("SELECT count(*) AS count, coalesce(sum(length(data)), 0) AS bytes, coalesce(max(length(data)), 0) AS maximum FROM executor_metadata")
        .get() as ExecutorSize;
      includeExecutions = includesExecutions(executionSize, budget);
      chargeBudget(size, executionSize, includeExecutions, budget);
      const hash = createHash("sha256").update(row.data);
      const executions = [];
      if (includeExecutions) {
        for (const value of database.prepare("SELECT idx, data FROM executor_metadata ORDER BY idx").iterate()) {
          checkCancellation();
          const execution = value as { idx: number; data: Uint8Array };
          if (!Number.isSafeInteger(execution.idx) || execution.idx < 0 || !(execution.data instanceof Uint8Array))
            throw new AntigravityError("antigravity_history_executor_format_unsupported");
          const payload = decode(execution.data, ".exa.cortex_pb.ExecutorMetadata");
          hash.update(JSON.stringify(["executor_metadata", execution.idx, execution.data.byteLength])).update(execution.data);
          // An unset protobuf ID cannot match an execution. It contributes to
          // revision identity, but never supplies terminal evidence.
          const receipt = projectExecutionReceipt(payload);
          if (receipt) executions.push(receipt);
        }
      } else {
        // Optional proof must not consume the step/child budget. Never acquire
        // a partial receipt set: omitted rows could contradict cancellation.
        hash.update(JSON.stringify(["executor_metadata_omitted_capacity", executionSize]));
      }
      const steps: AntigravityNativeStep[] = [];
      for (const value of database.prepare("SELECT idx, step_type, status, has_subtrajectory, step_format, step_payload FROM steps ORDER BY idx").iterate()) {
        checkCancellation();
        const step = value as { idx: number; step_type: number; status: number; has_subtrajectory: number; step_format: number; step_payload: Uint8Array };
        if (step.step_format !== 0 || !Number.isSafeInteger(step.idx) || step.idx < 0 || !(step.step_payload instanceof Uint8Array))
          throw new Error("antigravity_history_format_unsupported");
        const payload = decode(step.step_payload, ".gemini_coder.Step");
        if (integer(payload.type) !== step.step_type || integer(payload.status) !== step.status)
          throw new Error("antigravity_history_step_mismatch");
        assertAntigravityNativeSemantics(payload);
        hash.update(JSON.stringify([step.idx, step.step_type, step.status, step.has_subtrajectory])).update(step.step_payload);
        const projected = projectStep(step.idx, step.has_subtrajectory !== 0, payload, identity.sessionId, identity.cwd);
        const children = childResults(payload);
        if (children.length) {
          if (children.length > 32 || new Set(children.map(child => child.sessionId)).size !== children.length) throw new Error("antigravity_history_child_identity_invalid");
          childReferences.set(step.idx, children);
          projected.subagents = children.map(child => ({ sessionId: child.sessionId, state: "unknown" }));
        }
        steps.push(projected);
      }
      const parent = string(metadata.parent_conversation_id);
      return antigravityNativeHistorySchema.parse({ steps, executions, revision: hash.digest("hex"), ...(parent ? { parentSessionId: parent } : {}) });
    })();
    database.exec("ROLLBACK"); transactionOpen = false;
    own = { native, childReferences, size, executionSize, includesExecutions: includeExecutions, version, cachedBytes: 0 };
    store.cache(entry, own);
    }
    if (expectedParent && own.native.parentSessionId !== expectedParent) throw new Error("antigravity_history_child_parent_mismatch");
    const { native, childReferences } = own;
    // Child databases are read passively under the same aggregate bounds.
    // A launch result grants only its exact native child, never an arbitrary path.
    const aggregate = createHash("sha256").update(native.revision);
    const childSteps = new Map<number, AntigravityNativeStep>();
    for (const step of native.steps) {
      const references = childReferences.get(step.index);
      if (!references) continue;
      const childStep = { ...step, subagents: [] as NonNullable<AntigravityNativeStep["subagents"]> };
      childSteps.set(step.index, childStep);
      for (const reference of references) {
        checkCancellation();
        try {
          if (reference.workspaceUris.length !== 1 || nativeWorkspace(reference.workspaceUris[0]!) !== identity.cwd)
            throw new Error("antigravity_history_child_workspace_mismatch");
          const previousAncestors = budget.ancestors; budget.ancestors = ancestors;
          let child: AntigravityHistory;
          try { child = await readNative(store, { sessionId: reference.sessionId, cwd: identity.cwd }, signal, budget, identity.sessionId); }
          finally { budget.ancestors = previousAncestors; }
          const state = childState(child.native);
          childStep.subagents.push({ sessionId: reference.sessionId, state, revision: child.native.revision });
          aggregate.update(JSON.stringify([reference.sessionId, state, child.native.revision]));
        } catch {
          checkCancellation(); childStep.subagents.push({ sessionId: reference.sessionId, state: "unknown" });
          aggregate.update(JSON.stringify([reference.sessionId, "unknown"]));
        }
      }
    }
    checkCancellation();
    const revision = childReferences.size ? aggregate.digest("hex") : native.revision;
    if (own.aggregate?.revision === revision) return { ...identity, native: own.aggregate };
    const result = childReferences.size ? { ...native, revision, steps: native.steps.map(step => childSteps.get(step.index) ?? step) } : native;
    own.aggregate = result; store.cache(entry, own);
    return { ...identity, native: result };
  } catch (error) {
    // Neither caller cancellation nor a tighter aggregate allowance invalidates
    // a previously acquired snapshot. Failed rollback does invalidate its SQL
    // connection, even when the triggering error was otherwise harmless.
    let invalid = !cancelled && !(error instanceof NativeHistoryBudgetError);
    if (transactionOpen) {
      transactionOpen = false;
      try { database.exec("ROLLBACK"); } catch { invalid = true; }
    }
    if (invalid) store.invalidate(entry);
    throw error;
  }
}

function includesExecutions(size: ExecutorSize, budget: ReadBudget): boolean {
  return size.count <= budget.remainingExecutorRows && size.bytes <= budget.remainingExecutorBytes && size.maximum <= MAXIMUM_EXECUTOR_ROW_BYTES;
}
function chargeBudget(size: Size, executions: ExecutorSize, included: boolean, budget: ReadBudget): void {
  if (size.count > budget.remainingRows || size.bytes > budget.remainingBytes) throw new NativeHistoryBudgetError();
  budget.remainingRows -= size.count; budget.remainingBytes -= size.bytes;
  if (included) { budget.remainingExecutorRows -= executions.count; budget.remainingExecutorBytes -= executions.bytes; }
}

/** Only the caller's freshly-created empty catalog probe may be removed.
 * Existing user conversations are never cleanup targets. */
export async function removeAntigravityProbeSession(configuration: AntigravityRuntimeConfiguration, identity: AntigravityIdentity): Promise<void> {
  const history = await readAntigravityNativeHistory(configuration, identity);
  if (history.native.steps.length !== 0) throw new Error("antigravity_probe_not_empty");
  const file = await nativePath(configuration, identity);
  await unlink(file);
  for (const suffix of ["-wal", "-shm"]) {
    const auxiliary = `${file}${suffix}`;
    try { const stat = await lstat(auxiliary);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("antigravity_probe_auxiliary_invalid");
      await unlink(auxiliary);
    } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
}

function nativeWorkspace(uri: string): string {
  try { return fileURLToPath(uri); } catch { throw new Error("antigravity_history_workspace_invalid"); }
}
function time(value: unknown): string | undefined {
  const object = value as Message | undefined;
  if (!object || typeof object.seconds !== "number") return undefined;
  const milliseconds = object.seconds * 1000 + integer(object.nanos) / 1_000_000;
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8.64e15) throw new Error("antigravity_native_timestamp_invalid");
  return new Date(milliseconds).toISOString();
}
function tool(value: Message) {
  const id = string(value.id);
  return id ? { id, name: string(value.name), argumentsJson: string(value.arguments_json) } : undefined;
}
function projectStep(index: number, hasSubtrajectory: boolean, value: Message, sessionId: string, cwd: string): AntigravityNativeStep {
  const metadata = message(value.metadata);
  const started = time(metadata.created_at), completed = time(metadata.completed_at), executionStarted = time(metadata.started_at);
  const user = value.user_input ? message(value.user_input) : undefined;
  const response = value.planner_response ? message(value.planner_response) : undefined;
  const nativeTool = tool(message(metadata.tool_call));
  const command = value.run_command ? message(value.run_command) : undefined;
  const commandStatus = value.command_status ? message(value.command_status) : undefined;
  const usage = metadata.model_usage ? message(metadata.model_usage) : undefined;
  const error = message(value.error ?? message(value.error_message).error);
  const errorText = string(error.user_error_message) || string(error.short_error);
  const result = string(message(message(value.generic).result).result) || string(message(value.mcp_tool).result_string);
  const task = value.task_details ? message(value.task_details) : undefined;
  const system = value.system_message ? message(value.system_message) : undefined;
  const incoming = system ? message(system.agent_message) : undefined;
  const source = integer(metadata.source), eventType = system ? string(system.event_type) : "";
  const continuation = source === 5 && incoming && (eventType === "task_notification" || eventType === "agent_message")
    ? { id: string(incoming.id), recipient: string(incoming.recipient), sender: string(incoming.sender), kind: eventType, content: string(incoming.content) } : undefined;
  if (continuation && (continuation.recipient !== sessionId || !z.string().uuid().safeParse(continuation.id).success))
    throw new Error("antigravity_native_continuation_identity_invalid");
  const genericCommand = genericPayload(value, "RunCommand");
  const schedule = genericPayload(value, "Schedule");
  const projected: AntigravityNativeStep = {
    index, type: integer(value.type), status: integer(value.status), hasSubtrajectory,
    ...(started ? { createdAt: started } : {}), ...(completed ? { completedAt: completed } : {}),
    ...(executionStarted ? { startedAt: executionStarted } : {}),
    ...(string(metadata.execution_id) ? { executionId: string(metadata.execution_id) } : {}),
    ...(metadata.is_interrupting_step === true ? { isInterruptingStep: true as const } : {}),
    ...(user ? { user: { text: repeated(user.items).map(item => string(message(item).text)).join(""),
      ...(string(user.client_message_id) ? { clientMessageId: string(user.client_message_id) } : {}),
      ...(user.is_queued_message === true ? { isQueuedMessage: true as const } : {}) } } : {}),
    ...(response ? { response: { text: string(response.response), thinking: string(response.thinking),
      ...(string(response.message_id) ? { messageId: string(response.message_id) } : {}),
      stopReason: integer(response.stop_reason), toolCalls: repeated(response.tool_calls).flatMap(call => { const parsed = tool(message(call)); return parsed ? [parsed] : []; }) } } : {}),
    ...(nativeTool ? { tool: { ...nativeTool, ...(result ? { result } : {}), ...(string(metadata.tool_summary) ? { summary: string(metadata.tool_summary) } : {}) } } : {}),
    ...(task ? { task: { id: string(task.id), title: string(task.title), description: string(task.description), daemon: task.is_daemon === true } } : {}),
    ...(continuation ? { continuation: { ...continuation, kind: continuation.kind as "task_notification" | "agent_message" } } : {}),
    ...(schedule ? { schedule: { mode: string(schedule.mode), outcome: string(schedule.outcome), iterations: integer(schedule.iterations) } } : {}),
    ...(command ? { command: { command: string(command.command_line), cwd: string(command.cwd),
      ...(string(command.command_id) ? { commandId: string(command.command_id) } : {}),
      ...(typeof command.exit_code === "number" ? { exitCode: command.exit_code } : {}),
      output: string(message(command.combined_output).full) || string(message(command.combined_output_snapshot).truncated),
      persistent: command.run_persistent === true || command.is_daemon === true } } : {}),
    ...(commandStatus && string(commandStatus.command_id) ? { commandStatus: { commandId: string(commandStatus.command_id),
      status: integer(commandStatus.status), ...(typeof commandStatus.exit_code === "number" ? { exitCode: commandStatus.exit_code } : {}), output: string(commandStatus.combined) } } : {}),
    ...(errorText && error.is_benign !== true ? { error: errorText } : {}),
    ...(usage ? { usage: { inputTokens: integer(usage.input_tokens), outputTokens: integer(usage.output_tokens),
      cacheReadTokens: integer(usage.cache_read_tokens), cacheWriteTokens: integer(usage.cache_write_tokens), thinkingTokens: integer(usage.thinking_output_tokens) } } : {}),
  };
  if (!command && nativeTool?.name === "run_command" && integer(value.type) === 132 && integer(metadata.tool_source) === 1) {
    // Current native tool input and the exact typed result are separately
    // reviewed structures; tool prose never supplies command authority.
    const input = z.object({ CommandLine: z.string().max(8 * 1024 * 1024), Cwd: z.string().max(4096).optional(), IsDaemon: z.boolean().optional() })
      .parse(JSON.parse(nativeTool.argumentsJson));
    projected.command = { command: input.CommandLine,
      cwd: genericCommand && string(genericCommand.cwd) ? string(genericCommand.cwd) : input.Cwd ?? cwd,
      ...(task ? { commandId: string(task.id) } : {}),
      ...(genericCommand && integer(value.status) === 3 && genericCommand.exit_code_unknown !== true ? { exitCode: integer(genericCommand.exit_code) } : {}),
      output: result, persistent: task?.is_daemon === true || input.IsDaemon === true };
  }
  if (hasSubtrajectory) {
    if (!value.subtrajectory) projected.subtrajectoryState = "unknown";
    else {
      const nestedId = string(message(value.subtrajectory).cascade_id);
      if (!nestedId) projected.subtrajectoryState = "unknown";
      else {
        const trajectory = message(value.subtrajectory);
        const nested = repeated(trajectory.steps).map((step, index) => {
          const value = message(step); assertAntigravityNativeSemantics(value);
          return projectStep(index, value.subtrajectory !== undefined, value, nestedId, cwd);
        });
        // These receipts belong to the embedded trajectory itself. All bytes
        // were bounded, decoded and hashed with the enclosing native step.
        const executions = repeated(trajectory.executor_metadatas).flatMap(value => {
          const receipt = projectExecutionReceipt(message(value)); return receipt ? [receipt] : [];
        });
        const state = childState({ steps: nested, executions, revision: "0".repeat(64) });
        projected.subtrajectoryState = state === "cancelled" ? "terminal" : state;
      }
    }
  }
  return projected;
}
function projectExecutionReceipt(payload: Message): AntigravityNativeHistory["executions"][number] | undefined {
  const executionId = string(payload.execution_id);
  if (!executionId) return undefined;
  const receipt = antigravityNativeHistorySchema.shape.executions.element.safeParse({ executionId,
    lastStepIndex: integer(payload.last_step_idx), terminationReason: integer(payload.termination_reason),
    proceededWithAutoContinue: payload.proceeded_with_auto_continue === true });
  if (!receipt.success) throw new AntigravityError("antigravity_history_executor_format_unsupported");
  return receipt.data;
}
function genericPayload(value: Message, name: "RunCommand" | "InvokeSubagent" | "Schedule"): Message | undefined {
  const metadata = message(value.metadata), nativeTool = message(metadata.tool_call);
  const expectedName = { RunCommand: "run_command", InvokeSubagent: "invoke_subagent", Schedule: "schedule" }[name];
  if (integer(value.type) !== 132 || integer(metadata.tool_source) !== 1 || string(nativeTool.name) !== expectedName) return undefined;
  const payload = message(message(message(value.generic).result).payload);
  if (string(payload.type_url) !== `type.googleapis.com/exa.cortex.core.tools.${name}`) return undefined;
  const encoded = bytes(payload.value) ?? new Uint8Array();
  return decode(encoded, `.exa.cortex.core.tools.${name}`);
}
function childResults(value: Message): readonly ChildReference[] {
  const metadata = message(value.metadata);
  const invocation = genericPayload(value, "InvokeSubagent") ??
    (value.invoke_subagent && integer(metadata.tool_source) === 1 && string(message(metadata.tool_call).name) === "invoke_subagent" ? message(value.invoke_subagent) : undefined);
  if (!invocation) return [];
  return repeated(invocation.results).map(value => { const result = message(value); const sessionId = z.string().uuid().parse(string(result.conversation_id));
    return { sessionId, workspaceUris: repeated(result.workspace_uris).map(string) }; });
}
function childState(native: AntigravityNativeHistory): "active" | "terminal" | "cancelled" | "unknown" {
  const { steps } = native;
  const active = new Set([1, 2, 8, 9, 11]), terminal = new Set([3, 4, 5, 6, 7, 12]);
  const state = antigravityNativeActivity(native);
  if (state.active) return "active";
  if (state.unknown) return "unknown";
  if (steps.some(step => active.has(step.status) || step.subtrajectoryState === "active" || step.subagents?.some(child => child.state === "active"))) return "active";
  if (!steps.length || steps.some(step => !terminal.has(step.status) || (step.hasSubtrajectory && step.subtrajectoryState !== "terminal") || step.subagents?.some(child => child.state !== "terminal" && child.state !== "cancelled"))) return "unknown";
  const final = steps.at(-1);
  const outcome = antigravityNativeTerminalOutcome(final);
  if (outcome === "interrupted") return "cancelled";
  if (outcome === "completed" || outcome === "failed") return "terminal";
  if (final?.executionId && antigravityCancelledExecutionHeads(native).get(final.executionId) === final.index) return "cancelled";
  return "unknown";
}
