import type {
  ActivityDetailMode,
  ApplicationEventEnvelope,
  ThreadLoadServerDiagnostic,
  ThreadHandshakeServerDiagnostic,
  ThreadLoadError,
  ThreadReplayServerDiagnostic,
  ThreadEventEnvelope,
  ThreadCheckpoint,
} from "../../shared/index.js";
import {
  THREAD_LOAD_DIAGNOSTICS_QUERY_VALUE,
  applicationEventIdSchema,
  threadEventIdSchema,
  threadLoadErrorSchema,
  threadLoadServerDiagnosticSchema,
  threadHandshakeServerDiagnosticSchema,
  threadReplayServerDiagnosticSchema,
} from "../../shared/index.js";
import {
  endpointUsesCrossOriginTransport,
  resolveSedesServerUrl,
  sameOriginSedesServer,
  type SedesServerEndpoint,
} from "../app/server-endpoint.js";
import { authenticatedFetch, notifyUnauthorized } from "../authentication/auth-transport.js";
import { FetchEventSource, type ClientEventSource } from "./FetchEventSource.js";
import { recordStreamingDiagnostic } from "../app/diagnostics.js";
export type ConnectionState = "connected" | "reconnecting" | "disconnected";

export interface StreamSubscription {
  close(): void;
}

export interface ThreadLoadStreamDiagnostics {
  onEventSourceCreated(input: { readonly cursorAvailable: boolean }): void;
  onResponseHeadersReceived(): void;
  onEnvelopeParsed(input: {
    readonly envelope: ThreadEventEnvelope;
    readonly eventDataCharacters: number;
    readonly durationMilliseconds: number;
  }): void;
  onCheckpointParsed?(input: {
    readonly checkpoint: ThreadCheckpoint;
    readonly eventDataCharacters: number;
    readonly durationMilliseconds: number;
  }): void;
  onHandshakeDiagnostic(diagnostic: ThreadHandshakeServerDiagnostic): void;
  onServerDiagnostic(diagnostic: ThreadLoadServerDiagnostic): void;
  onReplayDiagnostic(diagnostic: ThreadReplayServerDiagnostic): void;
  onLive(input: {
    readonly cursorAvailable: boolean;
    readonly envelopeCount: number;
    readonly snapshotReceived: boolean;
  }): void;
}

export interface EventStreamTransport {
  subscribeApplication(input: {
    onEnvelope: (envelope: ApplicationEventEnvelope) => void;
    onConnection: (state: ConnectionState) => void;
    onProtocolError?: (error: Error) => void;
    onTerminalError?: (error: Error) => void;
    getReplayCursor?: () => string | undefined;
    initialHandshake?: "authoritative_replacement";
  }): StreamSubscription;
  subscribeThread(
    threadId: string,
    input: {
      activityDetail: ActivityDetailMode;
      onEnvelope: (envelope: ThreadEventEnvelope) => void;
      onCheckpoint: (checkpoint: ThreadCheckpoint) => void;
      onConnection: (state: ConnectionState) => void;
      onLive?: () => boolean | void;
      onLoadError?: (error: ThreadLoadError) => void;
      onProtocolError?: (error: Error) => void;
      onTerminalProtocolError?: (error: Error) => void;
      getReplayCursor?: () => string | undefined;
      loadDiagnostics?: ThreadLoadStreamDiagnostics;
    },
  ): StreamSubscription;
  subscribeWorkspaceFiles(
    workspaceId: string,
    input: {
      onInvalidate: () => void;
      onConnection: (state: ConnectionState) => void;
      onProtocolError?: (error: Error) => void;
    },
  ): StreamSubscription;
  markAllNativeSuspended(): void;
  reconnectAll(): void;
  closeAll(): void;
}

interface ManagedStream extends StreamSubscription {
  needsReconnect(): boolean;
  markNativeSuspended(): void;
  reopen(): void;
}

export class BrowserEventStreamTransport implements EventStreamTransport {
  readonly #streams = new Set<ManagedStream>();
  readonly #endpoint: SedesServerEndpoint;

  constructor(endpoint: SedesServerEndpoint = sameOriginSedesServer) {
    this.#endpoint = endpoint;
  }

