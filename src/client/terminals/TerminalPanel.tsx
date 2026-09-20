import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { X } from "lucide-react";
import type { TerminalResource } from "../../shared/index.js";
import type { ApiClient } from "../api/ApiClient.js";
import { getResolvedAppearance, subscribeResolvedAppearance } from "../app/appearance.js";
import {
  getTerminalPreferences,
  subscribeTerminalPreferences,
} from "../app/settings.js";
import { Button } from "../components/ui/button.js";
import { FindBarControl } from "../components/FindBarControl.js";
import { useMediaQuery } from "../app/use-media-query.js";
import {
  TerminalSession,
  type TerminalSessionSnapshot,
} from "./terminal-session.js";
import { GhosttyEmulator } from "./ghostty-emulator.js";
import type { TerminalSearchResult } from "./ghostty-emulator.js";
import { TerminalMobileControls } from "./TerminalMobileControls.js";
import { isSearchQueryReady } from "../search-query.js";

export interface TerminalPanelProps {
  /** Foreground input/focus ownership; false retains the mounted emulator. */
  readonly active?: boolean;
  readonly terminal: TerminalResource;
  readonly producerId: string;
  readonly api: Pick<ApiClient, "createTerminalAdmission" | "terminalWebSocketUrl">;
  readonly visible: boolean;
  readonly lifecycleError?: string;
  readonly onResourceChange?: (terminal: TerminalResource) => void;
  readonly onStateChange?: (state: TerminalSessionSnapshot) => void;
  readonly onRemoved?: (terminalId: string) => void;
}

export interface TerminalPanelHandle {
  readonly openSearch: () => void;
  readonly openTranscript: () => void;
  readonly clearSelection: () => void;
  readonly claimControl: () => void;
  readonly releaseControl: () => void;
  readonly retryConnection: () => void;
  readonly retryNotSentInput: () => void;
  readonly discardUnconfirmedInput: () => void;
  readonly focus: () => boolean;
}

