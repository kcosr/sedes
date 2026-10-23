export interface MockResponseEvent {
  readonly type: string;
  readonly [key: string]: unknown;
}
export function startMockResponsesServer(): Promise<{
  readonly baseUrl: string;
  readonly requestCount: number;
  readonly requestBodies: string[];
  setResponder(responder: ((body: string) => Promise<readonly MockResponseEvent[]>) | undefined): void;
  enqueue(events: readonly MockResponseEvent[]): void;
  hold(events: readonly MockResponseEvent[]): () => void;
  close(): Promise<void>;
}>;
