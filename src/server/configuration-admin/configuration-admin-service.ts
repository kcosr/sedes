import { randomBytes } from "node:crypto";
import {
  configurationLifecycleImpactRequestSchema, configurationLifecycleImpactSchema, configurationLifecycleRequestSchema,
  configurationLifecycleResultSchema, saveConfigurationRequestSchema,
  type ConfigurationDocument, type ConfigurationLifecycleImpact,
  type ConfigurationLifecycleImpactRequest, type ConfigurationLifecycleRequest,
  type ConfigurationLifecycleResult, type ConfigurationRuntimeState,
  type ConfigurationSnapshot, type SaveConfigurationRequest,
} from "../../shared/protocol/configuration-admin.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "../domain/errors.js";
import { ConfigurationRepository } from "./configuration-repository.js";
import type { ConfigurationProjection } from "./configuration-projection.js";
import { validateConfigurationDocument } from "./configuration-validation.js";

export type ConfigurationAdministrationAction = "read" | "write" | "probe" | "lifecycle";

/** Root composition supplies actual, scoped runtime evidence and admission fences. */
export interface ConfigurationRuntimeAdapter {
  observe(scope: RequestScope, snapshot: ConfigurationSnapshot): Promise<readonly ConfigurationRuntimeState[]>;
  reconcile(scope: RequestScope, snapshot: ConfigurationSnapshot): Promise<void>;
  impact(scope: RequestScope, request: ConfigurationLifecycleImpactRequest, runtime: ConfigurationRuntimeState): Promise<{
    readonly runtime: ConfigurationRuntimeState;
    /** Exact resource/active-work/controller fence, checked atomically by execute. */
    readonly fence: string;
    readonly interruptions: readonly string[];
  }>;
  execute(scope: RequestScope, input: {
    readonly request: ConfigurationLifecycleRequest;
    readonly runtime: ConfigurationRuntimeState;
    readonly expectedFence: string | null;
  }): Promise<ConfigurationLifecycleResult>;
  /** Explicit receipt lookup only. Inspect durable evidence for the original
   * command; never replay execution or reconnect ordinary snapshot reads.
   * Return undefined when no authoritative outcome is available. */
  recoverLifecycle?(scope: RequestScope, input: {
    readonly request: ConfigurationLifecycleRequest;
    readonly result: ConfigurationLifecycleResult;
  }): Promise<ConfigurationLifecycleResult | undefined>;
  /** Optional admission lock spanning validation and the durable save. */
  commitConfiguration?(scope: RequestScope, previous: ConfigurationSnapshot,
    next: ConfigurationDocument, commit: () => ConfigurationSnapshot): Promise<ConfigurationSnapshot>;
}

type ImpactEntry = {
  readonly scope: RequestScope;
  readonly impact: ConfigurationLifecycleImpact;
  readonly fence: string;
  readonly expiresAt: number;
};

export class ConfigurationAdminService {
  readonly #impacts = new Map<string, ImpactEntry>();
  readonly #lifecycleExecutions = new Map<string, Promise<ConfigurationLifecycleResult>>();
  readonly #now: () => number;

