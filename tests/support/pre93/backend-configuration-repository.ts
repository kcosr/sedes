/**
 * Frozen producer for explicit pre-93 migration fixtures (baseline 64f95038).
 * Never use this for current-schema fixtures or production startup. Current
 * fixtures import through database-configuration-fixture.ts.
 */
import type Database from "better-sqlite3";
import type {
  BackendKind,
  ConnectionKind,
} from "../../../src/server/backends/contracts.js";
import type {
  BackendConfigurationFile,
  ResolvedBackendConfigurationFile,
} from "../../../src/server/config/backend-configuration.js";
import {
  defaultBackendConfiguration,
  localWorkspaceIsolationPolicy,
} from "../../../src/server/config/backend-configuration.js";
import { configurationFingerprint } from "../../../src/server/config/configuration-fingerprint.js";
import { DomainError } from "../../../src/server/domain/errors.js";
import type { RequestScope } from "../../../src/server/identity/identity-provider.js";
import { deriveConnectionProfileId } from "../../../src/server/db/connection-profile-id.js";

export type BackendInstanceRecord = {
  readonly tenantId: string;
  readonly id: string;
  readonly kind: BackendKind;
  readonly label: string;
  readonly enabled: 0 | 1;
  readonly configurationRevision: number;
  readonly configurationFingerprint: string;
  readonly protocolRelease: string;
};

export type ConnectionProfileRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly templateId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
  readonly kind: ConnectionKind;
  readonly label: string;
  readonly enabled: 0 | 1;
  readonly configurationRevision: number;
  readonly configurationFingerprint: string;
};

export type ConversationTargetRecord = {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
};

export type ReconciledBackendConfiguration = {
  readonly targets: readonly ConversationTargetRecord[];
  readonly defaultTarget: ConversationTargetRecord;
};

const backendColumns = `
  tenant_id AS tenantId,
  id,
  kind,
  label,
  enabled,
  configuration_revision AS configurationRevision,
  configuration_fingerprint AS configurationFingerprint,
  protocol_release AS protocolRelease
`;

const profileColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  id,
  template_id AS templateId,
  backend_instance_id AS backendInstanceId,
  execution_environment_id AS executionEnvironmentId,
  kind,
  label,
  enabled,
  configuration_revision AS configurationRevision,
  configuration_fingerprint AS configurationFingerprint
