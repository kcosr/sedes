import type { ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";

export interface ConfigurationIdentity {
  readonly kind: "environment" | "backend" | "target";
  readonly id: string;
  readonly fingerprint: string;
}

/** Removed identities remain reserved so old threads can never be retargeted. */
export function configurationIdentities(document: ConfigurationDocument): ConfigurationIdentity[] {
  return [
    ...document.executionEnvironments.map(environment => ({
      kind: "environment" as const, id: environment.id,
      fingerprint: configurationFingerprint(environment.kind === "ssh" ? { kind: environment.kind, hostAlias: environment.hostAlias } : environment.kind === "outbound" ? { kind: environment.kind, pairingId: environment.pairingId, platform: environment.platform } : { kind: environment.kind }),
    })),
    ...document.backends.map(backend => {
      const target = document.targets.find(candidate => candidate.backendInstanceId === backend.id);
      const connection = backend.kind === "codex_app_server" ? backend.moduleConfiguration.connection : undefined;
      const nativeIdentity = connection ? connection.channel.type === "process_stdio" ? { type: "process_stdio", codexHome: connection.channel.codexHome ?? null }
        : connection.channel.type === "unix_websocket" ? { type: "unix_websocket", socketPath: connection.channel.socketPath }
        : { type: "tcp_websocket", url: connection.channel.url }
        : backend.kind === "claude_agent_sdk" ? { configDirectory: backend.moduleConfiguration.configDirectory ?? null }
        : { kind: backend.kind };
      return { kind: "backend" as const, id: backend.id,
        fingerprint: configurationFingerprint({ kind: backend.kind, environmentId: target?.executionEnvironmentId ?? null, nativeIdentity }) };
    }),
    ...document.targets.map(target => ({ kind: "target" as const, id: target.id,
      fingerprint: configurationFingerprint({ kind: target.kind, backendInstanceId: target.backendInstanceId, executionEnvironmentId: target.executionEnvironmentId }) })),
  ];
}

export function runtimeConfigurationFingerprint(document: ConfigurationDocument, kind: "environment" | "backend", id: string): string {
  if (kind === "environment") return configurationFingerprint(document.executionEnvironments.find(environment => environment.id === id) ?? null);
  const targets = document.targets.filter(target => target.backendInstanceId === id);
  return configurationFingerprint({
    backend: document.backends.find(backend => backend.id === id) ?? null,
    targets,
    environments: document.executionEnvironments.filter(environment => targets.some(target => target.executionEnvironmentId === environment.id)),
  });
}
