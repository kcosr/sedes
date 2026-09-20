import {
  createContext,
  useContext,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  ComposerTaskReference,
  ContextExcerpt,
} from "../../shared/index.js";

export interface ContextExcerptStagingSnapshot {
  readonly available: boolean;
  readonly deliveryMode?: "submit" | "steer" | "queue";
  readonly reason?: string;
}

export type ContextExcerptStageResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface ComposerDraftConsumer {
  readonly stage: (excerpt: ContextExcerpt) => ContextExcerptStageResult;
  readonly attachAndSubmit: (
    excerpt: ContextExcerpt,
  ) => ContextExcerptStageResult;
  readonly stageTaskReference: (
    reference: ComposerTaskReference,
  ) => ContextExcerptStageResult;
  readonly getSnapshot: () => ContextExcerptStagingSnapshot;
}

export interface ComposerDraftStagingTarget {
  readonly threadId: string;
  readonly workspaceId?: string;
  getSnapshot(): ContextExcerptStagingSnapshot;
  subscribe(listener: () => void): () => void;
  stage(excerpt: ContextExcerpt): ContextExcerptStageResult;
  attachAndSubmit(excerpt: ContextExcerpt): ContextExcerptStageResult;
  stageTaskReference(
    reference: ComposerTaskReference,
  ): ContextExcerptStageResult;
}

/** Context-capture surfaces consume only the excerpt subset. */
export type ContextExcerptStagingTarget = Pick<
  ComposerDraftStagingTarget,
  | "threadId"
  | "workspaceId"
  | "getSnapshot"
  | "subscribe"
  | "stage"
  | "attachAndSubmit"
>;

const UNAVAILABLE: ContextExcerptStagingSnapshot = Object.freeze({
  available: false,
  reason: "The message composer is unavailable.",
});

export class ComposerDraftCoordinator implements ComposerDraftStagingTarget {
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly #listeners = new Set<() => void>();
  #consumer?: ComposerDraftConsumer;
  #disposed = false;
  #snapshot: ContextExcerptStagingSnapshot = UNAVAILABLE;

  constructor(threadId: string, workspaceId?: string) {
    this.threadId = threadId;
    this.workspaceId = workspaceId;
  }

  getSnapshot = (): ContextExcerptStagingSnapshot => {
    return this.#snapshot;
  };

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  stage = (excerpt: ContextExcerpt): ContextExcerptStageResult => {
    const status = this.#consumer?.getSnapshot() ?? this.#snapshot;
    if (!status.available) {
      return { ok: false, reason: status.reason ?? UNAVAILABLE.reason! };
    }
    if (!this.#consumer || this.#disposed) {
      return { ok: false, reason: UNAVAILABLE.reason! };
    }
    return this.#consumer.stage(excerpt);
  };

  attachAndSubmit = (excerpt: ContextExcerpt): ContextExcerptStageResult => {
    const status = this.#consumer?.getSnapshot() ?? this.#snapshot;
    if (!status.available) {
      return { ok: false, reason: status.reason ?? UNAVAILABLE.reason! };
    }
    if (!this.#consumer || this.#disposed) {
      return { ok: false, reason: UNAVAILABLE.reason! };
    }
    return this.#consumer.attachAndSubmit(excerpt);
  };

  stageTaskReference = (
    reference: ComposerTaskReference,
  ): ContextExcerptStageResult => {
    const status = this.#consumer?.getSnapshot() ?? this.#snapshot;
    if (!status.available) {
      return { ok: false, reason: status.reason ?? UNAVAILABLE.reason! };
    }
    if (!this.#consumer || this.#disposed) {
      return { ok: false, reason: UNAVAILABLE.reason! };
    }
    return this.#consumer.stageTaskReference(reference);
  };

  registerConsumer(consumer: ComposerDraftConsumer): () => void {
    if (this.#disposed) return () => undefined;
    this.#consumer = consumer;
    this.#snapshot = consumer.getSnapshot();
    this.notify();
    return () => {
      if (this.#consumer !== consumer) return;
      this.#consumer = undefined;
      this.#snapshot = UNAVAILABLE;
      this.notify();
    };
  }

  notify(): void {
    if (!this.#disposed) {
      this.#snapshot = this.#consumer?.getSnapshot() ?? UNAVAILABLE;
    }
    for (const listener of this.#listeners) listener();
  }

  dispose(): void {
    this.#disposed = true;
    this.#consumer = undefined;
    this.#snapshot = Object.freeze({
      available: false,
      reason: "The active thread changed. Select the excerpt again.",
    });
    this.notify();
  }
}

const ContextExcerptStagingContext =
  createContext<ComposerDraftCoordinator | null>(null);

export function ComposerDraftProvider({
  threadId,
  workspaceId,
  children,
}: {
  readonly threadId: string;
  readonly workspaceId?: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const coordinator = useMemo(
    () => new ComposerDraftCoordinator(threadId, workspaceId),
    [threadId, workspaceId],
  );
  useLayoutEffect(() => () => coordinator.dispose(), [coordinator]);
  return (
    <ContextExcerptStagingContext.Provider value={coordinator}>
      {children}
    </ContextExcerptStagingContext.Provider>
  );
}

export function useComposerDraftStaging():
  ComposerDraftStagingTarget | undefined {
  return useContext(ContextExcerptStagingContext) ?? undefined;
}

export const useContextExcerptStaging = useComposerDraftStaging;

export function useContextExcerptStagingSnapshot(
  target?: ContextExcerptStagingTarget,
): ContextExcerptStagingSnapshot {
  return useComposerDraftStagingSnapshot(target);
}

export function useComposerDraftStagingSnapshot(
  suppliedTarget?: ContextExcerptStagingTarget,
): ContextExcerptStagingSnapshot {
  const contextTarget = useComposerDraftStaging();
  const target = suppliedTarget ?? contextTarget;
  return useSyncExternalStore(
    target?.subscribe ?? emptySubscribe,
    target?.getSnapshot ?? getUnavailable,
    target?.getSnapshot ?? getUnavailable,
  );
}

export function useComposerDraftCoordinator():
  ComposerDraftCoordinator | undefined {
  return useContext(ContextExcerptStagingContext) ?? undefined;
}

function emptySubscribe(): () => void {
  return () => undefined;
}

function getUnavailable(): ContextExcerptStagingSnapshot {
  return UNAVAILABLE;
}