export const TerminalPanel = forwardRef<TerminalPanelHandle, TerminalPanelProps>(
function TerminalPanel({
  active = true,
  terminal,
  producerId,
  api,
  visible,
  lifecycleError,
  onResourceChange,
  onStateChange,
  onRemoved,
}: TerminalPanelProps, ref): React.JSX.Element {
  const activeRef = useRef(active);
  activeRef.current = active;
  const activateSessionRef = useRef<() => void>(() => undefined);
  const panelRef = useRef<HTMLElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const commandInputRef = useRef<HTMLTextAreaElement | null>(null);
  const touchStartRef = useRef<
    { readonly x: number; readonly y: number } | undefined
  >(undefined);
  const emulatorRef = useRef<GhosttyEmulator | undefined>(undefined);
  const sessionRef = useRef<TerminalSession | undefined>(undefined);
  const autofocusPendingRef = useRef(false);
  const onResourceChangeRef = useRef(onResourceChange);
  const onStateChangeRef = useRef(onStateChange);
  const onRemovedRef = useRef(onRemoved);
  const latestTerminalRef = useRef(terminal);
  const [state, setState] = useState<TerminalSessionSnapshot>(() => initialSnapshot(terminal));
  const [colorScheme, setColorScheme] = useState(getResolvedAppearance);
  const [preferences, setPreferences] = useState(getTerminalPreferences);
  const preferencesRef = useRef(preferences);
  const appliedFontSizeRef = useRef(preferences.fontSize);
  const [searchOpen, setSearchOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [searchResult, setSearchResult] = useState<TerminalSearchResult>();
  const [showTranscript, setShowTranscript] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [transcriptSearch, setTranscriptSearch] = useState("");
  const [transcriptSearchDraft, setTranscriptSearchDraft] = useState("");
  const terminalIdentity = `${terminal.terminalId}:${terminal.incarnationId}`;
  const [uiTerminalIdentity, setUiTerminalIdentity] = useState(terminalIdentity);
  const showBottomControls = useMediaQuery("(pointer: coarse)");
  onResourceChangeRef.current = onResourceChange;
  onStateChangeRef.current = onStateChange;
  onRemovedRef.current = onRemoved;
  latestTerminalRef.current = terminal;
  preferencesRef.current = preferences;

  useEffect(() => subscribeResolvedAppearance(setColorScheme), []);
  useEffect(() => subscribeTerminalPreferences(setPreferences), []);
  useEffect(() => onStateChangeRef.current?.(state), [state]);

  // This intent belongs to opening a view, not to output, reconnects, or
  // renderer rebuilds. Abandon it if the user interacts while it is loading.
  useEffect(() => {
    autofocusPendingRef.current = active && visible && desktopTerminalFocusAllowed();
    const cancelAutofocus = () => {
      autofocusPendingRef.current = false;
    };
    document.addEventListener("pointerdown", cancelAutofocus, true);
    document.addEventListener("keydown", cancelAutofocus, true);
    return () => {
      autofocusPendingRef.current = false;
      document.removeEventListener("pointerdown", cancelAutofocus, true);
      document.removeEventListener("keydown", cancelAutofocus, true);
    };
  }, [active, visible, terminalIdentity]);

  useEffect(() => {
    if (
      !autofocusPendingRef.current ||
      !active ||
      !visible ||
      uiTerminalIdentity !== terminalIdentity ||
      state.connection !== "ready" ||
      !state.caughtUp ||
      !state.inputAvailable
    )
      return;
    let observer: MutationObserver | undefined;
    let frame: number;
    const attemptFocus = () => {
      observer?.disconnect();
      if (!autofocusPendingRef.current) return;
      const snapshot = sessionRef.current?.snapshot;
      if (
        snapshot?.connection !== "ready" ||
        !snapshot.caughtUp ||
        !snapshot.inputAvailable
      )
        return;
      const overlays = document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="menu"]',
      );
      if (
        overlays.length > 0 &&
        [...overlays].every(
          (overlay) => overlay.getAttribute("data-state") === "closed",
        )
      ) {
        // Radix retains closing surfaces for their exit animation. Wait for
        // unmount and focus restoration before fulfilling this opening intent.
        observer ??= new MutationObserver(() => {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(attemptFocus);
        });
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-state"],
        });
        return;
      }
      if (
        desktopTerminalFocusAllowed() &&
        !searchOpen &&
        !showTranscript &&
        document.visibilityState !== "hidden" &&
        overlays.length === 0
      ) {
        const emulator = emulatorRef.current;
        emulator?.focus();
        if (emulator?.hasFocus()) autofocusPendingRef.current = false;
        else frame = requestAnimationFrame(attemptFocus);
      } else {
        autofocusPendingRef.current = false;
      }
    };
    frame = requestAnimationFrame(attemptFocus);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [
    active,
    visible,
    terminalIdentity,
    uiTerminalIdentity,
    state.connection,
    state.caughtUp,
    state.inputAvailable,
    searchOpen,
    showTranscript,
  ]);

  const closeSearch = () => {
    setSearchOpen(false);
    requestAnimationFrame(() => emulatorRef.current?.focus());
  };

  useEffect(() => {
    if (!active || !visible || !searchOpen) return undefined;
    const handleEscape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        event.isComposing ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      const activeElement = document.activeElement;
      if (
        activeElement instanceof HTMLElement &&
        activeElement !== document.body &&
        !panelRef.current?.contains(activeElement)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeSearch();
    };
    document.addEventListener("keydown", handleEscape, { capture: true });
    return () =>
      document.removeEventListener("keydown", handleEscape, { capture: true });
  }, [active, searchOpen, visible]);

  useImperativeHandle(ref, () => ({
    openSearch: () => {
      setSearchOpen(true);
      requestAnimationFrame(() => searchInputRef.current?.focus());
    },
    openTranscript: () => openTranscript(),
    clearSelection: () => emulatorRef.current?.clearSelection(),
    claimControl: () => sessionRef.current?.claimControl(),
    releaseControl: () => sessionRef.current?.releaseControl(),
    retryConnection: () => sessionRef.current?.retryConnection(),
    retryNotSentInput: () => sessionRef.current?.retryNotSentInput(),
    discardUnconfirmedInput: () => sessionRef.current?.discardUnconfirmedInput(),
    focus: () => {
      const emulator = emulatorRef.current;
      const snapshot = sessionRef.current?.snapshot;
      if (
        !emulator ||
        !active ||
        !visible ||
        !desktopTerminalFocusAllowed() ||
        snapshot?.connection !== "ready" ||
        !snapshot.caughtUp ||
        !snapshot.inputAvailable ||
        searchOpen ||
        showTranscript ||
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"]',
        )
      )
        return false;
      emulator.focus();
      const focused = emulator.hasFocus();
      if (focused) autofocusPendingRef.current = false;
      return focused;
    },
  }));

  useEffect(() => {
    setState(initialSnapshot(terminal));
    setSearchOpen(false);
    setSearch("");
    setSearchResult(undefined);
    setShowTranscript(false);
    setTranscript("");
    setTranscriptSearch("");
    setTranscriptSearchDraft("");
    setUiTerminalIdentity(terminalIdentity);
  }, [terminal.incarnationId, terminal.terminalId]);

  useEffect(() => {
    if (!visible || !containerRef.current || !terminal.incarnationId) return;
    setState(initialSnapshot(terminal));
    const container = containerRef.current;
    const mountedPreferences = preferencesRef.current;
    const emulator = new GhosttyEmulator({
      fontSize: mountedPreferences.fontSize,
      cursorBlink: mountedPreferences.cursorBlink,
      scrollback: mountedPreferences.scrollback,
      colorScheme,
    });
    let disposed = false;
    let disposeMountedSession: (() => void) | undefined;
    void emulator.mount(container).then(() => {
      if (disposed) {
        emulator.dispose();
        return;
      }
      emulatorRef.current = emulator;
      emulator.setCursorBlink(preferencesRef.current.cursorBlink);
      const latestFontSize = preferencesRef.current.fontSize;
      if (latestFontSize !== mountedPreferences.fontSize)
        emulator.setFontSize(latestFontSize);
      appliedFontSizeRef.current = latestFontSize;
      const session = new TerminalSession({
        api,
        terminal,
        producerId,
        requestedRole: activeRef.current ? "controller" : "observer",
        sink: emulator,
        onRemoved: () => onRemovedRef.current?.(terminal.terminalId),
      });
      sessionRef.current = session;
      let resizeAnimationFrame: number | undefined;
      let resizeAfterPaintFrame: number | undefined;
      let resizeTimers: number[] = [];
      let layoutResizeTimer: number | undefined;
      let resizeGeneration = 0;
      let controllerReady = false;
      let lastRequestedSize: string | undefined;
      let attachmentActivationPending = true;
      const cancelResizeStabilization = () => {
        resizeGeneration += 1;
        if (resizeAnimationFrame !== undefined)
          window.cancelAnimationFrame(resizeAnimationFrame);
        if (resizeAfterPaintFrame !== undefined)
          window.cancelAnimationFrame(resizeAfterPaintFrame);
        for (const timer of resizeTimers) window.clearTimeout(timer);
        window.clearTimeout(layoutResizeTimer);
        layoutResizeTimer = undefined;
        resizeAnimationFrame = undefined;
        resizeAfterPaintFrame = undefined;
        resizeTimers = [];
      };
      const fitAndResize = (refreshMetrics = false) => {
        if (disposed || !activeRef.current || !controllerReady) return;
        const size = refreshMetrics
          ? emulator.refreshMetrics()
          : emulator.fit();
        const sizeKey = `${size.columns}:${size.rows}`;
        if (sizeKey === lastRequestedSize) return;
        if (session.resize(size.columns, size.rows))
          lastRequestedSize = sizeKey;
      };
      const stabilizeResize = () => {
        cancelResizeStabilization();
        const generation = resizeGeneration;
        // Always issue one resize for a newly acquired controller, even when
        // its first measurement matches the restored server geometry. This
        // gives the PTY a fresh WINCH/window-change for this visible panel.
        lastRequestedSize = undefined;
        fitAndResize();
        resizeAnimationFrame = window.requestAnimationFrame(() => {
          if (generation !== resizeGeneration) return;
          // Ghostty metrics can become usable only after its first canvas
          // paint. Fit again instead of waiting for an external browser
          // resize to produce the correct rows.
          fitAndResize();
          resizeAfterPaintFrame = window.requestAnimationFrame(() => {
            if (generation === resizeGeneration) fitAndResize();
          });
        });
        resizeTimers = [80, 280].map((delay) => window.setTimeout(() => {
          if (generation === resizeGeneration) fitAndResize();
        }, delay));
        void document.fonts?.ready.then(() => {
          if (generation === resizeGeneration) fitAndResize(true);
        });
      };
      const documentIsVisible = () => document.visibilityState !== "hidden";
      const activateForegroundSession = (
        next: TerminalSessionSnapshot = session.snapshot,
      ) => {
        if (
          disposed ||
          !activeRef.current ||
          !documentIsVisible() ||
          next.connection !== "ready" ||
          !next.caughtUp ||
          next.lifecycle !== "running"
        ) return;
        if (next.inputAvailable) stabilizeResize();
        else session.claimControl();
      };
      activateSessionRef.current = activateForegroundSession;
      const handleVisibilityChange = () => {
        if (documentIsVisible()) activateForegroundSession();
      };
      const handlePageShow = () => activateForegroundSession();
      let inputWasAvailable = false;
      let reportedResource = latestTerminalRef.current;
      const unsubscribe = session.subscribe((next) => {
        setState(next);
        emulator.setController(next.inputAvailable);
        controllerReady = next.inputAvailable;
        if (next.inputAvailable && !inputWasAvailable) stabilizeResize();
        else if (!next.inputAvailable && inputWasAvailable)
          cancelResizeStabilization();
        inputWasAvailable = next.inputAvailable;
        const attachmentReady = next.connection === "ready" && next.caughtUp;
        if (!attachmentReady) attachmentActivationPending = true;
        else if (attachmentActivationPending) {
          attachmentActivationPending = false;
          // A visible attachment represents the user's active device. Claim
          // control after replay, then publish a freshly measured size when
          // the server confirms the new controller epoch.
          if (!next.inputAvailable) activateForegroundSession(next);
        }
        const latestResource = latestTerminalRef.current;
        const baseResource =
          reportedResource.lifecycleRevision > latestResource.lifecycleRevision
            ? {
                ...latestResource,
                lifecycle: reportedResource.lifecycle,
                lifecycleRevision: reportedResource.lifecycleRevision,
                rows: reportedResource.rows,
                columns: reportedResource.columns,
              }
            : latestResource;
        const mergedResource = {
          ...baseResource,
          ...(next.lifecycleRevision >= baseResource.lifecycleRevision
            ? {
                lifecycle: next.lifecycle,
                lifecycleRevision: next.lifecycleRevision,
              }
            : {}),
          rows: next.rows,
          columns: next.columns,
        };
        if (
          baseResource.lifecycle !== mergedResource.lifecycle ||
          baseResource.lifecycleRevision !== mergedResource.lifecycleRevision ||
          baseResource.rows !== mergedResource.rows ||
          baseResource.columns !== mergedResource.columns
        ) {
          reportedResource = mergedResource;
          onResourceChangeRef.current?.(reportedResource);
        }
      });
      const unsubscribeInput = emulator.onInput((data) => {
        if (activeRef.current) session.sendInput(data);
      });
      const observer = new ResizeObserver(() => {
        window.clearTimeout(layoutResizeTimer);
        layoutResizeTimer = undefined;
        if (!window.matchMedia("(pointer: coarse)").matches) {
          fitAndResize();
          return;
        }
        // Mobile keyboards animate through many viewport heights. Let the
        // layout settle before asking a remote TUI to repaint its entire screen.
        layoutResizeTimer = window.setTimeout(() => {
          layoutResizeTimer = undefined;
          fitAndResize();
        }, 100);
      });
      observer.observe(container);
      document.addEventListener("visibilitychange", handleVisibilityChange);
      window.addEventListener("pageshow", handlePageShow);
      disposeMountedSession = () => {
        cancelResizeStabilization();
        observer.disconnect();
        document.removeEventListener("visibilitychange", handleVisibilityChange);
        window.removeEventListener("pageshow", handlePageShow);
        unsubscribeInput();
        unsubscribe();
        session.close();
      };
      session.connect();
    }).catch((error: unknown) => {
      if (disposed) return;
      setState((current) => ({
        ...current,
        connection: "failed",
        inputAvailable: false,
        message: error instanceof Error
          ? error.message
          : "The terminal renderer could not be initialized.",
      }));
    });
    return () => {
      disposed = true;
      activateSessionRef.current = () => undefined;
      disposeMountedSession?.();
      emulator.dispose();
      sessionRef.current = undefined;
      if (emulatorRef.current === emulator) emulatorRef.current = undefined;
    };
  }, [api, colorScheme, producerId, terminal.incarnationId, terminal.terminalId, visible]);

  useEffect(() => {
    if (active) activateSessionRef.current();
  }, [active]);

  useEffect(() => {
    emulatorRef.current?.setCursorBlink(preferences.cursorBlink);
  }, [preferences.cursorBlink]);

  useEffect(() => {
    const emulator = emulatorRef.current;
    if (!emulator || appliedFontSizeRef.current === preferences.fontSize) return;
    const size = emulator.setFontSize(preferences.fontSize);
    appliedFontSizeRef.current = preferences.fontSize;
    const session = sessionRef.current;
    if (!session) return;
    if (session.snapshot.inputAvailable) {
      session.resize(size.columns, size.rows);
    } else {
      emulator.resize(session.snapshot.columns, session.snapshot.rows);
    }
  }, [preferences.fontSize]);

  const moveSearch = (direction: -1 | 1) => {
    if (!isSearchQueryReady(search)) return;
    const result = emulatorRef.current?.find(search, direction);
    if (result) setSearchResult(result);
  };
  const updateSearch = (query: string) => {
    setSearch(query);
    if (!isSearchQueryReady(query)) {
      setSearchResult(undefined);
      emulatorRef.current?.clearSelection();
      return;
    }
    setSearchResult(emulatorRef.current?.find(query, 1));
  };
  function openTranscript() {
    setTranscript(emulatorRef.current?.transcript() ?? "");
    setShowTranscript(true);
  }

  return (
    <section ref={panelRef} className="terminal-panel" aria-label={`${terminal.displayName} terminal`} data-terminal-role={state.role}>
      <div className="sr-only" role="status" aria-atomic="true">
        <span>{terminalConnectionLabel(state)}</span>
        <span>{state.role === "controller" ? "You have control" : "Read only"}</span>
      </div>
      {uiTerminalIdentity === terminalIdentity && searchOpen ? (
        <div
          className="thread-find-bar terminal-panel-search"
          data-open="true"
          role="search"
          aria-label="Search terminal"
        >
          <FindBarControl
            id={`terminal-find-${terminal.terminalId}`}
            inputRef={searchInputRef}
            inputLabel="Search terminal text"
            placeholder="Find in terminal"
            interactive
            query={search}
            countLabel={isSearchQueryReady(search)
              ? `${searchResult?.index ?? 0} of ${searchResult?.total ?? 0}`
              : ""}
            canMove={searchResult?.found === true}
            onQueryChange={updateSearch}
            onMove={moveSearch}
            onClose={closeSearch}
          />
        </div>
      ) : null}
      {lifecycleError ? (
        <p className="terminal-panel-notice" role="alert">{lifecycleError}</p>
      ) : null}
      {state.message ? <p className="terminal-panel-notice" role="status">{state.message}</p> : null}
      {state.retryInputAvailable ? (
        <Button variant="outline" size="sm" onClick={() => sessionRef.current?.retryNotSentInput()}>
          Retry unsent input
        </Button>
      ) : null}
      {state.uncertainInputSeq !== undefined ? (
        <Button
          variant="outline"
          size="sm"
          disabled={
            state.connection !== "ready" ||
            !state.caughtUp ||
            state.role !== "controller"
          }
          onClick={() => sessionRef.current?.discardUnconfirmedInput()}
        >
          Discard unconfirmed input
        </Button>
      ) : null}
      {state.connection === "reconnecting" ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => sessionRef.current?.retryConnection()}
        >
          Reconnect now
        </Button>
      ) : null}
      <div
        key={terminalIdentity}
        ref={containerRef}
        className="terminal-panel-emulator"
        aria-hidden="true"
        data-restored={
          uiTerminalIdentity === terminalIdentity && state.caughtUp
            ? "true"
            : "false"
        }
        onPointerDown={(event) => {
          if (!showBottomControls || event.pointerType === "mouse") return;
          touchStartRef.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerCancel={() => {
          touchStartRef.current = undefined;
        }}
        onPointerUp={(event) => {
          const start = touchStartRef.current;
          touchStartRef.current = undefined;
          if (
            !start ||
            !state.inputAvailable ||
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8
          )
            return;
          // ghostty-web focuses its hidden textarea from a later touchend
          // listener. Reassert the visible native field after that handler.
          window.setTimeout(() => {
            commandInputRef.current?.focus({ preventScroll: true });
          }, 0);
        }}
      />
      {showBottomControls ? (
        <div className="terminal-panel-bottom-controls">
          <TerminalMobileControls
            inputAvailable={state.inputAvailable}
            sendInput={(data) => sessionRef.current?.sendInput(data) ?? false}
            focusTerminal={() => emulatorRef.current?.focus()}
            blurTerminal={() => emulatorRef.current?.blur()}
            isTerminalFocused={() => emulatorRef.current?.hasFocus() ?? false}
            commandInputRef={commandInputRef}
          />
        </div>
      ) : null}
      {uiTerminalIdentity === terminalIdentity && showTranscript ? (
        <aside className="terminal-transcript" aria-label="Terminal transcript">
          <header>
            <h3>Terminal transcript</h3>
            <Button variant="ghost" size="icon-sm" aria-label="Close transcript" onClick={() => setShowTranscript(false)}><X aria-hidden="true" /></Button>
          </header>
          <form
            role="search"
            aria-label="Search terminal transcript"
            onSubmit={(event) => {
              event.preventDefault();
              const normalizedQuery = transcriptSearchDraft.trim();
              setTranscriptSearch(
                isSearchQueryReady(normalizedQuery) ? normalizedQuery : "",
              );
            }}
          >
            <label htmlFor={`terminal-transcript-search-${terminal.terminalId}`}>
              Search transcript text
            </label>
            <input
              id={`terminal-transcript-search-${terminal.terminalId}`}
              value={transcriptSearchDraft}
              onChange={(event) => {
                const nextDraft = event.target.value;
                setTranscriptSearchDraft(nextDraft);
                if (!isSearchQueryReady(nextDraft.trim())) {
                  setTranscriptSearch("");
                }
              }}
            />
            <Button type="submit" variant="outline" size="sm">Search</Button>
          </form>
          {transcriptSearch ? (
            <p role="status">
              {transcriptMatchCount(transcript, transcriptSearch)} match{transcriptMatchCount(transcript, transcriptSearch) === 1 ? "" : "es"}
            </p>
          ) : null}
          <pre role="document" aria-label={`${terminal.displayName} terminal transcript text`} tabIndex={0}>
            {transcript
              ? highlightedTranscript(transcript, transcriptSearch)
              : "No terminal text is available."}
          </pre>
        </aside>
      ) : null}
    </section>
  );
});

