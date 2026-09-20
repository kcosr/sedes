import type Database from "better-sqlite3";
import type { ConfigurationDocument } from "../../src/shared/protocol/configuration-admin.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { configurationFingerprint } from "../../src/server/config/configuration-fingerprint.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { ConfigurationProjection } from "../../src/server/configuration-admin/configuration-projection.js";
import { validateConfigurationDocument } from "../../src/server/configuration-admin/configuration-validation.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { convertLegacyConfiguration, type LegacyConfigurationImport } from "../../src/server/config/legacy-configuration-import.js";

/** Explicit fixture setup after current schema migration; never startup sync. */
export function initializeDatabaseConfigurationFixture(database: Database.Database,
  value: ConfigurationDocument, options: { sourceLabel: string; now?: number }) {
  const document = validateConfigurationDocument(value);
  const scope = new SingleUserIdentityProvider(database).getScope();
  const now = () => options.now ?? Date.now();
  const repository = new ConfigurationRepository(database, now);
  const catalog = compiledBackendModuleCatalog;
  const projection = new ConfigurationProjection(database, {
    pi: catalog.protocolReleaseForBackendKind("pi"),
    codex_app_server: catalog.protocolReleaseForBackendKind("codex_app_server"),
    claude_agent_sdk: catalog.protocolReleaseForBackendKind("claude_agent_sdk"),
    grok_build: catalog.protocolReleaseForBackendKind("grok_build"),
  }, now);
  const snapshot = repository.initialize(scope, document, {
    sourceFingerprint: configurationFingerprint(document), sourceLabel: options.sourceLabel,
  }, () => {
    projection.adoptLegacyOwnership(scope);
    projection.project(scope, document);
    for (const backend of document.backends) {
      if (backend.kind !== "codex_app_server" || backend.moduleConfiguration.connection.ownership !== "external") continue;
      const channel = backend.moduleConfiguration.connection.channel;
      if (channel.type !== "tcp_websocket") continue;
      const target = document.targets.find(candidate => candidate.backendInstanceId === backend.id)!;
      repository.approveSecret(scope, target.executionEnvironmentId, channel.authentication.secret);
    }
  });
  return { scope, repository, projection, snapshot };
}

/** Migration-focused fixtures explicitly convert their historical input once. */
export function importLegacyDatabaseConfigurationFixture(database: Database.Database,
  input: LegacyConfigurationImport, now?: number) {
  const { document } = convertLegacyConfiguration(input);
  return initializeDatabaseConfigurationFixture(database, document, { sourceLabel: input.sourceLabel, ...(now === undefined ? {} : { now }) });
}
