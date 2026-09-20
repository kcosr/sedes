import { useSyncExternalStore } from "react";
import type {
  CannedPromptLibrary,
  CannedPromptMutationResult,
} from "../../shared/protocol/canned-prompts.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";

export interface CannedPromptClientState {
  readonly status: "loading" | "ready" | "error";
  readonly error?: string;
  readonly library: CannedPromptLibrary;
  readonly updateAvailable: boolean;
  readonly pendingMutation: boolean;
}

const emptyLibrary: CannedPromptLibrary = { revision: 0, items: [] };

const initialState: CannedPromptClientState = {
  status: "loading",
  library: emptyLibrary,
  updateAvailable: false,
  pendingMutation: false,
};

type Mutation = (
  expectedRevision: number,
  mutationId: string,
  signal: AbortSignal,
) => Promise<CannedPromptMutationResult>;

/**
 * Owns the principal canned-prompt library independently of application
 * bootstrap and thread projections. The picker and settings surfaces share
 * this one lazy-loaded store regardless of their responsive layout.
 */
export class CannedPromptClientStore {
  readonly #api: ApiClient;
  readonly #listeners = new Set<() => void>();
  #state = initialState;
  #loadGeneration = 0;
  #loadController?: AbortController;
  #loadPromise?: Promise<void>;
  #availableUpdate?: CannedPromptLibrary;
  #mutationController?: AbortController;
  #mutationChain: Promise<void> = Promise.resolve();
  #pendingMutationCount = 0;
  #disposed = false;

  constructor(api: ApiClient) {
    this.#api = api;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): CannedPromptClientState => this.#state;

  /** Starts the first read only when a prompt-owning surface needs it. */
  load(): Promise<void> {
    if (this.#state.status === "ready") return Promise.resolve();
    return this.#load("initial");
  }

  /** Replaces any older read with a fresh authoritative library snapshot. */
  refresh(): Promise<void> {
    return this.#load("refresh");
  }

  /**
   * Checks for a newer server revision without replacing the catalog currently
   * visible in an open picker.
   */
  revalidate(): Promise<void> {
    if (this.#state.status !== "ready") return this.load();
    return this.#load("revalidate");
  }

  /** Promotes a silently staged server revision into the visible catalog. */
  applyAvailableUpdate(): boolean {
    if (this.#disposed || !this.#availableUpdate) return false;
    const library = this.#availableUpdate;
    this.#availableUpdate = undefined;
    this.#replaceState({
      ...this.#state,
      status: "ready",
      error: undefined,
      library,
      updateAvailable: false,
    });
    return true;
  }

  create(input: {
    readonly title: string;
    readonly text: string;
  }): Promise<CannedPromptMutationResult> {
    return this.#enqueueMutation((expectedRevision, mutationId, signal) =>
      this.#api.createCannedPrompt(
        { ...input, expectedRevision, mutationId },
        signal,
      ),
    );
  }