function desktopTerminalFocusAllowed(): boolean {
  return !window.matchMedia("(max-width: 720px), (pointer: coarse)").matches;
}

function transcriptMatchCount(transcript: string, query: string): number {
  if (!query) return 0;
  const haystack = transcript.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  let count = 0;
  let offset = 0;
  while ((offset = haystack.indexOf(needle, offset)) !== -1) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function highlightedTranscript(transcript: string, query: string): React.ReactNode {
  if (!query) return transcript;
  const lowerTranscript = transcript.toLocaleLowerCase();
  const lowerQuery = query.toLocaleLowerCase();
  const parts: React.ReactNode[] = [];
  let offset = 0;
  let match = lowerTranscript.indexOf(lowerQuery);
  while (match !== -1) {
    parts.push(transcript.slice(offset, match));
    parts.push(<mark key={`${match}:${parts.length}`}>{transcript.slice(match, match + query.length)}</mark>);
    offset = match + query.length;
    match = lowerTranscript.indexOf(lowerQuery, offset);
  }
  parts.push(transcript.slice(offset));
  return parts;
}

function initialSnapshot(terminal: TerminalResource): TerminalSessionSnapshot {
  return {
    connection: "idle",
    role: "observer",
    controlRequestPending: false,
    controllerEpoch: 0,
    lifecycle: terminal.lifecycle,
    lifecycleRevision: terminal.lifecycleRevision,
    rows: terminal.rows,
    columns: terminal.columns,
    caughtUp: false,
    inputAvailable: false,
    retryInputAvailable: false,
    queuedInputCount: 0,
    queuedInputBytes: 0,
    inputQueueOverflowed: false,
  };
}

export function terminalConnectionLabel(state: TerminalSessionSnapshot): string {
  if (state.connection === "ready") return state.lifecycle === "running" ? "Connected" : state.lifecycle;
  switch (state.connection) {
    case "idle": return "Not connected";
    case "authorizing": return "Authorizing";
    case "connecting": return "Connecting";
    case "restoring": return "Restoring history";
    case "reconnecting": return "Reconnecting";
    case "closed": return "Panel closed";
    case "failed": return "Connection failed";
  }
}
