// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRunHistory } from "./RunHistory.js";
import { installThreadPanelOpenRequestListener } from "../../workspace-panels/thread-panel-navigation.js";

afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("AutomationRunHistory", () => {
  it("opens a result thread with the click-time panel presentation", () => {
    const onOpen = vi.fn();
    const removeOpenListener = installThreadPanelOpenRequestListener(
      window,
      onOpen,
    );
    render(
      <AutomationRunHistory
        history={[
          {
            id: "run-1",
            occurrence: "manual",
            state: "completed",
            scheduledFor: "2026-08-28T12:00:00.000Z",
            runMode: "same_thread",
            coalescedCount: 0,
            resultThreadId: "thread-result",
          },
        ]}
        saving={false}
        onResolveRun={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open result thread" }),
      { shiftKey: true },
    );

    expect(onOpen).toHaveBeenCalledWith({
      threadId: "thread-result",
      presentation: "single",
    });
    expect(window.location.pathname).toBe("/threads/thread-result");
    removeOpenListener();
  });
});
