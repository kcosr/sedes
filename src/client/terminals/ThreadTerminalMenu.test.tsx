// @vitest-environment jsdom

import { useRef } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalResource } from "../../shared/index.js";
import { ThreadTerminalMenu, type ThreadTerminalMenuHandle, type ThreadTerminalMenuProps } from "./ThreadTerminalMenu.js";

function TerminalMenuFixture(props: Omit<ThreadTerminalMenuProps, "onRename"> & Partial<Pick<ThreadTerminalMenuProps, "onRename">>) {
  const menu = useRef<ThreadTerminalMenuHandle>(null);
  return <>
    <button onClick={event => menu.current?.open(event.shiftKey ? "single" : "split", event.currentTarget)}>Open Terminals panel</button>
    <button onClick={event => menu.current?.create(event.currentTarget)}>Create terminal directly</button>
    <ThreadTerminalMenu onRename={vi.fn().mockResolvedValue(undefined)} {...props} ref={menu} />
  </>;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({
    matches: false,
    media: "(max-width: 819px), (pointer: coarse)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const terminal: TerminalResource = {
  terminalId: "00000000-0000-4000-8000-000000000010",
  threadId: "00000000-0000-4000-8000-000000000011",
  workspaceId: "00000000-0000-4000-8000-000000000012",
  environmentId: "local",
  environmentLabel: "Local",
  incarnationId: "00000000-0000-4000-8000-000000000013",
  displayName: "Build shell",
  shellProfile: null,
  initialCwd: "/workspace",
  lifecycle: "running",
  terminationEffect: "end_process",
  lifecycleRevision: 1,
  rows: 24,
  columns: 80,
  initialRows: 24,
  initialColumns: 80,
  historyFloorSeq: 0,
  headSeq: 0,
  exitCode: null,
  exitSignal: null,
  publicReason: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  startedAt: "2026-08-27T00:00:00.000Z",
  exitedAt: null,
  updatedAt: "2026-08-27T00:00:00.000Z",
};

function api(terminals: readonly TerminalResource[] = [terminal]) {
  return {
    listTerminals: vi.fn().mockResolvedValue({ terminals }),
    createTerminal: vi.fn().mockResolvedValue({ terminal }),
    renameTerminal: vi.fn(),
    endTerminal: vi.fn(),
    deleteTerminal: vi.fn(),
  };
}

describe("ThreadTerminalMenu", () => {
  it("opens terminals independently through panel activation and the tab menu", async () => {
    const client = api();
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open Terminals panel",
    });
    expect(trigger.querySelector(".thread-terminal-count")).toBeNull();
    expect(trigger.querySelector(".lucide-chevron-down")).toBeNull();
    expect(trigger).not.toHaveAttribute("title");
    const menuTrigger = screen.getByRole("button", { name: "Open terminal tab" });
    expect(menuTrigger.querySelector(".lucide-plus")).not.toBeNull();
    expect(menuTrigger).not.toHaveAttribute("title");
    fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: /Build shell.*Running/u })).toBeVisible();
    expect(client.listTerminals).toHaveBeenCalledWith(terminal.threadId, expect.any(AbortSignal));
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("menuitem", { name: /Build shell.*Running/u }));
    expect(onOpen).toHaveBeenCalledWith(terminal);
    await waitFor(() => expect(menuTrigger).not.toHaveFocus());

    onOpen.mockClear();
    fireEvent.click(trigger, { shiftKey: true });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(terminal, "single"));
  });

  it("reveals an existing terminal panel without changing its active tab", () => {
    const client = api();
    const onOpen = vi.fn();
    const onReveal = vi.fn().mockReturnValue(true);
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
        onReveal={onReveal}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open Terminals panel",
      }),
    );

    expect(onReveal).toHaveBeenCalledWith("split");
    expect(client.listTerminals).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("creates and opens the first terminal through panel activation", async () => {
    const client = api([]);
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Open Terminals panel",
    });
    expect(trigger).toBeEnabled();
    fireEvent.click(trigger, { shiftKey: true });
    fireEvent.click(trigger, { shiftKey: true });

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(terminal, "single"));
    expect(client.listTerminals).toHaveBeenCalledOnce();
    expect(client.createTerminal).toHaveBeenCalledOnce();

    const menuTrigger = screen.getByRole("button", { name: "Open terminal tab" });
    fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false });
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(menuTrigger).toHaveFocus());
  });

  it("keeps the terminal menu from superseding the primary inventory request", async () => {
    let resolveList!: (value: { terminals: readonly TerminalResource[] }) => void;
    const client = api([]);
    client.listTerminals.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveList = resolve;
      }) as never,
    );
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Open Terminals panel",
    }));
    const menuTrigger = screen.getByRole("button", { name: "Open terminal tab" });
    await waitFor(() => expect(menuTrigger).toBeDisabled());
    fireEvent.pointerDown(menuTrigger, { button: 0, ctrlKey: false });
    expect(client.listTerminals).toHaveBeenCalledOnce();

    resolveList({ terminals: [] });
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(terminal, "split"));
    expect(client.listTerminals).toHaveBeenCalledOnce();
    expect(client.createTerminal).toHaveBeenCalledOnce();
  });

  it("creates a terminal when only non-openable retained records exist", async () => {
    const retained: TerminalResource = {
      ...terminal,
      incarnationId: null,
      lifecycle: "interrupted",
      publicReason: "provider_connection_lost",
      exitedAt: "2026-08-27T00:05:00.000Z",
    };
    const client = api([retained]);
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button", {
      name: "Open Terminals panel",
    }));

    await waitFor(() => expect(client.createTerminal).toHaveBeenCalledOnce());
    expect(onOpen).toHaveBeenCalledWith(terminal, "split");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows list failures in the menu and retries the primary action", async () => {
    const client = api([]);
    client.listTerminals
      .mockRejectedValueOnce(new Error("Terminal inventory is unavailable."))
      .mockResolvedValue({ terminals: [] });
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Terminals panel" }));

    expect(await screen.findByRole("menuitem", {
      name: "Terminal inventory is unavailable.",
    })).toBeVisible();
    expect(client.listTerminals).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(terminal, "split"));
    expect(client.listTerminals).toHaveBeenCalledTimes(2);
    expect(client.createTerminal).toHaveBeenCalledOnce();
  });

  it("clears a stale primary-entry retry on a later normal menu open", async () => {
    const client = api([]);
    client.listTerminals
      .mockRejectedValueOnce(new Error("Terminal inventory is unavailable."))
      .mockResolvedValue({ terminals: [terminal] });
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Terminals panel" }));
    expect(await screen.findByRole("menuitem", { name: "Retry" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open terminal tab" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(await screen.findByRole("menuitem", {
      name: /Build shell.*Running/u,
    })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Retry" })).toBeNull();
  });

  it("reuses the create mutation when the primary action is retried", async () => {
    const client = api([]);
    client.createTerminal
      .mockRejectedValueOnce(new Error("Terminal creation is unavailable."))
      .mockResolvedValueOnce({ terminal });
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Open Terminals panel" }));
    expect(await screen.findByRole("menuitem", {
      name: "Terminal creation is unavailable.",
    })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "Retry" }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(terminal, "split"));
    expect(client.createTerminal).toHaveBeenCalledTimes(2);
    const firstRequest = client.createTerminal.mock.calls[0]?.[1];
    const secondRequest = client.createTerminal.mock.calls[1]?.[1];
    expect(secondRequest?.mutationId).toBe(firstRequest?.mutationId);
  });

  it("retries an ambiguous direct create through the tab menu using the same mutation", async () => {
    const client = api([]);
    client.createTerminal.mockRejectedValueOnce(new Error("Create response lost.")).mockResolvedValueOnce({ terminal });
    const onOpen = vi.fn();
    render(<TerminalMenuFixture threadId={terminal.threadId} api={client as never} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole("button", { name: "Create terminal directly" }));
    expect(await screen.findByText("Create response lost.")).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "New terminal" }));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(terminal));
    expect(client.createTerminal).toHaveBeenCalledTimes(2);
    expect(client.createTerminal.mock.calls[1]![1].mutationId).toBe(client.createTerminal.mock.calls[0]![1].mutationId);
  });

  it("creates a default terminal and opens it", async () => {
    const client = api([]);
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open terminal tab" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "New terminal" }));

    await waitFor(() => expect(onOpen).toHaveBeenCalledWith(terminal));
    expect(client.createTerminal).toHaveBeenCalledWith(
      terminal.threadId,
      expect.objectContaining({ displayName: "Terminal", rows: 24, columns: 80 }),
    );
  });

  it("keeps tab creation within the current presentation even with Shift", async () => {
    let resolveCreate!: (value: { terminal: TerminalResource }) => void;
    const client = api([]);
    client.createTerminal.mockReturnValue(
      new Promise((resolve) => {
        resolveCreate = resolve;
      }) as never,
    );
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open terminal tab" }), {
      button: 0,
      ctrlKey: false,
    });
    const create = await screen.findByRole("menuitem", { name: "New terminal" });
    fireEvent.pointerDown(create, { button: 0, shiftKey: true });
    fireEvent.click(create);
    localStorage.setItem("sedes-panel-presentation", "single");
    resolveCreate({ terminal });

    await waitFor(() =>
      expect(onOpen).toHaveBeenCalledWith(terminal),
    );
  });

  it("does not leak a canceled Shift gesture into a later keyboard selection", async () => {
    const client = api();
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open terminal tab" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const firstEntry = await screen.findByRole("menuitem", {
      name: /Build shell.*Running/u,
    });
    fireEvent.pointerDown(firstEntry, { button: 0, shiftKey: true });
    fireEvent.keyDown(firstEntry, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    const reopenedEntry = await screen.findByRole("menuitem", {
      name: /Build shell.*Running/u,
    });
    fireEvent.keyDown(reopenedEntry, { key: "Enter" });

    expect(onOpen).toHaveBeenCalledWith(terminal);
  });

  it("uses the same new-or-existing menu from a terminal tab add button", async () => {
    const client = api();
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        triggerVariant="tab"
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open terminal tab" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Build shell.*Running/u }),
    );
    expect(onOpen).toHaveBeenCalledWith(terminal);
  });

  it("disables terminals already open in the current terminal panel", async () => {
    const otherTerminal: TerminalResource = {
      ...terminal,
      terminalId: "00000000-0000-4000-8000-000000000014",
      displayName: "Test shell",
    };
    const client = api([terminal, otherTerminal]);
    const onOpen = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        triggerVariant="tab"
        displayedTerminalIds={new Set([terminal.terminalId])}
        api={client as never}
        onOpen={onOpen}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open terminal tab" }),
      { button: 0, ctrlKey: false },
    );
    const displayed = await screen.findByRole("menuitem", {
      name: /Build shell.*Running · Open/u,
    });
    expect(displayed).toHaveAttribute("aria-disabled", "true");
    expect(displayed).toHaveAttribute(
      "title",
      "Already open in this terminal panel",
    );
    fireEvent.click(displayed);
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("menuitem", { name: /Test shell.*Running/u }),
    );
    expect(onOpen).toHaveBeenCalledWith(otherTerminal);
  });

  it("describes remote teardown as disconnecting without promising process termination", async () => {
    const remote = { ...terminal, terminationEffect: "disconnect_transport" as const };
    const client = api([remote]);
    client.endTerminal.mockResolvedValue({ terminal: null } as never);
    render(<TerminalMenuFixture threadId={terminal.threadId} api={client as never} onOpen={vi.fn()} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Open terminal tab" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect and remove Build shell" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect and remove?" });
    expect(dialog).toHaveTextContent("Remote processes may continue running.");
    expect(client.endTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect and remove" }));
    await waitFor(() => expect(client.endTerminal).toHaveBeenCalledWith(terminal.terminalId, expect.objectContaining({ expectedRevision: terminal.lifecycleRevision })));
  });

  it("keeps unattached retained records removable and renamable from the tab menu", async () => {
    const retained = { ...terminal, incarnationId: null, lifecycle: "interrupted" as const };
    const client = api([retained]);
    const onRename = vi.fn().mockRejectedValueOnce(new Error("Rename response lost.")).mockResolvedValueOnce(undefined);
    render(<TerminalMenuFixture threadId={terminal.threadId} api={client as never} onOpen={vi.fn()} onRename={onRename} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Open terminal tab" }), { button: 0, ctrlKey: false });
    const record = await screen.findByRole("menuitem", { name: /Build shell.*Interrupted/u });
    expect(record).toHaveAttribute("data-disabled");
    expect(screen.getByRole("menuitem", { name: "Tear down and remove Build shell" })).not.toHaveAttribute("data-disabled");
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename Build shell" }));
    const input = screen.getByRole("textbox", { name: "Terminal name" });
    fireEvent.change(input, { target: { value: "Retained shell" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Rename response lost.");
    expect(input).toHaveValue("Retained shell");
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename terminal" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "Open terminal tab" })).toHaveFocus());
    expect(onRename.mock.calls).toEqual([[retained.terminalId, "Retained shell"], [retained.terminalId, "Retained shell"]]);
    expect(client.createTerminal).not.toHaveBeenCalled();
  });

  it.each(["Cancel", "Escape"])("restores tab-menu focus after dismissing rename with %s", async (dismiss) => {
    const onRename = vi.fn();
    render(<TerminalMenuFixture threadId={terminal.threadId} api={api() as never} onOpen={vi.fn()} onRename={onRename} />);
    const trigger = screen.getByRole("button", { name: "Open terminal tab" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename Build shell" }));
    expect(screen.getByRole("dialog", { name: "Rename terminal" })).toBeVisible();
    if (dismiss === "Cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    else fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal name" }), { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onRename).not.toHaveBeenCalled();
  });

  it("cancels lifecycle removal without mutating retained resources", async () => {
    const client = api();
    render(<TerminalMenuFixture threadId={terminal.threadId} api={client as never} onOpen={vi.fn()} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Open terminal tab" }), { button: 0, ctrlKey: false });
    expect(screen.queryByRole("menuitem", { name: "Manage terminals…" })).toBeNull();
    expect(screen.queryByText("New from this")).toBeNull();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Tear down and remove Build shell" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(client.endTerminal).not.toHaveBeenCalled();
    expect(client.deleteTerminal).not.toHaveBeenCalled();
  });

  it("confirms and tears down a running terminal from the terminal menu", async () => {
    const client = api();
    client.endTerminal.mockResolvedValue({ terminal: null } as never);
    const onDelete = vi.fn();
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={vi.fn()}
        onDelete={onDelete}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Open terminal tab" });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Tear down and remove Build shell",
      }),
    );

    const firstConfirmation = await screen.findByRole("dialog", {
      name: "End terminal?",
    });
    expect(firstConfirmation).toHaveTextContent(
      "End Build shell and permanently remove its retained history?",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(client.endTerminal).not.toHaveBeenCalled();

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Tear down and remove Build shell",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "End terminal" }),
    );

    await waitFor(() => expect(client.endTerminal).toHaveBeenCalledOnce());
    expect(client.endTerminal).toHaveBeenCalledWith(terminal.terminalId, {
      mutationId: expect.any(String),
      expectedRevision: terminal.lifecycleRevision,
    });
    expect(onDelete).toHaveBeenCalledWith(terminal.terminalId);
  });

  it("confirms and removes a retained terminal from the terminal menu", async () => {
    const retained: TerminalResource = {
      ...terminal,
      lifecycle: "interrupted",
      lifecycleRevision: 2,
      publicReason: "provider_connection_lost",
      exitedAt: "2026-08-27T00:05:00.000Z",
    };
    const client = api([retained]);
    const onResourceChange = vi.fn();
    const onDelete = vi.fn();
    client.deleteTerminal.mockResolvedValue({ terminal: null } as never);
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={vi.fn()}
        onResourceChange={onResourceChange}
        onDelete={onDelete}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open terminal tab" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Tear down and remove Build shell",
      }),
    );
    const confirmation = await screen.findByRole("dialog", {
      name: "Remove terminal?",
    });
    expect(confirmation).toHaveTextContent(
      "Remove Build shell and permanently delete its retained history?",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove terminal" }),
    );

    await waitFor(() => expect(client.deleteTerminal).toHaveBeenCalledOnce());
    expect(client.deleteTerminal).toHaveBeenCalledWith(retained.terminalId, {
      mutationId: expect.any(String),
      expectedRevision: retained.lifecycleRevision,
    });
    expect(client.endTerminal).not.toHaveBeenCalled();
    expect(onResourceChange).toHaveBeenCalledWith(retained);
    expect(onDelete).toHaveBeenCalledWith(retained.terminalId);
  });

  it("keeps teardown errors visible and refreshes the confirmation action", async () => {
    const interrupted: TerminalResource = {
      ...terminal,
      lifecycle: "interrupted",
      lifecycleRevision: 2,
      publicReason: "cleanup_unconfirmed",
      exitedAt: "2026-08-27T00:05:00.000Z",
    };
    const client = api();
    client.listTerminals
      .mockResolvedValueOnce({ terminals: [terminal] })
      .mockResolvedValueOnce({ terminals: [interrupted] });
    client.endTerminal.mockRejectedValue(
      new Error("Terminal cleanup could not be confirmed."),
    );
    client.deleteTerminal.mockResolvedValue({ terminal: null } as never);
    render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open terminal tab" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Tear down and remove Build shell",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "End terminal" }),
    );

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("Terminal cleanup could not be confirmed.");
    expect(
      screen.getByRole("dialog", { name: "Remove terminal?" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Remove terminal" }));

    await waitFor(() => expect(client.deleteTerminal).toHaveBeenCalledOnce());
    expect(client.deleteTerminal).toHaveBeenCalledWith(interrupted.terminalId, {
      mutationId: expect.any(String),
      expectedRevision: interrupted.lifecycleRevision,
    });
  });

  it("does not restore teardown state after switching threads mid-request", async () => {
    let rejectEnd!: (error: Error) => void;
    const client = api();
    client.endTerminal.mockReturnValue(
      new Promise((_, reject) => {
        rejectEnd = reject;
      }) as never,
    );
    const onDelete = vi.fn();
    const view = render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        triggerVariant="tab"
        api={client as never}
        onOpen={vi.fn()}
        onDelete={onDelete}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open terminal tab" }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Tear down and remove Build shell",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "End terminal" }),
    );

    view.rerender(
      <TerminalMenuFixture
        threadId="00000000-0000-4000-8000-000000000099"
        triggerVariant="tab"
        api={client as never}
        onOpen={vi.fn()}
        onDelete={onDelete}
      />,
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    rejectEnd(new Error("Terminal cleanup could not be confirmed."));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.endTerminal).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(client.listTerminals).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("closes lifecycle confirmation on a thread change", async () => {
    const client = api();
    const view = render(
      <TerminalMenuFixture
        threadId={terminal.threadId}
        api={client as never}
        onOpen={vi.fn()}
      />,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Open terminal tab" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Tear down and remove Build shell" }),
    );
    expect(
      screen.getByRole("dialog", { name: "End terminal?" }),
    ).toBeVisible();

    view.rerender(
      <TerminalMenuFixture
        threadId="00000000-0000-4000-8000-000000000099"
        api={client as never}
        onOpen={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(client.endTerminal).not.toHaveBeenCalled();
  });
});
