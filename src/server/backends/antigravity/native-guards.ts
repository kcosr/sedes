import { z } from "zod";
import { integer, message, repeated, string, type Message } from "./native-protobuf.js";

const uuid = z.string().uuid();
const errorTitlePrefix = "Error from ";
const errorBodySuffix = '" encountered an error and has either stopped or failed to start execution: ';

/** agy HandleExecutionError identifies the child in a fixed system message.
 * The decoded identity correlates delivery only. Receipts still prove settlement. */
export function antigravityFailedSubagentSessionId(step: Message, sessionId: string): string | undefined {
  const metadata = message(step.metadata);
  if (step.type !== 101 || step.status !== 3 || metadata.source !== 5 || metadata.tool_call !== undefined) return undefined;
  const system = message(step.system_message), incoming = message(system.agent_message);
  if (system.event_type !== undefined || incoming.sender !== "system" || incoming.recipient !== sessionId ||
      !uuid.safeParse(incoming.id).success) return undefined;

  const title = string(message(incoming.render_details).message_title), body = string(incoming.content);
  if (!title.startsWith(errorTitlePrefix) || title.length === errorTitlePrefix.length) return undefined;
  // Use the complete independently formatted title to delimit the name, which
  // can itself contain quotes, UUIDs or fragments of the error envelope.
  const prefix = `The subagent ${title.slice(errorTitlePrefix.length)} with id "`;
  const endId = prefix.length + 36;
  if (!body.startsWith(prefix) || !body.startsWith(errorBodySuffix, endId) ||
      body.length === endId + errorBodySuffix.length) return undefined;
  const childId = body.slice(prefix.length, endId);
  return uuid.safeParse(childId).success && childId !== sessionId ? childId : undefined;
}

/** Compatible runtimes may add fields, but cannot silently move the semantic
 * payloads used for transcript identity and terminal proof. These guards are
 * also applied by passive readers, which intentionally never launch the CLI. */
export function assertAntigravityNativeSemantics(step: Message): void {
  const type = integer(step.type), status = integer(step.status);
  const required: Readonly<Record<number, string>> = { 14: "user_input", 15: "planner_response", 101: "system_message", 132: "generic" };
  const payload = required[type];
  if (payload && (step[payload] === undefined || typeof step[payload] !== "object" || Array.isArray(step[payload])))
    throw new Error("antigravity_native_semantic_layout_incompatible");
  if (type === 14) {
    const user = message(step.user_input);
    const items = repeated(user.items);
    // Proto3 omits an empty string. Native scope-only items also legitimately
    // omit text; only the containing message structure is mandatory here.
    if (items.length === 0 || items.some(item => !item || typeof item !== "object" || Array.isArray(item)))
      throw new Error("antigravity_native_user_content_unsupported");
  }
  if (type === 15 && status === 3 && integer(message(step.planner_response).stop_reason) === 0)
    throw new Error("antigravity_native_completion_evidence_missing");
}
