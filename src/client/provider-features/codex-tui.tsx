import {
  createContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { RefreshCw, X } from "lucide-react";
import { z } from "zod";
import { boundedDisplayTextSchema } from "../../shared/index.js";
import type {
  BoundedValue,
  NormalizedThreadSnapshot,
  ProviderFeatureCapability,
} from "../../shared/index.js";
import type { ApiClient } from "../api/ApiClient.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { Button } from "../components/ui/button.js";
import { ChatViewVisibilityContext } from "../components/thread/chat-view-visibility.js";
import { MobileChatHistoryThumbstick } from "../components/thread/MobileChatHistoryThumbstick.js";
import type { ChatHistoryEntry } from "../components/thread/ChatHistoryRail.js";

export interface CodexTuiTerminalControl {
  /** Whether the terminal view is the active presentation. */
  readonly active: boolean;
  /** Whether the terminal socket has synchronized and accepts input. */
  readonly inputAvailable: boolean;
  /** Returns true only when terminal input was accepted for delivery. */
  readonly sendKey: (data: string) => boolean;
  /** Moves keyboard focus into the terminal (raises the soft keyboard). */
  readonly focusTerminal: () => void;
  /** Releases keyboard focus from the terminal. */
  readonly blurTerminal: () => void;
  /** Whether the terminal currently holds keyboard focus. */
  readonly isTerminalFocused: () => boolean;
}

/**
 * Terminal quick-key control for surfaces outside the terminal view itself
 * (the composer's mobile key bar). Null when no TUI feature is present.
 */
export const CodexTuiTerminalControlContext =
  createContext<CodexTuiTerminalControl | null>(null);
import {
  getMobileHistorySeekControl,
  getTerminalPreferences,
  subscribeMobileHistorySeekControl,
  subscribeTerminalPreferences,
} from "../app/settings.js";
import {
  getResolvedAppearance,
  subscribeResolvedAppearance,
} from "../app/appearance.js";
import {
  browserCodexTuiRendererFactory,
  type CodexTuiRendererFactory,
} from "./codex-tui-renderer.js";
import {
  readCodexTuiView,
  writeCodexTuiView,
} from "./codex-tui-view-preference.js";
import {
  browserCodexTuiTransportFactory,
  type CodexTuiConnectionState,
  type CodexTuiTransportFactory,
} from "./codex-tui-transport.js";

export const CODEX_TUI_FEATURE_REF = Object.freeze({
  featureId: "codex.tui",
  schemaVersion: 1,
});

/** Shared touch-layout boundary for terminal focus and composer controls. */
export const MOBILE_TUI_MEDIA_QUERY = "(max-width: 720px), (pointer: coarse)";

/**
 * Desktop-only autofocus. Narrow and coarse-pointer layouts keep the soft
 * keyboard closed until the user explicitly taps the terminal or the command
 * field (same policy as herdr-web mobile terminals).
 */
function shouldAutoFocusCodexTui(): boolean {
  return !window.matchMedia(MOBILE_TUI_MEDIA_QUERY).matches;
}

const exitStatusSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("code"), code: z.number().int() }),
  z.strictObject({
    kind: z.literal("signal"),
    signal: z.string().min(1).max(32),
  }),
]);

const codexTuiStateSchema = z.strictObject({
  lifecycle: z.enum([
    "stopped",
    "starting",
    "running",
    "stopping",
    "exited",
    "failed",
  ]),
  resourceGeneration: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  streamAvailable: z.boolean(),
  diagnostic: boundedDisplayTextSchema.optional(),
  exitStatus: exitStatusSchema.optional(),
});

export type CodexTuiFeatureState = z.infer<typeof codexTuiStateSchema>;

