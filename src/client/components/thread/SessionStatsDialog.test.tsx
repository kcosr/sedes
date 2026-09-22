// @vitest-environment jsdom

import { createRef } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionStatsDialog } from "./SessionStatsDialog.js";

import { UsageQueryCache } from "../../stores/UsageQueryCache.js";
import { usageReport } from "../../stores/usage-test-fixture.js";
const caches: UsageQueryCache[] = [];
function cache() {
  const result = new UsageQueryCache("sedes-thread-1", { getUsage: vi.fn().mockResolvedValue(usageReport({ threadId: "sedes-thread-1", turnId: null, measurementScope: "session", turnState: null, state: "unavailable" })) });
  caches.push(result); return result;
}
afterEach(() => { cleanup(); caches.splice(0).forEach(value => value.dispose()); });

describe("SessionStatsDialog", () => {
  it("shows Saved Agent origin only in stats and marks a missing Agent deleted", () => {
    const view = render(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        createdWithAgent={{
          id: "11111111-1111-4111-8111-111111111111",
          revision: 4,
          name: { text: "Careful Agent" },
          available: true,
        }}
        executionWorkspace={{ kind: "direct" }}
        environmentKind="local"
        usage={{}}
      />,
    );

    expect(screen.getByRole("heading", { name: "Origin" })).toBeVisible();
    expect(screen.getByText("Careful Agent · revision 4")).toBeVisible();
    expect(screen.queryByText(/deleted/i)).not.toBeInTheDocument();

    view.rerender(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        createdWithAgent={{
          id: "11111111-1111-4111-8111-111111111111",
          revision: 4,
          name: { text: "Careful Agent" },
          available: false,
        }}
        executionWorkspace={{ kind: "direct" }}
        environmentKind="local"
        usage={{}}
      />,
    );
    expect(
      screen.getByText("Careful Agent · revision 4 (deleted)"),
    ).toBeVisible();
  });

  it("renders only normalized usage values that were reported", () => {
    render(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        backendSessionId="backend-session-1"
        executionWorkspace={{ kind: "direct" }}
        environmentKind="local"
        usage={{
          context: { usedTokens: 2_000, windowTokens: 10_000, percent: 20 },
          counters: { userMessages: 2, assistantMessages: 3, toolCalls: 4 },
        }}
      />,
    );

    expect(screen.getByText("2,000 / 10,000")).toBeVisible();
    expect(screen.getByText("20.00%")).toBeVisible();
    expect(screen.queryByText("Cache read")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recorded session usage" })).toBeVisible();
  });

  it("shows an explicit empty state instead of fabricated zeroes", () => {
    render(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        executionWorkspace={{ kind: "direct" }}
        environmentKind="local"
        usage={{}}
      />,
    );
    expect(
      screen.getByText("Live context and transcript counters are unavailable."),
    ).toBeVisible();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("renders transcript counters and omits an undefined zero-window percentage", () => {
    render(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        executionWorkspace={{ kind: "direct" }}
        environmentKind="local"
        usage={{
          counters: { userMessages: 3 },
          context: { usedTokens: 0, windowTokens: 0 },
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "Messages" })).toBeVisible();
    expect(screen.getByText("3")).toBeVisible();
    expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
    expect(screen.queryByText("Context used")).not.toBeInTheDocument();
  });
  // Radix hands dialog focus back to `Dialog.Trigger`; this dialog is opened
  // from a menu row that unmounts with its menu, so without the explicit
  // target closing would drop focus to <body>.
  it("returns focus to the control the caller named", async () => {
    const trigger = createRef<HTMLButtonElement>();
    const dialog = (open: boolean) => (
      <>
        <button ref={trigger} type="button">
          Thread actions
        </button>
        <SessionStatsDialog
        usageCache={cache()}
          open={open}
          onOpenChange={vi.fn()}
          sedesThreadId="sedes-thread-1"
          executionWorkspace={{ kind: "direct" }}
          environmentKind="local"
          usage={{}}
          returnFocusRef={trigger}
        />
      </>
    );
    const view = render(dialog(true));
    expect(screen.getByRole("dialog")).toBeVisible();
    view.rerender(dialog(false));
    await waitFor(() => expect(trigger.current).toHaveFocus());
  });

  it("shows selectable Sedes and backend IDs and copies each one", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        backendSessionId="backend-session-1"
        executionWorkspace={{ kind: "direct" }}
        environmentKind="local"
        usage={{}}
      />,
    );

    expect(screen.getByText("sedes-thread-1")).toBeVisible();
    expect(screen.getByText("backend-session-1")).toBeVisible();
    screen.getByRole("button", { name: "Copy Sedes thread ID" }).click();
    screen.getByRole("button", { name: "Copy Backend session ID" }).click();
    await waitFor(() => {
      expect(writeText).toHaveBeenNthCalledWith(1, "sedes-thread-1");
      expect(writeText).toHaveBeenNthCalledWith(2, "backend-session-1");
    });
  });

  it("shows and copies environment-native isolated workspace paths", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        executionWorkspace={{
          kind: "isolated",
          workspaceAccess: "writable_clone",
          state: "ready",
          networkProfile: "isolated",
          hostPaths: {
            home: "/allocations/thread-1/home",
            workspace: "/allocations/thread-1/home/workspace",
          },
        }}
        environmentKind="ssh"
        usage={{}}
      />,
    );

    screen.getByRole("button", { name: "Copy SSH host home path" }).click();
    screen
      .getByRole("button", { name: "Copy SSH host workspace path" })
      .click();
    await waitFor(() => {
      expect(writeText).toHaveBeenNthCalledWith(
        1,
        "/allocations/thread-1/home",
      );
      expect(writeText).toHaveBeenNthCalledWith(
        2,
        "/allocations/thread-1/home/workspace",
      );
    });
  });

  it("falls back when the Clipboard API is unavailable", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: execCommand,
    });
    render(
      <SessionStatsDialog
        usageCache={cache()}
        open
        onOpenChange={() => undefined}
        sedesThreadId="sedes-thread-1"
        executionWorkspace={{ kind: "direct" }}
        environmentKind="local"
        usage={{}}
      />,
    );

    screen.getByRole("button", { name: "Copy Sedes thread ID" }).click();
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(document.querySelector("textarea[readonly]")).toBeNull();
  });
});