  update(
    promptId: string,
    input: { readonly title: string; readonly text: string },
  ): Promise<CannedPromptMutationResult> {
    return this.#enqueueMutation((expectedRevision, mutationId, signal) =>
      this.#api.updateCannedPrompt(
        promptId,
        { ...input, expectedRevision, mutationId },
        signal,
      ),
    );
  }

  delete(promptId: string): Promise<CannedPromptMutationResult> {
    return this.#enqueueMutation((expectedRevision, mutationId, signal) =>
      this.#api.deleteCannedPrompt(
        promptId,
        { expectedRevision, mutationId },
        signal,
      ),
    );
  }

  reorder(promptIds: readonly string[]): Promise<CannedPromptMutationResult> {
    return this.#enqueueMutation((expectedRevision, mutationId, signal) =>
      this.#api.reorderCannedPrompts(
        { promptIds: [...promptIds], expectedRevision, mutationId },
        signal,
      ),
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loadGeneration += 1;
    this.#loadController?.abort();
    this.#mutationController?.abort();
    this.#availableUpdate = undefined;
    this.#listeners.clear();
  }

  #load(mode: "initial" | "refresh" | "revalidate"): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (mode !== "refresh" && this.#loadPromise) return this.#loadPromise;

    const generation = ++this.#loadGeneration;
    this.#loadController?.abort();
    const controller = new AbortController();
    this.#loadController = controller;
    if (mode !== "revalidate") {
      this.#availableUpdate = undefined;
      this.#replaceState({
        ...this.#state,
        status: "loading",
        error: undefined,
        updateAvailable: false,
      });
    }

    const operation = this.#api
      .listCannedPrompts(controller.signal)
      .then((library) => {
        if (this.#disposed || generation !== this.#loadGeneration) return;
        if (mode === "revalidate") {
          if (library.revision <= this.#state.library.revision) return;
          this.#availableUpdate = library;
          if (!this.#state.updateAvailable) {
            this.#replaceState({ ...this.#state, updateAvailable: true });
          }
          return;
        }
        this.#replaceState({
          ...this.#state,
          status: "ready",
          error: undefined,
          library,
          updateAvailable: false,
        });
      })
      .catch((error: unknown) => {
        if (this.#disposed || generation !== this.#loadGeneration) return;
        if (mode === "revalidate") throw error;
        this.#replaceState({
          ...this.#state,
          status: "error",
          error: messageFrom(error),
        });
        throw error;
      })
      .finally(() => {
        if (this.#loadController === controller) {
          this.#loadController = undefined;
        }
        if (this.#loadPromise === operation) this.#loadPromise = undefined;
      });
    this.#loadPromise = operation;
    return operation;
  }

  #enqueueMutation(mutation: Mutation): Promise<CannedPromptMutationResult> {
    this.#pendingMutationCount += 1;
    this.#publishPendingMutation();
    const operation = this.#mutationChain.then(() =>
      this.#runMutation(mutation),
    );
    this.#mutationChain = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation.finally(() => {
      this.#pendingMutationCount -= 1;
      this.#publishPendingMutation();
    });
  }

  async #runMutation(mutation: Mutation): Promise<CannedPromptMutationResult> {
    if (this.#disposed)
      throw new Error("The canned prompt store was disposed.");
    if (this.#state.status !== "ready") await this.load();
    if (this.#disposed)
      throw new Error("The canned prompt store was disposed.");
    if (this.#state.status !== "ready") {
      throw new Error("Canned prompts must finish loading before mutation.");
    }

    // A list response admitted before this mutation must not later replace its
    // exact mutation result.
    this.#loadGeneration += 1;
    const controller = new AbortController();
    this.#mutationController = controller;
    try {
      const result = await mutation(
        this.#state.library.revision,
        crypto.randomUUID(),
        controller.signal,
      );
      if (!this.#disposed) {
        this.#availableUpdate = undefined;
        this.#loadGeneration += 1;
        this.#replaceState({
          ...this.#state,
          status: "ready",
          error: undefined,
          library: { revision: result.revision, items: result.items },
          updateAvailable: false,
        });
      }
      return result;
    } catch (error) {
      if (
        !this.#disposed &&
        error instanceof ApiError &&
        error.code === "conflict"
      ) {
        await this.refresh().catch(() => undefined);
      } else if (!this.#disposed && !isAbortError(error)) {
        this.#replaceState({
          ...this.#state,
          error: messageFrom(error),
        });
      }
      throw error;
    } finally {
      if (this.#mutationController === controller) {
        this.#mutationController = undefined;
      }
    }
  }

  #publishPendingMutation(): void {
    if (this.#disposed) return;
    const pendingMutation = this.#pendingMutationCount > 0;
    if (pendingMutation === this.#state.pendingMutation) return;
    this.#replaceState({ ...this.#state, pendingMutation });
  }

  #replaceState(state: CannedPromptClientState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export function useCannedPromptStore(
  store: CannedPromptClientStore,
): CannedPromptClientState {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
