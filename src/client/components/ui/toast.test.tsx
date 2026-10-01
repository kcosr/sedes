// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import { ToastProvider, useToast, type ToastOptions } from "./toast.js";

let show: (options: ToastOptions) => void;

function Harness() {
  show = useToast().show;
  return null;
}

function renderToasts(children?: React.ReactNode) {
  return render(
    <ToastProvider>
      <Harness />
      {children}
    </ToastProvider>,
  );
}

function toast(): HTMLElement | null {
  return document.querySelector('[data-slot="toast"]');
}

function viewport(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-slot="toast-viewport"]')!;
}

function box(rect: Partial<DOMRect>): () => DOMRect {
  const { left = 0, top = 0, width = 0, height = 0 } = rect;
  return () =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Toast", () => {
  it("shows a message with its action and a dismiss control in a labelled region", () => {
    renderToasts();
    act(() =>
      show({ message: "Task completed", action: { label: "Undo", onAction: () => undefined } }),
    );

    expect(toast()).toHaveTextContent("Task completed");
    expect(toast()).toHaveAttribute("data-state", "open");
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Notifications (F8)" })).toContainElement(toast());
  });

  it("announces politely through a status live region", () => {
    renderToasts();
    act(() => show({ message: "Moved to Project" }));
    act(() => vi.advanceTimersByTime(50));

    const status = screen
      .getAllByRole("status")
      .find((element) => element.textContent?.includes("Moved to Project"));
    expect(status).toHaveAttribute("aria-live", "polite");
  });

  it("keeps one toast at a time: a new toast replaces the current one", () => {
    renderToasts();
    act(() => show({ message: "Task completed" }));
    act(() => show({ message: "Task reopened" }));

    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(1);
    expect(toast()).toHaveTextContent("Task reopened");
    expect(screen.queryByText("Task completed")).not.toBeInTheDocument();
  });

  it("runs the action and closes", () => {
    const onAction = vi.fn();
    renderToasts();
    act(() => show({ message: "Task completed", action: { label: "Undo", onAction } }));

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(onAction).toHaveBeenCalledOnce();
    expect(toast()).toBeNull();
  });

  it("lets the action show the next toast", () => {
    renderToasts();
    act(() =>
      show({
        message: "Task completed",
        action: { label: "Undo", onAction: () => show({ message: "Task reopened" }) },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));

    expect(toast()).toHaveTextContent("Task reopened");
  });

  it("closes from its dismiss control and from Escape", () => {
    renderToasts();
    act(() => show({ message: "Task completed" }));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(toast()).toBeNull();

    act(() => show({ message: "Task reopened" }));
    fireEvent.keyDown(toast()!, { key: "Escape" });
    expect(toast()).toBeNull();
  });

  it("closes after about five seconds, or after its own duration", () => {
    renderToasts();
    act(() => show({ message: "Task completed" }));
    act(() => vi.advanceTimersByTime(4_900));
    expect(toast()).not.toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(toast()).toBeNull();

    act(() => show({ message: "Saved", duration: 1_000 }));
    act(() => vi.advanceTimersByTime(1_100));
    expect(toast()).toBeNull();
  });

  it("pauses while the pointer is over it and resumes when it leaves", () => {
    renderToasts();
    act(() => show({ message: "Task completed" }));
    const region = screen.getByRole("region", { name: "Notifications (F8)" });

    act(() => vi.advanceTimersByTime(3_000));
    fireEvent.pointerMove(region);
    act(() => vi.advanceTimersByTime(10_000));
    expect(toast()).not.toBeNull();

    fireEvent.pointerLeave(region);
    act(() => vi.advanceTimersByTime(1_900));
    expect(toast()).not.toBeNull();
    act(() => vi.advanceTimersByTime(200));
    expect(toast()).toBeNull();
  });

  it("pauses while focus is inside it", () => {
    renderToasts(<button type="button">Outside</button>);
    act(() => show({ message: "Task completed", action: { label: "Undo", onAction: () => undefined } }));

    act(() => screen.getByRole("button", { name: "Undo" }).focus());
    act(() => vi.advanceTimersByTime(10_000));
    expect(toast()).not.toBeNull();

    act(() => screen.getByRole("button", { name: "Outside" }).focus());
    act(() => vi.advanceTimersByTime(5_100));
    expect(toast()).toBeNull();
  });

  it("centres on the toast region and clears the composer in it", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(900);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1440);
    renderToasts(
      <>
        <div data-toast-region="default" data-testid="region">
          <div data-toast-avoid data-testid="composer" />
          <div data-toast-avoid data-testid="collapsed-composer" />
          <div aria-hidden="true">
            <div data-toast-avoid data-testid="covered-bar" />
          </div>
        </div>
        <div data-toast-avoid data-testid="sidebar-footer" />
      </>,
    );
    screen.getByTestId("region").getBoundingClientRect = box({ left: 260, top: 0, width: 1180, height: 900 });
    screen.getByTestId("composer").getBoundingClientRect = box({ left: 300, top: 760, width: 768, height: 120 });
    screen.getByTestId("collapsed-composer").getBoundingClientRect = box({});
    screen.getByTestId("covered-bar").getBoundingClientRect = box({ left: 260, top: 500, width: 1180, height: 400 });
    screen.getByTestId("sidebar-footer").getBoundingClientRect = box({ left: 0, top: 600, width: 260, height: 300 });

    act(() => show({ message: "Task completed" }));

    expect(viewport().style.getPropertyValue("--toast-x")).toBe("850px");
    expect(viewport().style.getPropertyValue("--toast-bottom")).toBe("140px");
    expect(viewport().style.getPropertyValue("--toast-region-width")).toBe("1180px");
  });

  it("clears a bottom bar outside the region, such as a sheet's", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    renderToasts(
      <>
        <div data-toast-region="default" data-testid="region" />
        <div data-toast-avoid data-testid="sheet-bar" />
      </>,
    );
    screen.getByTestId("region").getBoundingClientRect = box({ left: 0, top: 0, width: 390, height: 844 });
    screen.getByTestId("sheet-bar").getBoundingClientRect = box({ left: 0, top: 772, width: 390, height: 72 });

    act(() => show({ message: "Task completed" }));

    expect(viewport().style.getPropertyValue("--toast-x")).toBe("195px");
    expect(viewport().style.getPropertyValue("--toast-bottom")).toBe("72px");
  });

  it("falls back to the whole viewport without a toast region", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    renderToasts();

    act(() => show({ message: "Task completed" }));

    expect(viewport().style.getPropertyValue("--toast-x")).toBe("195px");
    expect(viewport().style.getPropertyValue("--toast-bottom")).toBe("0px");
    expect(viewport().style.getPropertyValue("--toast-region-width")).toBe("390px");
  });

  it("re-measures when a sheet covers the composer and brings its own bar, and again when it closes", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    renderToasts(
      <div data-testid="workspace">
        <div data-toast-region="default" data-testid="region">
          <div data-toast-avoid data-testid="composer" />
        </div>
      </div>,
    );
    screen.getByTestId("region").getBoundingClientRect = box({ left: 0, top: 0, width: 390, height: 844 });
    screen.getByTestId("composer").getBoundingClientRect = box({ left: 0, top: 724, width: 390, height: 120 });
    act(() => show({ message: "Task completed" }));
    expect(viewport().style.getPropertyValue("--toast-bottom")).toBe("120px");

    // The modal sheet hides the workspace and docks its add bar.
    const bar = document.createElement("div");
    bar.setAttribute("data-toast-avoid", "");
    bar.getBoundingClientRect = box({ left: 0, top: 780, width: 390, height: 64 });
    await act(async () => {
      screen.getByTestId("workspace").setAttribute("aria-hidden", "true");
      document.body.append(bar);
    });
    act(() => vi.advanceTimersByTime(20));
    expect(viewport().style.getPropertyValue("--toast-bottom")).toBe("64px");

    await act(async () => {
      bar.remove();
      screen.getByTestId("workspace").removeAttribute("aria-hidden");
    });
    act(() => vi.advanceTimersByTime(20));
    expect(viewport().style.getPropertyValue("--toast-bottom")).toBe("120px");
  });

  it("sits on the region of the surface that raised it, clear of its bottom bar", () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    renderToasts(
      <div data-toast-region="default" data-testid="workspace">
        <div data-toast-avoid data-testid="composer" />
        <section data-toast-region data-testid="panel">
          <button type="button">Complete</button>
          <div data-toast-avoid data-testid="panel-bar" />
        </section>
      </div>,
    );
    screen.getByTestId("workspace").getBoundingClientRect = box({ left: 260, top: 52, width: 764, height: 716 });
    screen.getByTestId("composer").getBoundingClientRect = box({ left: 300, top: 560, width: 300, height: 200 });
    screen.getByTestId("panel").getBoundingClientRect = box({ left: 644, top: 52, width: 380, height: 716 });
    screen.getByTestId("panel-bar").getBoundingClientRect = box({ left: 644, top: 720, width: 380, height: 48 });

    act(() =>
      show({ message: "Task completed", anchor: screen.getByRole("button", { name: "Complete" }) }),
    );

    // The panel's centre and bar, not the workspace's or the composer's.
    expect(viewport().style.getPropertyValue("--toast-x")).toBe("834px");
    expect(viewport().style.getPropertyValue("--toast-bottom")).toBe("48px");
    expect(viewport().style.getPropertyValue("--toast-region-width")).toBe("380px");
  });

  it("falls back to the default region once the anchor's surface has gone", async () => {
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(768);
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(1024);
    renderToasts(
      <div data-toast-region="default" data-testid="workspace">
        <section data-toast-region data-testid="panel" />
      </div>,
    );
    screen.getByTestId("workspace").getBoundingClientRect = box({ left: 260, top: 0, width: 764, height: 768 });
    screen.getByTestId("panel").getBoundingClientRect = box({ left: 644, top: 0, width: 380, height: 768 });
    act(() => show({ message: "Moved to Global", anchor: screen.getByTestId("panel") }));
    expect(viewport().style.getPropertyValue("--toast-x")).toBe("834px");

    await act(async () => screen.getByTestId("panel").remove());
    act(() => vi.advanceTimersByTime(20));

    expect(viewport().style.getPropertyValue("--toast-x")).toBe("642px");
    expect(viewport().style.getPropertyValue("--toast-region-width")).toBe("764px");
  });

  it("dismisses on a downward swipe and springs back from a short one", () => {
    const capture = {
      setPointerCapture: HTMLElement.prototype.setPointerCapture,
      releasePointerCapture: HTMLElement.prototype.releasePointerCapture,
      hasPointerCapture: HTMLElement.prototype.hasPointerCapture,
    };
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
    try {
      renderToasts();
      act(() => show({ message: "Task completed" }));
      const swipe = (distance: number) => {
        const item = toast()!;
        fireEvent.pointerDown(item, { button: 0, clientX: 100, clientY: 100, pointerType: "touch" });
        fireEvent.pointerMove(item, { clientX: 100, clientY: 112, pointerType: "touch" });
        fireEvent.pointerMove(item, { clientX: 100, clientY: 100 + distance, pointerType: "touch" });
        expect(item).toHaveAttribute("data-swipe", "move");
        fireEvent.pointerUp(item, { clientX: 100, clientY: 100 + distance, pointerType: "touch" });
        return item;
      };

      expect(swipe(20)).toHaveAttribute("data-swipe", "cancel");
      expect(toast()).toHaveAttribute("data-state", "open");

      swipe(80);
      expect(toast()).toBeNull();
    } finally {
      Object.assign(HTMLElement.prototype, capture);
    }
  });

  it("requires its provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Harness />)).toThrow("useToast must be used inside ToastProvider");
  });
});

