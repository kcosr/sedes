import type { ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "./configuration-fingerprint.js";
import { localWorkspaceIsolationPolicy, type ResolvedBackendConfigurationFile } from "./backend-configuration.js";
import { validateConfigurationDocument } from "../configuration-admin/configuration-validation.js";

export interface LegacyConfigurationImport {
  readonly configuration: ResolvedBackendConfigurationFile;
  readonly localWorkspaceRoots: readonly string[];
  readonly sourceLabel: string;
}

/** Explicit conversion only; this is never an ordinary startup file parser. */
export function convertLegacyConfiguration(input: LegacyConfigurationImport): {
  document: ConfigurationDocument;
  sourceFingerprint: string;
} {
  const configuration = input.configuration;
  const document = validateConfigurationDocument({
    executionEnvironments: configuration.executionEnvironments.map(environment => environment.kind === "local" ? {
      ...environment, workspaceRoots: [...input.localWorkspaceRoots], workspaceIsolation: localWorkspaceIsolationPolicy(environment),
    } : {
      ...environment,
      operations: environment.operations.kind === "none" ? { kind: "none" } : {
        kind: "sidecar", enabledCapabilities: environment.operations.enabledCapabilities,
      },
    }),
    backends: configuration.backends.map(({ protocolRelease: _release, moduleConfiguration, ...backend }) => ({
      ...backend,
      ...(backend.kind === "pi" ? {} : { moduleConfiguration: backend.kind === "claude_agent_sdk" ? { initializationTimeoutMs: 20_000, ...moduleConfiguration } : moduleConfiguration }),
    })),
    targets: configuration.targets,
    defaultTargetId: configuration.defaultTargetId,
    webSearch: configuration.webSearch ?? null,
  });
  return {
    document,
    sourceFingerprint: configurationFingerprint({ configuration: { ...configuration, backends: configuration.backends.map(({ protocolRelease: _release, ...backend }) => backend) }, localWorkspaceRoots: input.localWorkspaceRoots }),
  };
}
