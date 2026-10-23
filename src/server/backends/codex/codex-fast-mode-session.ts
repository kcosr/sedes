import type { CodexSpeedSession } from "./codex-speed-session.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import { codexThreadSettingsUpdateMethod } from "./codex-c2-protocol.js";
import { readCodexSpeedEnablement } from "./codex-speed-policy.js";
import {
  encodeCodexServiceTier,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const DEFAULT_RECOVERY_DELAYS_MILLISECONDS = [
  250, 1_000, 5_000, 15_000, 30_000,
];

export type CodexFastModeProjection = Readonly<{
  revision: number;
  fastEnabled: boolean;
  ultrafastEnabled: boolean;
  stepSwitchingEnabled: boolean;
  availability: "available" | "unavailable";
  unavailableReason?: string;
}>;

/** A fresh, thread-scoped policy must authorize each accelerated tier. */
export function codexSpeedPolicyAllows(
  projection: CodexFastModeProjection | undefined,
  selection: CodexServiceTierSelection,
): boolean {
  return (
    selection === "standard" ||
    (projection?.availability === "available" &&
      (selection === "fast"
        ? projection.fastEnabled
        : projection.ultrafastEnabled))
  );
}

/** Missing/stale discovery is not evidence that a saved preference is disabled. */
export function codexSpeedPolicyDisables(
  projection: CodexFastModeProjection | undefined,
  selection: CodexServiceTierSelection | undefined,
): boolean {
  return (
    selection !== undefined &&
    selection !== "standard" &&
    (projection?.availability === "available" ||
      projection?.unavailableReason === "feature_disabled") &&
    !(selection === "fast" ? projection.fastEnabled : projection.ultrafastEnabled)
  );
}

type SessionRecord = Readonly<{
  projection: CodexFastModeProjection;
  nativeThreadId: string;
  connectionGeneration: number;
  client: CodexSharedClientFacade;
}>;

type RefreshInput = Readonly<{
  scope: RequestScope;
  applicationThreadId: string;
  nativeThreadId: string;
  connectionGeneration: number;
  client: CodexSharedClientFacade;
  signal?: AbortSignal;
  onRecovered?: (projection: CodexFastModeProjection) => void | Promise<void>;
  shouldRecover?: () => boolean;
}>;

type PendingRecovery = Readonly<{
  work: Promise<void>;
  shouldRecover?: () => boolean;
}>;

type RefreshAuthority = Readonly<{
  connectionGeneration: number;
  token: object;
}>;

/**
 * Principal/thread-scoped native speed policy and mutation
 * authority. Only a successfully loaded native thread installs a usable
 * session, and every native write is fenced to that daemon generation.
 */
export class CodexFastModeSessionRegistry {
  readonly #controllers = new Map<string, CodexSpeedSession>();
  controller(scope: RequestScope, applicationThreadId: string): CodexSpeedSession | undefined {
    return this.#controllers.get(key(scope, applicationThreadId));
  }
  installController(scope: RequestScope, applicationThreadId: string, controller: CodexSpeedSession): () => void {
    const id = key(scope, applicationThreadId);
    this.#controllers.get(id)?.close();
    this.#controllers.set(id, controller);
    return () => { if (this.#controllers.get(id) === controller) this.#controllers.delete(id); controller.close(); };
  }

  readonly #records = new Map<string, SessionRecord>();
  readonly #refreshAuthorities = new Map<string, RefreshAuthority>();
  readonly #pendingRecoveries = new Map<string, PendingRecovery>();
  readonly #recoveryDelaysMilliseconds: readonly number[];

  constructor(input?: {
    readonly recoveryDelaysMilliseconds?: readonly number[];
  }) {
    const delays =
      input?.recoveryDelaysMilliseconds ?? DEFAULT_RECOVERY_DELAYS_MILLISECONDS;
    if (
      delays.length === 0 ||
      delays.some(
        (delay) =>
          !Number.isSafeInteger(delay) || delay < 0 || delay > 60_000,
      )
    ) {
      throw new Error("codex_fast_mode_recovery_delays_invalid");
    }
    this.#recoveryDelaysMilliseconds = Object.freeze([...delays]);
  }

  projection(
    scope: RequestScope,
    applicationThreadId: string,
  ): CodexFastModeProjection | undefined {
    const record = this.#records.get(key(scope, applicationThreadId));
    if (!record) return undefined;
    const lifecycle = record.client.lifecycleSnapshot();
    return lifecycle.state === "ready" &&
      lifecycle.generation === record.connectionGeneration
      ? record.projection
      : {
          revision: record.projection.revision,
          fastEnabled: record.projection.fastEnabled,
          ultrafastEnabled: record.projection.ultrafastEnabled,
          stepSwitchingEnabled: false,
          availability: "unavailable",
          unavailableReason: "generation_changed",
        };
  }

  async refresh(input: RefreshInput): Promise<CodexFastModeProjection> {
    const recordKey = key(input.scope, input.applicationThreadId);
    const prior = this.#records.get(recordKey);
    const pendingAuthority = this.#refreshAuthorities.get(recordKey);
    const initialLifecycle = input.client.lifecycleSnapshot();
    if (
      (pendingAuthority !== undefined &&
        pendingAuthority.connectionGeneration > input.connectionGeneration) ||
      (initialLifecycle.state === "ready" &&
        initialLifecycle.generation > input.connectionGeneration)
    ) {
      return Object.freeze({
        revision: prior?.projection.revision ?? 0,
        fastEnabled: prior?.projection.fastEnabled ?? false,
        ultrafastEnabled: prior?.projection.ultrafastEnabled ?? false,
        stepSwitchingEnabled: false,
        availability: "unavailable",
        unavailableReason: "generation_changed",
      });
    }
    const refreshAuthority = Object.freeze({});
    this.#refreshAuthorities.set(recordKey, {
      connectionGeneration: input.connectionGeneration,
      token: refreshAuthority,
    });
    let projection: CodexFastModeProjection;
    try {
      const policy = await readCodexSpeedEnablement(input);
      const enabled = policy.fastEnabled || policy.ultrafastEnabled;
      projection = Object.freeze({
        revision: (prior?.projection.revision ?? 0) + 1,
        ...policy,
        availability: enabled ? "available" : "unavailable",
        ...(enabled ? {} : { unavailableReason: "feature_disabled" }),
      });
    } catch {
      projection = Object.freeze({
        revision: (prior?.projection.revision ?? 0) + 1,
        fastEnabled: prior?.projection.fastEnabled ?? false,
        ultrafastEnabled: prior?.projection.ultrafastEnabled ?? false,
        stepSwitchingEnabled: false,
        availability: "unavailable",
        unavailableReason: "feature_unavailable",
      });
    }
    const current = input.client.lifecycleSnapshot();
    const latest = this.#records.get(recordKey);
    if (
      current.state !== "ready" ||
      current.generation !== input.connectionGeneration ||
      this.#refreshAuthorities.get(recordKey)?.token !== refreshAuthority ||
      (latest !== undefined &&
        latest.connectionGeneration > input.connectionGeneration)
    ) {
      return Object.freeze({
        revision: latest?.projection.revision ?? projection.revision,
        fastEnabled:
          latest?.projection.fastEnabled ??
          prior?.projection.fastEnabled ?? projection.fastEnabled,
        ultrafastEnabled:
          latest?.projection.ultrafastEnabled ??
          prior?.projection.ultrafastEnabled ?? projection.ultrafastEnabled,
        stepSwitchingEnabled: false,
        availability: "unavailable",
        unavailableReason: "generation_changed",
      });
    }
    if (prior && prior.connectionGeneration === input.connectionGeneration &&
        JSON.stringify({ ...projection, revision: 0 }) === JSON.stringify({ ...prior.projection, revision: 0 })) {
      projection = prior.projection;
    }
    this.#records.set(recordKey, {
      projection,
      nativeThreadId: input.nativeThreadId,
      connectionGeneration: input.connectionGeneration,
      client: input.client,
    });
    if (
      projection.unavailableReason === "feature_unavailable" &&
      input.onRecovered
    ) {
      this.#scheduleRecovery(input);
    }
    this.controller(input.scope, input.applicationThreadId)?.scheduleDefaults();
    return projection;
  }

  async syncServiceTier(
    scope: RequestScope,
    applicationThreadId: string,
    selection: CodexServiceTierSelection,
  ): Promise<void> {
    // All Speed default writes share the handle's actor-ordered idle coordinator.
    // The current durable selection is read there; never replay this captured argument.
    void selection;
    this.controller(scope, applicationThreadId)?.scheduleDefaults();
  }

  #scheduleRecovery(input: RefreshInput): void {
    const recoveryKey = `${key(input.scope, input.applicationThreadId)}\0${input.connectionGeneration}`;
    if (!input.onRecovered) return;
    const pending = this.#pendingRecoveries.get(recoveryKey);
    if (
      pending &&
      (!pending.shouldRecover || pending.shouldRecover())
    ) {
      return;
    }
    const onRecovered = input.onRecovered;
    let recovery!: PendingRecovery;
    let work!: Promise<void>;
    work = (async () => {
      for (const delayMilliseconds of this.#recoveryDelaysMilliseconds) {
        await delay(delayMilliseconds);
        if (input.shouldRecover && !input.shouldRecover()) return;
        const lifecycle = input.client.lifecycleSnapshot();
        if (
          lifecycle.state !== "ready" ||
          lifecycle.generation !== input.connectionGeneration
        ) {
          return;
        }
        const current = this.#records.get(
          key(input.scope, input.applicationThreadId),
        );
        if (
          !current ||
          current.connectionGeneration !== input.connectionGeneration ||
          current.projection.unavailableReason !== "feature_unavailable"
        ) {
          return;
        }
        const projection = await this.refresh({
          scope: input.scope,
          applicationThreadId: input.applicationThreadId,
          nativeThreadId: input.nativeThreadId,
          connectionGeneration: input.connectionGeneration,
          client: input.client,
        });
        const recoveredLifecycle = input.client.lifecycleSnapshot();
        const recoveredRecord = this.#records.get(
          key(input.scope, input.applicationThreadId),
        );
        if (
          projection.unavailableReason === "generation_changed" ||
          recoveredLifecycle.state !== "ready" ||
          recoveredLifecycle.generation !== input.connectionGeneration ||
          recoveredRecord?.connectionGeneration !== input.connectionGeneration
        ) {
          return;
        }
        if (projection.unavailableReason !== "feature_unavailable") {
          if (!input.shouldRecover || input.shouldRecover()) {
            await onRecovered(projection);
          }
          return;
        }
      }
    })().finally(() => {
      if (this.#pendingRecoveries.get(recoveryKey) === recovery) {
        this.#pendingRecoveries.delete(recoveryKey);
      }
    });
    recovery = Object.freeze({
      work,
      ...(input.shouldRecover ? { shouldRecover: input.shouldRecover } : {}),
    });
    this.#pendingRecoveries.set(recoveryKey, recovery);
    void work.catch(() => undefined);
  }
}


function key(scope: RequestScope, applicationThreadId: string): string {
  return `${scope.tenantId}\0${scope.principalId}\0${applicationThreadId}`;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}
