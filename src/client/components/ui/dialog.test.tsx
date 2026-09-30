// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "./button.js";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogTitle,
} from "./dialog.js";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";

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

  it("returns focus to the named target when it closes", async () => {
    const target = { current: null as HTMLButtonElement | null };
    const view = (open: boolean) => (
      <>
        <button ref={(node) => { target.current = node; }} type="button">Thread actions</button>
        <Dialog open={open}>
          <DialogContent aria-describedby={undefined} returnFocusRef={target}>
            <DialogTitle>Snooze</DialogTitle>
          </DialogContent>
        </Dialog>
      </>
    );
    const { rerender } = render(view(true));
    rerender(view(false));
    await waitFor(() => expect(target.current).toHaveFocus());
  });

  it("stamps its stacking band on the surface and the overlay", () => {
    const { dialog } = renderDialog(null);
    expect(dialog).toHaveAttribute("data-layer", "dialog");
    expect(screen.getByTestId("dialog-overlay")).toHaveAttribute("data-layer", "dialog");
    cleanup();
    const raised = renderDialog(null, { layer: "over-dialog" });
    expect(raised.dialog).toHaveAttribute("data-layer", "over-dialog");
    expect(screen.getByTestId("dialog-overlay")).toHaveAttribute("data-layer", "over-dialog");
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

/**
 * A row's action that opens a controlled dialog with no DialogTrigger, like
 * a settings list's Delete button. `removeOnClose` removes the row as the
 * dialog closes; `focusOnClose` moves focus once the dialog has unmounted,
 * as a surface opened meanwhile would.
 */
function OpenerHarness({
  removeOnClose = false,
  focusOnClose = false,
  ...contentProps
}: Partial<React.ComponentProps<typeof DialogContent>> & {
  removeOnClose?: boolean;
  focusOnClose?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [rowPresent, setRowPresent] = useState(true);
  const other = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open && focusOnClose) other.current?.focus();
  }, [open, focusOnClose]);
  return (
    <>
      {rowPresent && (
        <button type="button" onClick={() => setOpen(true)}>
          Delete Test
        </button>
      )}
      <button ref={other} type="button">Next row</button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next && removeOnClose) setRowPresent(false);
        }}
      >
        <DialogContent aria-describedby={undefined} {...contentProps}>
          <DialogTitle>Delete Test?</DialogTitle>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