export interface CodexTuiThreadPresentationProps {
  readonly threadId: string;
  /** Whether the retained outer Chat panel is currently presented. */
  readonly visible: boolean;
  readonly snapshot: NormalizedThreadSnapshot;
  readonly store: ThreadClientStore;
  readonly api: ApiClient;
  readonly historicalFocus: boolean;
  readonly chat: React.ReactNode;
  /** Ephemeral Chat-only status docked below the viewport and above composer UI. */
  readonly status?: React.ReactNode;
  /** Persistent composer rendered below both views so it never remounts. */
  readonly composer?: React.ReactNode;
  /** Thread-scoped interaction panel rendered above the presentation. */
  readonly takeover?: React.ReactNode;
  readonly mobileHistory?: {
    readonly entries: readonly ChatHistoryEntry[];
    readonly activeItemId?: string;
    readonly onBeginInteraction: () => string | undefined;
    readonly assistantLabel: string;
    readonly onSelect: (itemId: string) => void;
  };
  readonly transportFactory?: CodexTuiTransportFactory;
  readonly rendererFactory?: CodexTuiRendererFactory;
}

export function CodexTuiThreadPresentation({
  threadId,
  visible,
  snapshot,
  store,
  api,
  historicalFocus,
  chat,
  status,
  composer,
  takeover,
  mobileHistory,
  transportFactory,
  rendererFactory,
}: CodexTuiThreadPresentationProps): React.JSX.Element {
  const resolution = resolveCodexTui(snapshot);
  const resolved = resolution.kind === "available" ? resolution : undefined;
  const available = !historicalFocus && resolved !== undefined;
  const [selection, setSelection] = useState<"chat" | "tui">(() =>
    readCodexTuiView(threadId),
  );
  const [activated, setActivated] = useState(selection === "tui");
  const [mutationPending, setMutationPending] = useState(false);
  const [locallyStarting, setLocallyStarting] = useState(false);
  const [localStartFailure, setLocalStartFailure] = useState<string>();
  const [refitRequest, setRefitRequest] = useState(0);
  const [terminalInputAvailable, setTerminalInputAvailable] = useState(false);
  const [showMobileHistorySeekControl, setShowMobileHistorySeekControl] =
    useState(getMobileHistorySeekControl);
  const terminalInputRef = useRef<(data: string) => boolean>(() => false);
  const terminalFocusRef = useRef<() => void>(() => undefined);
  const terminalBlurRef = useRef<() => void>(() => undefined);
  const terminalHasFocusRef = useRef<() => boolean>(() => false);
  const switchRef = useRef<HTMLDivElement | null>(null);
  const pendingHistoryItemId = useRef<string | undefined>(undefined);
  const previousHistoricalFocus = useRef(historicalFocus);

  useEffect(() => {
    setSelection(readCodexTuiView(threadId));
    setActivated(readCodexTuiView(threadId) === "tui");
  }, [threadId]);

  useEffect(
    () => subscribeMobileHistorySeekControl(setShowMobileHistorySeekControl),
    [],
  );

  useEffect(() => {
    const wasHistorical = previousHistoricalFocus.current;
    previousHistoricalFocus.current = historicalFocus;
    if (historicalFocus) {
      setSelection("chat");
      return;
    }
    if (wasHistorical) {
      setSelection(readCodexTuiView(threadId));
      return;
    }
    if (resolution.kind === "unavailable" && selection === "tui") {
      setSelection("chat");
      writeCodexTuiView(threadId, "chat");
    }
  }, [historicalFocus, resolution.kind, selection, threadId]);

  useEffect(() => {
    if (
      resolved &&
      resolved.state.lifecycle !== "stopped" &&
      resolved.state.lifecycle !== "exited"
    ) {
      setLocallyStarting(false);
      setLocalStartFailure(undefined);
    }
  }, [resolved]);

  const select = (next: "chat" | "tui") => {
    setSelection(next);
    writeCodexTuiView(threadId, next);
    if (next === "tui") {
      setActivated(true);
      if (
        resolved?.capability.availability === "available" &&
        (resolved.state.lifecycle === "stopped" ||
          resolved.state.lifecycle === "exited")
      ) {
        void perform("start");
      }
    }
  };

  const perform = async (actionId: "start" | "stop") => {
    if (
      !resolved ||
      resolved.capability.availability !== "available" ||
      mutationPending
    )
      return;
    const operation = resolved.capability.operations.find(
      (candidate) => candidate.actionId === actionId,
    );
    if (!operation) return;
    if (actionId === "start") {
      setLocallyStarting(true);
      setLocalStartFailure(undefined);
    }
    setMutationPending(true);
    try {
      await store.perform({
        action: "perform_provider_feature",
        feature: CODEX_TUI_FEATURE_REF,
        actionId,
        arguments: null,
        expectedFeatureRevision: resolved.capability.revision,
        ...(operation.confirmation === "explicit" ? { confirmed: true } : {}),
      });
    } catch (error: unknown) {
      if (actionId === "start") {
        setLocallyStarting(false);
        setLocalStartFailure(messageFrom(error).slice(0, 400));
      }
    } finally {
      setMutationPending(false);
    }
  };

  const showTui = available && selection === "tui";
  const presentedState =
    localStartFailure &&
    resolved &&
    (resolved.state.lifecycle === "stopped" ||
      resolved.state.lifecycle === "exited")
      ? {
          ...resolved.state,
          lifecycle: "failed" as const,
          diagnostic: { text: localStartFailure },
        }
      : locallyStarting &&
          resolved &&
          (resolved.state.lifecycle === "stopped" ||
            resolved.state.lifecycle === "exited")
        ? { ...resolved.state, lifecycle: "starting" as const }
        : resolved?.state;
  const canStart =
    resolved?.capability.availability === "available" &&
    resolved.capability.operations.some(({ actionId }) => actionId === "start");
  const canStop =
    resolved?.capability.availability === "available" &&
    resolved.capability.operations.some(({ actionId }) => actionId === "stop");
  const handleSwitchKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (
      ![
        "ArrowLeft",
        "ArrowRight",
        "ArrowUp",
        "ArrowDown",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    const next =
      event.key === "ArrowLeft" ||
      event.key === "ArrowUp" ||
      event.key === "Home"
        ? "chat"
        : "tui";
    select(next);
    switchRef.current
      ?.querySelector<HTMLButtonElement>(`button[data-thread-view="${next}"]`)
      ?.focus();
  };
  const terminalControl = useMemo<CodexTuiTerminalControl>(
    () => ({
      active: visible && showTui,
      inputAvailable: visible && terminalInputAvailable,
      sendKey: (data) => visible && terminalInputRef.current(data),
      focusTerminal: () => {
        if (visible) terminalFocusRef.current();
      },
      blurTerminal: () => {
        if (visible) terminalBlurRef.current();
      },
      isTerminalFocused: () => visible && terminalHasFocusRef.current(),
    }),
    [showTui, terminalInputAvailable, visible],
  );
  const selectHistoryItem = (itemId: string) => {
    if (!mobileHistory) return;
    if (!showTui) {
      mobileHistory.onSelect(itemId);
      return;
    }
    pendingHistoryItemId.current = itemId;
    select("chat");
  };

  useLayoutEffect(() => {
    if (showTui || !pendingHistoryItemId.current || !mobileHistory) return;
    const itemId = pendingHistoryItemId.current;
    pendingHistoryItemId.current = undefined;
    mobileHistory.onSelect(itemId);
  }, [mobileHistory, showTui]);

  return (
    <ChatViewVisibilityContext.Provider value={visible && !showTui}>
      <CodexTuiTerminalControlContext.Provider value={terminalControl}>
        <div className="thread-presentation">
          <div
            className="thread-presentation-content"
            data-testid="thread-presentation-content"
          >
            <div
              className="thread-presentation-viewport"
              data-testid="thread-presentation-viewport"
            >
              {available && (
                <div className="thread-view-floating-controls">
                  <div
                    className="thread-view-switch"
                    role="group"
                    aria-label="Thread view"
                    ref={switchRef}
                    onKeyDown={handleSwitchKey}
                  >
                    <button
                      type="button"
                      aria-pressed={!showTui}
                      data-thread-view="chat"
                      onClick={() => select("chat")}
                    >
                      Chat
                    </button>
                    <button
                      type="button"
                      aria-pressed={showTui}
                      data-thread-view="tui"
                      onClick={() => select("tui")}
                    >
                      TUI
                    </button>
                  </div>
                  {showTui && presentedState?.lifecycle === "running" && (
                    <button
                      type="button"
                      className="thread-view-action"
                      aria-label="Refit terminal"
                      title="Refit terminal"
                      onClick={() => setRefitRequest((value) => value + 1)}
                    >
                      <RefreshCw aria-hidden="true" size={14} strokeWidth={2} />
                    </button>
                  )}
                  {showTui && canStop && (
                    <button
                      type="button"
                      className="thread-view-action thread-view-stop-action"
                      aria-label="Stop TUI"
                      title="Stop TUI"
                      disabled={mutationPending}
                      onClick={() => void perform("stop")}
                    >
                      <X aria-hidden="true" size={15} strokeWidth={2.25} />
                    </button>
                  )}
                </div>
              )}
              {mobileHistory && showMobileHistorySeekControl && (
                <MobileChatHistoryThumbstick
                  entries={mobileHistory.entries}
                  getActiveItemId={() => showTui
                    ? mobileHistory.activeItemId
                    : mobileHistory.onBeginInteraction()}
                  assistantLabel={mobileHistory.assistantLabel}
                  onSelect={selectHistoryItem}
                />
              )}
              <div
                className="chat-thread-panel"
                data-testid="chat-thread-panel"
                hidden={showTui}
              >
                {chat}
              </div>
              {available && activated && resolved && (
                <div
                  className="codex-tui-panel"
                  data-testid="codex-tui-panel"
                  hidden={!showTui}
                >
                  <CodexTuiPanel
                    threadId={threadId}
                    state={presentedState ?? resolved.state}
                    store={store}
                    api={api}
                    visible={visible && showTui}
                    mutationPending={mutationPending}
                    canStart={canStart}
                    unavailableReason={
                      resolved.capability.unavailableReason?.text
                    }
                    refitRequest={refitRequest}
                    terminalInputRef={terminalInputRef}
                    terminalFocusRef={terminalFocusRef}
                    terminalBlurRef={terminalBlurRef}
                    terminalHasFocusRef={terminalHasFocusRef}
                    onInputAvailabilityChange={setTerminalInputAvailable}
                    onStart={() => void perform("start")}
                    onReturnToChat={() => select("chat")}
                    {...(transportFactory ? { transportFactory } : {})}
                    {...(rendererFactory ? { rendererFactory } : {})}
                  />
                </div>
              )}
            </div>
            {status}
            {/* Docked in flow above the composer: a blocking request must never
                sit on top of the controls the thread still owns. */}
            {takeover}
            {composer}
          </div>
        </div>
      </CodexTuiTerminalControlContext.Provider>
    </ChatViewVisibilityContext.Provider>
  );
}

function CodexTuiPanel({
  threadId,
  state,
  api,
  visible,
  mutationPending,
  canStart,
  unavailableReason,
  refitRequest,
  onStart,
  onReturnToChat,
  terminalInputRef,
  terminalFocusRef,
  terminalBlurRef,
  terminalHasFocusRef,
  onInputAvailabilityChange,
  transportFactory,
  rendererFactory,
}: {
  readonly threadId: string;
  readonly state: CodexTuiFeatureState;
  readonly store: ThreadClientStore;
  readonly api: ApiClient;
  readonly visible: boolean;
  readonly mutationPending: boolean;
  readonly canStart: boolean;
  readonly unavailableReason?: string;
  readonly refitRequest: number;
  readonly onStart: () => void;
  readonly onReturnToChat: () => void;
  readonly terminalInputRef?: React.MutableRefObject<(data: string) => boolean>;
  readonly terminalFocusRef?: React.MutableRefObject<() => void>;
  readonly terminalBlurRef?: React.MutableRefObject<() => void>;
  readonly terminalHasFocusRef?: React.MutableRefObject<() => boolean>;
  readonly onInputAvailabilityChange: (available: boolean) => void;
  readonly transportFactory?: CodexTuiTransportFactory;
  readonly rendererFactory?: CodexTuiRendererFactory;
}): React.JSX.Element {
  const [preferences, setPreferences] = useState(getTerminalPreferences);
  useEffect(() => subscribeTerminalPreferences(setPreferences), []);
  const defaultTransportFactory = useMemo(
    () =>
      browserCodexTuiTransportFactory(
        api,
        threadId,
        state.resourceGeneration ?? 1,
      ),
    [api, state.resourceGeneration, threadId],
  );
  const defaultRendererFactory = useMemo(
    () => browserCodexTuiRendererFactory(
      { fontSize: preferences.fontSize, scrollback: preferences.scrollback },
      getResolvedAppearance(),
    ),
    [preferences.fontSize, preferences.scrollback],
  );

  if (
    state.lifecycle !== "running" ||
    !state.streamAvailable ||
    !state.resourceGeneration
  ) {
    return (
      <div className="codex-tui-lifecycle" role="status">
        <strong>{lifecycleTitle(state.lifecycle)}</strong>
        <span>
          {state.diagnostic?.text ??
            exitStatusCopy(state.exitStatus) ??
            (!canStart ? unavailableReason : undefined) ??
            lifecycleCopy(state.lifecycle)}
        </span>
        {(state.lifecycle === "failed" || state.lifecycle === "exited") &&
          canStart && (
            <div className="codex-tui-lifecycle-actions">
              <Button onClick={onStart} disabled={mutationPending}>
                Retry
              </Button>
              <Button variant="outline" onClick={onReturnToChat}>
                Return to Chat
              </Button>
            </div>
          )}
        {state.lifecycle === "stopped" && canStart && (
          <div className="codex-tui-lifecycle-actions">
            <Button onClick={onStart} disabled={mutationPending}>
              Start TUI
            </Button>
            <Button variant="outline" onClick={onReturnToChat}>
              Return to Chat
            </Button>
          </div>
        )}
      </div>
    );
  }

  const resolvedTransportFactory = transportFactory ?? defaultTransportFactory;
  const resolvedRendererFactory = rendererFactory ?? defaultRendererFactory;

  return (
    <section
      className="codex-tui-surface"
      role="region"
      aria-label="Codex terminal"
    >
      <CodexTuiTerminal
        cursorBlink={preferences.cursorBlink}
        visible={visible}
        refitRequest={refitRequest}
        transportFactory={resolvedTransportFactory}
        rendererFactory={resolvedRendererFactory}
        {...(terminalInputRef ? { terminalInputRef } : {})}
        {...(terminalFocusRef ? { terminalFocusRef } : {})}
        {...(terminalBlurRef ? { terminalBlurRef } : {})}
        {...(terminalHasFocusRef ? { terminalHasFocusRef } : {})}
        onInputAvailabilityChange={onInputAvailabilityChange}
      />
    </section>
  );
}

function CodexTuiTerminal({
  cursorBlink,
  visible,
  refitRequest,
  transportFactory,
  rendererFactory,
  terminalInputRef,
  terminalFocusRef,
  terminalBlurRef,
  terminalHasFocusRef,
  onInputAvailabilityChange,
}: {
  readonly cursorBlink: boolean;
  readonly visible: boolean;
  readonly refitRequest: number;
  readonly transportFactory: CodexTuiTransportFactory;
  readonly rendererFactory: CodexTuiRendererFactory;
  readonly terminalInputRef?: React.MutableRefObject<(data: string) => boolean>;
  readonly terminalFocusRef?: React.MutableRefObject<() => void>;
  readonly terminalBlurRef?: React.MutableRefObject<() => void>;
  readonly terminalHasFocusRef?: React.MutableRefObject<() => boolean>;
  readonly onInputAvailabilityChange: (available: boolean) => void;
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rendererRef = useRef<ReturnType<CodexTuiRendererFactory> | null>(null);
  const transportRef = useRef<ReturnType<CodexTuiTransportFactory> | null>(
    null,
  );
  const [connection, setConnection] = useState<CodexTuiConnectionState>("idle");
  const [diagnostic, setDiagnostic] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
  const cursorBlinkRef = useRef(cursorBlink);
  cursorBlinkRef.current = cursorBlink;
  useEffect(() => {
    rendererRef.current?.setCursorBlink(cursorBlink);
  }, [cursorBlink]);
  const [theme, setTheme] = useState(getResolvedAppearance);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  useEffect(() => subscribeResolvedAppearance(setTheme), []);

  useEffect(() => {
    rendererRef.current?.setTheme(theme);
    const size = rendererRef.current?.fit();
    if (size) transportRef.current?.requestRefit(size.cols, size.rows);
  }, [theme]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    const renderer = rendererFactory();
    renderer.setCursorBlink(cursorBlinkRef.current);
    renderer.setTheme(themeRef.current);
    rendererRef.current = renderer;
    const pendingOutput: Uint8Array[] = [];
    let outputTimer: number | undefined;
    const flushOutput = () => {
      outputTimer = undefined;
      if (pendingOutput.length === 0) return;
      const length = pendingOutput.reduce(
        (total, chunk) => total + chunk.byteLength,
        0,
      );
      const output = new Uint8Array(length);
      let offset = 0;
      for (const chunk of pendingOutput.splice(0)) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      renderer.write(output);
    };
    const transport = transportFactory({
      onState: (next) => {
        setConnection(next);
        onInputAvailabilityChange(next === "ready");
        if (next === "authorizing" || next === "ready")
          setDiagnostic(undefined);
      },
      onOutput: (data) => {
        pendingOutput.push(data);
        outputTimer ??= window.setTimeout(flushOutput, 16);
      },
      onReady: () => {
        if (!visibleRef.current) return;
        const size = renderer.fit();
        if (size) transportRef.current?.resize(size.cols, size.rows);
        if (shouldAutoFocusCodexTui()) renderer.focus();
      },
      onError: setDiagnostic,
      onExit: () => setDiagnostic("The managed TUI exited."),
    });
    transportRef.current = transport;
    if (terminalInputRef) {
      terminalInputRef.current = (data) => transport.input(data);
    }
    if (terminalFocusRef) {
      terminalFocusRef.current = () => rendererRef.current?.focus();
    }
    if (terminalBlurRef) {
      terminalBlurRef.current = () => rendererRef.current?.blur();
    }
    if (terminalHasFocusRef) {
      terminalHasFocusRef.current = () =>
        rendererRef.current?.hasFocus() ?? false;
    }
    void renderer
      .mount(host)
      .then((size) => {
        if (disposed) return;
        const removeInput = renderer.onInput((data) => transport.input(data));
        transport.connect();
        transport.resize(size.cols, size.rows);
        if (visibleRef.current && shouldAutoFocusCodexTui()) {
          renderer.focus();
        }
        cleanupInput = removeInput;
      })
      .catch((error: unknown) => setDiagnostic(messageFrom(error)));
    let cleanupInput: (() => void) | undefined;
    const observer = new ResizeObserver(() => {
      if (!visibleRef.current) return;
      const size = renderer.fit();
      if (size) transport.resize(size.cols, size.rows);
    });
    observer.observe(host);
    const handleVisibility = () => {
      if (!visibleRef.current || document.visibilityState !== "visible") return;
      const size = renderer.fit();
      if (size) transport.requestRefit(size.cols, size.rows);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      observer.disconnect();
      if (outputTimer !== undefined) window.clearTimeout(outputTimer);
      cleanupInput?.();
      transport.close();
      renderer.dispose();
      rendererRef.current = null;
      transportRef.current = null;
      if (terminalInputRef) terminalInputRef.current = () => false;
      if (terminalFocusRef) terminalFocusRef.current = () => undefined;
      if (terminalBlurRef) terminalBlurRef.current = () => undefined;
      if (terminalHasFocusRef) terminalHasFocusRef.current = () => false;
      onInputAvailabilityChange(false);
    };
  }, [
    onInputAvailabilityChange,
    rendererFactory,
    retryToken,
    terminalBlurRef,
    terminalFocusRef,
    terminalHasFocusRef,
    terminalInputRef,
    transportFactory,
  ]);

  useEffect(() => {
    if (!visible || document.visibilityState !== "visible") return;
    const size = rendererRef.current?.fit();
    if (size) transportRef.current?.requestRefit(size.cols, size.rows);
    // Touch layouts never focus programmatically (the renderer strips
    // ghostty's open()-time focus and contenteditable marker), so switching
    // Chat → TUI on mobile cannot pop the soft keyboard.
    if (shouldAutoFocusCodexTui()) rendererRef.current?.focus();
  }, [visible]);

  useEffect(() => {
    if (refitRequest === 0 || !visible) return;
    const size = rendererRef.current?.fit();
    if (size) transportRef.current?.requestRefit(size.cols, size.rows);
    // Refit is layout-only on touch layouts; keep keyboard focus where it is.
    if (shouldAutoFocusCodexTui()) rendererRef.current?.focus();
  }, [refitRequest, visible]);

  return (
    <>
      {(diagnostic || connection === "failed") && (
        <div className="codex-tui-connection" role="alert">
          {diagnostic ?? "Terminal unavailable"}
          {connection === "failed" && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setDiagnostic(undefined);
                setConnection("idle");
                setRetryToken((value) => value + 1);
              }}
            >
              Reconnect viewer
            </Button>
          )}
        </div>
      )}
      <div
        className="codex-tui-terminal"
        data-testid="codex-tui-terminal"
        ref={hostRef}
        tabIndex={-1}
      />
    </>
  );
}

