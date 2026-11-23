import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { LateBoundBackendAgentToolFacade } from "../../src/server/agent-tools/adapters/backend-facade.js";
import { SourceScopedAgentToolService } from "../../src/server/agent-tools/application/source-scoped-agent-tool-service.js";
import type { TrustedToolInvocationContext } from "../../src/server/agent-tools/contracts/agent-tool-contracts.js";
import { ExecutionConfigurationTools } from "../../src/server/agent-tools/execution/execution-configuration-tools.js";
import { QueuedInputDispatcher } from "../../src/server/conversations/queued-input-dispatcher.js";
import { ThreadCompletionCallbackDispatcher } from "../../src/server/conversations/thread-completion-callback-dispatcher.js";
import { ThreadMutationGateway } from "../../src/server/conversations/thread-mutation-gateway.js";
import { DurableScheduler } from "../../src/server/domain/durable-scheduler.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { startProductionApplication, type RunningApplication } from "../../src/server/production-application.js";

it("makes management services usable before publishing tools or dispatching startup work", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-management-startup-"));
  await writeFile(path.join(directory, "server.json"), JSON.stringify({ schemaVersion: 11, packagedClients: [] }));
  let application: RunningApplication | undefined;
  let facade: SourceScopedAgentToolService | undefined;
  const stages: string[] = [];
  const errors: unknown[] = [];
  const checks: Promise<void>[] = [];
  // This probe skips caller admission, which has separate production-MCP tests,
  // and reads through the actual service reference captured by the tool adapter.
  vi.spyOn(ExecutionConfigurationTools.prototype, "execute").mockImplementation(async function (this: ExecutionConfigurationTools) {
    const configuration = this.options.configuration();
    const scope = new SingleUserIdentityProvider(configuration.repository.database).getScope();
    return configuration.get(scope);
  });
  const probe = (stage: string) => {
    const pending = Promise.resolve().then(() => {
      expect(facade).toBeInstanceOf(SourceScopedAgentToolService);
      return facade!.canonical.registry.get("execution.defaults.get", 1)
        .execute({}, {} as TrustedToolInvocationContext);
    }).then(snapshot => {
      expect(snapshot).toMatchObject({ revision: 0, configuration: { defaultTargetId: null } });
      stages.push(stage);
    }, error => { errors.push(error); });
    checks.push(pending);
    return pending;
  };
  const bind = LateBoundBackendAgentToolFacade.prototype.bind;
  vi.spyOn(LateBoundBackendAgentToolFacade.prototype, "bind").mockImplementation(function (this: LateBoundBackendAgentToolFacade, delegate) {
    if (!(delegate instanceof SourceScopedAgentToolService)) throw new Error("unexpected_production_tool_facade");
    facade = delegate;
    bind.call(this, delegate);
    void probe("facade");
  });
  const recoverQueue = QueuedInputDispatcher.prototype.recover;
  vi.spyOn(QueuedInputDispatcher.prototype, "recover").mockImplementation(async function (this: QueuedInputDispatcher, scope) {
    await probe("queue");
    return recoverQueue.call(this, scope);
  });
  const deliverCallbacks = ThreadCompletionCallbackDispatcher.prototype.deliverReady;
  vi.spyOn(ThreadCompletionCallbackDispatcher.prototype, "deliverReady").mockImplementation(async function (this: ThreadCompletionCallbackDispatcher, scope) {
    await probe("callbacks");
    return deliverCallbacks.call(this, scope);
  });
  const recoverUncertain = ThreadMutationGateway.prototype.recoverUncertain;
  vi.spyOn(ThreadMutationGateway.prototype, "recoverUncertain").mockImplementation(async function (this: ThreadMutationGateway, scope) {
    await probe("uncertain");
    return recoverUncertain.call(this, scope);
  });
  const startScheduler = DurableScheduler.prototype.start;
  vi.spyOn(DurableScheduler.prototype, "start").mockImplementation(function (this: DurableScheduler) {
    void probe("scheduler");
    startScheduler.call(this);
  });
  try {
    application = await startProductionApplication({ ...process.env, APP_STATE_DIR: directory,
      SEDES_CONFIG_FILE: path.join(directory, "server.json"), PORT: "0",
      PI_CODING_AGENT_DIR: path.join(directory, "pi"), XDG_RUNTIME_DIR: path.join(directory, "runtime") });
    await Promise.all(checks);
    expect(errors).toEqual([]);
    expect(stages).toEqual(expect.arrayContaining(["facade", "queue", "callbacks", "uncertain", "scheduler"]));
  } finally {
    await application?.close();
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