describe("DialogContent return focus", () => {
  it("returns focus to the element focused when it opened", async () => {
    const user = userEvent.setup();
    render(<OpenerHarness />);
    const opener = screen.getByRole("button", { name: "Delete Test" });
    await user.click(opener);
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());

    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("prefers the named return target over the opener", async () => {
    const user = userEvent.setup();
    const target = { current: null as HTMLElement | null };
    render(<OpenerHarness returnFocusRef={target} />);
    target.current = screen.getByRole("button", { name: "Next row" });
    await user.click(screen.getByRole("button", { name: "Delete Test" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(target.current).toHaveFocus());
  });

  it("skips an opener the action removed and focuses the named survivor", async () => {
    const user = userEvent.setup();
    const survivor = vi.fn(() => screen.getByRole("button", { name: "Next row" }));
    render(<OpenerHarness removeOnClose fallbackFocus={survivor} />);
    await user.click(screen.getByRole("button", { name: "Delete Test" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.getByRole("button", { name: "Next row" })).toHaveFocus());
    expect(screen.queryByRole("button", { name: "Delete Test" })).toBeNull();
  });

  it("uses the survivor only when the opener is gone", async () => {
    const user = userEvent.setup();
    const survivor = vi.fn(() => screen.getByRole("button", { name: "Next row" }));
    render(<OpenerHarness fallbackFocus={survivor} />);
    const opener = screen.getByRole("button", { name: "Delete Test" });
    await user.click(opener);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(opener).toHaveFocus());
    expect(survivor).not.toHaveBeenCalled();
  });

  it("leaves focus where it moved after the dialog closed", async () => {
    const user = userEvent.setup();
    render(<OpenerHarness focusOnClose />);
    await user.click(screen.getByRole("button", { name: "Delete Test" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(screen.getByRole("button", { name: "Next row" })).toHaveFocus();
  });

  it("lets a close handler that prevents the default own focus", async () => {
    const user = userEvent.setup();
    render(<OpenerHarness onCloseAutoFocus={(event) => event.preventDefault()} />);
    await user.click(screen.getByRole("button", { name: "Delete Test" }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(document.body).toHaveFocus();
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

  it("marks the body while it has content below, for the footer's hairline", async () => {
    const bodyRef = { current: null as HTMLDivElement | null };
    renderDialog(
      <>
        <DialogBody ref={bodyRef}>Long content</DialogBody>
        <DialogFooter><Button>Save</Button></DialogFooter>
      </>,
    );
    const body = screen.getByText("Long content");
    expect(bodyRef.current).toBe(body);
    expect(body).not.toHaveAttribute("data-scroll-more");
    const scroll = (top: number) => {
      Object.defineProperties(body, {
        clientHeight: { configurable: true, value: 200 },
        scrollHeight: { configurable: true, value: 500 },
        scrollTop: { configurable: true, value: top },
      });
      act(() => body.dispatchEvent(new Event("scroll")));
    };
    scroll(0);
    expect(body).toHaveAttribute("data-scroll-more");
    scroll(150);
    expect(body).toHaveAttribute("data-scroll-more");
    scroll(300);
    expect(body).not.toHaveAttribute("data-scroll-more");
  });

  it("names a section by its label", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Session stats</DialogTitle>
          <DialogBody>
            <DialogSection title="Identifiers" description="Copy them for support.">
              <p>sedes-thread-1</p>
            </DialogSection>
          </DialogBody>
        </DialogContent>
      </Dialog>,
    );
    const section = screen.getByRole("region", { name: "Identifiers" });
    expect(section).toHaveAttribute("data-slot", "dialog-section");
    expect(screen.getByRole("heading", { name: "Identifiers" })).toHaveAttribute("data-slot", "dialog-section-title");
    expect(section).toHaveTextContent("Copy them for support.sedes-thread-1");
  });

  it("announces danger alerts and shows a titled notice", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Add project</DialogTitle>
          <DialogAlert tone="warning" title="Not a Git repository">
            Worktrees are unavailable.
          </DialogAlert>
          <DialogAlert tone="danger">Could not add the project.</DialogAlert>
        </DialogContent>
      </Dialog>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Could not add the project.");
    const notice = screen.getByText("Not a Git repository").closest('[data-slot="dialog-alert"]');
    expect(notice).toHaveAttribute("data-tone", "warning");
    expect(notice).not.toHaveAttribute("role");
    expect(notice).toHaveTextContent("Worktrees are unavailable.");
    // The Callout's anatomy: tone wash, icon, title over a quieter body.
    expect(notice).toHaveClass("bg-warning-soft", "border-warning-border");
    expect(notice?.querySelector('[data-slot="callout-title"]')).toHaveTextContent("Not a Git repository");
    expect(notice?.querySelector('[data-slot="callout-body"]')).toHaveClass("text-muted-foreground");
  });

  it("defaults DialogAlert to the info tone and lets a caller override the role", () => {
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Add project</DialogTitle>
          <DialogAlert>Scanning the folder.</DialogAlert>
          <DialogAlert tone="danger" role="status">Retrying.</DialogAlert>
        </DialogContent>
      </Dialog>,
    );
    const info = screen.getByText("Scanning the folder.").closest('[data-slot="dialog-alert"]');
    expect(info).toHaveAttribute("data-tone", "info");
    expect(info).toHaveClass("bg-info-soft");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Retrying.");
  });
});

describe("dialog-aware floating content", () => {
  it("portals popovers and menus into the dialog so they layer above it", async () => {
    const user = userEvent.setup();
    render(
      <Dialog open>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Settings</DialogTitle>
          <Popover>
            <PopoverTrigger>Details</PopoverTrigger>
            <PopoverContent>Popover body</PopoverContent>
          </Popover>
          <DropdownMenu>
            <DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>Rename</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogContent>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    await user.click(screen.getByRole("button", { name: "Details" }));
    expect(dialog).toContainElement(screen.getByText("Popover body"));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Actions" }));
    expect(dialog).toContainElement(await screen.findByRole("menuitem", { name: "Rename" }));
  });
});
