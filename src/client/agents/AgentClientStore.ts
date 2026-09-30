import { useSyncExternalStore } from "react";
import type {
  CreateSavedAgentRequest,
  DeleteSavedAgentRequest,
  SavedAgent,
  SavedAgentOptionsRequest,
  SavedAgentOptionsResult,
  SavedAgentSummary,
  UpdateSavedAgentRequest,
} from "../../shared/index.js";
import type { ApiClient } from "../api/ApiClient.js";
import { messageFrom } from "../stores/ApplicationClientStore.js";

/**
 * The one Agent a page shows, keyed by the Agent it was asked for. It is
 * separate from the list, so a list refresh never touches a failed load:
 * that stays until another Agent is asked for or a retry succeeds.
 */
export type AgentDetailState =
  | { readonly status: "none" }
  | { readonly status: "loading"; readonly agentId: string }
  | { readonly status: "ready"; readonly agentId: string; readonly agent: SavedAgent }
  | {
      readonly status: "error";
      readonly agentId: string;
      readonly error: string;
      /** A retry is in flight; the failure stays until it succeeds. */
      readonly retrying: boolean;
    };

export interface AgentClientState {
  readonly status: "idle" | "loading" | "ready" | "error";
  readonly items: readonly SavedAgentSummary[];
  readonly nextCursor?: string;
  readonly search: string;
  readonly loadingMore: boolean;
  /** The list's failure; the detail keeps its own. */
  readonly error?: string;
  readonly detail: AgentDetailState;
}

const initialState: AgentClientState = {
  status: "idle",
  items: [],
  search: "",
  loadingMore: false,
  detail: { status: "none" },
};

export class AgentClientStore {
  readonly api: ApiClient;
  #state = initialState;
  readonly #listeners = new Set<() => void>();
  #listAbort?: AbortController;
  #detailAbort?: AbortController;
  #listGeneration = 0;
  #detailGeneration = 0;

  constructor(api: ApiClient) {
    this.api = api;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getSnapshot = (): AgentClientState => this.#state;

  open(): Promise<void> {
    return this.#state.status === "idle" ? this.refresh() : Promise.resolve();
  }

  refresh(search = this.#state.search): Promise<void> {
    this.#listAbort?.abort();
    const abort = new AbortController();
    this.#listAbort = abort;
    const generation = ++this.#listGeneration;
    this.#replace({
      ...this.#state,
      status: "loading",
      search,
      error: undefined,
      nextCursor: undefined,
      loadingMore: false,
    });
    return this.api
      .listSavedAgents({
        ...(search.trim() ? { nameSearch: search.trim() } : {}),
        pageSize: 50,
        signal: abort.signal,
      })
      .then((page) => {
        if (generation !== this.#listGeneration) return;
        this.#replace({
          ...this.#state,
          status: "ready",
          items: page.items,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          error: undefined,
        });
      })
      .catch((cause: unknown) => {
        if (abort.signal.aborted || generation !== this.#listGeneration) return;
        this.#replace({
          ...this.#state,
          status: "error",
          error: messageFrom(cause),
        });
      });
  }

  loadMore(): Promise<void> {
    const cursor = this.#state.nextCursor;
    if (!cursor || this.#state.loadingMore) return Promise.resolve();
    const generation = this.#listGeneration;
    this.#replace({ ...this.#state, loadingMore: true, error: undefined });
    return this.api
      .listSavedAgents({
        ...(this.#state.search.trim()
          ? { nameSearch: this.#state.search.trim() }
          : {}),
        cursor,
        pageSize: 50,
      })
      .then((page) => {
        if (generation !== this.#listGeneration) return;
        const byId = new Map(this.#state.items.map((item) => [item.id, item]));
        for (const item of page.items) byId.set(item.id, item);
        this.#replace({
          ...this.#state,
          items: [...byId.values()],
          loadingMore: false,
          ...(page.nextCursor
            ? { nextCursor: page.nextCursor }
            : { nextCursor: undefined }),
        });
      })
      .catch((cause: unknown) => {
        if (generation !== this.#listGeneration) return;
        this.#replace({
          ...this.#state,
          loadingMore: false,
          error: messageFrom(cause),
        });
      });
  }

  /**
   * Loads the Agent a page shows. Asking again for an Agent whose load
   * failed is a retry: the failure stays, marked retrying, until it succeeds.
   */
  loadAgent(agentId: string): Promise<void> {
    this.#detailAbort?.abort();
    const abort = new AbortController();
    this.#detailAbort = abort;
    const generation = ++this.#detailGeneration;
    const current = this.#state.detail;
    this.#setDetail(
      current.status === "error" && current.agentId === agentId
        ? { ...current, retrying: true }
        : { status: "loading", agentId },
    );
    return this.api.getSavedAgent(agentId, abort.signal).then(
      (agent) => {
        if (generation !== this.#detailGeneration) return;
        this.#setDetail({ status: "ready", agentId, agent });
      },
      (cause: unknown) => {
        if (abort.signal.aborted || generation !== this.#detailGeneration) return;
        this.#setDetail({ status: "error", agentId, error: messageFrom(cause), retrying: false });
      },
    );
  }

  clearSelection(): void {
    this.#detailAbort?.abort();
    this.#detailGeneration += 1;
    this.#setDetail({ status: "none" });
  }

  options(
    input: SavedAgentOptionsRequest,
    signal?: AbortSignal,
  ): Promise<SavedAgentOptionsResult> {
    return this.api.getSavedAgentOptions(input, signal);
  }

  async refreshAgent(agentId: string): Promise<SavedAgent> {
    const agent = await this.api.getSavedAgent(agentId);
    this.#replaceShown(agent);
    return agent;
  }

  async create(input: CreateSavedAgentRequest): Promise<SavedAgent> {
    const agent = await this.api.createSavedAgent(input);
    await this.refresh();
    return agent;
  }

  async update(
    agentId: string,
    input: UpdateSavedAgentRequest,
  ): Promise<SavedAgent> {
    const agent = await this.api.updateSavedAgent(agentId, input);
    this.#replaceShown(agent);
    await this.refresh();
    return agent;
  }

  async delete(agentId: string, input: DeleteSavedAgentRequest): Promise<void> {
    await this.api.deleteSavedAgent(agentId, input);
    if (this.#shownId() === agentId) this.clearSelection();
    await this.refresh();
  }

  dispose(): void {
    this.#listAbort?.abort();
    this.#detailAbort?.abort();
    this.#listeners.clear();
  }

  #shownId(): string | undefined {
    const detail = this.#state.detail;
    return detail.status === "none" ? undefined : detail.agentId;
  }

  /** A newer copy of the Agent shown (a save or a conflict refresh). */
  #replaceShown(agent: SavedAgent): void {
    if (this.#shownId() !== agent.id) return;
    this.#detailAbort?.abort();
    this.#detailGeneration += 1;
    this.#setDetail({ status: "ready", agentId: agent.id, agent });
  }

  #setDetail(detail: AgentDetailState): void {
    this.#replace({ ...this.#state, detail });
  }

  #replace(state: AgentClientState): void {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}

export function useAgentStore(store: AgentClientStore): AgentClientState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
