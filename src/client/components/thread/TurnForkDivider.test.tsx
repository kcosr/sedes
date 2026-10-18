// @vitest-environment jsdom
vi.mock("./TurnUsageAction.js", () => ({ TurnUsageAction: () => null }));
const voiceContext = vi.hoisted(() => ({ store: null as NativeVoiceStore | null }));
vi.mock("../../voice/VoiceProvider.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../voice/VoiceProvider.js")>(),
  useNativeVoice: () => voiceContext.store,
}));

import { OperationOverlayHost } from "../../operations/OperationOverlay.js";
vi.mock("../../operations/thread-readiness.js", () => ({ waitForOperationThreadReady: vi.fn(async () => undefined), setOperationThreadRegistry: vi.fn() }));

import { getBlockingOperation } from "../../operations/blocking-operation.js";

import {
  act,
  cleanup,
  fireEvent,
  isInaccessible,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { NativeVoiceStore } from "../../voice/NativeVoiceStore.js";
import { fakeVoicePlugin, VOICE_CONNECTION, voiceSettings, voiceSnapshot } from "../../voice/native-voice-test-fixture.js";
import { TurnForkDivider } from "./TurnForkDivider.js";
import { TOUCH_DENSITY_QUERY } from "../../app/use-touch-density.js";
import { ChatViewVisibilityContext } from "./chat-view-visibility.js";

beforeEach(() => { render(<OperationOverlayHost />); });

afterEach(() => {
  getBlockingOperation()?.dismiss();
  cleanup();
  voiceContext.store?.dispose();
  voiceContext.store = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

const turn = {
  id: "turn-1",
  revision: 3,
  status: "completed" as const,
  endedBy: "agent_settled" as const,
  completedAt: "2026-07-30T15:00:00.000Z",
  orderedItemIds: [],
};

const capability = {
  sourceTurnId: "turn-1",
  expectedTurnRevision: 3,
  available: true,
};

describe("TurnForkDivider", () => {
  function touchLayout() {
    vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
      matches: query === TOUCH_DENSITY_QUERY,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
  }

  function forkProps() {
    const forkTurn = vi.fn(async () => ({ status: "created" as const, childThreadId: "child-1" }));
    return {
      turn,
      capability,
      attempt: undefined,
      connected: true,
      authoritative: true,
      store: { threadId: "thread-1", forkTurn } as unknown as ThreadClientStore,
    };
  }

  it("requires touch confirmation, cancels without a mutation, and confirms exactly one fork", async () => {
    touchLayout();
    const props = forkProps();
    render(<TurnForkDivider {...props} />);
    const opener = screen.getByRole("button", { name: /Fork from here/ });
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "Fork from this point?" })).toHaveAccessibleDescription(
      "Creates a new thread through this response, keeping this conversation.",
    );
    expect(props.store.forkTurn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog", { name: "Fork from this point?" })).toBeNull();
    await waitFor(() => expect(opener).toHaveFocus());
    expect(props.store.forkTurn).not.toHaveBeenCalled();

    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Fork from this point?" })).toBeNull();
    expect(props.store.forkTurn).not.toHaveBeenCalled();

    fireEvent.click(opener);
    const confirm = screen.getByRole("button", { name: "Fork" });
    act(() => {
      fireEvent.click(confirm);
      fireEvent.click(confirm);
    });
    expect(props.store.forkTurn).toHaveBeenCalledExactlyOnceWith(capability, { restart: false });
    await waitFor(() => expect(window.location.pathname).toBe("/threads/child-1"));
  });

  it("keeps desktop inline forking immediate", async () => {
    const props = forkProps();
    render(<TurnForkDivider {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Fork from here/ }));
    expect(screen.queryByRole("dialog", { name: "Fork from this point?" })).toBeNull();
    expect(props.store.forkTurn).toHaveBeenCalledExactlyOnceWith(capability, { restart: false });
    await waitFor(() => expect(window.location.pathname).toBe("/threads/child-1"));
  });

  it("discards a confirmation when its retained chat panel becomes hidden", () => {
    touchLayout();
    const props = forkProps();
    const content = (visible: boolean) => <ChatViewVisibilityContext.Provider value={visible}>
      <TurnForkDivider {...props} />
    </ChatViewVisibilityContext.Provider>;
    const view = render(content(true));
    fireEvent.click(screen.getByRole("button", { name: /Fork from here/ }));
    expect(screen.getByRole("dialog", { name: "Fork from this point?" })).toBeVisible();
    view.rerender(content(false));
    expect(screen.queryByRole("dialog", { name: "Fork from this point?" })).toBeNull();
    view.rerender(content(true));
    expect(screen.queryByRole("dialog", { name: "Fork from this point?" })).toBeNull();
    expect(props.store.forkTurn).not.toHaveBeenCalled();
  });

  it.each([
    { connected: false },
    { authoritative: false },
    { capability: { ...capability, available: false, unavailableReason: { text: "Forking is unavailable." } } },
    { attempt: { phase: "pending" as const } },
    { attempt: { phase: "recovery_required" as const, childThreadId: "child-2", retryable: true, diagnostic: "Recovery required." } },
  ])("rechecks current fork authority at confirmation: %j", async (changed) => {
    touchLayout();
    const props = forkProps();
    const view = render(<TurnForkDivider {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /Fork from here/ }));
    view.rerender(<TurnForkDivider {...props} {...changed} />);
    const confirm = screen.getByRole("button", { name: "Fork" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(props.store.forkTurn).not.toHaveBeenCalled();
    view.rerender(<TurnForkDivider {...props} copyText="Another message streamed." capability={{ ...capability }} />);
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));
    expect(props.store.forkTurn).toHaveBeenCalledExactlyOnceWith(capability, { restart: false });
    await waitFor(() => expect(window.location.pathname).toBe("/threads/child-1"));
  });

  it.each(["thread", "turn", "revision", "status"] as const)(
    "discards the confirmation when its source %s changes", (change) => {
      touchLayout();
      const props = forkProps();
      const view = render(<TurnForkDivider {...props} />);
      fireEvent.click(screen.getByRole("button", { name: /Fork from here/ }));
      const nextStore = { ...props.store, threadId: "thread-2", forkTurn: vi.fn() } as unknown as ThreadClientStore;
      view.rerender(<TurnForkDivider
        {...props}
        store={change === "thread" ? nextStore : props.store}
        turn={change === "turn" ? { ...turn, id: "turn-2" } : change === "status" ? { ...turn, status: "in_progress" } : turn}
        capability={change === "revision" ? { ...capability, expectedTurnRevision: 4 } : capability}
      />);
      expect(screen.queryByRole("dialog", { name: "Fork from this point?" })).toBeNull();
      expect(props.store.forkTurn).not.toHaveBeenCalled();
      expect(nextStore.forkTurn).not.toHaveBeenCalled();
      view.rerender(<TurnForkDivider {...props} />);
      expect(screen.queryByRole("dialog", { name: "Fork from this point?" })).toBeNull();
    },
  );

  it("shows only the rate outside the right-side controls, independently of recorded usage", () => {
    const props = {
      turn,
      turnNumber: 1,
      capability,
      attempt: undefined,
      connected: true,
      authoritative: true,
      store: { forkTurn: vi.fn() } as unknown as ThreadClientStore,
    };
    const view = render(
      <TurnForkDivider
        {...props}
        turn={{ ...turn, throughput: { outputTokens: 423, requestDurationMs: 10_000 } }}
      />,
    );
    const rate = screen.getByText("42.3 tok/s");
    expect(rate).toHaveClass("turn-throughput");
    expect(rate.closest(".turn-fork-controls")).toBeNull();
    expect(rate.parentElement?.firstElementChild).toBe(rate);
    expect(isInaccessible(rate)).toBe(true);
    const accessibleRate = screen.getByText("42.3 tokens per second");
    expect(accessibleRate).toHaveClass("sr-only");
    expect(isInaccessible(accessibleRate)).toBe(false);
    expect(rate.nextElementSibling).toBe(accessibleRate);
    expect(screen.queryByText(/elapsed/i)).not.toBeInTheDocument();
    view.rerender(<TurnForkDivider {...props} />);
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();
    expect(screen.queryByText("42.3 tokens per second")).not.toBeInTheDocument();
    view.rerender(<TurnForkDivider {...props} turn={{ ...turn, status: "in_progress" }} />);
    expect(view.container.querySelector("footer")).toBeNull();
  });

  it("offers only the bookmark action in a running turn footer", () => {
    const setTurnBookmarked = vi.fn(async () => undefined);
    const store = { forkTurn: vi.fn(), setTurnBookmarked } as unknown as ThreadClientStore;
    const preview = { userPreview: "Question", assistantPreview: null, responseState: "no_response" as const };
    const props = { turn: { ...turn, status: "in_progress" as const }, capability, attempt: undefined, connected: true, authoritative: true, store, copyText: "Partial reply", bookmark: { turnId: turn.id, preview, bookmarked: false, disabled: false, pending: false, store } };
    const view = render(<TurnForkDivider {...props} />);
    const bookmark = screen.getByRole("button", { name: "Bookmark response" });
    expect(bookmark.closest("footer")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Copy response" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Fork from here/ })).toBeNull();
    expect(view.container.querySelector("time")).toBeNull();
    fireEvent.click(bookmark);
    expect(setTurnBookmarked).toHaveBeenCalledWith({ turnId: turn.id, bookmarked: true, preview });
    view.rerender(<TurnForkDivider {...props} bookmark={{ ...props.bookmark, bookmarked: true, pending: true }} />);
    expect(screen.getByRole("button", { name: "Remove response bookmark" })).toBeDisabled();
    expect(view.container.querySelector("footer")).toHaveAttribute("data-active", "true");
  });

  it("shows a measurement added to an already completed turn with the same completion time", () => {
    const props = {
      turn,
      turnNumber: 1,
      capability,
      attempt: undefined,
      connected: true,
      authoritative: true,
      store: { forkTurn: vi.fn() } as unknown as ThreadClientStore,
    };
    const view = render(<TurnForkDivider {...props} />);
    const timestamp = view.container.querySelector("time");
    expect(screen.queryByText(/tok\/s/)).not.toBeInTheDocument();

    view.rerender(
      <TurnForkDivider
        {...props}
        turn={{ ...turn, revision: 4, throughput: { outputTokens: 100, requestDurationMs: 3000 } }}
      />,
    );

    expect(screen.getByText("33.3 tok/s")).toBeVisible();
    expect(view.container.querySelector("time")).toBe(timestamp);
    expect(timestamp).toHaveAttribute("datetime", turn.completedAt);
  });

  it("skips completed-divider work when every prop is unchanged", () => {
    let completedAtReads = 0;
    const observedTurn = new Proxy(turn, {
      get(target, property, receiver) {
        if (property === "completedAt") completedAtReads += 1;
        return Reflect.get(target, property, receiver);
      },
    });
    const store = { forkTurn: vi.fn() } as unknown as ThreadClientStore;
    const props = {
      turn: observedTurn,
      turnNumber: 1,
      capability,
      attempt: undefined,
      connected: true,
      authoritative: true,
      store,
      copyText: "Final answer",
    } as const;
    const view = render(<TurnForkDivider {...props} />);
    const initialCompletedAtReads = completedAtReads;

    view.rerender(<TurnForkDivider {...props} />);

    expect(initialCompletedAtReads).toBeGreaterThan(0);
    expect(completedAtReads).toBe(initialCompletedAtReads);

    view.rerender(
      <TurnForkDivider {...props} copyText="Updated final answer" />,
    );
    expect(completedAtReads).toBeGreaterThan(initialCompletedAtReads);
    expect(
      screen.getByRole("button", { name: "Copy response" }),
    ).toBeInTheDocument();
  });

  it("renders an icon-only action in a compact semantic turn footer", () => {
    const { container } = render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        attempt={undefined}
        connected
        authoritative
        store={{ forkTurn: vi.fn() } as unknown as ThreadClientStore}
      />,
    );

    const action = screen.getByRole("button", { name: /Fork from here/ });
    expect(action.closest("footer")).toHaveClass("turn-fork-footer");
    expect(action).not.toHaveTextContent("Fork from here");
    expect(
      action.querySelector(".lucide-split.fork-split-icon"),
    ).not.toBeNull();
    expect(container.querySelector(".turn-fork-rule")).toBeNull();
    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      turn.completedAt,
    );
  });

  it("updates fork authority without reformatting an unchanged completion time", () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    const format = vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
      function (locales, options) {
        return new OriginalDateTimeFormat(locales, options);
      },
    );
    const props = {
      turn,
      turnNumber: 1,
      capability,
      attempt: undefined,
      connected: true,
      authoritative: true,
      store: { forkTurn: vi.fn() } as unknown as ThreadClientStore,
      copyText: "Final answer",
    } as const;
    const view = render(<TurnForkDivider {...props} />);
    const action = screen.getByRole("button", { name: /Fork from here/ });
    const initialTitle = view.container.querySelector("time")!.title;
    expect(format).toHaveBeenCalledTimes(2);

    view.rerender(
      <TurnForkDivider
        {...props}
        capability={{
          ...capability,
          available: false,
          unavailableReason: { text: "This boundary is not forkable." },
        }}
      />,
    );
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveAccessibleDescription("This boundary is not forkable.");

    view.rerender(<TurnForkDivider {...props} connected={false} />);
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveAccessibleDescription(
      "Wait for the thread to reconnect and receive authoritative history.",
    );
    view.rerender(<TurnForkDivider {...props} authoritative={false} />);
    expect(action).toHaveAttribute("aria-disabled", "true");

    view.rerender(
      <TurnForkDivider
        {...props}
        turn={{ ...turn, revision: 4 }}
        capability={{ ...capability, expectedTurnRevision: 4 }}
        copyText="Updated final answer"
      />,
    );
    expect(action).toHaveAttribute("aria-disabled", "false");
    expect(format).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector("time")).toHaveAttribute("title", initialTitle);

    const completedAt = "2026-07-30T16:00:00.000Z";
    view.rerender(<TurnForkDivider {...props} turn={{ ...turn, completedAt }} />);
    expect(format).toHaveBeenCalledTimes(4);
    expect(view.container.querySelector("time")).toHaveAttribute("datetime", completedAt);
    expect(view.container.querySelector("time")!.title).not.toBe(initialTitle);
  });

  it("keeps hook order stable when a live turn completes in place", () => {
    const store = { forkTurn: vi.fn() } as unknown as ThreadClientStore;
    const view = render(
      <TurnForkDivider
        turn={{ ...turn, status: "in_progress" as const }}
        turnNumber={1}
        capability={capability}
        attempt={undefined}
        connected
        authoritative
        store={store}
      />,
    );
    expect(view.container).toBeEmptyDOMElement();

    // Completing the turn adds fork controls without changing hook order. It must not
    // change the number of hooks the component mounts.
    view.rerender(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        attempt={undefined}
        connected
        authoritative
        copyText="Final answer"
        store={store}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Copy response" }),
    ).toBeInTheDocument();
  });

  it("copies only the supplied assistant response", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        copyText={"Final answer\n\n```ts\nconst answer = 42;\n```"}
        attempt={undefined}
        connected
        authoritative
        store={{ forkTurn: vi.fn() } as unknown as ThreadClientStore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "Final answer\n\n```ts\nconst answer = 42;\n```",
      ),
    );
    expect(
      await screen.findByRole("button", { name: "Response copied" }),
    ).toBeInTheDocument();
  });

  it("shows pending work without allowing duplicate activation", () => {
    const forkTurn = vi.fn();
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        attempt={{ phase: "pending" }}
        connected
        authoritative
        store={{ forkTurn } as unknown as ThreadClientStore}
      />,
    );

    const button = screen.getByRole("button", { name: /Creating fork/ });
    expect(button).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(button);
    expect(forkTurn).not.toHaveBeenCalled();
  });

  it("offers the same fork retry only for a retryable request failure", () => {
    const forkTurn = vi.fn(async () => ({
      status: "created" as const,
      childThreadId: "child-1",
    }));
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        attempt={{
          phase: "request_failed",
          retryable: true,
          diagnostic: "Connection lost.",
        }}
        connected
        authoritative
        store={{ forkTurn } as unknown as ThreadClientStore}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry same fork" }));
    expect(forkTurn).toHaveBeenCalledWith(capability, { restart: false });
  });

  it("locks and dismisses a deterministic nonretryable request failure", () => {
    const forkTurn = vi.fn();
    const clearForkAttempt = vi.fn();
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        attempt={{
          phase: "request_failed",
          retryable: false,
          diagnostic: "Fork prerequisites changed.",
        }}
        connected
        authoritative
        store={{ forkTurn, clearForkAttempt } as unknown as ThreadClientStore}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Fork prerequisites changed.",
    );
    expect(
      screen.queryByRole("button", { name: "Retry same fork" }),
    ).toBeNull();
    const primary = screen.getByRole("button", { name: /Fork from here/ });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    expect(primary).toHaveAccessibleDescription("Fork prerequisites changed.");
    expect(primary).toHaveAttribute("title", "Fork prerequisites changed.");
    fireEvent.click(primary);
    expect(forkTurn).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss fork status" }),
    );
    expect(clearForkAttempt).toHaveBeenCalledWith(turn.id);
  });

  it.each([true, false])("offers a new fork after an abort only when it could succeed (restartable=%s)", (restartable) => {
    const clearForkAttempt = vi.fn();
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        attempt={{
          phase: "aborted",
          childThreadId: "child-1",
          diagnostic: "Claude did not start the fork.",
          restartable,
        }}
        connected
        authoritative
        store={{ forkTurn: vi.fn(), clearForkAttempt } as unknown as ThreadClientStore}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Claude did not start the fork.");
    expect(screen.queryByRole("button", { name: /Start a new fork/ }) !== null).toBe(restartable);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss fork status" }));
    expect(clearForkAttempt).toHaveBeenCalledWith(turn.id);
  });

  it("keeps uncertain work on the source and exposes recovery without duplicating it", () => {
    const forkTurn = vi.fn(async () => ({
      status: "created" as const,
      childThreadId: "child-1",
    }));
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={capability}
        attempt={{
          phase: "recovery_required",
          childThreadId: "child-1",
          retryable: false,
          diagnostic: "Provider outcome is unknown.",
        }}
        connected
        authoritative
        store={
          {
            forkTurn,
            clearForkAttempt: vi.fn(),
          } as unknown as ThreadClientStore
        }
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Retry same fork" }),
    ).toBeNull();
    const primary = screen.getByRole("button", { name: /Fork from here/ });
    expect(primary).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(primary);
    expect(
      screen.queryByRole("button", { name: "Dismiss fork status" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Open recovery thread" }),
    );
    expect(window.location.pathname).toBe("/threads/child-1");
    expect(forkTurn).not.toHaveBeenCalled();
  });

  it.each(["in_progress", "interrupted", "failed"] as const)(
    "does not render fork chrome for a %s turn",
    (status) => {
      const forkTurn = vi.fn();
      const { container } = render(
        <TurnForkDivider
          turn={{
            ...turn,
            status,
            completedAt: undefined,
            endedBy: status === "in_progress" ? undefined : status,
          }}
          turnNumber={7}
          capability={{
            ...capability,
            available: false,
            unavailableReason: {
              text: "Only a successfully completed turn can be forked.",
            },
          }}
          attempt={undefined}
          connected
          authoritative
          store={{ forkTurn } as unknown as ThreadClientStore}
        />,
      );

      expect(screen.queryByRole("button", { name: "Turn usage and cost" })).toBeNull();
      expect(
        screen.queryByRole("button", { name: /Fork from here/ }),
      ).toBeNull();
      expect(forkTurn).not.toHaveBeenCalled();
      if (status === "in_progress") expect(container).toBeEmptyDOMElement();
      else expect(container.querySelector("footer")).toBeInTheDocument();
    },
  );

  it("keeps completed-turn time and copy available while fork is unavailable", () => {
    const forkTurn = vi.fn();
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={{
          ...capability,
          available: false,
          unavailableReason: { text: "This boundary is not forkable." },
        }}
        copyText="Final answer"
        attempt={undefined}
        connected
        authoritative
        store={{ forkTurn } as unknown as ThreadClientStore}
      />,
    );

    expect(document.querySelector("time")).toHaveAttribute(
      "datetime",
      turn.completedAt,
    );
    expect(
      screen.getByRole("button", { name: "Copy response" }),
    ).toBeInTheDocument();
    const action = screen.getByRole("button", { name: /Fork from here/ });
    expect(action).toHaveAttribute("aria-disabled", "true");
    expect(action).toHaveAccessibleDescription(
      "This boundary is not forkable.",
    );
    fireEvent.click(action);
    expect(forkTurn).not.toHaveBeenCalled();
  });

  it("preserves durable recovery controls when capability availability is lost", () => {
    render(
      <TurnForkDivider
        turn={turn}
        turnNumber={1}
        capability={undefined}
        attempt={{
          phase: "recovery_required",
          childThreadId: "child-recovery",
          retryable: false,
          diagnostic: "Provider outcome is unknown.",
        }}
        connected
        authoritative
        store={
          {
            forkTurn: vi.fn(),
            clearForkAttempt: vi.fn(),
          } as unknown as ThreadClientStore
        }
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Provider outcome is unknown.",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Open recovery thread" }),
    );
    expect(window.location.pathname).toBe("/threads/child-recovery");
  });

  it("uses a truthful nonordinal label when the absolute turn number is unknown", () => {
    render(
      <TurnForkDivider
        turn={{ ...turn, completedAt: undefined }}
        capability={capability}
        attempt={undefined}
        connected
        authoritative
        store={{ forkTurn: vi.fn() } as unknown as ThreadClientStore}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: /Fork from here.*Completed turn/,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Turn 1")).toBeNull();
  });

  it("places Play response aloud directly after Copy response on every ended turn with reply text", async () => {
    const plugin = fakeVoicePlugin();
    plugin.plugin.setConnection.mockResolvedValue(voiceSnapshot({ ready: true, readiness: "ready", phase: "idle",
      settings: voiceSettings({ audioMode: "speak" }), speech: { ...voiceSnapshot().speech, credentialConfigured: true } }));
    const voice = new NativeVoiceStore(plugin.asPlugin, VOICE_CONNECTION, vi.fn());
    await voice.initialize();
    voiceContext.store = voice;
    const store = { threadId: "thread-1", forkTurn: vi.fn(), readTurnReplySpeech: vi.fn() } as unknown as ThreadClientStore;
    const props = { turnNumber: 1, capability, attempt: undefined, connected: true, authoritative: true, store };
    const buttons = () => screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"));
    // A live turn completing in place mounts the speaker without changing the footer's hook order.
    const view = render(<TurnForkDivider {...props} turn={{ ...turn, status: "in_progress" as const }} copyText="Final answer" />);
    expect(view.container).toBeEmptyDOMElement();
    view.rerender(<TurnForkDivider {...props} turn={turn} copyText="Final answer" />);
    expect(buttons()).toEqual(["Copy response", "Play response aloud", expect.stringMatching(/^Fork from here, /u)]);
    for (const status of ["failed", "interrupted"] as const) {
      view.rerender(<TurnForkDivider {...props} turn={{ ...turn, status }} copyText="Partial answer" />);
      expect(buttons()).toEqual(["Copy response", "Play response aloud"]);
    }
    view.rerender(<TurnForkDivider {...props} turn={turn} />);
    expect(buttons()).toEqual([expect.stringMatching(/^Fork from here, /u)]);
    // Voice Off removes the speaker from the footer instead of greying it out.
    view.rerender(<TurnForkDivider {...props} turn={turn} copyText="Final answer" />);
    act(() => plugin.emit("stateChanged", voiceSnapshot({ stateRevision: 2, settings: voiceSettings({ audioMode: "off" }),
      speech: { ...voiceSnapshot().speech, credentialConfigured: true } })));
    expect(buttons()).toEqual(["Copy response", expect.stringMatching(/^Fork from here, /u)]);
  });
});
