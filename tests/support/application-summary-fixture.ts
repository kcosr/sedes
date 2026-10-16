import { DatabaseApplicationThreadSummaryReader } from "../../src/server/application/database-application-summary-reader.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { QueuedInputRepository } from "../../src/server/db/repositories/queued-input-repository.js";
import { SubmissionCompletionRepository } from "../../src/server/db/repositories/submission-completion-repository.js";
import { savedAgentDatabase } from "./saved-agent-fixture.js";

/** Disposable current-schema database; never opens a provider or persistent state. */
export function applicationSummaryFixture(threadCount = 4) {
  const { database, scope } = savedAgentDatabase();
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id,
    canonicalPath: "/tmp/summary-sql-fixture",
    displayName: "Summary SQL fixture",
    project: { kind: "new", name: "Summary SQL fixture" },
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 200,
  });
  const profile = database.prepare("SELECT id FROM agent_connection_profiles WHERE enabled = 1").get() as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const ids = database.transaction(() => Array.from({ length: threadCount }, (_, index) => bindings.createUnboundThread(scope, {
    id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workspaceId: workspace.id,
    connectionProfileId: profile.id,
    title: `Thread ${index}`,
    // The first two deliberately tie, exercising the ID ordering tiebreaker.
    now: 300 + Math.max(0, index - 1),
  }).id))();
  const queue = new QueuedInputRepository(database);
  const completion = new SubmissionCompletionRepository(database);
  const createReader = () => new DatabaseApplicationThreadSummaryReader({ inventory, queue, completion });
  return { database, scope, inventory, environment, workspace, bindings, ids, queue, completion, createReader };
}