  subscribeApplication(input: {
    onEnvelope: (envelope: ApplicationEventEnvelope) => void;
    onConnection: (state: ConnectionState) => void;
    onProtocolError?: (error: Error) => void;
    onTerminalError?: (error: Error) => void;
    getReplayCursor?: () => string | undefined;
    initialHandshake?: "authoritative_replacement";
  }): StreamSubscription {
    return this.#subscribe(
      "/api/application/events",
      "application",
      "application-live",
      input,
    );
  }

  subscribeThread(
    threadId: string,
    input: {
      activityDetail: ActivityDetailMode;
      onEnvelope: (envelope: ThreadEventEnvelope) => void;
      onCheckpoint: (checkpoint: ThreadCheckpoint) => void;
      onConnection: (state: ConnectionState) => void;
      onLive?: () => boolean | void;
      onLoadError?: (error: ThreadLoadError) => void;
      onProtocolError?: (error: Error) => void;
      onTerminalProtocolError?: (error: Error) => void;
      getReplayCursor?: () => string | undefined;
      loadDiagnostics?: ThreadLoadStreamDiagnostics;
    },
  ): StreamSubscription {
    const parameters = new URLSearchParams({
      activityDetail: input.activityDetail,
    });
    if (input.loadDiagnostics) {
      parameters.set("diagnostics", THREAD_LOAD_DIAGNOSTICS_QUERY_VALUE);
    }
    return this.#subscribe(
      `/api/threads/${encodeURIComponent(threadId)}/events?${parameters.toString()}`,
      "thread",
      "thread-live",
      input,
    );
  }

  subscribeWorkspaceFiles(
    workspaceId: string,
    input: {
      onInvalidate: () => void;
      onConnection: (state: ConnectionState) => void;
      onProtocolError?: (error: Error) => void;
    },
  ): StreamSubscription {
    return this.#subscribe(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/files/events`,
      "workspace-files-invalidated",
      "workspace-files-live",
      {
        onEnvelope: () => input.onInvalidate(),
        onConnection: input.onConnection,
        ...(input.onProtocolError
          ? { onProtocolError: input.onProtocolError }
          : {}),
      },
    );
  }

  reconnectAll(): void {
    // OPEN streams are healthy and CONNECTING streams are already using the
    // browser's native retry path, which preserves Last-Event-ID. Replacing
    // either with a new EventSource discards that cursor and needlessly asks
    // the server for another snapshot. A CLOSED stream cannot recover itself.
    // Offline streams need a new handshake once WebView reports them OPEN.
    // Native-suspended streams are reopened immediately because Android can
    // leave EventSource CONNECTING on a delayed browser retry schedule.
    for (const stream of this.#streams) {
      if (stream.needsReconnect()) stream.reopen();
    }
  }

  markAllNativeSuspended(): void {
    for (const stream of this.#streams) stream.markNativeSuspended();
  }

  closeAll(): void {
    for (const stream of [...this.#streams]) stream.close();
  }

  #subscribe<T>(
    path: string,
    eventName: "application" | "thread" | "workspace-files-invalidated",
    liveEventName: "application-live" | "thread-live" | "workspace-files-live",
    input: {
      onEnvelope: (envelope: T) => void;
      onCheckpoint?: (checkpoint: ThreadCheckpoint) => void;
      onConnection: (state: ConnectionState) => void;
      onLive?: () => boolean | void;
      onLoadError?: (error: ThreadLoadError) => void;
      onProtocolError?: (error: Error) => void;
      onTerminalError?: (error: Error) => void;
      onTerminalProtocolError?: (error: Error) => void;
      getReplayCursor?: () => string | undefined;
      loadDiagnostics?: ThreadLoadStreamDiagnostics;
      initialHandshake?: "authoritative_replacement";
    },
  ): StreamSubscription {
    const baseUrl = resolveSedesServerUrl(this.#endpoint, path);
    const options = {
      withCredentials: !endpointUsesCrossOriginTransport(this.#endpoint),
    };
    const observeLoadDiagnostic = (observe: () => void): void => {
      try {
        observe();
      } catch {
        // Optional diagnostics must never invalidate, reopen, or delay the
        // authoritative normalized stream when browser APIs fail.
      }
    };
    let closed = false;
    let stale = false;
    let nativeSuspended = false;
    let source!: ClientEventSource;
    let handshakeCursorAvailable = false;
    let handshakeEnvelopeCount = 0;
    let handshakeSnapshotReceived = false;
    let lastStreamingEnvelopeAt: number | undefined;
    let pendingInitialHandshake = input.initialHandshake;
    const windowTarget = typeof window === "undefined" ? undefined : window;

    const readReplayCursor = (): string | undefined => {
      try {
        const cursorSchema =
          eventName === "application"
            ? applicationEventIdSchema
            : threadEventIdSchema;
        const parsed = cursorSchema.safeParse(input.getReplayCursor?.());
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    };

    const createSource = (): ClientEventSource => {
      lastStreamingEnvelopeAt = undefined;
      const replayCursor = readReplayCursor();
      handshakeCursorAvailable = replayCursor !== undefined;
      handshakeEnvelopeCount = 0;
      handshakeSnapshotReceived = false;
      const initialHandshake = pendingInitialHandshake;
      const query = initialHandshake
        ? `handshake=${encodeURIComponent(initialHandshake)}`
        : replayCursor
          ? `replayCursor=${encodeURIComponent(replayCursor)}`
          : undefined;
      const url = query
        ? `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}${query}`
        : baseUrl;
      const created = endpointUsesCrossOriginTransport(this.#endpoint)
        ? new FetchEventSource(this.#endpoint, query
          ? `${path}${path.includes("?") ? "&" : "?"}${query}`
          : path)
        : new EventSource(url, options);
      pendingInitialHandshake = undefined;
      if (input.loadDiagnostics) {
        observeLoadDiagnostic(() =>
          input.loadDiagnostics!.onEventSourceCreated({
            cursorAvailable: handshakeCursorAvailable,
          }),
        );
      }
      return created;
    };

    source = createSource();

    const parse = (
      attachedSource: ClientEventSource,
      message: MessageEvent<string>,
    ) => {
      if (closed || attachedSource !== source) return;
      try {
        // The normalized application/thread stores are the single schema and
        // semantic validation boundary. Parsing the complete envelope here as
        // well doubled traversal and allocation for large thread snapshots.
        const parseStartedAt = input.loadDiagnostics
          ? performance.now()
          : undefined;
        const decoded = JSON.parse(message.data) as T;
        handshakeEnvelopeCount += 1;
        const threadEnvelope = decoded as ThreadEventEnvelope;
        if (
          eventName === "thread" &&
          threadEnvelope.event.type === "item_upsert"
        ) {
          const receivedAt = performance.now();
          const item = threadEnvelope.event.item;
          recordStreamingDiagnostic("sse_item_received", {
            arrivalGapMilliseconds:
              lastStreamingEnvelopeAt === undefined
                ? null
                : receivedAt - lastStreamingEnvelopeAt,
            eventDataCharacters: message.data.length,
            eventType: threadEnvelope.event.type,
            itemKind: item.kind,
            itemStatus: item.status,
          });
          lastStreamingEnvelopeAt = receivedAt;
        }
        if (
          eventName === "thread" &&
          (decoded as { event?: { type?: unknown } }).event?.type === "snapshot"
        ) {
          handshakeSnapshotReceived = true;
          observeLoadDiagnostic(() =>
            input.loadDiagnostics!.onEnvelopeParsed({
              envelope: decoded as ThreadEventEnvelope,
              eventDataCharacters: message.data.length,
              durationMilliseconds:
                performance.now() - (parseStartedAt ?? performance.now()),
            }),
          );
        }
        input.onEnvelope(decoded);
      } catch (cause) {
        const error = new Error("Invalid normalized event envelope.", {
          cause,
        });
        input.onProtocolError?.(error);
        managed.reopen();
      }
    };
    const attach = () => {
      const attachedSource = source;
      attachedSource.onopen = () => {
        if (closed || attachedSource !== source) return;
        if (input.loadDiagnostics) {
          observeLoadDiagnostic(() =>
            input.loadDiagnostics!.onResponseHeadersReceived(),
          );
        }
      };
      attachedSource.onerror = () => {
        if (closed || attachedSource !== source) return;
        handshakeCursorAvailable = readReplayCursor() !== undefined;
        handshakeEnvelopeCount = 0;
        handshakeSnapshotReceived = false;
        input.onConnection(
          typeof navigator !== "undefined" && !navigator.onLine
            ? "disconnected"
            : "reconnecting",
        );
        if (attachedSource.readyState === 2) {
          if (!endpointUsesCrossOriginTransport(this.#endpoint)) {
            // Native EventSource hides HTTP status. Distinguish revoked cookie
            // sessions from network failures without putting credentials in URLs.
            void authenticatedFetch(this.#endpoint, "/api/auth/status")
              .then(async (response) => {
                if (!response.ok) return;
                const status: unknown = await response.json();
                if (!closed && attachedSource === source &&
                    typeof status === "object" && status !== null &&
                    "required" in status && status.required === true &&
                    "authenticated" in status && status.authenticated === false) {
                  notifyUnauthorized(this.#endpoint);
                }
              }).catch(() => undefined);
          }
          input.onTerminalError?.(
            new Error("The application event stream closed permanently."),
          );
        }
      };
      attachedSource.addEventListener(eventName, ((
        message: MessageEvent<string>,
      ) => parse(attachedSource, message)) as EventListener);
      attachedSource.addEventListener(liveEventName, () => {
        if (closed || attachedSource !== source) return;
        // A live marker is sent only after the server has completed this
        // connection's snapshot/replay handshake. Native EventSource may
        // recover the same object after offline or suspension, so that marker
        // is also the evidence that an earlier stale mark has been repaired.
        stale = false;
        nativeSuspended = false;
        const accepted = input.onLive?.();
        if (accepted !== false && input.loadDiagnostics) {
          observeLoadDiagnostic(() =>
            input.loadDiagnostics!.onLive({
              cursorAvailable: handshakeCursorAvailable,
              envelopeCount: handshakeEnvelopeCount,
              snapshotReceived: handshakeSnapshotReceived,
            }),
          );
        }
        if (accepted !== false) input.onConnection("connected");
      });
      if (eventName === "thread") {
        attachedSource.addEventListener("thread-checkpoint", ((
          message: MessageEvent<string>,
        ) => {
          if (closed || attachedSource !== source) return;
          try {
            const startedAt = performance.now();
            // Schema and semantic validation belong to the normalized store,
            // just as for published envelopes. Do not traverse text twice.
            const checkpoint = JSON.parse(message.data) as ThreadCheckpoint;
            if (!input.onCheckpoint) {
              throw new Error("Thread checkpoint handler missing.");
            }
            handshakeEnvelopeCount += 1;
            handshakeSnapshotReceived = true;
            observeLoadDiagnostic(() =>
              input.loadDiagnostics?.onCheckpointParsed?.({
                checkpoint,
                eventDataCharacters: message.data.length,
                durationMilliseconds: performance.now() - startedAt,
              }),
            );
            input.onCheckpoint(checkpoint);
          } catch (cause) {
            input.onProtocolError?.(
              new Error("Invalid normalized thread checkpoint.", { cause }),
            );
            managed.reopen();
          }
        }) as EventListener);
        attachedSource.addEventListener("thread-load-error", ((
          message: MessageEvent<string>,
        ) => {
          if (closed || attachedSource !== source) return;
          const parsed = threadLoadErrorSchema.safeParse(
            (() => {
              try {
                return JSON.parse(message.data);
              } catch {
                return undefined;
              }
            })(),
          );
          if (!parsed.success) {
            managed.close();
            input.onTerminalProtocolError?.(
              new Error("Invalid normalized thread load error.", {
                cause: parsed.error,
              }),
            );
            return;
          }
          // A classified bootstrap failure is complete authority for this
          // attach. Close before notifying the store so native EventSource
          // cannot turn the server's deliberate end into an opaque retry.
          managed.close();
          input.onLoadError?.(parsed.data);
        }) as EventListener);
      }
      if (eventName === "thread" && input.loadDiagnostics) {
        attachedSource.addEventListener("thread-handshake-diagnostic", ((
          message: MessageEvent<string>,
        ) => {
          if (closed || attachedSource !== source) return;
          try {
            const parsed = threadHandshakeServerDiagnosticSchema.safeParse(
              JSON.parse(message.data),
            );
            if (parsed.success) {
              observeLoadDiagnostic(() =>
                input.loadDiagnostics!.onHandshakeDiagnostic(parsed.data),
              );
            }
          } catch {
            // Optional diagnostics cannot affect the normalized stream.
          }
        }) as EventListener);
        attachedSource.addEventListener("thread-load-diagnostic", ((
          message: MessageEvent<string>,
        ) => {
          if (closed || attachedSource !== source) return;
          try {
            const parsed = threadLoadServerDiagnosticSchema.safeParse(
              JSON.parse(message.data),
            );
            if (parsed.success) {
              observeLoadDiagnostic(() =>
                input.loadDiagnostics!.onServerDiagnostic(parsed.data),
              );
            }
          } catch {
            // Diagnostics are observational and may never invalidate or reopen
            // the authoritative normalized conversation stream.
          }
        }) as EventListener);
        attachedSource.addEventListener("thread-replay-diagnostic", ((
          message: MessageEvent<string>,
        ) => {
          if (closed || attachedSource !== source) return;
          try {
            const parsed = threadReplayServerDiagnosticSchema.safeParse(
              JSON.parse(message.data),
            );
            if (parsed.success) {
              observeLoadDiagnostic(() =>
                input.loadDiagnostics!.onReplayDiagnostic(parsed.data),
              );
            }
          } catch {
            // Optional diagnostics cannot affect the normalized stream.
          }
        }) as EventListener);
      }
    };
    const markOffline = () => {
      stale = true;
      input.onConnection("disconnected");
    };
    windowTarget?.addEventListener("offline", markOffline);

    const managed: ManagedStream = {
      needsReconnect: () => {
        const shouldReopen =
          source.readyState === 2 ||
          nativeSuspended ||
          (stale && source.readyState === 1);
        return shouldReopen;
      },
      markNativeSuspended: () => {
        if (closed || nativeSuspended) return;
        stale = true;
        nativeSuspended = true;
        source.close();
        input.onConnection("disconnected");
      },
      reopen: () => {
        if (closed) return;
        source.close();
        input.onConnection("reconnecting");
        stale = false;
        nativeSuspended = false;
        source = createSource();
        attach();
      },
      close: () => {
        if (closed) return;
        closed = true;
        source.close();
        windowTarget?.removeEventListener("offline", markOffline);
        this.#streams.delete(managed);
      },
    };
    attach();
    this.#streams.add(managed);
    return managed;
  }
}
