import type { ConfigurationBackend, ConfigurationRuntimeState } from "../../shared/protocol/configuration-admin.js";

/** Operator lifecycle controls depend on who owns the provider process. */
export function backendLifecycleActions(
  definition: ConfigurationBackend | undefined,
  remote: boolean,
): ConfigurationRuntimeState["supportedActions"] {
  if (!definition) return [];
  switch (definition.kind) {
    case "opencode":
      return definition.moduleConfiguration.connection.ownership === "external"
        ? definition.enabled ? ["connect", "disconnect"] : ["disconnect"]
        : definition.enabled ? ["connect", "start", "stop", "restart"] : ["stop"];
    case "pi":
    case "codex_app_server":
    case "claude_agent_sdk":
    case "grok_build":
      return definition.enabled
        ? ["connect", ...(remote ? ["disconnect" as const] : []), "start", "stop", "restart"]
        : [...(remote ? ["disconnect" as const] : []), "stop"];
  }
}