`;

type ConfiguredExecutionEnvironment =
  BackendConfigurationFile["executionEnvironments"][number];

function environmentAuthorityFingerprint(
  environment: ConfiguredExecutionEnvironment,
  localWorkspaceRoots: readonly string[],
): string {
  return configurationFingerprint(
    environment.kind === "local"
      ? { kind: environment.kind, workspaceRoots: localWorkspaceRoots }
      : {
          kind: environment.kind,
          hostAlias: environment.hostAlias,
          workspaceRoots: environment.workspaceRoots,
        },
  );
}

function environmentOperationsFingerprint(
  environment: ConfiguredExecutionEnvironment,
): string {
  return configurationFingerprint(
    environment.kind === "ssh"
      ? environment.operations
      : {
          kind: "local",
          workspaceIsolation: localWorkspaceIsolationPolicy(environment),
        },
  );
}

export class Pre93BackendConfigurationRepository {
  constructor(readonly database: Database.Database) {}

  reconcile(
    scope: RequestScope,
    configuration: ResolvedBackendConfigurationFile,
    input: {
      readonly localWorkspaceRoots: readonly string[];
      readonly now: number;
    },
  ): ReconciledBackendConfiguration {
    const { localWorkspaceRoots, now } = input;
    return this.database.transaction(() => {
      this.#assertReferencedConfigurationRetained(scope, configuration);
      for (const configured of configuration.executionEnvironments) {
        this.#reconcileEnvironment(
          scope,
          configured,
          localWorkspaceRoots,
          now,
        );
      }
      for (const configured of configuration.backends) {
        const backendFingerprint = configurationFingerprint({
          moduleConfiguration: configured.moduleConfiguration ?? null,
          modelPolicy: configured.modelPolicy,
        });
        const current = this.#findBackend(scope, configured.id);
        if (!current) {
          this.database
            .prepare(
              `
                INSERT INTO agent_backend_instances(
                  tenant_id, id, kind, label, enabled,
                  configuration_revision, configuration_fingerprint,
                  protocol_release, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
              `,
            )
            .run(
              scope.tenantId,
              configured.id,
              configured.kind,
              configured.label,
              configured.enabled ? 1 : 0,
              backendFingerprint,
              configured.protocolRelease,
              now,
              now,
            );
        } else {
          if (current.kind !== configured.kind) {
            throw new DomainError(
              "conflict",
              `Backend "${configured.id}" changed immutable identity fields.`,
            );
          }
          if (
            current.label !== configured.label ||
            current.enabled !== (configured.enabled ? 1 : 0) ||
            current.protocolRelease !== configured.protocolRelease ||
            current.configurationFingerprint !== backendFingerprint
          ) {
            this.database
              .prepare(
                `
                  UPDATE agent_backend_instances
                  SET label = ?, enabled = ?, protocol_release = ?,
                    configuration_fingerprint = ?,
                    configuration_revision = configuration_revision + 1,
                    updated_at = ?
                  WHERE tenant_id = ? AND id = ?
                `,
              )
              .run(
                configured.label,
                configured.enabled ? 1 : 0,
                configured.protocolRelease,
                backendFingerprint,
                now,
                scope.tenantId,
                configured.id,
              );
          }
        }
      }

      for (const configured of configuration.targets) {
        const profileFingerprint = configurationFingerprint(
          configured.moduleConfiguration ?? null,
        );
        const current = this.#findProfileByTemplate(scope, configured.id);
        if (!current) {
          this.database
            .prepare(
              `
                INSERT INTO agent_connection_profiles(
                  tenant_id, owner_principal_id, id, template_id,
                  backend_instance_id, backend_kind,
                  execution_environment_id, kind, label, enabled,
                  configuration_revision, configuration_fingerprint,
                  created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
              `,
            )
            .run(
              scope.tenantId,
              scope.principalId,
              deriveConnectionProfileId(
                scope.tenantId,
                scope.principalId,
                configured.id,
              ),
              configured.id,
              configured.backendInstanceId,
              this.getBackend(scope, configured.backendInstanceId).kind,
              configured.executionEnvironmentId,
              configured.kind,
              configured.label,
              configured.enabled ? 1 : 0,
              profileFingerprint,
              now,
              now,
            );
        } else {
          if (
            current.kind !== configured.kind ||
            current.backendInstanceId !== configured.backendInstanceId ||
            current.executionEnvironmentId !== configured.executionEnvironmentId
          ) {
            throw new DomainError(
              "conflict",
              `Connection template "${configured.id}" changed immutable identity fields.`,
            );
          }
          if (
            current.label !== configured.label ||
            current.enabled !== (configured.enabled ? 1 : 0) ||
            current.configurationFingerprint !== profileFingerprint
          ) {
            this.database
              .prepare(
                `
                  UPDATE agent_connection_profiles
                  SET label = ?, enabled = ?, configuration_fingerprint = ?,
                    configuration_revision = configuration_revision + 1,
                    updated_at = ?
                  WHERE tenant_id = ? AND owner_principal_id = ?
                    AND template_id = ?
                `,
              )
              .run(
                configured.label,
                configured.enabled ? 1 : 0,
                profileFingerprint,
                now,
                scope.tenantId,
                scope.principalId,
                configured.id,
              );
          }
        }
      }

      this.#removeUnreferencedConfiguration(scope, configuration);
      const targets = configuration.targets
        .filter(({ enabled }) => enabled)
        .map((configured) => {
          const backend = this.getBackend(scope, configured.backendInstanceId);
          const profile = this.getProfileByTemplate(scope, configured.id);
          if (
            backend.enabled !== 1 ||
            profile.enabled !== 1 ||
            profile.backendInstanceId !== backend.id ||
            profile.executionEnvironmentId !== configured.executionEnvironmentId
          ) {
            throw new DomainError(
              "conflict",
              `Configured target "${configured.id}" is not available to this principal.`,
            );
          }
          return {
            backendInstanceId: backend.id,
            connectionProfileId: profile.id,
            executionEnvironmentId: configured.executionEnvironmentId,
          };
        });
      const { target: defaultConfiguration } =
        defaultBackendConfiguration(configuration);
      const defaultProfile = this.getProfileByTemplate(
        scope,
        defaultConfiguration.id,
      );
      const defaultTarget = targets.find(
        ({ connectionProfileId }) =>
          connectionProfileId === defaultProfile.id,
      );
      if (!defaultTarget) {
        throw new DomainError(
          "conflict",
          "The configured default target is not available to this principal.",
        );
      }
      return { targets, defaultTarget };
    })();
  }

  listBackends(scope: RequestScope): BackendInstanceRecord[] {
    return this.database
      .prepare(
        `
          SELECT ${backendColumns}
          FROM agent_backend_instances
          WHERE tenant_id = ?
          ORDER BY id
        `,
      )
      .all(scope.tenantId) as BackendInstanceRecord[];
  }

  listProfiles(scope: RequestScope): ConnectionProfileRecord[] {
    return this.database
      .prepare(
        `
          SELECT ${profileColumns}
          FROM agent_connection_profiles
          WHERE tenant_id = ? AND owner_principal_id = ?
          ORDER BY template_id
        `,
      )
      .all(scope.tenantId, scope.principalId) as ConnectionProfileRecord[];
  }

  getBackend(scope: RequestScope, backendId: string): BackendInstanceRecord {
    const backend = this.#findBackend(scope, backendId);
    if (!backend) {
      throw new DomainError("not_found", "The backend instance was not found.");
    }
    return backend;
  }

  getProfile(scope: RequestScope, profileId: string): ConnectionProfileRecord {
    const profile = this.database
      .prepare(
        `
          SELECT ${profileColumns}
          FROM agent_connection_profiles
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, profileId) as
      ConnectionProfileRecord | undefined;
    if (!profile) {
      throw new DomainError(
        "not_found",
        "The backend connection profile was not found.",
      );
    }
    return profile;
  }

  getProfileByTemplate(
    scope: RequestScope,
    templateId: string,
  ): ConnectionProfileRecord {
    const profile = this.#findProfileByTemplate(scope, templateId);
    if (!profile) {
      throw new DomainError(
        "not_found",
        "The connection profile was not found.",
      );
    }
    return profile;
  }

  #findBackend(
    scope: RequestScope,
    backendId: string,
  ): BackendInstanceRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${backendColumns}
          FROM agent_backend_instances
          WHERE tenant_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, backendId) as BackendInstanceRecord | undefined;
  }

  #findProfileByTemplate(
    scope: RequestScope,
    templateId: string,
  ): ConnectionProfileRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${profileColumns}
          FROM agent_connection_profiles
          WHERE tenant_id = ? AND owner_principal_id = ? AND template_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, templateId) as
      ConnectionProfileRecord | undefined;
  }

  #reconcileEnvironment(
    scope: RequestScope,
    configured: ConfiguredExecutionEnvironment,
    localWorkspaceRoots: readonly string[],
    now: number,
  ): void {
    const fingerprint = environmentAuthorityFingerprint(
      configured,
      localWorkspaceRoots,
    );
    const operationsFingerprint =
      environmentOperationsFingerprint(configured);
    const current = this.database
      .prepare(
        `
          SELECT id, kind, label, availability,
            diagnostic_code AS diagnosticCode,
            configuration_fingerprint AS configurationFingerprint,
            operations_configuration_fingerprint AS operationsConfigurationFingerprint
          FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, configured.id) as
      | {
          readonly id: string;
          readonly kind: "local" | "ssh";
          readonly label: string;
          readonly availability: "available" | "unavailable";
          readonly diagnosticCode: string | null;
          readonly configurationFingerprint: string;
          readonly operationsConfigurationFingerprint: string;
        }
      | undefined;
    if (!current) {
      // Local remains singleton per principal. Multiple SSH environments are
      // allowed; each keeps a durable id and independent authority fingerprint.
      if (configured.kind === "local") {
        const conflictingKind = this.database
          .prepare(
            `
            SELECT id
            FROM execution_environments
            WHERE tenant_id = ? AND owner_principal_id = ? AND kind = ?
          `,
          )
          .get(scope.tenantId, scope.principalId, configured.kind) as
          | { readonly id: string }
          | undefined;
        if (conflictingKind) {
          throw new DomainError(
            "conflict",
            `Execution environment kind "${configured.kind}" is already bound to immutable ID "${conflictingKind.id}".`,
          );
        }
      }
      this.database
        .prepare(
          `
            INSERT INTO execution_environments(
              tenant_id, owner_principal_id, id, kind, label,
              availability, diagnostic_code, revision,
              configuration_revision, configuration_fingerprint,
              operations_configuration_revision,
              operations_configuration_fingerprint,
              created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 'unavailable', ?, 0, 0, ?, 0, ?, ?, ?)
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          configured.id,
          configured.kind,
          configured.label,
          configured.kind === "ssh"
            ? "ssh_environment_not_validated"
            : "local_environment_not_validated",
          fingerprint,
          operationsFingerprint,
          now,
          now,
        );
      return;
    }
    if (current.kind !== configured.kind) {
      throw new DomainError(
        "conflict",
        `Execution environment "${configured.id}" changed immutable kind.`,
      );
    }
    const labelChanged = current.label !== configured.label;
    const authorityChanged = current.configurationFingerprint !== fingerprint;
    const operationsChanged =
      current.operationsConfigurationFingerprint !== operationsFingerprint;
    if (!labelChanged && !authorityChanged && !operationsChanged) return;
    const availability =
      authorityChanged && configured.kind === "ssh"
        ? "unavailable"
        : current.availability;
    const diagnosticCode =
      authorityChanged && configured.kind === "ssh"
        ? "ssh_environment_not_validated"
        : current.diagnosticCode;
    const observableChanged =
      labelChanged ||
      availability !== current.availability ||
      diagnosticCode !== current.diagnosticCode;
    this.database
      .prepare(
        `
          UPDATE execution_environments
          SET label = ?,
            availability = ?,
            diagnostic_code = ?,
            revision = revision + ?,
            configuration_revision = configuration_revision + ?,
            configuration_fingerprint = ?,
            operations_configuration_revision =
              operations_configuration_revision + ?,
            operations_configuration_fingerprint = ?,
            updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .run(
        configured.label,
        availability,
        diagnosticCode,
        observableChanged ? 1 : 0,
        authorityChanged ? 1 : 0,
        fingerprint,
        operationsChanged ? 1 : 0,
        operationsFingerprint,
        now,
        scope.tenantId,
        scope.principalId,
        configured.id,
      );
  }

  #assertReferencedConfigurationRetained(
    scope: RequestScope,
    configuration: ResolvedBackendConfigurationFile,
  ): void {
    const environmentIds = new Set(
      configuration.executionEnvironments.map(({ id }) => id),
    );
    const referencedEnvironments = this.database
      .prepare(
        `
          SELECT DISTINCT environment_id AS id
          FROM workspaces
          WHERE tenant_id = ? AND owner_principal_id = ?
        `,
      )
      .all(scope.tenantId, scope.principalId) as Array<{
      readonly id: string;
    }>;
    const missingEnvironment = referencedEnvironments.find(
      ({ id }) => !environmentIds.has(id),
    );
    if (missingEnvironment) {
      throw new DomainError(
        "conflict",
        `Referenced execution environment "${missingEnvironment.id}" is absent from configuration.`,
      );
    }

    const clientEnvironments = this.#principalToolClientsAvailable()
      ? (this.database
          .prepare(
            `SELECT environment.environment_id AS id
             FROM principal_agent_tool_client_environments AS environment
             JOIN principal_agent_tool_clients AS client
               ON client.tenant_id = environment.tenant_id
               AND client.owner_principal_id = environment.owner_principal_id
               AND client.id = environment.client_id
             WHERE environment.tenant_id = ?
               AND environment.owner_principal_id = ?
               AND client.revoked_at IS NULL
             GROUP BY environment.environment_id
             ORDER BY environment.environment_id`,
          )
          .all(scope.tenantId, scope.principalId) as { readonly id: string }[])
      : [];
    const clientEnvironment = clientEnvironments.find(
      ({ id }) => !environmentIds.has(id),
    );
    if (clientEnvironment) {
      const blockers = this.database
        .prepare(
          `SELECT client.name
           FROM principal_agent_tool_client_environments AS environment
           JOIN principal_agent_tool_clients AS client
             ON client.tenant_id = environment.tenant_id
             AND client.owner_principal_id = environment.owner_principal_id
             AND client.id = environment.client_id
           WHERE environment.tenant_id = ?
             AND environment.owner_principal_id = ?
             AND environment.environment_id = ?
             AND client.revoked_at IS NULL
           ORDER BY client.name, client.id
           LIMIT 9`,
        )
        .all(
          scope.tenantId,
          scope.principalId,
          clientEnvironment.id,
        ) as { readonly name: string }[];
      const names = blockers
        .slice(0, 8)
        .map(({ name }) => `"${name}"`)
        .join(", ");
      const suffix = blockers.length > 8 ? ", and more" : "";
      throw new DomainError(
        "conflict",
        `Execution environment "${clientEnvironment.id}" is referenced by tool clients ${names}${suffix}. Edit or revoke those clients first.`,
      );
    }

    const backendIds = new Set(configuration.backends.map(({ id }) => id));
    const referencedBackend = this.database
      .prepare(
        `
          SELECT DISTINCT backend_instance_id AS id
          FROM application_threads
          WHERE tenant_id = ?
        `,
      )
      .all(scope.tenantId) as Array<{ id: string }>;
    const missingBackend = referencedBackend.find(
      ({ id }) => !backendIds.has(id),
    );
    if (missingBackend) {
      throw new DomainError(
        "conflict",
        `Referenced backend "${missingBackend.id}" is absent from configuration.`,
      );
    }

    const templateIds = new Set(
      configuration.targets.map(({ id }) => id),
    );
    const referencedTemplate = this.database
      .prepare(
        `
          SELECT DISTINCT profile.template_id AS id
          FROM agent_connection_profiles AS profile
          JOIN application_threads AS thread
            ON thread.tenant_id = profile.tenant_id
            AND thread.owner_principal_id = profile.owner_principal_id
            AND thread.connection_profile_id = profile.id
          WHERE profile.tenant_id = ?
        `,
      )
      .all(scope.tenantId) as Array<{ id: string }>;
    const missingTemplate = referencedTemplate.find(
      ({ id }) => !templateIds.has(id),
    );
    if (missingTemplate) {
      throw new DomainError(
        "conflict",
        `Referenced connection template "${missingTemplate.id}" is absent from configuration.`,
      );
    }
  }

  #removeUnreferencedConfiguration(
    scope: RequestScope,
    configuration: ResolvedBackendConfigurationFile,
  ): void {
    const templateIds = configuration.targets.map(({ id }) => id);
    const templatePlaceholders = templateIds.map(() => "?").join(", ");
    const toolClientBlocker = this.#principalToolClientsAvailable()
      ? `AND NOT EXISTS (
           SELECT 1
           FROM principal_agent_tool_client_environments AS environment
           JOIN principal_agent_tool_clients AS client
             ON client.tenant_id = environment.tenant_id
             AND client.owner_principal_id = environment.owner_principal_id
             AND client.id = environment.client_id
           WHERE environment.tenant_id = execution_environments.tenant_id
             AND environment.owner_principal_id =
               execution_environments.owner_principal_id
             AND environment.environment_id = execution_environments.id
             AND client.revoked_at IS NULL
         )`
      : "";
    this.database
      .prepare(
        `
          DELETE FROM agent_connection_profiles
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND template_id NOT IN (${templatePlaceholders})
            AND NOT EXISTS (
              SELECT 1
              FROM application_threads AS thread
              WHERE thread.tenant_id = agent_connection_profiles.tenant_id
                AND thread.owner_principal_id =
                  agent_connection_profiles.owner_principal_id
                AND thread.connection_profile_id =
                  agent_connection_profiles.id
            )
        `,
      )
      .run(scope.tenantId, scope.principalId, ...templateIds);

    const backendIds = configuration.backends.map(({ id }) => id);
    const backendPlaceholders = backendIds.map(() => "?").join(", ");
    this.database
      .prepare(
        `
          DELETE FROM agent_backend_instances
          WHERE tenant_id = ?
            AND id NOT IN (${backendPlaceholders})
            AND NOT EXISTS (
              SELECT 1
              FROM application_threads AS thread
              WHERE thread.tenant_id = agent_backend_instances.tenant_id
                AND thread.backend_instance_id =
                  agent_backend_instances.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM agent_connection_profiles AS profile
              WHERE profile.tenant_id = agent_backend_instances.tenant_id
                AND profile.backend_instance_id =
                  agent_backend_instances.id
            )
        `,
      )
      .run(scope.tenantId, ...backendIds);

    const environmentIds = configuration.executionEnvironments.map(
      ({ id }) => id,
    );
    const environmentPlaceholders = environmentIds.map(() => "?").join(", ");
    this.database
      .prepare(
        `
          DELETE FROM execution_environments
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND id NOT IN (${environmentPlaceholders})
            AND NOT EXISTS (
              SELECT 1
              FROM workspaces
              WHERE workspaces.tenant_id = execution_environments.tenant_id
                AND workspaces.owner_principal_id =
                  execution_environments.owner_principal_id
                AND workspaces.environment_id = execution_environments.id
            )
            AND NOT EXISTS (
              SELECT 1
              FROM agent_connection_profiles AS profile
              WHERE profile.tenant_id = execution_environments.tenant_id
                AND profile.owner_principal_id =
                  execution_environments.owner_principal_id
                AND profile.execution_environment_id =
                  execution_environments.id
            )
            ${toolClientBlocker}
        `,
      )
      .run(scope.tenantId, scope.principalId, ...environmentIds);
  }

  #principalToolClientsAvailable(): boolean {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM sqlite_master
           WHERE type = 'table'
             AND name = 'principal_agent_tool_client_environments'`,
        )
        .get(),
    );
  }
}
