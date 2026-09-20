import type { RequestScope } from "../../identity/identity-provider.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import {
  CODEX_C2_MAX_CATALOG_ITEMS,
  codexExperimentalFeatureListMethod,
  codexThreadSettingsUpdateMethod,
  type CodexExperimentalFeatureListResponse,
} from "./codex-c2-protocol.js";
import {
  encodeCodexServiceTier,
  type CodexServiceTierSelection,
} from "./codex-service-tier.js";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_FEATURE_PAGES = 32;
const MAXIMUM_CURSOR_BYTES = 4_096;
const FAST_MODE_FEATURE_NAME = "fast_mode";
const DEFAULT_RECOVERY_DELAYS_MILLISECONDS = [
  250, 1_000, 5_000, 15_000, 30_000,
];

export type CodexFastModeProjection = Readonly<{
  revision: number;
  enabled: boolean;
  availability: "available" | "unavailable";
  unavailableReason?: string;
}>;

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
 * Principal/thread-scoped native Fast-mode availability and mutation
 * authority. Only a successfully loaded native thread installs a usable
 * session, and every native write is fenced to that daemon generation.
 */
export class CodexFastModeSessionRegistry {
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
          enabled: record.projection.enabled,
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
        enabled: prior?.projection.enabled ?? false,
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
      const enabled = await readFastModeEnablement(input);
      projection = Object.freeze({
        revision: (prior?.projection.revision ?? 0) + 1,
        enabled,
        availability: enabled ? "available" : "unavailable",
        ...(enabled ? {} : { unavailableReason: "feature_disabled" }),
      });
    } catch {
      projection = Object.freeze({
        revision: (prior?.projection.revision ?? 0) + 1,
        enabled: prior?.projection.enabled ?? false,
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
        enabled:
          latest?.projection.enabled ??
          prior?.projection.enabled ??
          projection.enabled,
        availability: "unavailable",
        unavailableReason: "generation_changed",
      });
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
    return projection;
  }

  async syncServiceTier(
    scope: RequestScope,
    applicationThreadId: string,
    selection: CodexServiceTierSelection,
  ): Promise<void> {
    const record = this.#records.get(key(scope, applicationThreadId));
    if (!record || record.projection.availability !== "available") {
      throw new Error("codex_fast_mode_session_unavailable");
    }
    const lifecycle = record.client.lifecycleSnapshot();
    if (
      lifecycle.state !== "ready" ||
      lifecycle.generation !== record.connectionGeneration
    ) {
      throw new Error("codex_fast_mode_generation_changed");
    }
    const response = await record.client.requestWithReceipt(
      codexThreadSettingsUpdateMethod,
      {
        threadId: record.nativeThreadId,
        serviceTier: encodeCodexServiceTier(selection),
      },
      { timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS },
    );
    const current = record.client.lifecycleSnapshot();
    if (
      response.generation !== record.connectionGeneration ||
      current.state !== "ready" ||
      current.generation !== response.generation
    ) {
      throw new Error("codex_fast_mode_generation_changed");
    }
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

async function readFastModeEnablement(input: {
  readonly nativeThreadId: string;
  readonly connectionGeneration: number;
  readonly client: CodexSharedClientFacade;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  let cursor: string | null = null;
  const names = new Set<string>();
  const cursors = new Set<string>();
  let fastModeEnabled: boolean | undefined;
  for (let page = 0; page < MAXIMUM_FEATURE_PAGES; page += 1) {
    const response: {
      readonly generation: number;
      readonly result: CodexExperimentalFeatureListResponse;
    } = await input.client.requestWithReceipt(
      codexExperimentalFeatureListMethod,
      {
        threadId: input.nativeThreadId,
        limit: CODEX_C2_MAX_CATALOG_ITEMS,
        ...(cursor ? { cursor } : {}),
      },
      {
        timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    if (response.generation !== input.connectionGeneration) {
      throw new Error("codex_fast_mode_generation_changed");
    }
    for (const feature of response.result.data) {
      if (names.has(feature.name)) {
        throw new Error("codex_feature_catalog_duplicate");
      }
      names.add(feature.name);
      if (feature.name === FAST_MODE_FEATURE_NAME) {
        if (feature.stage !== "stable") {
          throw new Error("codex_fast_mode_stage_invalid");
        }
        fastModeEnabled = feature.enabled;
      }
    }
    cursor = response.result.nextCursor;
    if (cursor === null) return fastModeEnabled ?? false;
    if (
      cursor.length === 0 ||
      Buffer.byteLength(cursor, "utf8") > MAXIMUM_CURSOR_BYTES ||
      cursors.has(cursor)
    ) {
      throw new Error("codex_feature_catalog_cursor_invalid");
    }
    cursors.add(cursor);
  }
  throw new Error("codex_feature_catalog_page_limit_exceeded");
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
