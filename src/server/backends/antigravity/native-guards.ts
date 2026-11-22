import { integer, message, repeated, type Message } from "./native-protobuf.js";

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
