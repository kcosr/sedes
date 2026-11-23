import type { ConfigurationBackend } from "../../shared/protocol/configuration-admin.js";
import { mergeEnvironmentVariableOverrides, type EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";

type ModuleConfiguration<K extends ConfigurationBackend["kind"]> =
  Extract<ConfigurationBackend, { kind: K }> extends { moduleConfiguration: infer C } ? C : never;

/** Both sides hash the same launch contract before the host resolves any secrets.
 * The policy carries only the digest. Per-thread defaults, labels and the target
 * roster never change the identity of an already admitted native process. */
export const runtimeLaunchDigest = {
  codex_app_server(config: Pick<ModuleConfiguration<"codex_app_server">, "connection">, startup: EnvironmentVariableOverrides = {}) {
    return configurationFingerprint(["codex_app_server", config.connection, startup]);
  },
  claude_agent_sdk(config: Pick<ModuleConfiguration<"claude_agent_sdk">, "initializationTimeoutMs" | "executablePath" | "configDirectory">, startup: EnvironmentVariableOverrides = {}) {
    return configurationFingerprint(["claude_agent_sdk", config.executablePath ?? "claude", config.configDirectory ?? null, config.initializationTimeoutMs, startup]);
  },
  pi_native(config: ModuleConfiguration<"pi_native">, startup: EnvironmentVariableOverrides = {}) {
    return configurationFingerprint(["pi_native", config.executablePath ?? null, config.agentDirectory ?? null, config.sessionDirectory ?? null,
      config.projectTrusted, config.initializationTimeoutMs, startup]);
  },
  antigravity(config: ModuleConfiguration<"antigravity">, startup: EnvironmentVariableOverrides = {}) {
    return configurationFingerprint(["antigravity", config.executablePath ?? null, config.geminiDirectory ?? null, config.initializationTimeoutMs, startup]);
  },
  opencode(config: ModuleConfiguration<"opencode">, startup: EnvironmentVariableOverrides = {}) {
    return configurationFingerprint(["opencode", config.nativeStorePath ?? null, config.configDirectory ?? null, config.connection, startup]);
  },
};

export function providerStartupEnvironmentVariables(backend: ConfigurationBackend, environmentStartup: EnvironmentVariableOverrides = {}): EnvironmentVariableOverrides {
  if (backend.kind === "pi" || ((backend.kind === "codex_app_server" || backend.kind === "opencode") &&
      backend.moduleConfiguration.connection.ownership === "external")) return {};
  return mergeEnvironmentVariableOverrides(environmentStartup, backend.environmentVariables?.startup ?? {});
}

export function providerLaunchDigest(backend: ConfigurationBackend, environmentStartup: EnvironmentVariableOverrides = {}): string {
  const startup = providerStartupEnvironmentVariables(backend, environmentStartup);
  switch (backend.kind) {
    case "codex_app_server": return runtimeLaunchDigest.codex_app_server(backend.moduleConfiguration, startup);
    case "opencode": return runtimeLaunchDigest.opencode(backend.moduleConfiguration, startup);
    case "claude_agent_sdk": return runtimeLaunchDigest.claude_agent_sdk(backend.moduleConfiguration, startup);
    case "pi_native": return runtimeLaunchDigest.pi_native(backend.moduleConfiguration, startup);
    case "antigravity": return runtimeLaunchDigest.antigravity(backend.moduleConfiguration, startup);
    case "pi": return configurationFingerprint(["pi"]);
    case "grok_build": return configurationFingerprint(["grok_build", backend.moduleConfiguration, startup]);
  }
}
