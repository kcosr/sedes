import type { SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "node:crypto";
import { BackendError, type BackendMutationReconciliation } from "../contracts.js";
import { claudeCommandLifecycle, claudeResultUserMessageIds } from "./claude-result-lifecycle.js";
import { claudeMessageIsChildOwned } from "./claude-message-scope.js";
import { projectClaudeCompactUsageReceipt, type ClaudeCompactUsageReceipt } from "./claude-compact-usage-receipt.js";
export type { ClaudeCompactUsageReceipt } from "./claude-compact-usage-receipt.js";

export interface ClaudeRuntimeCompactInput {
  readonly operationId: string;
  readonly instructions?: string;
}

export interface ClaudeRuntimeCompactResult {
  readonly outcome: "compacted" | "noop";
  readonly message?: string;
  /** Auxiliary provider spend; never an ordinary conversation-turn receipt. */
  readonly nativeResult?: ClaudeCompactUsageReceipt;
}

export interface ClaudeRuntimeCompactDisposition {
  readonly outcome: "accepted" | "not_applied" | "unknown";
  /** False only when the owner has exact evidence no command can still execute. */
  readonly pending: boolean;
  readonly nativeResult?: ClaudeCompactUsageReceipt;
}

export class ClaudeRuntimeCompactError extends BackendError {
  readonly nativeResult?: ClaudeCompactUsageReceipt;
  constructor(code: string, crossedSubmissionBoundary: boolean, nativeResult?: ClaudeCompactUsageReceipt) {
    super({
      category: crossedSubmissionBoundary ? "submission_unknown" : "rejected",
      retryable: false,
      crossedSubmissionBoundary,
      backendCode: code,
      safeMessage: crossedSubmissionBoundary
        ? "Claude compaction has an uncertain outcome. Reconnect to recover its result."
        : "Claude could not start the requested compaction.",
    });
    this.nativeResult = nativeResult;
  }
}

/** Reject mismatched auxiliary usage before it crosses into accounting. */
export function assertClaudeCompactReceiptScope(
  result: { readonly nativeResult?: ClaudeCompactUsageReceipt }, input: ClaudeRuntimeCompactInput, sessionId: string,
): void {
  const native = result.nativeResult;
  if (!native) return;
  const identities = claudeResultUserMessageIds(native);
  if (native.type !== "result" || native.session_id !== sessionId || identities.length !== 1 || identities[0] !== input.operationId) {
    throw new ClaudeRuntimeCompactError("claude_compact_result_identity_mismatch", true);
  }
}

interface Entry {
  readonly fingerprint: string;
  arguments: string;
  readonly promise: Promise<ClaudeRuntimeCompactResult>;
  readonly resolve: (value: ClaudeRuntimeCompactResult) => void;
  readonly reject: (error: unknown) => void;
  submitted: boolean;
  started: boolean;
  boundary: boolean;
  summary: boolean;
  completed: boolean;
  settled: boolean;
  disposition: ClaudeRuntimeCompactDisposition["outcome"];
  pending: boolean;
  output?: string;
  localFailure?: boolean;
  nativeResult?: ClaudeCompactUsageReceipt;
}

/** One query owner's exact-operation journal, independent of user input turns. */
export class ClaudeCompactOperations {
  readonly #entries = new Map<string, Entry>();
  /** Lightweight refused-operation tombstones prevent old UUIDs executing later. */
  readonly #notApplied = new Map<string, Entry>();
  #active: Entry | undefined;

  get busy(): boolean { return this.#active !== undefined; }

  run(input: ClaudeRuntimeCompactInput, submit: (content: string) => void): Promise<ClaudeRuntimeCompactResult> {
    const fingerprint = compactFingerprint(input);
    const previous = this.#entries.get(input.operationId) ?? this.#notApplied.get(input.operationId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) return Promise.reject(new ClaudeRuntimeCompactError("claude_compact_operation_conflict", false));
      return previous.promise;
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(input.operationId) ||
        (input.instructions !== undefined && (input.instructions.length > 65_536 || input.instructions.includes("\0")))) {
      return Promise.reject(new ClaudeRuntimeCompactError("claude_compact_input_invalid", false));
    }
    if (this.#active) return Promise.reject(new ClaudeRuntimeCompactError("claude_compact_busy", false));
    // Never reclaim operation evidence while this query owner can execute it.
    if (this.#entries.size >= 256) return Promise.reject(new ClaudeRuntimeCompactError("claude_compact_receipt_capacity", false));
    if (this.#notApplied.size >= 16_384) return Promise.reject(new ClaudeRuntimeCompactError("claude_compact_tombstone_capacity", false));
    let resolve!: Entry["resolve"];
    let reject!: Entry["reject"];
    const promise = new Promise<ClaudeRuntimeCompactResult>((done, failed) => { resolve = done; reject = failed; });
    const entry: Entry = { fingerprint, arguments: input.instructions?.trim() ?? "", promise, resolve, reject, submitted: false, started: false,
      boundary: false, summary: false, completed: false, settled: false, disposition: "unknown", pending: true };
    this.#entries.set(input.operationId, entry);
    this.#active = entry;
    try {
      submit(`/compact${input.instructions ? ` ${input.instructions}` : ""}`);
      entry.submitted = true;
    } catch {
      this.#fail(entry, "claude_compact_not_submitted", false);
    }
    return promise;
  }

  reconcile(input: ClaudeRuntimeCompactInput): ClaudeRuntimeCompactDisposition {
    const entry = this.#entries.get(input.operationId) ?? this.#notApplied.get(input.operationId);
    if (!entry || entry.fingerprint !== compactFingerprint(input)) return { outcome: "unknown", pending: true };
    return { outcome: entry.disposition, pending: entry.pending, ...(entry.nativeResult ? { nativeResult: entry.nativeResult } : {}) };
  }

  /**
   * Returns true for command-only frames. Boundaries and summaries are delivered
   * in stream order before the dedicated promise may complete.
   */
  async consume(message: SDKMessage, deliver: () => Promise<void>): Promise<boolean> {
    if (claudeMessageIsChildOwned(message)) return false;
    const lifecycle = claudeCommandLifecycle(message);
    if (lifecycle) {
      const entry = this.#entries.get(lifecycle.commandUuid) ?? this.#notApplied.get(lifecycle.commandUuid);
      if (!entry) return false;
      if (["completed", "cancelled", "discarded", "refused"].includes(lifecycle.state)) this.#terminal(entry);
      if (entry.settled) return true;
      if (lifecycle.state === "started") entry.started = true;
      if (lifecycle.state === "completed") { entry.completed = true; this.#complete(entry); }
      if (lifecycle.state === "cancelled" || lifecycle.state === "discarded" || lifecycle.state === "refused") {
        this.#fail(entry, `claude_compact_${lifecycle.state}`, entry.started || entry.boundary);
      }
      return true;
    }
    if (message.type === "user" && message.uuid && (this.#entries.has(message.uuid) || this.#notApplied.has(message.uuid))) return true;
    const identities = (message.type === "result" || message.type === "assistant" || message.type === "stream_event")
      ? claudeResultUserMessageIds(message) : [];
    const correlated = identities.map(id => this.#entries.get(id) ?? this.#notApplied.get(id)).find(entry => entry !== undefined);
    if (correlated) {
      if (message.type === "result" && !correlated.settled) {
        this.#terminal(correlated);
        if (identities.length !== 1) {
          this.#fail(correlated, "claude_compact_result_identity_mismatch", true);
          return true;
        }
        try { correlated.nativeResult = projectClaudeCompactUsageReceipt(message); }
        catch { this.#fail(correlated, "claude_compact_usage_receipt_invalid", true); return true; }
        if (message.subtype === "success" && message.local_command === "compact" && message.num_turns === 0 && typeof message.result === "string" && compactNoop(message.result)) {
          correlated.output = message.result;
          correlated.localFailure = true;
        }
        if (message.is_error || message.subtype !== "success") this.#fail(correlated, "claude_compact_failed", true);
        else { correlated.completed = true; this.#complete(correlated); }
      }
      return true;
    }
    const active = this.#active;
    if (!active?.started) return false;
    if (message.type === "system" && message.subtype === "compact_boundary") {
      if (message.compact_metadata.trigger !== "manual") return false;
      active.boundary = true;
      await deliver();
      return true;
    }
    if (active.boundary && message.type === "user" && message.isSynthetic === true && message.parent_tool_use_id === null &&
        message.origin === undefined) {
      await deliver();
      active.summary = true;
      return true;
    }
    if (message.type === "user" && "isReplay" in message && message.isReplay === true && typeof message.message.content === "string" &&
        /^<local-command-(?:stdout|stderr)>[\s\S]*<\/local-command-(?:stdout|stderr)>$/u.test(message.message.content)) return true;
    if (message.type === "assistant" && message.parent_tool_use_id === null) {
      // The pinned CLI emits failed local commands as synthetic assistants;
      // SDK 0.3.287 forwards these native fields without declaring them.
      const native = message as unknown as {
        local_command_run?: { command?: unknown; args?: unknown };
        local_command_source?: unknown;
        local_command_outcome?: { kind?: unknown };
      };
      if (message.message.model === "<synthetic>" && native.local_command_run?.command === "compact" &&
          native.local_command_run.args === active.arguments && typeof native.local_command_source === "string" &&
          (native.local_command_outcome?.kind === "failed" || compactNoop(stripCommandOutput(native.local_command_source)))) {
        active.output = stripCommandOutput(native.local_command_source);
        active.localFailure = true;
        return true;
      }
      if (message.message.model === "<synthetic>" && typeof native.local_command_source === "string" &&
          stripCommandOutput(native.local_command_source) === "Compaction canceled.") return true;
    }
    if (message.type === "system" && message.subtype === "local_command_output") return true;
    // Claude's compactor must not create an implicit application turn. Native
    // background task/permission frames retain their own ordinary delivery.
    if (message.type === "system" && message.subtype === "status") {
      if (message.compact_result === "failed" && typeof message.compact_error === "string") {
        active.localFailure = true;
        active.output = message.compact_error;
      }
      if (message.permissionMode) await deliver();
      return true;
    }
    if (message.type === "system" && message.subtype === "session_state_changed") return true;
    return false;
  }

  ownerLost(): void {
    for (const entry of this.#entries.values()) {
      if (!entry.settled) { this.#terminal(entry); this.#fail(entry, "claude_compact_owner_lost", entry.submitted); }
    }
  }

  #terminal(entry: Entry): void {
    entry.pending = false;
    if (this.#active === entry) this.#active = undefined;
  }

  #complete(entry: Entry): void {
    // Lifecycle completion does not carry cumulative usage. Retain the exact
    // command's result even if a producer sends its lifecycle first.
    if ((entry.boundary && entry.summary || entry.localFailure) && !entry.nativeResult) return;
    if (entry.started && entry.boundary && entry.summary) {
      this.#settle(entry, { outcome: "compacted", ...(entry.nativeResult ? { nativeResult: entry.nativeResult } : {}) });
    } else if (entry.started && !entry.boundary && entry.output && compactNoop(entry.output)) {
      this.#settle(entry, { outcome: "noop", message: stripCommandOutput(entry.output).slice(0, 16_384),
        ...(entry.nativeResult ? { nativeResult: entry.nativeResult } : {}) });
    } else {
      this.#fail(entry, entry.localFailure ? "claude_compact_failed" : "claude_compact_completion_unproven",
        entry.localFailure && !entry.boundary ? false : entry.submitted);
    }
  }

  #settle(entry: Entry, result: ClaudeRuntimeCompactResult): void {
    this.#terminal(entry);
    entry.arguments = "";
    entry.settled = true;
    entry.disposition = "accepted";
    if (this.#active === entry) this.#active = undefined;
    entry.resolve(result);
  }

  #fail(entry: Entry, code: string, crossed: boolean): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.disposition = crossed ? "unknown" : "not_applied";
    if (!crossed) this.#terminal(entry);
    if (!entry.pending) entry.arguments = "";
    if (!crossed && !entry.nativeResult) {
      for (const [operationId, current] of this.#entries) {
        if (current === entry) { this.#entries.delete(operationId); this.#notApplied.set(operationId, entry); break; }
      }
    }
    entry.reject(new ClaudeRuntimeCompactError(code, crossed, entry.nativeResult));
  }
}

function compactFingerprint(input: ClaudeRuntimeCompactInput): string {
  return createHash("sha256").update(JSON.stringify([input.operationId, input.instructions ?? null])).digest("hex");
}

function compactNoop(content: string): boolean {
  return /^(?:Error: )?(?:Not enough (?:messages|history)|No messages) to compact[.!]?$/iu.test(stripCommandOutput(content).trim());
}

function stripCommandOutput(content: string): string {
  return content.replace(/^<local-command-(?:stdout|stderr)>|<\/local-command-(?:stdout|stderr)>$/gu, "");
}
