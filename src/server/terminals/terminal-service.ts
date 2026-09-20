import type { EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import { randomUUID } from "node:crypto";
import { SidecarOperationError } from "../../internal/sidecar-protocol/operation-registry.js";
import type {
  CreateTerminalRequest,
  RenameTerminalRequest,
  TerminalClientFrame,
  TerminalMutationRequest,
  TerminalResource,
  TerminalServerFrame,
} from "../../shared/protocol/terminals.js";
import { TERMINAL_PROTOCOL_VERSION } from "../../shared/protocol/terminals.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type { InteractiveTerminalEnvironmentProvider } from "../execution/interactive-terminal.js";
import { InteractiveTerminalStartUncertainError } from "../execution/interactive-terminal.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { TerminalActor, type TerminalViewerSession } from "./terminal-actor.js";
import { TerminalJournalStore } from "./terminal-journal.js";
import { TerminalRepository } from "./terminal-repository.js";

export type TerminalServiceErrorCode =
  | "not_found"
  | "conflict"
  | "invalid_transition"
  | "environment_unavailable"
  | "runtime_unavailable";

export class TerminalServiceError extends Error {
  constructor(
    readonly code: TerminalServiceErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "TerminalServiceError";
  }
}

export class TerminalService {
  readonly #environmentVariables: (scope: RequestScope, environmentId: string) => EnvironmentVariableOverrides;
  readonly #inventory: InventoryRepository;
  readonly #repository: TerminalRepository;
  readonly #journal: TerminalJournalStore;
  readonly #providers: ReadonlyMap<
    string,
    InteractiveTerminalEnvironmentProvider
  >;
  readonly #actors = new Map<string, TerminalActor>();
  readonly #recoveringActors = new Map<string, Promise<TerminalActor | undefined>>();
  readonly #recoveringLifecycleActors = new Map<string, Promise<TerminalActor | undefined>>();
  readonly #environmentAdmissions = new Map<string, {
    retiring: boolean;
    readonly pending: Set<Promise<void>>;
  }>();
  readonly #workspaceAdmissions = new Map<string, {
    retiring: boolean;
    readonly pending: Set<Promise<void>>;
  }>();
  #closing = false;
  readonly #endOperations = new Map<
    string,
    {
      readonly mutationId: string;
      readonly expectedRevision: number;
      readonly promise: Promise<void>;
    }
  >();
  readonly #onTerminalSummaryChanged: (
    scope: RequestScope,
    threadId: string,
  ) => void;

  constructor(input: {
    readonly environmentVariables?: (scope: RequestScope, environmentId: string) => EnvironmentVariableOverrides;
    readonly inventory: InventoryRepository;
    readonly repository: TerminalRepository;
    readonly journal: TerminalJournalStore;
    readonly providers: ReadonlyMap<
      string,
      InteractiveTerminalEnvironmentProvider
    >;
    readonly onTerminalSummaryChanged: (
      scope: RequestScope,
      threadId: string,
    ) => void;
  }) {
    this.#environmentVariables = input.environmentVariables ?? (() => ({}));
    this.#inventory = input.inventory;
    this.#repository = input.repository;
    this.#journal = input.journal;
    this.#providers = input.providers;
    this.#onTerminalSummaryChanged = input.onTerminalSummaryChanged;
  }

  recover(scope: RequestScope): TerminalResource[] {
    const now = Date.now();
    for (const pending of this.#repository.listPendingDeletions(scope)) {
      if (pending.operationKind === "terminal_end" && !terminalDeletionReady(pending)) {
        this.#repository.cancelDeletion(scope, {
          terminalId: pending.terminalId,
          mutationId: pending.mutationId,
          operationKind: pending.operationKind,
          now,
        });
        continue;
      }
      const terminal = this.#repository.get(scope, pending.terminalId);
      if (terminal && this.#providers.get(terminal.environmentId)?.attachTerminal) continue;
      this.#journal.delete(scope, pending.terminalId);
      this.#repository.completeDeletion(scope, pending.terminalId, now);
    }
    this.#repository.recoverInterrupted(scope, now);
    const recovered: TerminalResource[] = [];
    for (const terminal of this.#repository.listAll(scope)) {
      const journal = this.#journal.recover(scope, terminal.terminalId);
      if (journal.kind === "corrupt") {
        recovered.push(
          this.#repository.markJournalCorrupt(
            scope,
            terminal.terminalId,
            Date.now(),
          ),
        );
        continue;
      }
      if (journal.state.headSeq < terminal.headSeq) {
        this.#journal.quarantineCorrupt(scope, terminal.terminalId);
        recovered.push(
          this.#repository.markJournalCorrupt(
            scope,
            terminal.terminalId,
            Date.now(),
          ),
        );
        continue;
      }
      let rows = journal.state.checkpoint.seq > 0
        ? journal.state.checkpoint.rows : terminal.initialRows;
      let columns = journal.state.checkpoint.seq > 0
        ? journal.state.checkpoint.columns : terminal.initialColumns;
      let finalStatus:
        | Extract<(typeof journal.state.records)[number], { kind: "final_status" }>
        | undefined;
      for (const record of journal.state.records) {
        if (record.kind === "resize") {
          rows = record.rows;
          columns = record.columns;
        } else if (record.kind === "final_status") {
          finalStatus = record;
        }
      }
      recovered.push(
        this.#repository.reconcileJournal(scope, terminal.terminalId, {
          headSeq: journal.state.headSeq,
          historyFloorSeq: journal.state.checkpoint.seq,
          rows,
          columns,
          ...(finalStatus ? { finalStatus } : {}),
          now: Date.now(),
        }),
      );
    }
    return recovered;
  }

  list(scope: RequestScope, threadId: string): TerminalResource[] {
    try {
      this.#inventory.getThread(scope, threadId);
    } catch {
      throw new TerminalServiceError("not_found", "The thread was not found.");
    }
    return this.#repository.list(scope, threadId);
  }

  get(scope: RequestScope, terminalId: string): TerminalResource {
    const terminal = this.#repository.get(scope, terminalId);
    if (!terminal) {
      throw new TerminalServiceError("not_found", "The terminal was not found.");
    }
    return terminal;
  }

  async create(
    scope: RequestScope,
    threadId: string,
    request: CreateTerminalRequest,
  ): Promise<TerminalResource> {
    let thread;
    try {
      thread = this.#inventory.getThread(scope, threadId).thread;
    } catch {
      throw new TerminalServiceError("not_found", "The thread was not found.");
    }
    const release = this.#admitTerminal(scope, thread.environmentId, thread.workspaceId);
    try {
      const workspace = this.#inventory.getWorkspace(scope, thread.workspaceId);
      const environment = this.#inventory.getEnvironment(
        scope,
        thread.environmentId,
      );
      if (
        workspace.environmentId !== thread.environmentId ||
        workspace.availability !== "available"
      ) {
        throw new TerminalServiceError(
          "environment_unavailable",
          "The thread workspace is unavailable.",
          true,
        );
      }
      const provider = this.#providers.get(thread.environmentId);
      if (
        !provider ||
        provider.availability(scope, thread.environmentId) !== "available"
      ) {
        throw new TerminalServiceError(
          "environment_unavailable",
          "Interactive terminals are unavailable for this execution environment.",
          true,
        );
      }
      const activeCount = this.#repository
        .list(scope, threadId)
        .filter((terminal) =>
          ["reserved", "starting", "running", "stopping"].includes(
            terminal.lifecycle,
          ),
        ).length;
      if (activeCount >= 8) {
        throw new TerminalServiceError(
          "conflict",
          "This thread already has the maximum number of running terminals.",
        );
      }
      const now = Date.now();
      const terminal = this.#repository.receipt(scope, {
        mutationId: request.mutationId,
        operationKind: "terminal_create",
        request: { threadId, ...request },
        now,
        run: () =>
          this.#repository.insert(scope, {
            terminalId: randomUUID(),
            threadId,
            workspaceId: workspace.id,
            environmentId: environment.id,
            environmentLabel: environment.label,
            terminationEffect: provider.terminationEffect,
            displayName: request.displayName,
            shellProfile: request.shellProfile ?? null,
            initialCwd: workspace.canonicalPath,
            rows: request.rows,
            columns: request.columns,
            now,
          }),
      });
      const current = this.get(scope, terminal.terminalId);
      if (current.lifecycle !== "reserved") return current;
      const incarnationId = randomUUID();
      const starting = this.#repository.beginStart(
        scope,
        terminal.terminalId,
        incarnationId,
        Date.now(),
      );
      let openedProcess: Awaited<ReturnType<typeof provider.openTerminal>> | undefined;
      try {
        openedProcess = await provider.openTerminal({
          scope,
          environmentId: starting.environmentId,
          environmentVariables: this.#environmentVariables(scope, starting.environmentId),
          terminalId: starting.terminalId,
          incarnationId,
          initialCwd: starting.initialCwd,
          ...(starting.shellProfile ? { shellProfile: starting.shellProfile } : {}),
          rows: starting.rows,
          columns: starting.columns,
        });
        const running = this.#repository.markRunning(
          scope,
          starting.terminalId,
          Date.now(),
        );
        const actor = this.#installActor(scope, running, openedProcess);
        await actor.ready();
        this.#publishTerminalSummary(scope, running.threadId);
        return running;
      } catch (error) {
        if (error instanceof InteractiveTerminalStartUncertainError || openedProcess?.persistent) {
          // A remote create/attach may have taken effect. Preserve its exact
          // starting incarnation for query-only recovery; never spawn it again.
          await openedProcess?.persistent?.detach().catch(() => undefined);
          const actor = this.#actors.get(this.#key(scope, starting.terminalId));
          await actor?.close().catch(() => undefined);
          this.#actors.delete(this.#key(scope, starting.terminalId));
          this.#publishTerminalSummary(scope, starting.threadId);
          throw new TerminalServiceError("runtime_unavailable", "The remote terminal outcome is unconfirmed; reconnect to recover the existing incarnation.", true);
        }
        await openedProcess?.terminate("kill").catch(() => undefined);
        const failed = this.#repository.finalize(scope, starting.terminalId, {
          lifecycle: "failed",
          headSeq: starting.headSeq,
          publicReason: "start_failed",
          now: Date.now(),
        });
        this.#publishTerminalSummary(scope, failed.threadId);
        throw new TerminalServiceError(
          "runtime_unavailable",
          `The terminal could not start (${failed.publicReason}).`,
          true,
        );
      }
    } finally { release(); }
  }

  rename(
    scope: RequestScope,
    terminalId: string,
    request: RenameTerminalRequest,
  ): TerminalResource {
    try {
      const renamed = this.#repository.receipt(scope, {
        mutationId: request.mutationId,
        operationKind: "terminal_rename",
        request: { terminalId, ...request },
        now: Date.now(),
        run: () =>
          this.#repository.rename(
            scope,
            terminalId,
            request.expectedRevision,
            request.displayName,
            Date.now(),
          ),
      });
      this.#publishTerminalSummary(scope, renamed.threadId);
      return renamed;
    } catch (error) {
      throw this.#repositoryError(error);
    }
  }

  async end(
    scope: RequestScope,
    terminalId: string,
    request: TerminalMutationRequest,
  ): Promise<void> {
    const receiptedRequest = { terminalId, ...request };
    let completed: { terminalId: string } | undefined;
    try {
      completed = this.#repository.completedReceipt<{ terminalId: string }>(
        scope,
        {
          mutationId: request.mutationId,
          operationKind: "terminal_end",
          request: receiptedRequest,
        },
      );
    } catch (error) {
      throw this.#repositoryError(error);
    }
    if (completed) return;

    const key = this.#key(scope, terminalId);
    const existing = this.#endOperations.get(key);
    if (existing) {
      if (
        existing.mutationId !== request.mutationId ||
        existing.expectedRevision !== request.expectedRevision
      ) {
        throw new TerminalServiceError(
          "conflict",
          "Another request is already ending this terminal.",
        );
      }
      return this.#waitForEnd(existing.promise);
    }

    const promise = this.#endAndDelete(scope, terminalId, request).finally(() => {
      if (this.#endOperations.get(key)?.promise === promise) {
        this.#endOperations.delete(key);
      }
    });
    this.#endOperations.set(key, {
      mutationId: request.mutationId,
      expectedRevision: request.expectedRevision,
      promise,
    });
    return this.#waitForEnd(promise);
  }

  async #waitForEnd(operation: Promise<void>): Promise<void> {
    // Bound the HTTP wait without cancelling the durable End intent, stop
    // escalation, or late exit/history handoff that will finish deletion.
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([operation, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new TerminalServiceError(
          "runtime_unavailable",
          "Terminal End is still pending. Removal will finish after cleanup is confirmed; its history is retained until then.",
          true,
        )), 10_000);
        timer.unref();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async delete(
    scope: RequestScope,
    terminalId: string,
    request: TerminalMutationRequest,
  ): Promise<void> {
    try {
      await this.#deleteWithOperation(
        scope,
        terminalId,
        request.expectedRevision,
        request,
        "terminal_delete",
      );
    } catch (error) {
      if (error instanceof TerminalServiceError) throw error;
      throw this.#repositoryError(error);
    }
  }

  async #endAndDelete(
    scope: RequestScope,
    terminalId: string,
    request: TerminalMutationRequest,
  ): Promise<void> {
    const original = this.get(scope, terminalId);
    let prepared;
    try {
      prepared = this.#repository.prepareDeletion(scope, {
        terminalId,
        expectedRevision: request.expectedRevision,
        mutationId: request.mutationId,
        operationKind: "terminal_end",
        request: { terminalId, ...request },
        now: Date.now(),
      });
    } catch (error) {
      throw this.#repositoryError(error);
    }
    if (prepared.kind === "completed") return;
    this.#publishTerminalSummary(scope, original.threadId);

    let final = this.get(scope, terminalId);
    let endingActor = this.#actors.get(this.#key(scope, terminalId));
    const provider = this.#providers.get(final.environmentId);
    if (provider?.recoverTerminal || (!endingActor && provider?.attachTerminal)) {
      endingActor = undefined;
      try {
        endingActor = await this.#recoverLifecycleActor(scope, final);
        if (!endingActor) throw new Error("terminal_handoff_unavailable");
      }
      catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (["exited", "failed", "interrupted"].includes(final.lifecycle) && code !== "terminal_history_transferred" && code !== "terminal_incarnation_unknown") {
          this.#cancelEnd(scope, final, request.mutationId);
          throw new TerminalServiceError("runtime_unavailable", "The remote terminal history handoff could not be confirmed.", true);
        }
        // A transferred/missing remote receipt contains no retained screen.
        // A still-live unavailable incarnation follows the cleanup path below.
      }
      final = this.get(scope, terminalId);
    }
    if (!["exited", "failed", "interrupted"].includes(final.lifecycle)) {
      const actor = endingActor;
      if (!actor) {
        this.#cancelEnd(scope, final, request.mutationId);
        throw new TerminalServiceError(
          "runtime_unavailable",
          "The terminal process is unavailable.",
          true,
        );
      }
      endingActor = actor;
      try {
        final = await actor.end(final.lifecycleRevision);
      } catch (error) {
        const raced = this.#repository.get(scope, terminalId);
        if (raced && ["exited", "failed", "interrupted"].includes(raced.lifecycle)) {
          this.#cancelEnd(scope, raced, request.mutationId);
          throw new TerminalServiceError(
            "invalid_transition",
            "The terminal ended independently; its history was retained for inspection.",
          );
        }
        this.#cancelEnd(scope, final, request.mutationId);
        throw this.#repositoryError(error);
      }
    }

    const deletion = this.#repository.getPendingDeletion(scope, terminalId);
    if (!deletion || !terminalDeletionReady(deletion)) {
      this.#cancelEnd(scope, final, request.mutationId);
      throw new TerminalServiceError(
        "runtime_unavailable",
        original.terminationEffect === "disconnect_transport"
          ? "Terminal disconnection could not be confirmed; its history was retained for inspection."
          : "Terminal cleanup could not be confirmed; its history was retained for inspection.",
        true,
      );
    }
    try {
      await endingActor?.prepareDiscard();
      this.#journal.delete(scope, terminalId);
      this.#repository.completeDeletion(scope, terminalId, Date.now());
      this.#publishTerminalSummary(scope, original.threadId);
      await endingActor?.discardAfterEnd();
      this.#actors.delete(this.#key(scope, terminalId));
    } catch (error) {
      if (error instanceof TerminalServiceError) throw error;
      throw this.#repositoryError(error);
    }
  }

  #cancelEnd(
    scope: RequestScope,
    terminal: TerminalResource,
    mutationId: string,
  ): void {
    const retained = this.#repository.cancelDeletion(scope, {
      terminalId: terminal.terminalId,
      mutationId,
      operationKind: "terminal_end",
      now: Date.now(),
    });
    this.#publishTerminalSummary(scope, retained.threadId);
  }

  async #deleteWithOperation(
    scope: RequestScope,
    terminalId: string,
    expectedRevision: number,
    request: TerminalMutationRequest,
    operationKind: "terminal_end" | "terminal_delete",
  ): Promise<void> {
    const terminal = this.#repository.get(scope, terminalId);
    const threadId = terminal?.threadId;
    const prepared = this.#repository.prepareDeletion(scope, {
      terminalId,
      expectedRevision,
      mutationId: request.mutationId,
      operationKind,
      request: { terminalId, ...request },
      now: Date.now(),
    });
    if (prepared.kind === "completed") return;
    if (threadId) this.#publishTerminalSummary(scope, threadId);
    let actor = this.#actors.get(this.#key(scope, terminalId));
    if (terminal && (this.#providers.get(terminal.environmentId)?.attachTerminal || this.#providers.get(terminal.environmentId)?.recoverTerminal)) {
      actor = undefined;
      try {
        actor = await this.#recoverLifecycleActor(scope, terminal);
        if (!actor) throw new Error("terminal_handoff_unavailable");
        await actor.prepareDiscard();
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        if (code !== "terminal_history_transferred" && code !== "terminal_incarnation_unknown") {
          throw new TerminalServiceError("runtime_unavailable", "The remote terminal history handoff could not be confirmed.", true);
        }
      }
    }
    this.#journal.delete(scope, terminalId);
    this.#repository.completeDeletion(scope, terminalId, Date.now());
    if (threadId) this.#publishTerminalSummary(scope, threadId);
    await actor?.discardAfterEnd();
    await actor?.close();
    this.#actors.delete(this.#key(scope, terminalId));
  }

  async attach(input: {
    readonly scope: RequestScope;
    readonly terminalId: string;
    readonly incarnationId: string;
    readonly attachmentId: string;
    readonly producerId: string;
    readonly requestedRole: "controller" | "observer";
    readonly restore:
      | { readonly kind: "checkpoint" }
      | { readonly kind: "resume"; readonly appliedSeq: number };
    readonly emit: (frame: TerminalServerFrame) => void;
  }): Promise<TerminalViewerSession> {
    let terminal = this.get(input.scope, input.terminalId);
    if (!terminal.incarnationId) {
      throw new TerminalServiceError(
        "invalid_transition",
        "No terminal process history is available.",
      );
    }
    if (terminal.incarnationId !== input.incarnationId) {
      throw new TerminalServiceError("invalid_transition", "The terminal process changed.");
    }
    if (!["exited", "failed", "interrupted"].includes(terminal.lifecycle) && this.#repository.getPendingDeletion(input.scope, terminal.terminalId)) {
      throw new TerminalServiceError("conflict", "The terminal is ending; a new interactive attachment is unavailable.", true);
    }
    if (!["exited", "failed", "interrupted"].includes(terminal.lifecycle) && this.#providers.get(terminal.environmentId)?.availability(input.scope, terminal.environmentId) !== "available") {
      throw new TerminalServiceError("environment_unavailable", "Interactive terminal attachment is disabled for this environment.", true);
    }
    const release = ["exited", "failed", "interrupted"].includes(terminal.lifecycle)
      ? () => undefined : this.#admitTerminal(input.scope, terminal.environmentId, terminal.workspaceId);
    try {
      let actor = this.#actors.get(this.#key(input.scope, input.terminalId));
      if (!actor && !["exited", "failed", "interrupted"].includes(terminal.lifecycle)) {
        try { actor = await this.#ensureRemoteActor(input.scope, terminal, false, true); }
        catch { throw new TerminalServiceError("runtime_unavailable", "The remote terminal is unavailable; its process outcome is not confirmed.", true); }
        terminal = this.get(input.scope, input.terminalId);
      }
      if (
        actor &&
        !["exited", "failed", "interrupted"].includes(terminal.lifecycle)
      ) {
        return await actor.attach(input);
      }
      if (!["exited", "failed", "interrupted"].includes(terminal.lifecycle)) {
        throw new TerminalServiceError(
          "runtime_unavailable",
          "The terminal process is unavailable.",
          true,
        );
      }
      return Promise.resolve(this.#attachSealed(terminal, input));
    } finally { release(); }
  }

  /** Keeps new terminal ownership fenced while configuration removal commits. */
  async runWithEnvironmentRetired<Result>(scope: RequestScope, environmentId: string, operation: () => Promise<Result>): Promise<Result> {
    try { this.#inventory.getEnvironment(scope, environmentId); }
    catch { throw new TerminalServiceError("not_found", "The execution environment was not found."); }
    if (this.#closing) throw new TerminalServiceError("runtime_unavailable", "Terminal administration is closing.", true);
    const key = this.#key(scope, environmentId);
    const admission = this.#environmentAdmissions.get(key) ?? { retiring: false, pending: new Set<Promise<void>>() };
    if (admission.retiring) throw new TerminalServiceError("conflict", "Terminal admission is already suspended for this environment.", true);
    admission.retiring = true;
    this.#environmentAdmissions.set(key, admission);
    try {
      // A launch admitted before the fence must publish its owned PTY or its
      // uncertain incarnation before the authoritative impact check.
      await Promise.all(admission.pending);
      const impact = this.impact(scope, environmentId);
      if (impact.liveCount || impact.unknownCount) {
        throw new TerminalServiceError("conflict", "The environment has live or unconfirmed terminals. End or recover them before removing it.", true);
      }
      return await operation();
    } finally {
      admission.retiring = false;
      if (admission.pending.size === 0) this.#environmentAdmissions.delete(key);
    }
  }

  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all([...this.#environmentAdmissions.values()].flatMap(admission => [...admission.pending]));
    await Promise.allSettled(this.#recoveringLifecycleActors.values());
    await Promise.allSettled(this.#recoveringActors.values());
    await Promise.all(
      [...this.#actors.values()].map((actor) =>
        actor.close().catch(() => undefined),
      ),
    );
    this.#actors.clear();
  }

  /** Fence only this project's terminal admission while its removal commits. */
  async runWithWorkspaceRetired<Result>(scope: RequestScope, workspaceId: string, operation: () => Promise<Result>): Promise<Result> {
    try { this.#inventory.getWorkspace(scope, workspaceId); }
    catch { throw new TerminalServiceError("not_found", "The project was not found."); }
    if (this.#closing) throw new TerminalServiceError("runtime_unavailable", "Terminal administration is closing.", true);
    const key = this.#key(scope, workspaceId);
    const admission = this.#workspaceAdmissions.get(key) ?? { retiring: false, pending: new Set<Promise<void>>() };
    if (admission.retiring) throw new TerminalServiceError("conflict", "Terminal admission is already suspended for this project.", true);
    admission.retiring = true;
    this.#workspaceAdmissions.set(key, admission);
    try {
      await Promise.all(admission.pending);
      if (this.#repository.listAll(scope).some(terminal => terminal.workspaceId === workspaceId &&
        ["reserved", "starting", "running", "stopping"].includes(terminal.lifecycle))) {
        throw new TerminalServiceError("conflict", "The project has live or unconfirmed terminals. End or recover them before removing it.", true);
      }
      return await operation();
    } finally {
      admission.retiring = false;
      if (admission.pending.size === 0) this.#workspaceAdmissions.delete(key);
    }
  }

  /** Called after environment attachment/configuration reconciliation. */
  async reconcileRemote(scope: RequestScope, environmentId?: string, options: { readonly recoveryOnly?: boolean } = {}): Promise<{ connected: number; unavailable: number }> {
    let connected = 0; let unavailable = 0;
    for (const terminal of this.#repository.listAll(scope)) {
      if (this.#closing) break;
      if (environmentId && terminal.environmentId !== environmentId) continue;
      if (!terminal.incarnationId || terminal.terminationEffect !== "end_process" || !this.#providers.get(terminal.environmentId)?.attachTerminal) continue;
      const existing = this.#actors.get(this.#key(scope, terminal.terminalId));
      let actor: TerminalActor | undefined;
      try {
        actor = await this.#ensureRemoteActor(scope, terminal, options.recoveryOnly === true);
        if (actor) {
          connected += 1;
          const pending = this.#repository.getPendingDeletion(scope, terminal.terminalId);
          if (pending && (pending.operationKind !== "terminal_end" || terminalDeletionReady(pending))) {
            await actor.prepareDiscard();
            this.#journal.delete(scope, terminal.terminalId);
            this.#repository.completeDeletion(scope, terminal.terminalId, Date.now());
            await actor.discardAfterEnd();
            await actor.close();
            this.#actors.delete(this.#key(scope, terminal.terminalId));
            this.#publishTerminalSummary(scope, terminal.threadId);
            continue;
          }
        }
      }
      catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
        const pending = this.#repository.getPendingDeletion(scope, terminal.terminalId);
        if ((code === "terminal_history_transferred" || code === "terminal_incarnation_unknown") && pending && (pending.operationKind !== "terminal_end" || terminalDeletionReady(pending))) {
          this.#journal.delete(scope, terminal.terminalId);
          this.#repository.completeDeletion(scope, terminal.terminalId, Date.now());
          this.#publishTerminalSummary(scope, terminal.threadId);
        } else if (!["exited", "failed", "interrupted"].includes(terminal.lifecycle)) unavailable += 1;
      } finally {
        if (options.recoveryOnly && !existing && actor) {
          await actor.close();
          if (this.#actors.get(this.#key(scope, terminal.terminalId)) === actor) this.#actors.delete(this.#key(scope, terminal.terminalId));
        }
      }
    }
    return { connected, unavailable };
  }

  /** Rebind existing PTYs after provider-map replacement without ending them. */
  async detachEnvironment(scope: RequestScope, environmentId: string): Promise<void> {
    for (const terminal of this.#repository.listAll(scope)) {
      if (terminal.environmentId !== environmentId) continue;
      const key = this.#key(scope, terminal.terminalId);
      const actor = this.#actors.get(key);
      if (actor) { await actor.close(); this.#actors.delete(key); }
    }
  }

  impact(scope: RequestScope, environmentId?: string): {
    readonly liveCount: number; readonly unknownCount: number;
    readonly terminals: readonly { terminalId: string; environmentId: string; incarnationId: string | null; state: "live" | "unknown" }[];
  } {
    const terminals = this.#repository.listAll(scope)
      .filter((terminal) => (!environmentId || terminal.environmentId === environmentId) && ["reserved", "starting", "running", "stopping"].includes(terminal.lifecycle))
      .map((terminal) => ({
        terminalId: terminal.terminalId, environmentId: terminal.environmentId, incarnationId: terminal.incarnationId,
        state: this.#actors.get(this.#key(scope, terminal.terminalId))?.available ? "live" as const : "unknown" as const,
      }));
    return { liveCount: terminals.filter((terminal) => terminal.state === "live").length, unknownCount: terminals.filter((terminal) => terminal.state === "unknown").length, terminals };
  }

  #installActor(scope: RequestScope, terminal: TerminalResource, process: import("../execution/interactive-terminal.js").InteractiveTerminalProcess): TerminalActor {
    const actorKey = this.#key(scope, terminal.terminalId);
    let actor!: TerminalActor;
    actor = new TerminalActor({
      scope, terminal, repository: this.#repository, journal: this.#journal, process,
      onTerminalSummaryChanged: () => this.#publishTerminalSummary(scope, terminal.threadId),
      onFinalized: () => {
        // Retain remote delivery state until explicit detach/discard, including
        // a final-history acknowledgment still awaiting carrier recovery.
        if (process.persistent) return;
        const pending = this.#repository.getPendingDeletion(scope, terminal.terminalId);
        if (this.#actors.get(actorKey) === actor && !(pending?.operationKind === "terminal_end" && terminalDeletionReady(pending))) this.#actors.delete(actorKey);
      },
    });
    this.#actors.set(actorKey, actor);
    return actor;
  }

  async #ensureRemoteActor(scope: RequestScope, terminal: TerminalResource, recoveryOnly = false, admittedOrExplicit = false): Promise<TerminalActor | undefined> {
    const release = recoveryOnly || admittedOrExplicit ? () => undefined : this.#admitTerminal(scope, terminal.environmentId, terminal.workspaceId);
    try {
      const actorKey = this.#key(scope, terminal.terminalId);
      if (!admittedOrExplicit && this.#recoveringLifecycleActors.has(actorKey)) {
        throw new TerminalServiceError("conflict", "Terminal lifecycle recovery is in progress.", true);
      }
      const existing = this.#actors.get(actorKey);
      if (existing) { await existing.ready(); return existing; }
      const pending = this.#recoveringActors.get(actorKey);
      if (pending) return await pending;
      const provider = this.#providers.get(terminal.environmentId);
      const attach = recoveryOnly ? provider?.recoverTerminal : provider?.attachTerminal;
      if (!attach || !terminal.incarnationId || this.#closing) return undefined;
      const recover = async () => {
        const process = await attach({ scope, environmentId: terminal.environmentId, terminalId: terminal.terminalId, incarnationId: terminal.incarnationId! });
        try {
          let current = this.#repository.get(scope, terminal.terminalId);
          if (this.#closing || !current || current.incarnationId !== terminal.incarnationId) {
            await process.persistent?.detach(); return undefined;
          }
          if (current.lifecycle === "starting") current = this.#repository.markRunning(scope, current.terminalId, Date.now());
          const actor = this.#installActor(scope, current, process);
          await actor.ready();
          return actor;
        } catch (error) {
          await process.persistent?.detach().catch(() => undefined);
          this.#actors.delete(actorKey);
          throw error;
        }
      };
      const result = recover(); this.#recoveringActors.set(actorKey, result);
      try { return await result; }
      catch (error) {
        if (error instanceof SidecarOperationError && error.code === "terminal_incarnation_unknown") {
          const current = this.#repository.get(scope, terminal.terminalId);
          if (current && current.incarnationId === terminal.incarnationId && !["exited", "failed", "interrupted"].includes(current.lifecycle)) {
            const record = { kind: "final_status" as const, seq: current.headSeq + 1,
              lifecycle: "interrupted" as const, exitCode: null, exitSignal: null,
              publicReason: "execution_host_continuity_lost" };
            this.#journal.append(scope, current.terminalId, record);
            this.#repository.finalize(scope, current.terminalId, { ...record, headSeq: record.seq, now: Date.now() });
            this.#publishTerminalSummary(scope, current.threadId);
          }
        }
        throw error;
      }
      finally { if (this.#recoveringActors.get(actorKey) === result) this.#recoveringActors.delete(actorKey); }
    } finally { release(); }
  }

  /** Explicit End/Delete can stop and hand off retained work after admission is disabled. */
  async #recoverLifecycleActor(scope: RequestScope, terminal: TerminalResource): Promise<TerminalActor | undefined> {
    const key = this.#key(scope, terminal.terminalId);
    const pending = this.#recoveringLifecycleActors.get(key);
    if (pending) return await pending;
    const recover = async () => {
      // Drain an attachment admitted before the deletion intent, then replace
      // its ordinary lease with scoped lifecycle recovery authority.
      await this.#recoveringActors.get(key)?.catch(() => undefined);
      const existing = this.#actors.get(key);
      if (existing) {
        await existing.close();
        if (this.#actors.get(key) === existing) this.#actors.delete(key);
      }
      const current = this.#repository.get(scope, terminal.terminalId);
      if (!current || current.incarnationId !== terminal.incarnationId) return undefined;
      return await this.#ensureRemoteActor(scope, current, true, true);
    };
    const result = recover();
    this.#recoveringLifecycleActors.set(key, result);
    try { return await result; }
    finally { if (this.#recoveringLifecycleActors.get(key) === result) this.#recoveringLifecycleActors.delete(key); }
  }

  #admitTerminal(scope: RequestScope, environmentId: string, workspaceId: string): () => void {
    this.#inventory.assertWorkspaceActive(scope, workspaceId);
    const key = this.#key(scope, workspaceId);
    const admission = this.#workspaceAdmissions.get(key) ?? { retiring: false, pending: new Set<Promise<void>>() };
    if (admission.retiring) throw new TerminalServiceError("conflict", "Terminal admission is suspended while this project is being removed.", true);
    const releaseEnvironment = this.#admitEnvironment(scope, environmentId);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    admission.pending.add(pending);
    this.#workspaceAdmissions.set(key, admission);
    return () => {
      if (!admission.pending.delete(pending)) return;
      finish();
      releaseEnvironment();
      if (!admission.retiring && admission.pending.size === 0) this.#workspaceAdmissions.delete(key);
    };
  }

  #admitEnvironment(scope: RequestScope, environmentId: string): () => void {
    if (this.#closing) throw new TerminalServiceError("runtime_unavailable", "Terminal administration is closing.", true);
    const key = this.#key(scope, environmentId);
    const admission = this.#environmentAdmissions.get(key) ?? { retiring: false, pending: new Set<Promise<void>>() };
    if (admission.retiring) throw new TerminalServiceError("conflict", "Terminal admission is suspended while this environment is being removed.", true);
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    admission.pending.add(pending);
    this.#environmentAdmissions.set(key, admission);
    return () => {
      if (!admission.pending.delete(pending)) return;
      finish();
      if (!admission.retiring && admission.pending.size === 0) this.#environmentAdmissions.delete(key);
    };
  }

  #scopeCopy(scope: RequestScope): RequestScope {
    return Object.freeze({ ...scope });
  }

  #publishTerminalSummary(scope: RequestScope, threadId: string): void {
    try {
      this.#onTerminalSummaryChanged(this.#scopeCopy(scope), threadId);
    } catch {
      // Projection publication is derived and must not roll back PTY authority.
    }
  }

  #attachSealed(
    terminal: TerminalResource,
    input: {
      readonly scope: RequestScope;
      readonly attachmentId: string;
      readonly producerId: string;
      readonly restore:
        | { readonly kind: "checkpoint" }
        | { readonly kind: "resume"; readonly appliedSeq: number };
      readonly emit: (frame: TerminalServerFrame) => void;
    },
  ): TerminalViewerSession {
    const incarnationId = terminal.incarnationId;
    if (!incarnationId) throw new TerminalServiceError("invalid_transition", "No history is available.");
    const base = {
      v: TERMINAL_PROTOCOL_VERSION,
      terminalId: terminal.terminalId,
      incarnationId,
    };
    let closed = false;
    let lastSentSeq = 0;
    let outstandingBytes = 0;
    let snapshotSeq: number | undefined;
    let snapshotSentChunkIndex = -1;
    let snapshotAckChunkIndex = -1;
    const outstanding: Array<{ seq: number; bytes: number }> = [];
    let wake: (() => void) | undefined;
    const journalState = this.#journal.read(input.scope, terminal.terminalId);
    if (
      journalState.headSeq !== terminal.headSeq ||
      journalState.checkpoint.seq !== terminal.historyFloorSeq
    ) {
      throw new TerminalServiceError(
        "runtime_unavailable",
        "The terminal history metadata is inconsistent.",
        true,
      );
    }
    const canResume =
      input.restore.kind === "resume" &&
      input.restore.appliedSeq >= terminal.historyFloorSeq &&
      input.restore.appliedSeq <= journalState.headSeq;
    const restoreKind = canResume ? "resume" as const : "checkpoint" as const;
    const replayAfter = canResume
      ? input.restore.appliedSeq
      : journalState.checkpoint.seq;
    input.emit({
      ...base,
      type: "attached",
      attachmentId: input.attachmentId,
      role: "observer",
      controllerEpoch: 0,
      lastAcceptedInputSeq: 0,
      lifecycle: terminal.lifecycle,
      lifecycleRevision: terminal.lifecycleRevision,
      rows: terminal.rows,
      columns: terminal.columns,
      historyFloorSeq: terminal.historyFloorSeq,
      headSeq: terminal.headSeq,
      restoreKind,
    });
    const waitForAck = () => new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("terminal_viewer_ack_timeout")),
        15_000,
      );
      timeout.unref();
      wake = () => {
        clearTimeout(timeout);
        resolve();
      };
    });
    void (async () => {
      if (restoreKind === "checkpoint") {
        const checkpoint = journalState.checkpoint;
        const chunks = chunkBytes(checkpoint.bytes, 48 * 1024);
        snapshotSeq = checkpoint.seq;
        input.emit({ ...base, type: "snapshot_begin", checkpointSeq: checkpoint.seq,
          rows: checkpoint.seq === 0 ? terminal.initialRows : checkpoint.rows,
          columns: checkpoint.seq === 0 ? terminal.initialColumns : checkpoint.columns,
          format: "ansi-checkpoint-v1", byteLength: checkpoint.bytes.byteLength,
          chunkCount: chunks.length });
        for (let offset = 0; offset < chunks.length; offset += 4) {
          const windowEnd = Math.min(chunks.length - 1, offset + 3);
          for (let index = offset; index <= windowEnd; index += 1) {
            snapshotSentChunkIndex = index;
            input.emit({ ...base, type: "snapshot_chunk",
              checkpointSeq: checkpoint.seq, chunkIndex: index,
              data: Buffer.from(chunks[index]!).toString("base64url") });
          }
          while (!closed && snapshotAckChunkIndex < windowEnd) await waitForAck();
        }
        input.emit({ ...base, type: "snapshot_end", checkpointSeq: checkpoint.seq,
          sha256: checkpoint.sha256 });
        snapshotSeq = undefined;
      }
      let sentFinalStatus = false;
      for (const record of journalState.records) {
        if (closed || record.seq <= replayAfter) continue;
        const bytes = record.kind === "output" ? record.bytes.byteLength : 64;
        while (!closed &&
          (outstanding.length >= 64 ||
            (outstanding.length > 0 && outstandingBytes + bytes > 256 * 1024))) {
          await waitForAck();
        }
        if (closed) return;
        if (record.kind === "output") {
          input.emit({ ...base, type: "output", seq: record.seq,
            data: Buffer.from(record.bytes).toString("base64url") });
        } else if (record.kind === "resize") {
          input.emit({ ...base, type: "resize_committed", seq: record.seq,
            rows: record.rows, columns: record.columns });
        } else {
          sentFinalStatus = true;
          input.emit({ ...base, type: "terminal_status", seq: record.seq,
            lifecycle: record.lifecycle,
            lifecycleRevision: terminal.lifecycleRevision,
            exitCode: record.exitCode, exitSignal: record.exitSignal,
            publicReason: record.publicReason });
        }
        lastSentSeq = record.seq;
        outstanding.push({ seq: record.seq, bytes });
        outstandingBytes += bytes;
      }
      if (!closed && !sentFinalStatus) {
        input.emit({ ...base, type: "lifecycle_state",
          lifecycle: terminal.lifecycle,
          lifecycleRevision: terminal.lifecycleRevision,
          headSeq: terminal.headSeq, exitCode: terminal.exitCode,
          exitSignal: terminal.exitSignal, publicReason: terminal.publicReason });
      }
      if (!closed) input.emit({ ...base, type: "caught_up", headSeq: terminal.headSeq });
    })().catch(() => {
      if (!closed) input.emit({ ...base, type: "resync_required",
        historyFloorSeq: terminal.historyFloorSeq });
    });
    return {
      async dispatch(frame: TerminalClientFrame) {
        if (frame.type === "ack_snapshot") {
          if (
            frame.checkpointSeq !== snapshotSeq ||
            frame.chunkIndex > snapshotSentChunkIndex ||
            frame.chunkIndex < snapshotAckChunkIndex
          ) {
            closed = true;
            wake?.();
            wake = undefined;
            return;
          }
          snapshotAckChunkIndex = frame.chunkIndex;
          wake?.();
          wake = undefined;
          return;
        }
        if (frame.type !== "ack_output" || frame.appliedSeq > lastSentSeq) return;
        while (outstanding.length > 0 && outstanding[0]!.seq <= frame.appliedSeq) {
          outstandingBytes -= outstanding.shift()!.bytes;
        }
        wake?.();
        wake = undefined;
      },
      close() {
        closed = true;
        wake?.();
        wake = undefined;
      },
    };
  }

  #repositoryError(error: unknown): TerminalServiceError {
    const message = error instanceof Error ? error.message : "terminal_operation_failed";
    if (message.includes("not_found")) {
      return new TerminalServiceError("not_found", "The terminal was not found.");
    }
    if (message.includes("revision") || message.includes("mutation_id")) {
      return new TerminalServiceError("conflict", "The terminal changed.");
    }
    return new TerminalServiceError("invalid_transition", "The terminal operation is not allowed.");
  }

  #key(scope: RequestScope, terminalId: string): string {
    return `${scope.tenantId}\0${scope.principalId}\0${terminalId}`;
  }
}

function terminalDeletionReady(pending: {
  readonly terminationEffect: TerminalResource["terminationEffect"];
  readonly cleanupConfirmed: boolean;
  readonly transportClosed: boolean;
}): boolean {
  return pending.terminationEffect === "disconnect_transport"
    ? pending.transportClosed
    : pending.cleanupConfirmed;
}

function chunkBytes(bytes: Uint8Array, maximumBytes: number): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += maximumBytes) {
    chunks.push(bytes.slice(offset, offset + maximumBytes));
  }
  return chunks;
}
