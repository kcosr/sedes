// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./dialog.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function touchDensity(matches: boolean): void {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })));
}

function renderDialog(content: React.ReactNode, props: Partial<React.ComponentProps<typeof DialogContent>> = {}) {
  const onOpenChange = vi.fn();
  render(
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined} {...props}>
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
        </DialogHeader>
        {content}
      </DialogContent>
    </Dialog>,
  );
  return { onOpenChange, dialog: screen.getByRole("dialog", { name: "Add project" }) };
}

describe("DialogContent presentation", () => {
  it("defaults to a small modal card with the X and the shared overlay", () => {
    const { dialog } = renderDialog(null);
    expect(dialog).toHaveAttribute("data-size", "sm");
    expect(dialog).toHaveAttribute("data-layout", "modal");
    expect(dialog).toHaveAttribute("data-close");
    expect(screen.getByTestId("dialog-overlay")).toHaveAttribute("data-slot", "dialog-overlay");
    expect(screen.getByRole("button", { name: "Close" })).toBeEnabled();
  });

  it.each([
    [{ size: "sm" }, "modal"],
    [{ size: "md" }, "sheet"],
    [{ size: "xl" }, "sheet"],
    [{ size: "viewer" }, "fullscreen"],
    [{ size: "md", mobile: "card" }, "modal"],
    [{ size: "sm", mobile: "fullscreen" }, "fullscreen"],
    [{ layout: "side" }, "sheet"],
  ] as const)("under the density switch %o presents as %s", (props, layout) => {
    touchDensity(true);
    const { dialog } = renderDialog(null, props);
    expect(dialog).toHaveAttribute("data-layout", layout);
  });

  it("keeps the desktop layout without the density switch", () => {
    touchDensity(false);
    const { dialog } = renderDialog(null, { size: "lg", layout: "side" });
    expect(dialog).toHaveAttribute("data-layout", "side");
    expect(dialog).toHaveAttribute("data-size", "lg");
  });

  it("lifts itself above the soft keyboard under the density switch", () => {
    touchDensity(true);
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    const { dialog } = renderDialog(null, { layout: "sheet" });
    expect(dialog.style.getPropertyValue("--keyboard-inset")).toBe("0px");
    act(() => {
      viewport.height = window.innerHeight - 280;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--keyboard-inset")).toBe("280px");
  });

  it("hides the X on request", () => {
    renderDialog(null, { showClose: false });
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-close");
  });
});

describe("DialogContent dismissal", () => {
  it("closes on Escape while dismissible", async () => {
    const { onOpenChange } = renderDialog(null);
    await userEvent.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("locks Escape, outside clicks and the X when not dismissible", async () => {
    const onEscapeKeyDown = vi.fn();
    const { onOpenChange } = renderDialog(null, { dismissible: false, onEscapeKeyDown });
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByTestId("dialog-overlay"));
    expect(onEscapeKeyDown).toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Close" })).toBeDisabled();
  });
});

describe("DialogContent initial focus", () => {
  it("focuses the first field, never the X", async () => {
    renderDialog(
      <DialogBody>
        <input aria-label="Name" />
        <input aria-label="Location" />
      </DialogBody>,
    );
    await waitFor(() => expect(screen.getByLabelText("Name")).toHaveFocus());
  });

  it("skips hidden, disabled and read-only fields", async () => {
    renderDialog(
      <DialogBody>
        <input aria-label="Hidden" hidden />
        <input aria-label="Disabled" disabled />
        <input aria-label="Read only" readOnly />
        <textarea aria-label="Notes" />
      </DialogBody>,
    );
    await waitFor(() => expect(screen.getByLabelText("Notes")).toHaveFocus());
  });

  it("focuses the primary action when there is no field", async () => {
    renderDialog(
      <DialogFooter start={<Button variant="ghost">Remind now</Button>}>
        <Button variant="outline">Cancel</Button>
        <Button>Snooze</Button>
      </DialogFooter>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Snooze" })).toHaveFocus());
  });

  it("focuses the safe choice when the primary action is destructive", async () => {
    renderDialog(
      <DialogFooter>
        <Button variant="outline">Keep editing</Button>
        <Button variant="destructive">Discard</Button>
      </DialogFooter>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Keep editing" })).toHaveFocus());
  });

  it("honors an explicit data-autofocus target", async () => {
    renderDialog(
      <>
        <DialogBody><input aria-label="Name" /></DialogBody>
        <DialogFooter><Button data-autofocus="">Done</Button></DialogFooter>
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Done" })).toHaveFocus());
  });

  it("focuses the dialog itself when nothing else fits", async () => {
    const { dialog } = renderDialog(<p>Read-only details</p>);
    await waitFor(() => expect(dialog).toHaveFocus());
    expect(screen.getByRole("button", { name: "Close" })).not.toHaveFocus();
  });

  it("lets a handler that prevents the default own focus", async () => {
    renderDialog(
      <DialogBody>
        <input aria-label="Name" />
        <input aria-label="Search" id="search" />
      </DialogBody>,
      {
        onOpenAutoFocus: (event) => {
          event.preventDefault();
          document.getElementById("search")?.focus();
        },
      },
    );
    await waitFor(() => expect(screen.getByLabelText("Search")).toHaveFocus());
  });
});

describe("Dialog slots", () => {
  it("renders the header, the one scroll body and a footer with the start slot first", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Snooze thread</DialogTitle>
            <DialogDescription>Hide it until a time you choose.</DialogDescription>
          </DialogHeader>
          <DialogBody>Body</DialogBody>
          <DialogFooter start={<Button variant="ghost">Remind now</Button>}>
            <Button variant="outline">Cancel</Button>
            <Button>Snooze</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Snooze thread" });
    expect(dialog).toHaveAccessibleDescription("Hide it until a time you choose.");
    expect(screen.getByText("Body")).toHaveAttribute("data-slot", "dialog-body");
    const footer = screen.getByRole("button", { name: "Cancel" }).parentElement!;
    expect(footer).toHaveAttribute("data-slot", "dialog-footer");
    expect(footer.firstElementChild).toHaveAttribute("data-slot", "dialog-footer-start");
    expect([...footer.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Remind now",
      "Cancel",
      "Snooze",
    ]);
  });

  it("announces destructive alerts and shows a titled notice", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Add project</DialogTitle>
          <DialogAlert tone="warning" title="Not a Git repository">
            Worktrees are unavailable.
          </DialogAlert>
          <DialogAlert tone="destructive">Could not add the project.</DialogAlert>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not add the project.");
    const notice = screen.getByText("Not a Git repository").closest('[data-slot="dialog-alert"]');
    expect(notice).toHaveAttribute("data-tone", "warning");
    expect(notice).toHaveTextContent("Worktrees are unavailable.");
  });
});
