import { randomUUID } from "node:crypto";
import {
  isNormalizedRemotePath,
  isWithinRemoteRoot,
  remotePath,
  type RemotePlatform,
} from "./remote-path.js";
import type { EnvironmentSummary } from "../../shared/protocol/domain.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  ExecutionWorkspaceAdmissionDeniedError,
  type ExecutionCommandRequest,
  type ExecutionCommandResult,
  type ExecutionDirectoryBrowseRequest,
  type ExecutionEnvironmentLease,
  type ExecutionEnvironmentLeaseRequest,
  type ExecutionEnvironmentProvider,
  type ExecutionScope,
  type ValidatedWorkspace,
} from "./contracts.js";
import { SshEnvironmentError } from "./ssh-open-ssh.js";

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

export class RemoteExecutionEnvironment implements ExecutionEnvironmentProvider {
  #environment: EnvironmentSummary;
  readonly #kind: "ssh" | "outbound";
  readonly #platform: RemotePlatform;
  readonly #isExecutionAvailable: () => boolean;
  readonly #scope: RequestScope;
  readonly #roots: readonly string[];
  readonly #configurationRevision: number;
  readonly #activeConfigurationRevision: () => number | Promise<number>;
  readonly #reportAvailability: (
    available: boolean,
    diagnosticCode?: string,
  ) => void | Promise<void>;
  readonly #directoryBrowser: () =>
    | Pick<
        ExecutionEnvironmentProvider,
        "directoryBrowsingAvailability" | "browseDirectories"
      >
    | undefined;
  readonly #workspaceIds = new Map<string, string>();
  readonly #leases = new Set<object>();
  #closed = false;

  constructor(
    options: {
      readonly platform: RemotePlatform;
      readonly environmentId: string;
      readonly scope: RequestScope;
      readonly allowedRoots: readonly string[];
      readonly label?: string;
      readonly availability?: "available" | "unavailable";
      readonly diagnosticCode?: string | null;
      readonly revision?: number;
      readonly configurationRevision: number;
      readonly activeConfigurationRevision: () => number | Promise<number>;
      readonly reportAvailability?: (
        available: boolean,
        diagnosticCode?: string,
      ) => void | Promise<void>;
      readonly directoryBrowser: () =>
        | Pick<
            ExecutionEnvironmentProvider,
            "directoryBrowsingAvailability" | "browseDirectories"
          >
        | undefined;
    } & (
      | { readonly kind: "ssh" }
      | {
          readonly kind: "outbound";
          readonly isExecutionAvailable: () => boolean;
        }
    ),
  ) {
    if (
      !options.environmentId ||
      !options.scope.tenantId ||
      !options.scope.principalId ||
      options.allowedRoots.length === 0 ||
      options.allowedRoots.some(
        (root) => !isNormalizedRemotePath(root, options.platform),
      ) ||
      !Number.isSafeInteger(options.configurationRevision) ||
      options.configurationRevision < 0
    ) {
      throw new Error(
        `${options.kind}_execution_environment_configuration_invalid`,
      );
    }
    this.#kind = options.kind;
    this.#platform = options.platform;
    this.#isExecutionAvailable =
      options.kind === "outbound" ? options.isExecutionAvailable : () => true;
    this.#scope = Object.freeze({ ...options.scope });
    this.#roots = Object.freeze([...new Set(options.allowedRoots)]);
    this.#configurationRevision = options.configurationRevision;
    this.#activeConfigurationRevision = options.activeConfigurationRevision;
    this.#reportAvailability = options.reportAvailability ?? (() => undefined);
    this.#directoryBrowser = options.directoryBrowser;
    this.#environment = Object.freeze({
      id: options.environmentId,
      label: options.label ?? options.environmentId,
      availability: options.availability ?? "unavailable",
      diagnosticCode:
        options.diagnosticCode === undefined
          ? `${options.kind}_environment_not_validated`
          : options.diagnosticCode,
      revision: options.revision ?? 0,
    });
  }

  get environment(): EnvironmentSummary {
    return this.#environment;
  }

  async listEnvironments(scope: ExecutionScope) {
    return !this.#closed && sameScope(scope, this.#scope)
      ? [this.environment]
      : [];
  }

  directoryBrowsingAvailability(
    scope: ExecutionScope,
    environmentId: string,
  ): "available" | "unavailable" {
    const directoryBrowser = this.#directoryBrowser();
    if (
      this.#closed ||
      !this.#isExecutionAvailable() ||
      !sameScope(scope, this.#scope) ||
      environmentId !== this.environment.id ||
      !directoryBrowser
    )
      return "unavailable";
    return directoryBrowser.directoryBrowsingAvailability(scope, environmentId);
  }

  async browseDirectories(
    scope: ExecutionScope,
    request: ExecutionDirectoryBrowseRequest,
  ) {
    await this.#assertActive(scope, request.environmentId);
    const directoryBrowser = this.#directoryBrowser();
    if (!directoryBrowser) throw new Error("directory_browse_unavailable");
    return await directoryBrowser.browseDirectories(scope, request);
  }

  async validateWorkspace(
    scope: ExecutionScope,
    environmentId: string,
    candidatePath: string,
  ): Promise<ValidatedWorkspace> {
    await this.#assertActive(scope, environmentId);
    if (
      !isNormalizedRemotePath(candidatePath, this.#platform) ||
      !this.#roots.some((root) => isWithinRemoteRoot(candidatePath, root))
    ) {
      throw new ExecutionWorkspaceAdmissionDeniedError();
    }
    // The configured execution-host path and allowed roots are operator authority for
    // this execution-environment revision. Existence and connectivity are
    // established by the foreground carrier/backend protocol, not a second
    // transport command whose filesystem observation cannot be held as a lease.
    const canonicalPath = candidatePath;
    const id = this.#workspaceIds.get(canonicalPath) ?? randomUUID();
    this.#workspaceIds.set(canonicalPath, id);
    return {
      canonicalPath,
      authorityRevision: this.#configurationRevision,
      summary: {
        id,
        environmentId: this.environment.id,
        displayName:
          remotePath(this.#platform).basename(canonicalPath) || canonicalPath,
        displayPath: canonicalPath,
        availability: "available",
        trustState: "untrusted",
        revision: 0,
      },
    };
  }

  async revalidateWorkspace(
    scope: ExecutionScope,
    workspace: ValidatedWorkspace,
  ): Promise<ValidatedWorkspace> {
    const reopened = await this.validateWorkspace(
      scope,
      workspace.summary.environmentId,
      workspace.canonicalPath,
    );
    this.#workspaceIds.set(reopened.canonicalPath, workspace.summary.id);
    return {
      ...reopened,
      summary: {
        ...reopened.summary,
        id: workspace.summary.id,
        revision: workspace.summary.revision,
      },
    };
  }

  async acquireLease(
    scope: ExecutionScope,
    request: ExecutionEnvironmentLeaseRequest,
  ): Promise<ExecutionEnvironmentLease> {
    await this.#assertActive(scope, request.environmentId);
    if (request.workspace.authorityRevision !== this.#configurationRevision) {
      throw new Error("workspace_authority_stale");
    }
    const workspace = await this.revalidateWorkspace(scope, request.workspace);
    if (workspace.canonicalPath !== request.workspace.canonicalPath) {
      throw new Error("workspace_identity_changed");
    }
    const token = {};
    this.#leases.add(token);
    let released = false;
    return {
      scope,
      environment: this.environment,
      workspace,
      release: async () => {
        if (released) return;
        released = true;
        this.#leases.delete(token);
      },
    };
  }

  async executeCommand(
    scope: ExecutionScope,
    request: ExecutionCommandRequest,
  ): Promise<ExecutionCommandResult> {
    this.#assertAvailable(scope, request.environmentId);
    return {
      kind: "unavailable",
      stdoutPreview: new Uint8Array(),
      stderrPreview: new Uint8Array(),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMilliseconds: 0,
      diagnosticCode: `${this.#kind}_command_execution_unsupported`,
    };
  }

  async observeAvailability(
    available: boolean,
    diagnosticCode?: string,
  ): Promise<void> {
    await this.#setAvailability(available, diagnosticCode);
  }

  close(): void {
    if (this.#leases.size > 0)
      throw new Error(`${this.#kind}_execution_leases_active`);
    this.#closed = true;
  }

  async #setAvailability(
    available: boolean,
    diagnosticCode?: string,
  ): Promise<void> {
    available = available && this.#isExecutionAvailable();
    const availability = available ? "available" : "unavailable";
    const nextDiagnosticCode = available
      ? null
      : (diagnosticCode ?? `${this.#kind}_environment_unavailable`);
    if (
      this.#environment.availability !== availability ||
      this.#environment.diagnosticCode !== nextDiagnosticCode
    ) {
      this.#environment = Object.freeze({
        ...this.#environment,
        availability,
        diagnosticCode: nextDiagnosticCode,
        revision: this.#environment.revision + 1,
      });
    }
    await this.#reportAvailability(available, diagnosticCode);
  }

  #assertAvailable(scope: ExecutionScope, environmentId: string): void {
    if (
      this.#closed ||
      !this.#isExecutionAvailable() ||
      !sameScope(scope, this.#scope) ||
      environmentId !== this.environment.id
    ) {
      throw new SshEnvironmentError(
        "unavailable",
        `${this.#kind}_environment_unavailable`,
      );
    }
  }

  async #assertActive(
    scope: ExecutionScope,
    environmentId: string,
  ): Promise<void> {
    this.#assertAvailable(scope, environmentId);
    let activeRevision: number;
    try {
      activeRevision = await this.#activeConfigurationRevision();
    } catch {
      throw new SshEnvironmentError(
        "unavailable",
        `${this.#kind}_environment_configuration_unavailable`,
      );
    }
    this.#assertAvailable(scope, environmentId);
    if (activeRevision !== this.#configurationRevision) {
      throw new SshEnvironmentError(
        "unavailable",
        `${this.#kind}_environment_configuration_stale`,
      );
    }
  }
}
