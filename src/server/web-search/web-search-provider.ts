export interface WebSearchProviderAvailability {
  readonly available: boolean;
  readonly reason?: string;
}

export interface WebSearchProviderRequest {
  readonly query: string;
  readonly resumeSessionId?: string;
  readonly signal: AbortSignal;
}

export interface WebSearchProviderResult {
  readonly text: string;
  readonly sessionId?: string;
}

export type WebSearchProviderErrorCode =
  | "cancelled"
  | "timed_out"
  | "session_unavailable"
  | "unavailable"
  | "failed";

export class WebSearchProviderError extends Error {
  constructor(
    readonly code: WebSearchProviderErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebSearchProviderError";
  }
}

/** Narrow provider seam; provider-native sessions never leave this boundary. */
export interface WebSearchProvider {
  readonly id: string;
  checkAvailability(signal?: AbortSignal): Promise<WebSearchProviderAvailability>;
  search(request: WebSearchProviderRequest): Promise<WebSearchProviderResult>;
}
