// @vitest-environment jsdom

import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionState } from "../api/EventStreamTransport.js";
import { NavigationControlsContext, type NavigationControls } from "../app/navigation-controls.js";
import { ApiClient } from "../api/ApiClient.js";
import { NotificationSettingsStore } from "../stores/NotificationSettingsStore.js";
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

function triggerView(connection: ConnectionState, controls: Partial<NavigationControls> = {}) {
  return (
    <NavigationControlsContext.Provider
      value={{
        openDrawer: vi.fn(),
        toggleDrawer: vi.fn(),
        toggleSidebar: vi.fn(),
        sidebarCollapsed: false,
        drawerOpen: false,
        connection,
        triggerRef: createRef<HTMLButtonElement>(),
        ...controls,
      }}
    >
      <SidebarNavTrigger />
    </NavigationControlsContext.Provider>
  );
}

function renderTrigger(connection: ConnectionState, controls: Partial<NavigationControls> = {}) {
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
  return render(triggerView(connection, controls));
}

describe("SidebarNavTrigger", () => {
  it("shows Home only while a default-thread action is available and invokes the current action", () => {
    const view = renderTrigger("connected");
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();

    const first = vi.fn();
    view.rerender(triggerView("connected", { openDefaultThread: first }));
    const home = screen.getByRole("button", { name: "Home" });
    expect(home).toBeEnabled();
    expect(home).toHaveAttribute("title", "Open default thread");
    fireEvent.click(home);
    expect(first).toHaveBeenCalledOnce();
    expect(home).toBeEnabled();

    const second = vi.fn();
    view.rerender(triggerView("connected", { openDefaultThread: second }));
    fireEvent.click(home);
    expect(second).toHaveBeenCalledOnce();
    expect(first).toHaveBeenCalledOnce();

    view.rerender(triggerView("connected"));
    expect(screen.queryByRole("button", { name: "Home" })).toBeNull();
  });

  it("keeps the connection slot after Sidebar, Notifications, and Home throughout reconnects", () => {
    vi.useFakeTimers();
    const controls = {
      notifications: new NotificationSettingsStore(new ApiClient()),
      openDefaultThread: vi.fn(),
    };
    const view = renderTrigger("connected", controls);
    const sidebar = screen.getByRole("button", { name: "Hide sidebar" });
    const notifications = screen.getByRole("button", { name: "Silence notifications" });
    const home = screen.getByRole("button", { name: "Home" });
    const slot = view.container.querySelector(".sidebar-connection-status-slot");
    expect(slot).toBeEmptyDOMElement();
    expect(home.nextElementSibling).toBe(slot);
    expect(screen.getAllByRole("button")).toEqual([sidebar, notifications, home]);

    view.rerender(triggerView("reconnecting", controls));
    act(() => vi.advanceTimersByTime(CONNECTION_INDICATOR_DELAY_MILLISECONDS));
    const dot = screen.getByRole("img", { name: "Application reconnecting" });
    expect(dot.parentElement).toBe(slot);
    expect([...view.container.querySelectorAll("button, [role=img]")])
      .toEqual([sidebar, notifications, home, dot]);

    view.rerender(triggerView("connected", controls));
    expect(home.nextElementSibling).toBe(slot);
    expect(slot).toBeEmptyDOMElement();
    expect(screen.getAllByRole("button")).toEqual([sidebar, notifications, home]);
  });

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
