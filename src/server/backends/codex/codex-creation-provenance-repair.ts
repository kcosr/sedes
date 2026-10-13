import type { CreationProvenanceRepairEvidence } from "../../db/repositories/conversation-creation-provenance-repository.js";
import { parseCodexBindingDetail } from "./codex-binding-codec.js";

/** Only server-retained, exactly matching provider-assigned identity proves creation. */
export function verifyCodexCreationProvenanceRepair(evidence: CreationProvenanceRepairEvidence): boolean {
  try {
    const created = parseCodexBindingDetail(evidence.detail);
    const bound = evidence.boundDetail === null ? created : parseCodexBindingDetail(evidence.boundDetail);
    return evidence.backendKind === "codex_app_server" && created.threadId === evidence.backendConversationId
      && bound.threadId === created.threadId && bound.sessionId === created.sessionId;
  } catch { return false; }
}
