// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu.js";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuEmpty,
  DropdownMenuItem,
  DropdownMenuItemDescription,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./dropdown-menu.js";
import type { MenuPresentation } from "./menu-sheet.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function ThreadMenu({
  presentation,
  onRename = vi.fn(),
  onKeepOpen = vi.fn(),
}: {
  readonly presentation: MenuPresentation;
  readonly onRename?: () => void;
  readonly onKeepOpen?: () => void;
}) {
  const [sort, setSort] = useState("recent");
  const [peek, setPeek] = useState(false);
  return (
    <DropdownMenu presentation={presentation}>
      <DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>
      <DropdownMenuContent
        aria-label="Thread actions"
        sheetTitle="MCP events"
        sheetDescription="sedes · Claude · updated 12m ago"
      >
        <DropdownMenuItem onSelect={onRename}>Rename</DropdownMenuItem>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onKeepOpen();
          }}
        >
          <span>
            Agent tools…
            <DropdownMenuItemDescription>Off</DropdownMenuItemDescription>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          Fork<DropdownMenuShortcut>Running</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>Copy ID</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuItem>Thread ID</DropdownMenuItem>
            <DropdownMenuItem>Backend ID</DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Sort</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
          <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="name">Name</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuCheckboxItem checked={peek} onCheckedChange={setPeek}>
          Peek
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive">Force reset…</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

describe("floating menu rows", () => {
  it("renders descriptions, trailing checks, shortcuts and a destructive row", async () => {
    const user = userEvent.setup();
    render(<ThreadMenu presentation="menu" />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    const menu = await screen.findByRole("menu", { name: "Thread actions" });
    expect(menu).toHaveAttribute("data-slot", "dropdown-menu-content");
    expect(screen.getByText("Off")).toHaveAttribute("data-slot", "dropdown-menu-item-description");
    expect(screen.getByRole("menuitemradio", { name: "Recent" })).toHaveAttribute("data-state", "checked");
    expect(screen.getByRole("menuitem", { name: /Fork/ })).toHaveAttribute("data-disabled");
    expect(screen.getByText("Running")).toHaveAttribute("data-slot", "dropdown-menu-shortcut");
    expect(screen.getByRole("menuitem", { name: "Force reset…" })).toHaveAttribute("data-variant", "destructive");
    expect(screen.getByText("Sort")).toHaveAttribute("data-variant", "label");
  });

  it("renders a name header and a non-focusable empty row", async () => {
    const user = userEvent.setup();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Stack</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuLabel variant="header" description="4 threads">
            Checkout flow
          </DropdownMenuLabel>
          <DropdownMenuEmpty loading>Loading terminals…</DropdownMenuEmpty>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Stack" }));
    const header = await screen.findByText("Checkout flow");
    expect(header).toHaveAttribute("data-variant", "header");
    expect(header).toHaveTextContent("Checkout flow4 threads");
    const empty = screen.getByRole("status");
    expect(empty).toHaveTextContent("Loading terminals…");
    expect(empty).not.toHaveAttribute("tabindex");
    expect(screen.queryByRole("menuitem")).toBeNull();
  });
});

describe("menu presented as a sheet", () => {
  it("opens the shared sheet with the subject's name and meta line", async () => {
    const user = userEvent.setup();
    render(<ThreadMenu presentation="sheet" />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    const sheet = screen.getByRole("dialog", { name: "MCP events" });
    expect(sheet).toHaveAttribute("data-layout", "sheet");
    expect(sheet).toHaveAttribute("data-menu-sheet");
    expect(sheet).toHaveAccessibleDescription("sedes · Claude · updated 12m ago");
    expect(screen.getByRole("menu", { name: "Thread actions" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Close" })).toBeVisible();
  });

  it("runs an item and closes, unless onSelect prevents it", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onKeepOpen = vi.fn();
    render(<ThreadMenu presentation="sheet" onRename={onRename} onKeepOpen={onKeepOpen} />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await user.click(screen.getByRole("menuitem", { name: /Agent tools/ }));
    expect(onKeepOpen).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps disabled rows inert and shows their reason", async () => {
    const user = userEvent.setup();
    render(<ThreadMenu presentation="sheet" />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    const fork = screen.getByRole("menuitem", { name: /Fork/ });
    expect(fork).toBeDisabled();
    expect(fork).toHaveTextContent("Running");
  });

  it("selects radio and checkbox rows with their checked state", async () => {
    const user = userEvent.setup();
    render(<ThreadMenu presentation="sheet" />);
    const trigger = screen.getByRole("button", { name: "Thread actions" });
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Recent" })).toHaveAttribute("aria-checked", "true");
    await user.click(screen.getByRole("menuitemradio", { name: "Name" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(trigger);
    expect(screen.getByRole("menuitemradio", { name: "Name" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemcheckbox", { name: "Peek" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Peek" }));
    await user.click(trigger);
    expect(screen.getByRole("menuitemcheckbox", { name: "Peek" })).toHaveAttribute("aria-checked", "true");
  });

  it("drills into a submenu and back", async () => {
    const user = userEvent.setup();
    render(<ThreadMenu presentation="sheet" />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    const copy = screen.getByRole("menuitem", { name: "Copy ID" });
    expect(copy).toHaveAttribute("aria-haspopup", "menu");
    await user.click(copy);
    expect(screen.getByRole("group", { name: "Copy ID" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Thread ID" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Rename" })).toBeNull();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Copy ID" })).toHaveFocus());
    await user.click(screen.getByRole("menuitem", { name: "Copy ID" }));
    expect(screen.queryByRole("menuitem", { name: "Thread ID" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
  });

  it("moves between rows with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<ThreadMenu presentation="sheet" />);
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    await waitFor(() => expect(screen.getByRole("menu", { name: "Thread actions" })).toHaveFocus());
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Copy ID" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Force reset…" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Rename" })).toHaveFocus();
  });
});

describe("context menu presented as a sheet", () => {
  function RowMenu({ onOpenChange = vi.fn() }: { readonly onOpenChange?: (open: boolean) => void }) {
    return (
      <ContextMenu presentation="sheet" onOpenChange={onOpenChange}>
        <ContextMenuTrigger>MCP events row</ContextMenuTrigger>
        <ContextMenuContent sheetTitle="MCP events" sheetDescription="sedes · Claude">
          <ContextMenuItem>Pin</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  it("opens on a secondary click", async () => {
    const onOpenChange = vi.fn();
    render(<RowMenu onOpenChange={onOpenChange} />);
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    act(() => {
      screen.getByText("MCP events row").dispatchEvent(contextMenu);
    });
    expect(contextMenu.defaultPrevented).toBe(true);
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Pin" })).toBeVisible();
  });

  it("opens on a touch long press but not on a scroll", () => {
    vi.useFakeTimers();
    render(<RowMenu />);
    const row = screen.getByText("MCP events row");
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(row, { pointerType: "touch", clientX: 10, clientY: 40 });
    act(() => vi.advanceTimersByTime(800));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(800));
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
  });
});
