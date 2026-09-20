import type Database from "better-sqlite3";
import { createThreadAgentToolPolicyDependencies } from "../../src/server/conversations/thread-agent-tool-policy-dependencies.js";
import { ThreadAgentToolPolicyRepository } from "../../src/server/db/repositories/thread-agent-tool-policy-repository.js";

export function threadAgentToolPolicyReaderDependencies(
  database: Database.Database,
) {
  const dependencies = createThreadAgentToolPolicyDependencies();
  return {
    agentTools: new ThreadAgentToolPolicyRepository(
      database,
      dependencies.eligibility,
    ),
    agentToolCatalog: dependencies.catalog,
    agentToolEligibility: dependencies.eligibility,
  } as const;
}

export function threadAgentToolPolicyRepository(database: Database.Database) {
  return threadAgentToolPolicyReaderDependencies(database).agentTools;
}
