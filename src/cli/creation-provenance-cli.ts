import path from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { SedesCliIo } from "./sedes-cli.js";
import { ConversationCreationProvenanceRepository, type CreationProvenanceRepairEvidence } from "../server/db/repositories/conversation-creation-provenance-repository.js";
import { verifyCodexCreationProvenanceRepair } from "../server/backends/codex/codex-creation-provenance-repair.js";
import { parseOpenCodeBindingDetail } from "../server/backends/opencode/opencode-binding-detail.js";
import { OpenCodeThreadRepository } from "../server/backends/opencode/opencode-thread-repository.js";

const usage = `Usage: sedes repair creation-provenance --database ABSOLUTE_PATH --tenant ID --principal ID --thread ID --native-session ID
  [--apply --server-stopped --expected-fingerprint SHA256]

Default: read-only evidence preview. Apply requires a stopped server and the exact
preview fingerprint. Only provenance and its audit receipt are written. No input
is replayed and no thread is restored, attached, or unarchived.
`;

export function verifyCreationRepair(database: Database.Database, evidence: CreationProvenanceRepairEvidence): boolean {
  if (evidence.backendKind === "codex_app_server") return verifyCodexCreationProvenanceRepair(evidence);
  if (evidence.backendKind === "opencode") {
    try {
      const detail = parseOpenCodeBindingDetail(evidence.detail);
      return new OpenCodeThreadRepository({ database,
        scope: { tenantId: evidence.tenantId, principalId: evidence.ownerPrincipalId },
        backendInstanceId: evidence.backendInstanceId, nativeNamespaceKey: detail.nativeNamespaceKey,
      }).verifyCreationRepairEvidence({ tenantId: evidence.tenantId, principalId: evidence.ownerPrincipalId },
        evidence.applicationThreadId, evidence.backendConversationId, evidence.attemptId);
    } catch { return false; }
  }
  return false;
}

export async function runCreationProvenanceCli(args: readonly string[], io: SedesCliIo = process): Promise<number> {
  if ((args.length === 1 && ["--help", "-h"].includes(args[0]!)) ||
      (args.length === 2 && args[0] === "creation-provenance" && ["--help", "-h"].includes(args[1]!))) {
    io.stdout.write(usage); return 0;
  }
  let database: Database.Database | undefined;
  try {
    const { values, positionals } = parseArgs({ args: [...args], options: {
      database: { type: "string" }, tenant: { type: "string" }, principal: { type: "string" },
      thread: { type: "string" }, "native-session": { type: "string" },
      apply: { type: "boolean" }, "server-stopped": { type: "boolean" }, "expected-fingerprint": { type: "string" },
    }, strict: true, allowPositionals: true });
    if (positionals.length !== 1 || positionals[0] !== "creation-provenance" || !values.database || !path.isAbsolute(values.database)
      || !values.tenant || !values.principal || !values.thread || !values["native-session"]
      || (values.apply && (!values["server-stopped"] || !/^[a-f0-9]{64}$/u.test(values["expected-fingerprint"] ?? "")))) {
      io.stderr.write(usage); return 2;
    }
    database = new Database(values.database, { readonly: !values.apply, fileMustExist: true });
    database.pragma("foreign_keys = ON");
    database.pragma("busy_timeout = 5000");
    if (!database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_creation_provenance'").get()) {
      throw new Error("Upgrade and migrate this Sedes database before using creation-provenance repair. This command never migrates a database.");
    }
    const scope = { tenantId: values.tenant, principalId: values.principal };
    const repository = new ConversationCreationProvenanceRepository(database);
    const evidence = repository.previewRepair(scope, values.thread, values["native-session"]);
    if (!verifyCreationRepair(database, evidence)) throw new Error("The retained backend creation evidence does not verify this exact binding.");
    if (values.apply) repository.applyRepair(scope, values.thread, {
      expectedNativeSessionId: values["native-session"], expectedFingerprint: values["expected-fingerprint"]!,
      now: Date.now(), repairId: randomUUID(), verify: current => verifyCreationRepair(database!, current),
    });
    io.stdout.write(`${JSON.stringify({ status: values.apply ? "repaired" : "dry_run", threadId: evidence.applicationThreadId,
      nativeSessionId: evidence.backendConversationId, backendInstanceId: evidence.backendInstanceId,
      attemptId: evidence.attemptId, fingerprint: evidence.fingerprint, inventoryState: evidence.inventoryState,
      runtimeRefresh: evidence.inventoryState === "archived" ? "deferred_until_explicit_restore" : "requires_idle_retirement_and_resume" })}\n`);
    return 0;
  } catch (error) { io.stderr.write(`${error instanceof Error ? error.message : "Creation provenance repair failed."}\n`); return 1; }
  finally { database?.close(); }
}
