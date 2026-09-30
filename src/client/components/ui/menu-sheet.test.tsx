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
import { Dialog, DialogContent, DialogTitle } from "./dialog.js";
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

describe("sheet rows compose consumer click handlers", () => {
  function SettingsMenu(props: {
    readonly onPeekClick?: (event: React.MouseEvent) => void;
    readonly onPeekChange?: (checked: boolean) => void;
    readonly onSortClick?: (event: React.MouseEvent) => void;
    readonly onSortChange?: (value: string) => void;
    readonly onCopyClick?: (event: React.MouseEvent) => void;
    readonly onRenameClick?: (event: React.MouseEvent) => void;
    readonly onRename?: () => void;
  }) {
    const [peek, setPeek] = useState(false);
    const [sort, setSort] = useState("recent");
    return (
      <DropdownMenu presentation="sheet">
        <DropdownMenuTrigger>View</DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="View options">
          <DropdownMenuItem onClick={props.onRenameClick} onSelect={props.onRename}>Rename</DropdownMenuItem>
          <DropdownMenuCheckboxItem
            checked={peek}
            onClick={props.onPeekClick}
            onCheckedChange={(checked) => {
              props.onPeekChange?.(checked);
              setPeek(checked);
            }}
          >
            Peek
          </DropdownMenuCheckboxItem>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(value) => {
              props.onSortChange?.(value);
              setSort(value);
            }}
          >
            <DropdownMenuRadioItem value="recent">Recent</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="name" onClick={props.onSortClick}>Name</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger onClick={props.onCopyClick}>Copy ID</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Thread ID</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("runs a checkbox row's click handler and still toggles and closes", async () => {
    const user = userEvent.setup();
    const onPeekClick = vi.fn();
    const onPeekChange = vi.fn();
    render(<SettingsMenu onPeekClick={onPeekClick} onPeekChange={onPeekChange} />);
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Peek" }));
    expect(onPeekClick).toHaveBeenCalledOnce();
    expect(onPeekChange).toHaveBeenCalledExactlyOnceWith(true);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("runs a radio row's click handler and still changes the value", async () => {
    const user = userEvent.setup();
    const onSortClick = vi.fn();
    const onSortChange = vi.fn();
    render(<SettingsMenu onSortClick={onSortClick} onSortChange={onSortChange} />);
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Name" }));
    expect(onSortClick).toHaveBeenCalledOnce();
    expect(onSortChange).toHaveBeenCalledExactlyOnceWith("name");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("runs a submenu trigger's click handler and still drills in", async () => {
    const user = userEvent.setup();
    const onCopyClick = vi.fn();
    render(<SettingsMenu onCopyClick={onCopyClick} />);
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy ID" }));
    expect(onCopyClick).toHaveBeenCalledOnce();
    expect(screen.getByRole("menuitem", { name: "Thread ID" })).toBeVisible();
  });

  it("skips the row's behavior when the click handler prevents the default", async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onPeekChange = vi.fn();
    const onSortChange = vi.fn();
    const prevent = (event: React.MouseEvent) => event.preventDefault();
    render(
      <SettingsMenu
        onRenameClick={prevent}
        onRename={onRename}
        onPeekClick={prevent}
        onPeekChange={onPeekChange}
        onSortClick={prevent}
        onSortChange={onSortChange}
        onCopyClick={prevent}
      />,
    );
    await user.click(screen.getByRole("button", { name: "View" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.click(screen.getByRole("menuitemcheckbox", { name: "Peek" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Name" }));
    await user.click(screen.getByRole("menuitem", { name: "Copy ID" }));
    expect(onRename).not.toHaveBeenCalled();
    expect(onPeekChange).not.toHaveBeenCalled();
    expect(onSortChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem", { name: "Thread ID" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "View options" })).toBeVisible();
  });
});

describe("menu sheets return focus when they close", () => {
  function RowWithRename({
    presentation,
    onCloseAutoFocus,
  }: {
    readonly presentation: "context" | "dropdown";
    readonly onCloseAutoFocus?: (event: Event) => void;
  }) {
    const [renaming, setRenaming] = useState(false);
    const items = (
      <>
        <DropdownMenuItem>Pin</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename…</DropdownMenuItem>
      </>
    );
    return (
      <>
        {presentation === "context" ? (
          <ContextMenu presentation="sheet">
            <ContextMenuTrigger asChild>
              <button type="button">MCP events</button>
            </ContextMenuTrigger>
            <ContextMenuContent sheetTitle="MCP events" onCloseAutoFocus={onCloseAutoFocus}>
              <ContextMenuItem>Pin</ContextMenuItem>
              <ContextMenuItem onSelect={() => setRenaming(true)}>Rename…</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <DropdownMenu presentation="sheet">
            <DropdownMenuTrigger>MCP events</DropdownMenuTrigger>
            <DropdownMenuContent sheetTitle="MCP events" onCloseAutoFocus={onCloseAutoFocus}>
              {items}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <button type="button">Elsewhere</button>
        <Dialog open={renaming} onOpenChange={setRenaming}>
          <DialogContent aria-describedby={undefined}>
            <DialogTitle>Rename thread</DialogTitle>
            <input aria-label="Thread name" />
          </DialogContent>
        </Dialog>
      </>
    );
  }

  async function openFromFocusedTrigger(presentation: "context" | "dropdown") {
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "MCP events" });
    trigger.focus();
    if (presentation === "context") fireEvent.contextMenu(trigger);
    else await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
    return { user, trigger };
  }

  it.each(["context", "dropdown"] as const)("restores the %s trigger after Escape", async (presentation) => {
    render(<RowWithRename presentation={presentation} />);
    const { user, trigger } = await openFromFocusedTrigger(presentation);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["context", "dropdown"] as const)("restores the %s trigger after the close button", async (presentation) => {
    render(<RowWithRename presentation={presentation} />);
    const { user, trigger } = await openFromFocusedTrigger(presentation);
    await user.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["context", "dropdown"] as const)("restores the %s trigger after selecting an item", async (presentation) => {
    render(<RowWithRename presentation={presentation} />);
    const { user, trigger } = await openFromFocusedTrigger(presentation);
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["context", "dropdown"] as const)("leaves focus in a dialog that a %s item opened", async (presentation) => {
    render(<RowWithRename presentation={presentation} />);
    const { user, trigger } = await openFromFocusedTrigger(presentation);
    await user.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const rename = await screen.findByRole("dialog", { name: "Rename thread" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "MCP events" })).toBeNull());
    await waitFor(() => expect(screen.getByLabelText("Thread name")).toHaveFocus());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(rename).toContainElement(document.activeElement as HTMLElement);
    expect(trigger).not.toHaveFocus();
  });

  it("lets onCloseAutoFocus take over", async () => {
    const onCloseAutoFocus = vi.fn((event: Event) => {
      event.preventDefault();
      screen.getByRole("button", { name: "Elsewhere" }).focus();
    });
    render(<RowWithRename presentation="context" onCloseAutoFocus={onCloseAutoFocus} />);
    const { user, trigger } = await openFromFocusedTrigger("context");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Elsewhere" })).toHaveFocus();
    expect(trigger).not.toHaveFocus();
  });
});
