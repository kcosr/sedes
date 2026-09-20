import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  ManagedTerminalResourceAuthority,
  ManagedTerminalServerEvent,
  ManagedTerminalViewerSession,
} from "../../terminal/managed-terminal-carrier.js";
import { ManagedTerminalCarrierError } from "../../terminal/managed-terminal-carrier.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import {
  CodexManagedTuiRegistry,
  type CodexManagedTuiBindingAuthority,
  type CodexManagedTuiLauncher,
  type CodexManagedTuiRegistryAuthority,
} from "./codex-managed-tui-registry.js";
import type { CodexTuiActionId, CodexTuiStateV1 } from "./codex-tui-feature.js";
import { codexThreadSettingsUpdateMethod } from "./codex-c2-protocol.js";
import {
  codexExecutionPolicy,
  type CodexExecutionPolicySelection,
} from "./codex-execution-policy.js";
import {
  encodeCodexServiceTier,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

export type CodexManagedTuiHandleAuthority = Omit<
  CodexManagedTuiBindingAuthority,
  "appServerGeneration"
>;

export class CodexManagedTuiController implements ManagedTerminalResourceAuthority {
  readonly registry: CodexManagedTuiRegistryAuthority;
  readonly #client: CodexSharedClientFacade;
  readonly #isRuntimeSupported: () => boolean;
  readonly #supportsThreadEnvironment: (scope: RequestScope, applicationThreadId: string) => boolean;
  readonly #isResumable: (
    scope: RequestScope,
    applicationThreadId: string,
  ) => boolean;
  readonly #isPolicyRepresentable: (
    scope: RequestScope,
    applicationThreadId: string,
  ) => boolean;
  readonly #isModelSelectionAllowed: (
    model: string,
    reasoningEffort: string,
  ) => boolean;
  #launcher: CodexManagedTuiLauncher | undefined;
  #unavailableReason = "Managed terminal execution is unavailable.";
  #closed = false;
  #nextProjectionRevision = 1;
  readonly #projectionRevisions = new Map<
    string,
    { readonly fingerprint: string; readonly revision: number }
  >();

  constructor(input: {
    readonly client: CodexSharedClientFacade;
    readonly isRuntimeSupported?: () => boolean;
    readonly supportsThreadEnvironment?: (scope: RequestScope, applicationThreadId: string) => boolean;
    readonly registry?: CodexManagedTuiRegistryAuthority;
    readonly isResumable?: (
      scope: RequestScope,
      applicationThreadId: string,
    ) => boolean;
    readonly isPolicyRepresentable?: (
      scope: RequestScope,
      applicationThreadId: string,
    ) => boolean;
    readonly isModelSelectionAllowed?: (
      model: string,
      reasoningEffort: string,
    ) => boolean;
  }) {
    this.#client = input.client;
    this.#supportsThreadEnvironment = input.supportsThreadEnvironment ?? (() => true);
    this.#isRuntimeSupported = input.isRuntimeSupported ?? (() => true);
    this.registry = input.registry ?? new CodexManagedTuiRegistry();
    this.#isResumable = input.isResumable ?? (() => true);
    this.#isPolicyRepresentable = input.isPolicyRepresentable ?? (() => true);
    this.#isModelSelectionAllowed =
      input.isModelSelectionAllowed ?? (() => true);
  }

  configure(launcher: CodexManagedTuiLauncher): void {
    if (this.#closed || this.#launcher) {
      throw new Error("codex_tui_controller_configuration_invalid");
    }
    this.#launcher = launcher;
  }

  unavailable(reason: string): void {
    if (!reason || reason.length > 400) {
      throw new Error("codex_tui_unavailable_reason_invalid");
    }
    this.#unavailableReason = reason;
  }

  presentation(
    scope: RequestScope,
    applicationThreadId: string,
  ): {
    readonly revision: number;
    readonly availability: "available" | "unavailable";
    readonly unavailableReason?: string;
    readonly state: CodexTuiStateV1;
  } {
    const projection = this.registry.projection(scope, applicationThreadId);
    const lifecycle = this.#client.lifecycleSnapshot();
    const resumable = this.#isResumable(scope, applicationThreadId);
    const policyRepresentable = this.#isPolicyRepresentable(
      scope,
      applicationThreadId,
    );
    const runtimeSupported = this.#isRuntimeSupported();
    const runtimeEligible =
      !this.#closed &&
      runtimeSupported &&
      this.#launcher !== undefined &&
      lifecycle.state === "ready" &&
      lifecycle.generation > 0;
    const environmentSupported = this.#supportsThreadEnvironment(scope, applicationThreadId);
    const available = runtimeEligible && resumable && policyRepresentable && environmentSupported;
    const unavailableReason = available
      ? undefined
      : !environmentSupported
        ? "Managed TUI is unavailable for threads with execution environment variables."
      : !runtimeSupported
        ? "The execution runtime does not provide managed terminal support."
        : !runtimeEligible
        ? this.#launcher === undefined || this.#closed
          ? this.#unavailableReason
          : "The Codex connection is not ready."
        : !resumable
          ? "Send the first message before starting the managed TUI."
          : "The current execution policy cannot be represented by the managed TUI.";
    const key = JSON.stringify([
      scope.tenantId,
      scope.principalId,
      applicationThreadId,
    ]);
    const fingerprint = JSON.stringify([
      projection.revision,
      available,
      unavailableReason,
      projection.state,
    ]);
    const prior = this.#projectionRevisions.get(key);
    const revision =
      prior?.fingerprint === fingerprint
        ? prior.revision
        : this.#nextProjectionRevision++;
    if (prior?.fingerprint !== fingerprint) {
      this.#projectionRevisions.set(key, { fingerprint, revision });
    }
    return {
      state: projection.state,
      revision,
      availability: available ? "available" : "unavailable",
      ...(available ? {} : { unavailableReason }),
    };
  }

  async perform(
    authority: CodexManagedTuiHandleAuthority,
    actionId: CodexTuiActionId,
  ): Promise<{
    readonly outcome: "accepted" | "rejected";
    readonly projectedState?: CodexTuiStateV1;
    readonly resourceGeneration?: number;
    readonly safeMessage?: string;
  }> {
    if (actionId === "start" && !this.#supportsThreadEnvironment(authority.scope, authority.applicationThreadId)) return { outcome: "rejected", safeMessage: "Managed TUI is unavailable for threads with execution environment variables." };
    const lifecycle = this.#client.lifecycleSnapshot();
    const launcher = this.#launcher;
    const resumable = this.#isResumable(
      authority.scope,
      authority.applicationThreadId,
    );
    const policyRepresentable = this.#isPolicyRepresentable(
      authority.scope,
      authority.applicationThreadId,
    );
    if (
      this.#closed ||
      !this.#isRuntimeSupported() ||
      !launcher ||
      lifecycle.state !== "ready" ||
      lifecycle.generation <= 0 ||
      !resumable ||
      (actionId === "start" && !policyRepresentable)
    ) {
      return {
        outcome: "rejected",
        safeMessage:
          actionId === "start" && !policyRepresentable
            ? "The current execution policy cannot be represented by the managed TUI."
            : !resumable && launcher && lifecycle.state === "ready"
              ? "Send the first message before starting the managed TUI."
              : this.#unavailableReason,
      };
    }
    const completeAuthority = {
      ...authority,
      appServerGeneration: lifecycle.generation,
    } satisfies CodexManagedTuiBindingAuthority;
    const priorGeneration =
      this.registry.state(completeAuthority).resourceGeneration;
    const state =
      actionId === "start"
        ? await this.registry.start(completeAuthority, launcher)
        : await this.registry.stop(completeAuthority);
    return {
      outcome: "accepted",
      projectedState: state,
      ...((state.resourceGeneration ?? priorGeneration) === null
        ? {}
        : { resourceGeneration: state.resourceGeneration ?? priorGeneration! }),
    };
  }

  async authorizeAdmission(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
  }): Promise<{ readonly resourceGeneration: number }> {
    const resourceGeneration = this.registry.runningGeneration(
      input.scope,
      input.applicationThreadId,
    );
    if (!this.#supportsThreadEnvironment(input.scope, input.applicationThreadId) || !this.#isRuntimeSupported() || resourceGeneration === undefined) {
      throw new ManagedTerminalCarrierError(
        "terminal_unavailable",
        "The managed Codex TUI is not running.",
        true,
      );
    }
    return { resourceGeneration };
  }

  async attachViewer(
    input: {
      readonly scope: RequestScope;
      readonly applicationThreadId: string;
      readonly resourceGeneration: number;
      readonly viewerId: string;
    },
    emit: (event: ManagedTerminalServerEvent) => void,
  ): Promise<ManagedTerminalViewerSession> {
    if (!this.#supportsThreadEnvironment(input.scope, input.applicationThreadId)) throw new ManagedTerminalCarrierError("terminal_unavailable", "Managed TUI is unavailable for threads with execution environment variables.", false);
    if (!this.#isRuntimeSupported()) throw new ManagedTerminalCarrierError("terminal_unavailable", "The execution runtime does not provide managed terminal support.", true);
    const marker = new TextEncoder().encode("\u001b[?2026l");
    let scanTail = new Uint8Array();
    let syncing:
      | {
          markerSeen: boolean;
          geometry?: { readonly columns: number; readonly rows: number };
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined;
    let closed = false;

    const finishIfReady = () => {
      if (!syncing?.markerSeen || !syncing.geometry) return;
      clearTimeout(syncing.timer);
      const geometry = syncing.geometry;
      syncing = undefined;
      scanTail = new Uint8Array();
      emit({ type: "ready", ...geometry });
    };
    const scan = (bytes: Uint8Array) => {
      if (!syncing) return;
      const combined = new Uint8Array(scanTail.byteLength + bytes.byteLength);
      combined.set(scanTail);
      combined.set(bytes, scanTail.byteLength);
      if (containsBytes(combined, marker)) syncing.markerSeen = true;
      scanTail = combined.slice(
        Math.max(0, combined.byteLength - (marker.byteLength - 1)),
      );
      finishIfReady();
    };
    let handle;
    try {
      handle = this.registry.attachScopedViewer(
        input.scope,
        input.applicationThreadId,
        input.resourceGeneration,
        {
          viewerId: input.viewerId,
          transportLost: () => emit({ type: "error", code: "terminal_unavailable",
            message: "The managed terminal connection was lost. The remote TUI may still be running.", retryable: true }),
          output: (bytes) => {
            emit({ type: "output", bytes });
            scan(bytes);
          },
          stateChanged: (state) => {
            if (state.lifecycle === "exited") {
              emit({
                type: "exit",
                exitCode:
                  state.exitStatus?.kind === "code"
                    ? state.exitStatus.code
                    : null,
                signal:
                  state.exitStatus?.kind === "signal"
                    ? state.exitStatus.signal
                    : null,
              });
            } else if (state.lifecycle === "failed") {
              emit({
                type: "error",
                code: "terminal_unavailable",
                message:
                  state.diagnostic?.text ?? "The managed Codex TUI failed.",
                retryable: true,
              });
            }
          },
        },
      );
    } catch {
      throw new ManagedTerminalCarrierError(
        "generation_changed",
        "The managed Codex TUI generation changed.",
        true,
      );
    }
    const synchronize = async (
      request: () => Promise<{
        readonly columns: number;
        readonly rows: number;
      }>,
    ) => {
      if (closed) throw new Error("codex_tui_viewer_detached");
      if (syncing) throw new Error("codex_tui_sync_in_progress");
      emit({ type: "sync_started" });
      const currentSync: {
        markerSeen: boolean;
        geometry?: { readonly columns: number; readonly rows: number };
        timer: ReturnType<typeof setTimeout>;
      } = {
        markerSeen: false,
        timer: setTimeout(() => {
          if (!syncing) return;
          syncing = undefined;
          scanTail = new Uint8Array();
          emit({
            type: "error",
            code: "resync_failed",
            message: "The terminal repaint did not complete in time.",
            retryable: true,
          });
        }, 3_000),
      };
      syncing = currentSync;
      currentSync.timer.unref?.();
      try {
        currentSync.geometry = await request();
        if (syncing !== currentSync) return;
        finishIfReady();
      } catch (error) {
        clearTimeout(currentSync.timer);
        if (syncing === currentSync) syncing = undefined;
        throw error;
      }
    };
    return {
      sendInput: async (bytes) => await handle.input(bytes),
      resize: async ({ columns, rows }) => await handle.resize(columns, rows),
      requestSync: async () => await synchronize(() => handle.requestSync()),
      requestRefit: async ({ columns, rows }) =>
        await synchronize(() => handle.requestRefit(columns, rows)),
      close: () => {
        if (closed) return;
        closed = true;
        if (syncing) clearTimeout(syncing.timer);
        syncing = undefined;
        handle.detach();
      },
    };
  }

  async consumeLifecycle(): Promise<void> {
    const lifecycle = this.#client.lifecycleSnapshot();
    await this.registry.fenceAppServerGeneration(
      lifecycle.state === "ready" ? lifecycle.generation : 0,
    );
  }

  async syncSettings(
    scope: RequestScope,
    applicationThreadId: string,
    settings: CodexExecutionPolicySelection & {
      readonly model: string;
      readonly reasoningEffort: string;
      readonly serviceTier: CodexServiceTierSelection;
    },
  ): Promise<void> {
    const authority = this.registry.runningAuthority(
      scope,
      applicationThreadId,
    );
    if (!authority) return;
    if (
      !this.#isModelSelectionAllowed(
        settings.model,
        settings.reasoningEffort,
      )
    ) {
      await this.registry.fail(
        authority,
        "This model or reasoning effort is not allowed by the backend policy.",
      );
      return;
    }
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== authority.appServerGeneration
    ) {
      await this.registry.fail(
        authority,
        "The Codex connection changed before TUI settings could be synchronized.",
      );
      return;
    }
    const policy = codexExecutionPolicy(settings).turn;
    try {
      await this.#client.request(
        codexThreadSettingsUpdateMethod,
        {
          threadId: authority.backendConversationId,
          cwd: authority.canonicalWorkspacePath,
          approvalPolicy: policy.approvalPolicy,
          approvalsReviewer: policy.approvalsReviewer,
          sandboxPolicy: policy.sandboxPolicy,
          model: settings.model,
          serviceTier: encodeCodexServiceTier(settings.serviceTier),
          effort: settings.reasoningEffort,
        },
        { timeoutMilliseconds: 10_000 },
      );
    } catch (error) {
      await this.registry.fail(
        authority,
        "Sedes kept the new settings, but the running TUI could not apply them. Start a new TUI.",
      );
    }
  }

  async releaseRuntime(
    authority: CodexManagedTuiHandleAuthority,
    appServerGeneration: number,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(appServerGeneration) ||
      appServerGeneration <= 0
    ) {
      return;
    }
    await this.registry.releaseRuntime({
      ...authority,
      appServerGeneration,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.registry.close();
    this.#projectionRevisions.clear();
  }
}

function containsBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (
    let index = 0;
    index <= haystack.byteLength - needle.byteLength;
    index += 1
  ) {
    for (let offset = 0; offset < needle.byteLength; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
}
