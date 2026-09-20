// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalTabs } from "./TerminalTabs.js";

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TerminalTabs", () => {
  it("uses nested terminal tab semantics and roving keyboard focus", () => {
    const onActivate = vi.fn();
    render(
      <TerminalTabs
        tabs={tabs}
        activeTerminalId="terminal-2"
        onActivate={onActivate}
        onClose={() => undefined}
        onRename={async () => undefined}
      />,
    );

    const rendered = screen.getAllByRole("tab");
    expect(rendered).toHaveLength(3);
    expect(rendered[1]).toHaveAttribute("aria-selected", "true");
    expect(rendered[1]).toHaveAttribute("tabindex", "0");
    expect(rendered[0]).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(rendered[1]!, { key: "ArrowRight" });
    expect(onActivate).toHaveBeenLastCalledWith("terminal-3");
    fireEvent.keyDown(rendered[1]!, { key: "Home" });
    expect(onActivate).toHaveBeenLastCalledWith("terminal-1");
    fireEvent.keyDown(rendered[1]!, { key: "End" });
    expect(onActivate).toHaveBeenLastCalledWith("terminal-3");
  });

  it("requests closing the selected terminal through click and Delete", () => {
    const onClose = vi.fn();
    render(
      <TerminalTabs
        tabs={tabs}
        activeTerminalId="terminal-2"
        onActivate={() => undefined}
        onClose={onClose}
        onRename={async () => undefined}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Close Test terminal",
      }),
    );
    expect(onClose).toHaveBeenCalledWith("terminal-2");

    fireEvent.keyDown(screen.getByRole("tab", { name: "Test" }), {
      key: "Delete",
    });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("exposes the lifecycle action and blocks click and Delete while removal is pending", () => {
    const onClose = vi.fn();
    render(
      <TerminalTabs
        tabs={[{ terminalId: "terminal-1", label: "Logs", lifecycle: "exited", closeLabel: "Remove Logs terminal and history", closeDisabled: true }]}
        activeTerminalId="terminal-1"
        onActivate={() => undefined}
        onClose={onClose}
        onRename={async () => undefined}
      />,
    );
    const close = screen.getByRole("button", { name: "Remove Logs terminal and history" });
    expect(close).toHaveAttribute("title", "Remove Logs terminal and history");
    expect(close).toBeDisabled();
    fireEvent.click(close);
    fireEvent.keyDown(screen.getByRole("tab", { name: /Logs/ }), { key: "Delete" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps normal attach states and inactive running tabs silent", () => {
    render(
      <TerminalTabs
        tabs={[
          {
            terminalId: "terminal-1",
            label: "Active",
            lifecycle: "running",
            connection: "ready",
          },
          {
            terminalId: "terminal-2",
            label: "Authorizing",
            lifecycle: "running",
            connection: "authorizing",
          },
          {
            terminalId: "terminal-3",
            label: "Connecting",
            lifecycle: "running",
            connection: "connecting",
          },
          {
            terminalId: "terminal-4",
            label: "Restoring",
            lifecycle: "running",
            connection: "restoring",
          },
          { terminalId: "terminal-5", label: "Inactive", lifecycle: "running" },
        ]}
        activeTerminalId="terminal-1"
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={async () => undefined}
      />,
    );

    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders non-healthy status after the terminal label", () => {
    render(
      <TerminalTabs
        tabs={[
          {
            terminalId: "terminal-1",
            label: "Shell",
            lifecycle: "running",
            connection: "reconnecting",
          },
          { terminalId: "terminal-2", label: "Logs", lifecycle: "interrupted" },
        ]}
        activeTerminalId="terminal-1"
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={async () => undefined}
      />,
    );

    const activeTab = screen.getByRole("tab", { name: /Shell/u });
    const label = activeTab.querySelector(".terminal-tab-label");
    const status = screen.getByRole("img", { name: "Terminal reconnecting" });
    expect(label?.nextElementSibling).toBe(status);
    expect(
      screen.getByRole("img", { name: "Terminal interrupted" }),
    ).toBeInTheDocument();
  });

  it("renders a compact read-only lock after the active terminal label", () => {
    render(
      <TerminalTabs
        tabs={[
          {
            terminalId: "terminal-1",
            label: "Shell",
            lifecycle: "running",
            connection: "ready",
            readOnly: true,
          },
        ]}
        activeTerminalId="terminal-1"
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={async () => undefined}
      />,
    );

    const activeTab = screen.getByRole("tab", { name: /Shell/u });
    const label = activeTab.querySelector(".terminal-tab-label");
    const status = screen.getByRole("img", {
      name: "Read only — controlled by another client",
    });
    expect(label?.nextElementSibling).toBe(status);
    expect(status).toHaveAttribute("data-status", "read-only");
  });

  it("renders an exited terminal as a neutral retained lifecycle status", () => {
    render(
      <TerminalTabs
        tabs={[
          { terminalId: "terminal-1", label: "Shell", lifecycle: "exited" },
        ]}
        activeTerminalId="terminal-1"
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={async () => undefined}
      />,
    );

    expect(
      screen.getByRole("img", { name: "Terminal exited" }),
    ).toHaveAttribute("data-status", "exited");
  });

  it("renames an inactive tab inline without activating it", async () => {
    const onActivate = vi.fn();
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(
      <TerminalTabs
        tabs={tabs}
        activeTerminalId="terminal-1"
        onActivate={onActivate}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Test" });
    fireEvent.contextMenu(tab);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));

    const input = screen.getByRole("textbox", { name: "Rename Test" });
    expect(input).toHaveValue("Test");
    expect(input).toHaveFocus();
    expect(
      screen.queryByRole("button", {
        name: "Close Test terminal",
      }),
    ).toBeNull();
    expect(onActivate).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "Test runner" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("terminal-2", "Test runner");
    expect(await screen.findByRole("tab", { name: "Test" })).toHaveFocus();
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("renames an inactive tab from its touch-accessible actions button", async () => {
    const onActivate = vi.fn();
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(<TerminalTabs tabs={tabs} activeTerminalId="terminal-1" onActivate={onActivate} onClose={vi.fn()} onRename={onRename} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Terminal actions for Test" }), { button: 0, ctrlKey: false, pointerType: "touch" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Test" });
    fireEvent.change(input, { target: { value: "Test runner" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("terminal-2", "Test runner");
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("opens rename from the keyboard context-menu shortcut and Escape cancels", async () => {
    const onRename = vi.fn();
    render(
      <TerminalTabs
        tabs={tabs}
        activeTerminalId="terminal-1"
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Build" });
    tab.focus();
    fireEvent.keyDown(tab, { key: "F10", shiftKey: true });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Build" });
    fireEvent.change(input, { target: { value: "Changed" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("tab", { name: "Build" })).toHaveFocus();
  });

  it("keeps a failed rename editable for a same-attempt retry", async () => {
    const onRename = vi
      .fn()
      .mockRejectedValueOnce(new Error("The terminal changed elsewhere."))
      .mockResolvedValueOnce(undefined);
    render(
      <TerminalTabs
        tabs={tabs}
        activeTerminalId="terminal-1"
        onActivate={() => undefined}
        onClose={() => undefined}
        onRename={onRename}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Build" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Build" });
    fireEvent.change(input, { target: { value: "Build shell" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The terminal changed elsewhere.",
    );
    expect(input).toHaveValue("Build shell");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledTimes(2);
  });

  it("does not turn a touch hold into the desktop tab context menu", () => {
    const onActivate = vi.fn();
    render(
      <TerminalTabs
        tabs={tabs}
        activeTerminalId="terminal-1"
        onActivate={onActivate}
        onClose={() => undefined}
        onRename={async () => undefined}
      />,
    );

    const tab = screen.getByRole("tab", { name: "Build" });
    fireEvent.pointerDown(tab, { pointerType: "touch", button: 0 });
    expect(fireEvent.contextMenu(tab)).toBe(false);
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    fireEvent.click(tab);
    expect(onActivate).toHaveBeenCalledWith("terminal-1");
  });

  it("commits on blur without stealing intentionally moved focus", async () => {
    const onRename = vi.fn().mockResolvedValue(undefined);
    render(
      <>
        <TerminalTabs
          tabs={tabs}
          activeTerminalId="terminal-1"
          onActivate={() => undefined}
          onClose={() => undefined}
          onRename={onRename}
        />
        <button type="button">Outside control</button>
      </>,
    );

    fireEvent.contextMenu(screen.getByRole("tab", { name: "Build" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Build" });
    fireEvent.change(input, { target: { value: "Build shell" } });
    const outside = screen.getByRole("button", { name: "Outside control" });
    outside.focus();
    fireEvent.blur(input);

    expect(onRename).toHaveBeenCalledWith("terminal-1", "Build shell");
    await screen.findByRole("tab", { name: "Build" });
    expect(outside).toHaveFocus();
  });
});

const tabs = [
  { terminalId: "terminal-1", label: "Build", lifecycle: "running" as const },
  { terminalId: "terminal-2", label: "Test", lifecycle: "running" as const },
  { terminalId: "terminal-3", label: "Logs", lifecycle: "exited" as const },
];
