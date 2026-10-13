import type Database from "better-sqlite3";
import type { RequestScope } from "../identity/identity-provider.js";
import type { BackendKind } from "./contracts.js";

export interface BackendCreationProvenanceRepairContext {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly backendConversationId: string;
  readonly attemptId: string;
  readonly canonicalWorkspacePath: string;
}

export interface BackendCreationProvenanceRepairAdapter {
  /** Read and verify all private evidence; return its complete immutable fingerprint input. */
  collectVerifiedEvidence(input: BackendCreationProvenanceRepairContext): string | undefined;
}

export interface BackendCreationProvenanceRepairRegistry {
  creationProvenanceRepairForBackendKind(kind: BackendKind): BackendCreationProvenanceRepairAdapter | undefined;
}