  constructor(readonly repository: ConfigurationRepository, readonly options: {
    readonly authorize: (scope: RequestScope, action: ConfigurationAdministrationAction) => void | Promise<void>;
    readonly projection: ConfigurationProjection;
    readonly runtime?: ConfigurationRuntimeAdapter;
    readonly authorizeSecretReference?: (scope: RequestScope, environmentId: string,
      reference: { source: "environment"; variable: string } | { source: "protected_file"; path: string }) => void | Promise<void>;
    readonly now?: () => number;
    readonly onLifecycleError?: (error: unknown, operation: Pick<ConfigurationLifecycleRequest,
      "mutationId" | "resourceKind" | "resourceId" | "action">) => void;
  }) { this.#now = options.now ?? Date.now; }

  async get(scope: RequestScope): Promise<ConfigurationSnapshot> {
    await this.options.authorize(scope, "read");
    const snapshot = this.repository.get(scope);
    if (this.options.runtime) {
      const observations = await this.options.runtime.observe(scope, snapshot);
      for (const observation of observations) {
        try { this.repository.observe(scope, observation); }
        catch (error) { if (!(error instanceof DomainError && error.code === "conflict")) throw error; }
      }
    }
    return this.repository.get(scope);
  }

  async save(scope: RequestScope, value: SaveConfigurationRequest): Promise<ConfigurationSnapshot> {
    await this.options.authorize(scope, "write");
    const request = saveConfigurationRequestSchema.parse(value);
    const replayed = this.repository.replaySave(scope, request);
    if (replayed) return replayed;
    const configuration = validateConfigurationDocument(request.configuration);
    const references = await this.#authorizeSecrets(scope, configuration);
    const previous = this.repository.get(scope);
    const commit = () => this.repository.save(scope, { ...request, configuration }, document => {
      this.options.projection.project(scope, document);
      for (const reference of references) this.repository.approveSecret(scope, reference.environmentId, reference.reference);
    });
    const result = this.options.runtime?.commitConfiguration
      ? await this.options.runtime.commitConfiguration(scope, previous, configuration, commit)
      : commit();
    if (this.options.runtime) {
      try { await this.options.runtime.reconcile(scope, result); }
      catch {
        // The save already committed. Do not turn a successful durable mutation
        // into a retry-inducing HTTP failure when applying external state fails.
        for (const runtime of result.runtimes.filter(item => item.desiredRevision === result.revision)) {
          try { this.repository.observe(scope, { ...runtime, applyState: "unavailable", lastError: "Configuration is saved; runtime reconciliation is unavailable." }); }
          catch (error) { if (!(error instanceof DomainError && error.code === "conflict")) throw error; }
        }
      }
    }
    return result;
  }

  async impact(scope: RequestScope, value: ConfigurationLifecycleImpactRequest): Promise<ConfigurationLifecycleImpact> {
    await this.options.authorize(scope, "probe");
    await this.options.authorize(scope, "lifecycle");
    const request = configurationLifecycleImpactRequestSchema.parse(value);
    const snapshot = this.repository.get(scope);
    if (snapshot.revision !== request.expectedRevision) throw new DomainError("conflict", "Configuration changed. Refresh before inspecting lifecycle impact.");
    const runtime = this.repository.runtime(scope, request.resourceKind, request.resourceId);
    const adapter = this.#runtimeAdapter();
    const evidence = await adapter.impact(scope, request, runtime);
    if (!evidence.runtime.supportedActions.includes(request.action)) throw new DomainError("bad_request", "This lifecycle action is unsupported for the selected runtime.");
    this.repository.observe(scope, evidence.runtime);
    this.#pruneImpacts();
    if (this.#impacts.size >= 256) throw new DomainError("conflict", "Too many pending lifecycle confirmations.");
    const token = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + 120_000;
    if (!evidence.fence || evidence.fence.length > 4096) throw new Error("configuration_runtime_impact_fence_invalid");
    const impact = configurationLifecycleImpactSchema.parse({
      token, resourceKind: request.resourceKind, resourceId: request.resourceId, action: request.action,
      configurationRevision: snapshot.revision, incarnation: evidence.runtime.incarnation,
      activeResources: evidence.runtime.activeResources, interruptions: [...evidence.interruptions], expiresAt: new Date(expiresAt).toISOString(),
    });
    this.#impacts.set(token, { scope: { ...scope }, impact, fence: evidence.fence, expiresAt });
    return impact;
  }

  async lifecycle(scope: RequestScope, value: ConfigurationLifecycleRequest): Promise<ConfigurationLifecycleResult> {
    await this.options.authorize(scope, "lifecycle");
    const request = configurationLifecycleRequestSchema.parse(value);
    const replayed = this.repository.replayLifecycle(scope, request);
    if (replayed) return replayed;
    const adapter = this.#runtimeAdapter();
    const runtime = this.repository.runtime(scope, request.resourceKind, request.resourceId);
    if (!runtime.supportedActions.includes(request.action)) throw new DomainError("bad_request", "This lifecycle action is unsupported for the selected runtime.");
    if (request.action === "stop" && this.repository.pendingLifecycle(scope).some(entry =>
      entry.request.resourceKind === request.resourceKind && entry.request.resourceId === request.resourceId &&
      this.#lifecycleExecutions.has(JSON.stringify([scope.tenantId, scope.principalId, entry.request.mutationId])))) {
      throw new DomainError("conflict", "The previous lifecycle command is still running. Check its original status before stopping this runtime.");
    }
    const disruptive = ["stop", "restart", "upgrade"].includes(request.action);
    const confirmation = request.impactToken ? this.#impacts.get(request.impactToken) : undefined;
    if (disruptive || request.impactToken !== null) {
      if (!confirmation || confirmation.expiresAt <= this.#now() ||
        confirmation.scope.tenantId !== scope.tenantId || confirmation.scope.principalId !== scope.principalId ||
        confirmation.impact.resourceKind !== request.resourceKind || confirmation.impact.resourceId !== request.resourceId ||
        confirmation.impact.action !== request.action || confirmation.impact.configurationRevision !== request.expectedRevision ||
        confirmation.impact.incarnation !== request.expectedIncarnation) {
        throw new DomainError("conflict", "Lifecycle impact confirmation is missing, expired, or stale. Inspect the current impact again.");
      }
    }
    const admitted = this.repository.beginLifecycle(scope, request);
    if (!admitted.fresh) return admitted.result;
    if (request.impactToken) this.#impacts.delete(request.impactToken);
    const key = JSON.stringify([scope.tenantId, scope.principalId, request.mutationId]);
    const execution = this.#executeLifecycle(scope, request, admitted.result, confirmation?.fence ?? null, adapter);
    this.#lifecycleExecutions.set(key, execution);
    void execution.finally(() => this.#lifecycleExecutions.delete(key)).catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // HTTP acknowledgement has its own budget. A slow upgrade remains owned
      // by this service and finishes the same durable receipt after returning.
      return await Promise.race([execution, new Promise<ConfigurationLifecycleResult>(resolve => {
        timer = setTimeout(() => resolve(admitted.result), 10_000);
        timer.unref();
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async #executeLifecycle(scope: RequestScope, request: ConfigurationLifecycleRequest,
    admitted: ConfigurationLifecycleResult, expectedFence: string | null, adapter: ConfigurationRuntimeAdapter): Promise<ConfigurationLifecycleResult> {
    let result: ConfigurationLifecycleResult;
    try {
      result = configurationLifecycleResultSchema.parse(await adapter.execute(scope, {
        request, runtime: admitted.runtime, expectedFence,
      }));
    } catch (error) {
      try {
        this.options.onLifecycleError?.(error, {
          mutationId: request.mutationId, resourceKind: request.resourceKind,
          resourceId: request.resourceId, action: request.action,
        });
      } catch { /* Reporting must not prevent retaining the uncertain outcome. */ }
      result = { mutationId: request.mutationId, state: "unknown", runtime: {
        ...admitted.runtime, applyState: "unavailable", connectionState: "unknown",
        lastError: "The lifecycle operation has no confirmed outcome. Refresh status before taking further action.",
      } };
    }
    return this.repository.completeLifecycle(scope, request, result);
  }

  async lifecycleReceipt(scope: RequestScope, mutationId: string): Promise<ConfigurationLifecycleResult> {
    await this.options.authorize(scope, "read");
    const result = this.repository.lifecycleReceipt(scope, mutationId);
    if (this.#lifecycleExecutions.has(JSON.stringify([scope.tenantId, scope.principalId, mutationId]))) return result;
    if (result.state === "pending" || result.state === "unknown") {
      const pending = this.repository.pendingLifecycle(scope).find(entry => entry.request.mutationId === mutationId);
      if (pending) {
        if (pending.result.state === "pending") {
          // Durable admission survived this server's execution owner. The
          // remote command may still be running; expose uncertainty so the
          // user can recover its receipt or request a separately fenced Stop.
          const message = "The server no longer owns this lifecycle operation. Its remote outcome is unconfirmed. Refresh its result or stop the execution environment.";
          pending.result = this.repository.completeLifecycle(scope, pending.request, {
            ...pending.result, state: "unknown", runtime: {
              ...pending.result.runtime, applyState: "unavailable", lastError: message,
            },
          });
          try {
            this.options.onLifecycleError?.(new Error(message), {
              mutationId: pending.request.mutationId, resourceKind: pending.request.resourceKind,
              resourceId: pending.request.resourceId, action: pending.request.action,
            });
          } catch { /* Reporting must not prevent retaining the uncertain outcome. */ }
        }
        if (this.options.runtime?.recoverLifecycle) {
          await this.options.authorize(scope, "probe");
          const recovered = await this.options.runtime.recoverLifecycle(scope, pending);
          if (recovered) return this.repository.completeLifecycle(scope, pending.request, recovered);
        }
      }
    }
    return this.repository.lifecycleReceipt(scope, mutationId);
  }

  async settleLifecycleOperations(): Promise<void> {
    await Promise.all([...this.#lifecycleExecutions.values()]);
  }

  #runtimeAdapter(): ConfigurationRuntimeAdapter {
    if (!this.options.runtime) throw new DomainError("runtime_unavailable", "Runtime administration is unavailable.", true);
    return this.options.runtime;
  }

  #pruneImpacts(): void {
    for (const [token, entry] of this.#impacts) if (entry.expiresAt <= this.#now()) this.#impacts.delete(token);
  }

  async #authorizeSecrets(scope: RequestScope, document: ConfigurationDocument) {
    const approved: { environmentId: string; reference: { source: "environment"; variable: string } | { source: "protected_file"; path: string } }[] = [];
    for (const backend of document.backends) {
      if (backend.kind !== "codex_app_server" || backend.moduleConfiguration.connection.ownership !== "external") continue;
      const channel = backend.moduleConfiguration.connection.channel;
      if (channel.type !== "tcp_websocket") continue;
      const environmentId = document.targets.find(target => target.backendInstanceId === backend.id)?.executionEnvironmentId;
      if (!environmentId) throw new DomainError("bad_request", "Credential reference requires an execution environment.");
      const reference = channel.authentication.secret;
      if (!this.repository.hasApprovedSecret(scope, environmentId, reference)) {
        if (!this.options.authorizeSecretReference) throw new DomainError("bad_request", "This credential reference has not been approved for the execution environment.");
        await this.options.authorizeSecretReference(scope, environmentId, reference);
        approved.push({ environmentId, reference });
      }
    }
    return approved;
  }
}