describe("Toast and Escape", () => {
  // Menus and popovers open through real pointer and focus sequences.
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("lets Escape close a menu beneath it while focus is outside the toast", async () => {
    const user = userEvent.setup();
    renderToasts(
      <DropdownMenu>
        <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Rename</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    act(() => show({ message: "Task completed" }));

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(toast()).toHaveAttribute("data-state", "open");
  });

  it("leaves Escape to the page while focus is outside it", () => {
    const onPage = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener("keydown", onPage);
    try {
      renderToasts();
      act(() => show({ message: "Task completed" }));

      fireEvent.keyDown(document.body, { key: "Escape" });

      expect(onPage).toHaveReturnedWith(false);
      expect(toast()).toHaveAttribute("data-state", "open");
    } finally {
      window.removeEventListener("keydown", onPage);
    }
  });

  it("takes Escape while focused, before a popover beneath it, and hands focus back", async () => {
    const user = userEvent.setup();
    renderToasts(
      <Popover>
        <PopoverTrigger>Tasks</PopoverTrigger>
        <PopoverContent aria-label="Tasks popover">
          <button type="button">Inside</button>
        </PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByRole("button", { name: "Tasks" }));
    const inside = screen.getByRole("button", { name: "Inside" });
    act(() => inside.focus());
    act(() =>
      show({ message: "Task completed", action: { label: "Undo", onAction: () => undefined } }),
    );

    // F8 moves focus to the toast; the popover stays open around it.
    await user.keyboard("{F8}");
    expect(toast()).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "Tasks popover" })).toBeInTheDocument();

    await user.keyboard("{Escape}");

    expect(toast()).toBeNull();
    expect(screen.getByRole("dialog", { name: "Tasks popover" })).toBeInTheDocument();
    expect(inside).toHaveFocus();
  });
});
