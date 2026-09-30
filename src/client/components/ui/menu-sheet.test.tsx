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
  DropdownMenuValue,
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
          Fork<DropdownMenuValue>Running</DropdownMenuValue>
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
    expect(screen.getByText("Running")).toHaveAttribute("data-slot", "dropdown-menu-item-value");
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

  function LinkRowMenu({ onRowClick }: { readonly onRowClick: () => void }) {
    return (
      <ContextMenu presentation="sheet">
        <ContextMenuTrigger asChild>
          <button type="button" onClick={onRowClick}>
            MCP events row
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent sheetTitle="MCP events">
          <ContextMenuItem>Pin</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  }

  it("swallows the click that ends a long press that opened the sheet", () => {
    vi.useFakeTimers();
    const onRowClick = vi.fn();
    render(<LinkRowMenu onRowClick={onRowClick} />);
    const row = screen.getByRole("button", { name: "MCP events row" });
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(800));
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
    // Lifting the finger clicks the pressed row (touch captures the pointer).
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    const release = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    act(() => {
      row.dispatchEvent(release);
    });
    expect(release.defaultPrevented).toBe(true);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
  });

  it("swallows the release click after Android's contextmenu during a hold", () => {
    const onRowClick = vi.fn();
    render(<LinkRowMenu onRowClick={onRowClick} />);
    const row = screen.getByRole("button", { name: "MCP events row" });
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    expect(fireEvent.contextMenu(row)).toBe(false);
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.click(row, { detail: 1 });
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("lets taps, and a keyboard click after an unfinished long press, through", () => {
    vi.useFakeTimers();
    const onRowClick = vi.fn();
    render(<LinkRowMenu onRowClick={onRowClick} />);
    const row = screen.getByRole("button", { name: "MCP events row" });
    // A tap: no long press, so its click acts.
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.click(row, { detail: 1 });
    expect(onRowClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();

    // A long press whose release produced no click on the row, then Enter.
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => vi.advanceTimersByTime(800));
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(row, { detail: 0 });
    expect(onRowClick).toHaveBeenCalledTimes(2);

    // The next press starts over: its tap acts.
    fireEvent.pointerDown(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerUp(row, { pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.click(row, { detail: 1 });
    expect(onRowClick).toHaveBeenCalledTimes(3);
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

describe("trailing values", () => {
  function ValueMenu({ presentation }: { presentation: "menu" | "sheet" }) {
    return (
      <DropdownMenu presentation={presentation}>
        <DropdownMenuTrigger>Thread settings</DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="Thread settings" aria-label="Thread settings">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              Reasoning effort<DropdownMenuValue>GPT-6.1-Sol extra high</DropdownMenuValue>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>High</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem>
            Command palette<DropdownMenuShortcut>⌘K</DropdownMenuShortcut>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it.each(["menu", "sheet"] as const)(
    "keeps the %s row's label on one line and truncates the value at the row's size and tracking",
    async (presentation) => {
      const user = userEvent.setup();
      render(<ValueMenu presentation={presentation} />);
      await user.click(screen.getByRole("button", { name: "Thread settings" }));
      const value = await screen.findByText("GPT-6.1-Sol extra high");
      expect(value).toHaveAttribute("data-slot", "dropdown-menu-item-value");
      // Normal tracking and the row's own size: no wide shortcut tracking,
      // no smaller shortcut text.
      expect(value.className).not.toMatch(/tracking-wide/u);
      expect(value.className).toMatch(/\btracking-normal\b/u);
      expect(value.className).not.toMatch(/text-\(length:/u);
      // It takes the room the one-line label leaves, then truncates; no
      // fixed share of the row caps it.
      expect(value).toHaveClass("truncate", "min-w-0", "shrink", "pl-4");
      expect(value.className).not.toMatch(/max-w-/u);
      const row = value.closest<HTMLElement>("[role=\"menuitem\"]")!;
      expect(row).toHaveClass("whitespace-nowrap");
      // A menu with values is wide enough to show a short one whole.
      if (presentation === "menu") {
        expect(row.closest("[data-slot=\"dropdown-menu-content\"]")).toHaveClass(
          "has-[[data-slot$=item-value]]:min-w-60",
        );
      }
      // The chevron stays beside the value.
      expect(value.nextElementSibling?.tagName.toLowerCase()).toBe("svg");
    },
  );

  it("keeps the shortcut slot for keyboard hints", async () => {
    const user = userEvent.setup();
    render(<ValueMenu presentation="menu" />);
    await user.click(screen.getByRole("button", { name: "Thread settings" }));
    const hint = await screen.findByText("⌘K");
    expect(hint).toHaveAttribute("data-slot", "dropdown-menu-shortcut");
    expect(hint.className).not.toMatch(/tracking-wide/u);
  });
});

describe("sheet drill-in labels", () => {
  function SettingsSheet() {
    const [thinking, setThinking] = useState("low");
    return (
      <DropdownMenu presentation="sheet">
        <DropdownMenuTrigger>Thread settings</DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="Thread settings">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              Thinking<DropdownMenuValue>Low</DropdownMenuValue>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioGroup value={thinking} onValueChange={setThinking}>
                <DropdownMenuRadioItem value="low">Low</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="high">High</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span>
                Draft workspace
                <DropdownMenuItemDescription>acme-web</DropdownMenuItemDescription>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>billing-service</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger textValue="Permission mode">
              Permissions<span>Default</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem>Plan</DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it.each([
    [/^Thinking/, "Thinking", "High"],
    [/^Draft workspace/, "Draft workspace", "billing-service"],
    [/^Permissions/, "Permission mode", "Plan"],
  ] as const)("names the %s pane without its trailing value", async (trigger, label, child) => {
    const user = userEvent.setup();
    render(<SettingsSheet />);
    await user.click(screen.getByRole("button", { name: "Thread settings" }));
    await user.click(screen.getByRole("menuitem", { name: trigger }));
    expect(screen.getByRole("group", { name: label })).toContainElement(
      screen.getByRole(child === "High" ? "menuitemradio" : "menuitem", { name: child }),
    );
    expect(screen.getByRole("menuitem", { name: label })).toHaveAttribute("data-slot", "menu-sheet-back");
  });
});

describe("sheet presentation keeps the content's props", () => {
  it("forwards classes, data attributes and handlers from DropdownMenuContent", async () => {
    const user = userEvent.setup();
    const onPointerDownCapture = vi.fn();
    const onKeyDownCapture = vi.fn();
    const onEscapeKeyDown = vi.fn();
    render(
      <DropdownMenu presentation="sheet">
        <DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label="Thread actions"
          sheetTitle="MCP events"
          className="thread-actions-custom"
          data-testid="thread-actions-menu"
          data-thread-id="thread-1"
          side="bottom"
          align="end"
          sideOffset={8}
          loop
          onPointerDownCapture={onPointerDownCapture}
          onKeyDownCapture={onKeyDownCapture}
          onEscapeKeyDown={onEscapeKeyDown}
        >
          <DropdownMenuItem onSelect={(event) => event.preventDefault()}>Pin</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole("button", { name: "Thread actions" }));
    const sheet = screen.getByRole("dialog", { name: "MCP events" });
    expect(sheet).toBe(screen.getByTestId("thread-actions-menu"));
    expect(sheet).toHaveClass("thread-actions-custom");
    expect(sheet).toHaveAttribute("data-thread-id", "thread-1");
    expect(sheet).toHaveAttribute("data-menu-sheet");
    for (const floatingOnly of ["side", "align", "sideoffset", "loop", "aria-label"]) {
      expect(sheet).not.toHaveAttribute(floatingOnly);
    }
    expect(screen.getByRole("menu", { name: "Thread actions" })).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: "Pin" }));
    expect(onPointerDownCapture).toHaveBeenCalled();
    await user.keyboard("{ArrowDown}");
    expect(onKeyDownCapture).toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(onEscapeKeyDown).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("forwards handlers from ContextMenuContent and still returns focus", async () => {
    const user = userEvent.setup();
    const onKeyDownCapture = vi.fn();
    const onCloseAutoFocus = vi.fn();
    render(
      <ContextMenu presentation="sheet">
        <ContextMenuTrigger asChild>
          <button type="button">MCP events row</button>
        </ContextMenuTrigger>
        <ContextMenuContent
          sheetTitle="MCP events"
          className="thread-context-custom"
          data-testid="thread-context-menu"
          collisionPadding={12}
          onKeyDownCapture={onKeyDownCapture}
          onCloseAutoFocus={onCloseAutoFocus}
        >
          <ContextMenuItem>Pin</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>,
    );
    const row = screen.getByRole("button", { name: "MCP events row" });
    row.focus();
    fireEvent.contextMenu(row);
    const sheet = screen.getByTestId("thread-context-menu");
    expect(sheet).toHaveClass("thread-context-custom");
    expect(sheet).not.toHaveAttribute("collisionpadding");
    await user.keyboard("{ArrowDown}");
    expect(onKeyDownCapture).toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(onCloseAutoFocus).toHaveBeenCalledOnce());
    await waitFor(() => expect(row).toHaveFocus());
  });
});

describe("dropdown sheets opened without a trigger click", () => {
  function ControlledMenu({
    open,
    defaultOpen,
    onOpenChange,
  }: {
    readonly open?: boolean;
    readonly defaultOpen?: boolean;
    readonly onOpenChange?: (open: boolean) => void;
  }) {
    return (
      <DropdownMenu presentation="sheet" open={open} defaultOpen={defaultOpen} onOpenChange={onOpenChange}>
        <DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>
        <DropdownMenuContent sheetTitle="MCP events">
          <DropdownMenuItem>Pin</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  it("returns focus to the trigger after a controlled open", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <ControlledMenu open={open} onOpenChange={setOpen} />
          <button type="button" onKeyDown={(event) => event.key === "o" && setOpen(true)}>
            Shortcut
          </button>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Thread actions" });
    const shortcut = screen.getByRole("button", { name: "Shortcut" });
    shortcut.focus();
    fireEvent.keyDown(shortcut, { key: "o" });
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("returns focus to the trigger after opening with defaultOpen", async () => {
    const user = userEvent.setup();
    render(<ControlledMenu defaultOpen />);
    expect(screen.getByRole("dialog", { name: "MCP events" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Thread actions" })).toHaveFocus());
  });

  it("skips a trigger that is no longer in the document", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(true);
      const [showTrigger, setShowTrigger] = useState(true);
      return (
        <DropdownMenu presentation="sheet" open={open} onOpenChange={setOpen}>
          {showTrigger && <DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>}
          <DropdownMenuContent sheetTitle="MCP events">
            <DropdownMenuItem onSelect={() => setShowTrigger(false)}>Archive</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      );
    }
    render(<Harness />);
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Thread actions" })).toBeNull();
    expect(document.body).toHaveFocus();
  });
});
