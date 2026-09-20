// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../api/EventStreamTransport.js";
import { NavigationControlsContext } from "../app/navigation-controls.js";
import {
  ApplicationConnectionStatus,
  SidebarNavTrigger,
} from "./SidebarNavTrigger.js";
import {
  CONNECTION_INDICATOR_DELAY_MILLISECONDS,
} from "../app/use-delayed-connection-status.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function renderTrigger(connection: ConnectionState): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      media: "(max-width: 819px)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
  render(
    <NavigationControlsContext.Provider
      value={{
        openDrawer: vi.fn(),
        toggleDrawer: vi.fn(),
        toggleSidebar: vi.fn(),
        sidebarCollapsed: false,
        drawerOpen: false,
        connection,
        triggerRef: createRef<HTMLButtonElement>(),
      }}
    >
      <SidebarNavTrigger />
    </NavigationControlsContext.Provider>,
  );
}

describe("SidebarNavTrigger connection status", () => {
  it("does not clear the retained workspace trigger when a replaced pane trigger unmounts", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    const triggerRef = createRef<HTMLButtonElement>();
    const controls = {
      openDrawer: vi.fn(),
      toggleDrawer: vi.fn(),
      toggleSidebar: vi.fn(),
      sidebarCollapsed: false,
      drawerOpen: false,
      connection: "connected" as const,
      triggerRef,
    };
    const settings = render(
      <NavigationControlsContext.Provider value={controls}>
        <SidebarNavTrigger />
      </NavigationControlsContext.Provider>,
    );
    const settingsTrigger = triggerRef.current;
    const workspace = render(
      <NavigationControlsContext.Provider value={controls}>
        <SidebarNavTrigger />
      </NavigationControlsContext.Provider>,
    );
    const workspaceTrigger = triggerRef.current;
    expect(workspaceTrigger).not.toBe(settingsTrigger);
    settings.unmount();
    expect(triggerRef.current).toBe(workspaceTrigger);
    triggerRef.current?.focus();
    expect(workspaceTrigger).toHaveFocus();
    workspace.unmount();
    expect(triggerRef.current).toBeNull();
  });

  it("keeps a healthy application connection silent", () => {
    renderTrigger("connected");

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Hide sidebar" })).toBeEnabled();
  });

  it.each([
    ["reconnecting", "Application reconnecting"],
    ["disconnected", "Application disconnected"],
  ] as const)(
    "delays the %s application status for one second",
    (connection, label) => {
      vi.useFakeTimers();
      render(<ApplicationConnectionStatus connection={connection} />);

      expect(screen.queryByRole("img")).toBeNull();
      act(() => {
        vi.advanceTimersByTime(
          CONNECTION_INDICATOR_DELAY_MILLISECONDS - 1,
        );
      });
      expect(screen.queryByRole("img")).toBeNull();

      act(() => vi.advanceTimersByTime(1));
      expect(screen.getByRole("img", { name: label })).toHaveAttribute(
        "data-connection",
        connection,
      );
    },
  );

  it("cancels the reconnecting status when the connection recovers", () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ApplicationConnectionStatus connection="reconnecting" />,
    );

    rerender(<ApplicationConnectionStatus connection="connected" />);
    act(() => {
      vi.advanceTimersByTime(
        CONNECTION_INDICATOR_DELAY_MILLISECONDS,
      );
    });

    expect(screen.queryByRole("img")).toBeNull();
  });

  it("does not render outside the application shell", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(<SidebarNavTrigger />);

    expect(screen.queryByRole("img")).toBeNull();
  });
});
