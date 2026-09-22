// @vitest-environment jsdom
vi.mock("./TurnUsageAction.js", () => ({ TurnUsageAction: () => null }));

import { OperationOverlayHost } from "../../operations/OperationOverlay.js";
vi.mock("../../operations/thread-readiness.js", () => ({ waitForOperationThreadReady: vi.fn(async () => undefined), setOperationThreadRegistry: vi.fn() }));

import { getBlockingOperation } from "../../operations/blocking-operation.js";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { TurnForkDivider } from "./TurnForkDivider.js";

beforeEach(() => { render(<OperationOverlayHost />); });

afterEach(() => {
  getBlockingOperation()?.cancel();
  cleanup();
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
    expect(screen.queryByRole("button", { name: "Turn usage and cost" })).toBeNull();

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
});