type CodexTuiResolution =
  | {
      readonly kind: "available";
      readonly capability: ProviderFeatureCapability;
      readonly state: CodexTuiFeatureState;
    }
  | { readonly kind: "transient" }
  | { readonly kind: "unavailable" };

function resolveCodexTui(
  snapshot: NormalizedThreadSnapshot,
): CodexTuiResolution {
  const capability = snapshot.capabilities.providerFeatures.find(
    ({ ref }) =>
      ref.featureId === CODEX_TUI_FEATURE_REF.featureId &&
      ref.schemaVersion === 1,
  );
  if (!capability || capability.availability === "unavailable") {
    return { kind: "unavailable" };
  }
  const envelope = snapshot.providerFeatures.find(
    ({ ref }) =>
      ref.featureId === CODEX_TUI_FEATURE_REF.featureId &&
      ref.schemaVersion === 1,
  );
  if (!envelope || envelope.revision !== capability.revision)
    return { kind: "transient" };
  const decoded = decodeBoundedValue(envelope.state);
  if (!decoded.ok) return { kind: "transient" };
  const parsed = codexTuiStateSchema.safeParse(decoded.value);
  if (!parsed.success) return { kind: "transient" };
  return { kind: "available", capability, state: parsed.data };
}

type DecodedBoundedValue =
  { readonly ok: true; readonly value: unknown } | { readonly ok: false };

