import type { PiNativeCommand } from "./port.js";

const CONTROL_RPC_COMMANDS = new Set(["abort", "abort_retry", "abort_bash", "clear_queue", "get_state", "get_messages", "get_session_stats",
  "get_available_models", "get_available_thinking_levels", "get_fork_messages", "get_tree", "get_entries", "get_last_assistant_text", "get_commands", "extension_ui_response"]);
const CONTROL_COMPANION_COMMANDS = new Set(["snapshot", "get_submission", "complete_submission", "begin_stop", "end_stop", "resolve_tool_approval", "resolve_agent_tool"]);

export function piNativeCommandIsControl(command: PiNativeCommand): boolean {
  return (command.channel === "rpc" ? CONTROL_RPC_COMMANDS : CONTROL_COMPANION_COMMANDS).has(String(command.command.type));
}

/** Observation cannot create a mutation or an obligation to deliver its result. */
export function piNativeCommandIsReadOnly(command: PiNativeCommand): boolean {
  const type = String(command.command.type);
  return command.channel === "rpc" ? CONTROL_RPC_COMMANDS.has(type) && type.startsWith("get_") : type === "snapshot" || type === "get_submission";
}

/** Recovery may stop work or deny a wait, but cannot approve or create work. */
export function piNativeCommandIsRecoveryControl(command: PiNativeCommand): boolean {
  if (piNativeCommandIsReadOnly(command)) return true;
  const value = command.command;
  if (command.channel === "rpc") return ["abort", "abort_retry", "abort_bash", "clear_queue"].includes(String(value.type)) ||
    (value.type === "extension_ui_response" && value.cancelled === true);
  return value.type === "begin_stop" || value.type === "end_stop" ||
    (value.type === "resolve_tool_approval" && value.approved === false) ||
    (value.type === "resolve_agent_tool" && value.isError === true);
}
