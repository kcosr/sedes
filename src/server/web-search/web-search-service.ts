import {
  WebSearchProviderError,
  type WebSearchProvider,
  type WebSearchProviderAvailability,
} from "./web-search-provider.js";

const MAXIMUM_SESSION_MAPPINGS = 4_096;

export interface WebSearchSubject {
  readonly tenantId: string;
  readonly principalId: string;
  readonly kind: "thread" | "principal_client";
  readonly id: string;
}

export interface WebSearchResult {
  readonly text: string;
  readonly continued: boolean;
  readonly continuationFallback: boolean;
}

interface WebSearchGeneration {
  readonly provider: WebSearchProvider;
  readonly availability: WebSearchProviderAvailability;
  readonly sessions: Map<string, string>;
  readonly inFlight: Map<string, Promise<void>>;
}

export class WebSearchService {
  #generation: WebSearchGeneration;

  constructor(
    provider: WebSearchProvider,
    availability: WebSearchProviderAvailability,
  ) {
    this.#generation = createGeneration(provider, availability);
  }

  reconfigure(
    provider: WebSearchProvider,
    availability: WebSearchProviderAvailability,
  ): void {
    // A new native home/account must never inherit a previous continuation.
    // Admitted calls keep their generation until they and its queue settle.
    this.#generation = createGeneration(provider, availability);
  }

  async search(input: {
    readonly subject: WebSearchSubject;
    readonly query: string;
    readonly continue: boolean;
    readonly signal: AbortSignal;
  }): Promise<WebSearchResult> {
    const generation = this.#generation;
    if (!generation.availability.available) {
      throw new WebSearchProviderError(
        "unavailable",
        generation.availability.reason ?? "Web search is unavailable.",
        true,
      );
    }
    const key = subjectKey(input.subject);
    return await this.#serialize(generation, key, async () => {
      const resumeSessionId = input.continue
        ? generation.sessions.get(key)
        : undefined;
      const continuationFallback = input.continue && !resumeSessionId;
      try {
        const result = await generation.provider.search({
          query: input.query,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          signal: input.signal,
        });
        if (resumeSessionId) {
          this.#remember(generation, key, result.sessionId);
        } else {
          generation.sessions.delete(key);
          this.#remember(generation, key, result.sessionId);
        }
        return Object.freeze({
          text: result.text,
          continued: resumeSessionId !== undefined,
          continuationFallback,
        });
      } catch (error) {
        if (
          resumeSessionId &&
          error instanceof WebSearchProviderError &&
          error.code === "session_unavailable"
        ) {
          generation.sessions.delete(key);
          const fresh = await generation.provider.search({
            query: input.query,
            signal: input.signal,
          });
          generation.sessions.delete(key);
          this.#remember(generation, key, fresh.sessionId);
          return Object.freeze({
            text: fresh.text,
            continued: false,
            continuationFallback: true,
          });
        }
        throw error;
      }
    });
  }

  #remember(
    generation: WebSearchGeneration,
    key: string,
    sessionId: string | undefined,
  ): void {
    if (!sessionId) return;
    generation.sessions.delete(key);
    generation.sessions.set(key, sessionId);
    while (generation.sessions.size > MAXIMUM_SESSION_MAPPINGS) {
      generation.sessions.delete(generation.sessions.keys().next().value!);
    }
  }

  async #serialize<T>(
    generation: WebSearchGeneration,
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = generation.inFlight.get(key);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    generation.inFlight.set(key, gate);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (generation.inFlight.get(key) === gate) generation.inFlight.delete(key);
    }
  }
}

function createGeneration(
  provider: WebSearchProvider,
  availability: WebSearchProviderAvailability,
): WebSearchGeneration {
  return Object.freeze({
    provider,
    availability: Object.freeze({ ...availability }),
    sessions: new Map<string, string>(),
    inFlight: new Map<string, Promise<void>>(),
  });
}

function subjectKey(subject: WebSearchSubject): string {
  return `${subject.tenantId}\0${subject.principalId}\0${subject.kind}\0${subject.id}`;
}
