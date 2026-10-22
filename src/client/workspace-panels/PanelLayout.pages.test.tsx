// @vitest-environment jsdom

import { useEffect, useState } from "react";
import { act, fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  installPanelLayoutHarness,
  measureStage,
  setMobile,
  setup,
} from "./panel-layout.fixtures.js";
import type { WorkspacePanelContext, WorkspacePanelTenant } from "./registry.js";

vi.mock("../terminals/TerminalPanel.js", async () => ({
  TerminalPanel: (await import("./panel-layout.terminal-fixture.js")).TerminalPanelFixture,
}));

installPanelLayoutHarness();

function pagesFixture() {
  const mounted = vi.fn();
  const unmounted = vi.fn();
  function Pages({ context }: { readonly context: WorkspacePanelContext }) {
    const [selection, setSelection] = useState("First page");
    useEffect(() => {
      mounted();
      return () => { unmounted(); };
    }, []);
    return (
      <div>
        <span data-testid="pages-thread">{context.threadId}</span>
        <span data-testid="pages-visible">{String(context.visible)}</span>
        <button onClick={() => setSelection("Second page")}>Select second page</button>
        <span data-testid="pages-selection">{selection}</span>
        {context.visible ? <iframe title="Page document" /> : null}
      </div>
    );
  }
  const tenant: WorkspacePanelTenant = {
    id: "pages",
    title: "Pages",
    icon: () => null,
    scope: "thread",
    size: { minWidth: 360, minHeight: 240, preferredWidth: 800, preferredHeight: 560, preferredShare: 0.5 },
    availability: () => ({ available: true }),
    render: (context) => <Pages context={context} />,
  };
  return { tenant, mounted, unmounted };
}

describe("Pages panel host", () => {
  it("keeps the visible document in the same DOM slot through maximize, restore, move and resize", () => {
    const { tenant, mounted, unmounted } = pagesFixture();
    const store = setup({ extraTenants: [tenant] });
    act(() => store.open("pages", { focus: false }));
    const frame = screen.getByTitle("Page document");
    const slot = frame.closest(".workspace-panel-content");
    expect(slot).not.toBeNull();
    expect(screen.getByRole("region", { name: "Pages panel" })).toHaveAttribute("data-region", "right");

    for (const change of [
      () => store.maximize("pages"),
      () => store.restore(),
      () => store.move("pages", "left"),
      () => store.resize("pages", "width", 0.4),
      () => measureStage(1400, 900),
    ]) {
      act(change);
      expect(screen.getByTitle("Page document")).toBe(frame);
      expect(frame.closest(".workspace-panel-content")).toBe(slot);
      expect(screen.getByTestId("pages-visible")).toHaveTextContent("true");
    }
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("disables hidden Pages content while keeping selection, and unloads it on close", () => {
    const { tenant, mounted, unmounted } = pagesFixture();
    const store = setup({ extraTenants: [tenant] });
    act(() => store.open("pages", { focus: false }));
    fireEvent.click(screen.getByRole("button", { name: "Select second page" }));
    const firstFrame = screen.getByTitle("Page document");

    for (const hide of [
      () => store.toggle("pages", { focus: false }),
      () => store.open("files", { focus: false }),
      () => store.maximize("chat"),
      () => measureStage(600, 800),
    ]) {
      act(hide);
      expect(screen.getByTestId("pages-visible")).toHaveTextContent("false");
      expect(screen.queryByTitle("Page document")).toBeNull();
      expect(document.querySelector(".workspace-panel-parking iframe")).toBeNull();
      expect(screen.getByTestId("pages-selection")).toHaveTextContent("Second page");
      expect(store.isLoaded("pages")).toBe(true);
      act(() => {
        measureStage(1200, 800);
        store.open("pages", { focus: false });
      });
      expect(screen.getByTitle("Page document")).not.toBe(firstFrame);
    }
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close Pages panel" }));
    expect(store.isLoaded("pages")).toBe(false);
    expect(screen.queryByTestId("pages-selection")).toBeNull();
    expect(unmounted).toHaveBeenCalledOnce();
  });

  it("passes the current thread to its retained tenant across route changes", () => {
    const { tenant, mounted, unmounted } = pagesFixture();
    const store = setup({ extraTenants: [tenant] });
    act(() => store.open("pages", { focus: false }));
    expect(screen.getByTestId("pages-thread")).toHaveTextContent("thread-1");
    act(() => store.rerenderThread("thread-2"));
    expect(screen.getByTestId("pages-thread")).toHaveTextContent("thread-2");
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("uses the phone stage and disables the page while Chat is in front", () => {
    const { tenant, mounted } = pagesFixture();
    setMobile(true);
    const store = setup({ extraTenants: [tenant] });
    act(() => store.open("pages"));
    expect(screen.getByTitle("Page document")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "Maximize Pages panel" })).toBeNull();
    fireEvent.click(screen.getByTestId("chat-panel-toggle"));
    expect(screen.getByTestId("pages-visible")).toHaveTextContent("false");
    expect(screen.queryByTitle("Page document")).toBeNull();
    fireEvent.click(screen.getByTestId("pages-panel-toggle"));
    expect(screen.getByTitle("Page document")).toBeInTheDocument();
    expect(mounted).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Close Pages panel" }));
    expect(screen.getByTestId("chat-visible")).toHaveTextContent("true");
  });
});