function decodeBoundedValue(value: BoundedValue): DecodedBoundedValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return { ok: true, value };
  }
  if ("text" in value) {
    return value.truncation ? { ok: false } : { ok: true, value: value.text };
  }
  if (value.kind === "array") {
    if (value.truncation) return { ok: false };
    const values: unknown[] = [];
    for (const entry of value.values) {
      const decoded = decodeBoundedValue(entry);
      if (!decoded.ok) return decoded;
      values.push(decoded.value);
    }
    return { ok: true, value: values };
  }
  if (value.kind === "object") {
    if (value.truncation) return { ok: false };
    const result: Record<string, unknown> = {};
    for (const entry of value.entries) {
      if (entry.key.truncation || Object.hasOwn(result, entry.key.text)) {
        return { ok: false };
      }
      const decoded = decodeBoundedValue(entry.value);
      if (!decoded.ok) return decoded;
      result[entry.key.text] = decoded.value;
    }
    return { ok: true, value: result };
  }
  return { ok: false };
}

function lifecycleTitle(lifecycle: CodexTuiFeatureState["lifecycle"]): string {
  return (
    {
      stopped: "TUI is stopped",
      starting: "Launching TUI…",
      running: "Connecting to TUI…",
      stopping: "Stopping TUI…",
      exited: "TUI exited",
      failed: "TUI failed to start",
    } as const
  )[lifecycle];
}

function lifecycleCopy(lifecycle: CodexTuiFeatureState["lifecycle"]): string {
  if (lifecycle === "stopped")
    return "Select TUI to launch the managed terminal.";
  if (lifecycle === "starting")
    return "Sedes is attaching Codex to this thread.";
  if (lifecycle === "stopping") return "Disconnecting all terminal viewers.";
  if (lifecycle === "running") return "Authorizing this terminal viewer.";
  return "The Chat view remains available.";
}

function exitStatusCopy(
  status: CodexTuiFeatureState["exitStatus"],
): string | undefined {
  if (!status) return undefined;
  return status.kind === "code"
    ? `The managed TUI exited with code ${status.code}.`
    : `The managed TUI exited after ${status.signal}.`;
}

function messageFrom(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The terminal renderer failed.";
}
