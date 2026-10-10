// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/ApiClient.js";
import { pushHistoryEntry } from "../app/router.js";
import { setConfirmTerminalTermination } from "../app/settings.js";
import type { TerminalResource } from "../../shared/index.js";
import {
  SECOND_TERMINAL_ID,
  TERMINAL_ID,
  applicationStore,
  filesTenant,
  harness,
  installPanelLayoutHarness,
  layoutElement,
  noStorage,
  openPanelsMenu,
  setApi,
  setup,
  terminalResource,
} from "./panel-layout.fixtures.js";
import { PanelRegionStore } from "./region-store.js";
import { WorkspacePanelTenantRegistry } from "./registry.js";

vi.mock("../terminals/TerminalPanel.js", async () => ({
  TerminalPanel: (await import("./panel-layout.terminal-fixture.js"))
    .TerminalPanelFixture,
}));

installPanelLayoutHarness();

describe("PanelLayout Terminals panel", () => {
  it("keeps the terminal mounted while hidden, moved or behind a maximized panel", async () => {
    setApi({
      readTerminal: vi.fn().mockResolvedValue(terminalResource()),
      createTerminalAdmission: vi.fn(),
      terminalWebSocketUrl: vi.fn(),
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: false }));
    const terminal = await screen.findByRole("region", { name: "Remote shell terminal" });
    expect(terminal).toHaveAttribute("data-visible", "true");
    expect(screen.getByRole("region", { name: "Terminals panel" })).toHaveAttribute(
      "data-region",
      "bottom",
    );
    const toggle = within(screen.getByTestId("workspace-workbench-bar")).getByTestId(
      "terminals-panel-toggle",
    );

    // Hidden by its quick button: still loaded, still mounted, not visible.
    fireEvent.click(toggle);
    expect(store.isLoaded("terminals")).toBe(true);
    expect(screen.queryByRole("region", { name: "Terminals panel" })).toBeNull();
    expect(terminal).toBeInTheDocument();
    expect(terminal).toHaveAttribute("data-visible", "false");

    fireEvent.click(toggle);
    expect(terminal).toHaveAttribute("data-visible", "true");

    // Moved to the Right, and behind a maximized Chat: the same renderer.
    act(() => {
      store.move("terminals", "right");
    });
    expect(screen.getByRole("region", { name: "Terminals panel" })).toHaveAttribute(
      "data-region",
      "right",
    );
    act(() => {
      store.maximize("chat");
    });
    expect(terminal).toHaveAttribute("data-visible", "false");
    act(() => {
      store.restore();
    });
    expect(screen.getByRole("region", { name: "Remote shell terminal" })).toBe(terminal);
    expect(terminal).toHaveAttribute("data-terminal-panel-instance", "1");
  });

  it("reopens an existing terminal from the panel list without creating a shell", async () => {
    const resource = terminalResource();
    const listTerminals = vi.fn().mockResolvedValue({ terminals: [resource] });
    const createTerminal = vi.fn();
    Object.assign(applicationStore.api, { listTerminals, createTerminal });
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    await waitFor(() => expect(store.terminalPanel()?.activeTerminalId).toBe(resource.terminalId));
    expect(listTerminals).toHaveBeenCalledWith("thread-1", undefined);
    expect(createTerminal).not.toHaveBeenCalled();
    act(() => store.toggle("terminals"));
    expect(store.isLoaded("terminals")).toBe(true);
    expect(store.isVisible("terminals")).toBe(false);
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals, Loaded, hidden" }));
    expect(store.isVisible("terminals")).toBe(true);
    expect(listTerminals).toHaveBeenCalledTimes(1);
  });

  it("keeps the empty Terminals panel after its last tab closes and creates a new terminal on request", async () => {
    const first = terminalResource();
    const next = terminalResource(SECOND_TERMINAL_ID, "New shell");
    const createTerminal = vi.fn().mockResolvedValue({ terminal: next });
    const listTerminals = vi.fn().mockResolvedValue({ terminals: [first] });
    Object.assign(applicationStore.api, {
      readTerminal: vi.fn(async (id: string) => id === first.terminalId ? first : next),
      createTerminal, listTerminals,
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
    });
    const store = setup();
    act(() => store.openTerminalTab(first.terminalId, { focus: true }));
    await screen.findByRole("tab", { name: "Remote shell" });
    act(() => store.closeTerminalTab(first.terminalId));
    expect(store.terminalPanel()).toMatchObject({ tabs: [], activeTerminalId: null });
    expect(screen.getByText("No terminals open")).toBeVisible();
    expect(within(screen.getByRole("tablist", { name: "Terminal tabs" })).queryAllByRole("tab")).toEqual([]);
    expect(createTerminal).not.toHaveBeenCalled();
    act(() => store.toggle("terminals"));
    expect(store.isLoaded("terminals")).toBe(true);
    expect(store.isVisible("terminals")).toBe(false);
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals, Loaded, hidden" }));
    expect(screen.getByText("No terminals open")).toBeVisible();
    expect(listTerminals).not.toHaveBeenCalled();
    expect(createTerminal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "New terminal" }));
    await waitFor(() => expect(store.terminalPanel()?.activeTerminalId).toBe(next.terminalId));
    expect(createTerminal).toHaveBeenCalledOnce();
    expect(screen.queryByText("No terminals open")).toBeNull();
  });

  it("returns focus to Panels after dismissing a terminal entry failure", async () => {
    Object.assign(applicationStore.api, { listTerminals: vi.fn().mockRejectedValue(new Error("Inventory unavailable")) });
    setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    const dialog = await screen.findByRole("dialog", { name: "Could not open Terminals" });
    expect(dialog).toHaveAccessibleDescription("Inventory unavailable");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Panels" })).toHaveFocus());
  });

  it("creates a terminal when no retained terminal is attachable", async () => {
    Object.assign(applicationStore.api, {
      listTerminals: vi.fn().mockResolvedValue({ terminals: [{ ...terminalResource(), incarnationId: null }] }),
      createTerminal: vi.fn().mockResolvedValue({ terminal: terminalResource() }),
    });
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    await waitFor(() => expect(applicationStore.api.createTerminal).toHaveBeenCalledOnce());
    expect(store.terminalPanel()?.activeTerminalId).toBe(TERMINAL_ID);
  });

  it("retries terminal inventory failures before creating a shell", async () => {
    const resource = terminalResource();
    const listTerminals = vi.fn().mockRejectedValueOnce(new Error("Inventory unavailable")).mockResolvedValue({ terminals: [] });
    const createTerminal = vi.fn().mockResolvedValue({ terminal: resource });
    Object.assign(applicationStore.api, { listTerminals, createTerminal });
    const store = setup();
    await openPanelsMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Terminals" }));
    const dialog = await screen.findByRole("dialog", { name: "Could not open Terminals" });
    expect(within(dialog).getByText("Inventory unavailable")).toBeInTheDocument();
    expect(createTerminal).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(store.terminalPanel()?.activeTerminalId).toBe(resource.terminalId));
    expect(createTerminal).toHaveBeenCalledTimes(1);
  });


  it("keeps transient terminal lookup failures retryable", async () => {
    const readTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockImplementation(() => new Promise(() => undefined));
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    const terminalTabs = await screen.findByRole("tablist", {
      name: "Terminal tabs",
    });
    const terminalTab = screen.getByRole("tab", { name: "Terminal" });
    expect(terminalTabs).toContainElement(terminalTab);
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Terminal" })).toHaveAttribute(
      "aria-labelledby",
      terminalTab.id,
    );
    expect(
      await screen.findByText(/Couldn’t load this terminal/),
    ).toHaveTextContent("Network unavailable");
    expect(screen.queryByText(/retained history was deleted/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Loading terminal…")).toBeInTheDocument();
  });

  it("labels known-gone terminals separately and allows re-attempting lookup", async () => {
    const readTerminal = vi
      .fn()
      .mockRejectedValue(
        new ApiError(404, "terminal_not_found", "Terminal not found.", false),
      );
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    expect(
      await screen.findByRole("tablist", { name: "Terminal tabs" }),
    ).toContainElement(screen.getByRole("tab", { name: "Terminal" }));
    expect(
      await screen.findByText("This terminal is no longer available."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Re-attempt lookup" }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(2));
  });

  it("deduplicates concurrent terminal lookups across resource updates", async () => {
    const thirdTerminalId = "44444444-4444-4444-8444-444444444444";
    const pending = new Map<
      string,
      (terminal: TerminalResource) => void
    >();
    const readTerminal = vi.fn(
      (terminalId: string) =>
        new Promise<TerminalResource>((resolve) => {
          pending.set(terminalId, resolve);
        }),
    );
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
      store.openTerminalTab(thirdTerminalId, { focus: false });
    });
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(3));

    await act(async () => {
      pending.get(TERMINAL_ID)?.(
        terminalResource(TERMINAL_ID, "First shell"),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "First shell" }),
    ).toBeInTheDocument();
    expect(readTerminal).toHaveBeenCalledTimes(3);

    await act(async () => {
      pending.get(SECOND_TERMINAL_ID)?.(
        terminalResource(SECOND_TERMINAL_ID, "Second shell"),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "Second shell" }),
    ).toBeInTheDocument();
    expect(readTerminal).toHaveBeenCalledTimes(3);

    await act(async () => {
      pending.get(thirdTerminalId)?.(
        terminalResource(thirdTerminalId, "Third shell"),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "Third shell" }),
    ).toBeInTheDocument();
    expect(readTerminal).toHaveBeenCalledTimes(3);
  });

  it("does not let a slow lookup overwrite a newer inventory resource", async () => {
    harness.applicationState = {
      ...harness.applicationState,
      connection: "connected",
      authoritative: true,
      snapshot: {
        threads: [
          {
            id: "thread-1",
            terminalSummary: { runningCount: 1, retainedCount: 1 },
          },
        ],
      },
    };
    let settleLookup: ((terminal: TerminalResource) => void) | undefined;
    const readTerminal = vi.fn(
      () =>
        new Promise<TerminalResource>((resolve) => {
          settleLookup = resolve;
        }),
    );
    const newer = {
      ...terminalResource(TERMINAL_ID, "Newer shell"),
      lifecycleRevision: 2,
    };
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        listTerminals: vi.fn().mockResolvedValue({ terminals: [newer] }),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: false }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    expect(
      await screen.findByRole("tab", { name: "Newer shell" }),
    ).toBeInTheDocument();

    await act(async () => {
      settleLookup?.(terminalResource(TERMINAL_ID, "Older shell"));
      await Promise.resolve();
    });

    expect(readTerminal).toHaveBeenCalledOnce();
    expect(screen.getByRole("tab", { name: "Newer shell" })).toBeVisible();
    expect(screen.queryByRole("tab", { name: "Older shell" })).toBeNull();
  });

  it("removes the local resource, rendered history, and tab after a remote End", async () => {
    const readTerminal = vi.fn().mockResolvedValue(terminalResource());
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    expect(
      await screen.findByText("stale rendered terminal history"),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Remote shell" })).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Simulate terminal removed" }),
    );

    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(screen.queryByText("stale rendered terminal history")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Remote shell" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Remote shell ended. Its retained terminal history was removed.",
    );
  });

  it("offers cancellation before ending a running terminal from its tab", async () => {
    const resource = terminalResource();
    const endTerminal = vi.fn().mockResolvedValue({ terminal: null });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        endTerminal,
        deleteTerminal: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });

    fireEvent.click(screen.getByRole("button", { name: "Close Remote shell terminal" }));

    const confirmation = await screen.findByRole("dialog", {
      name: "Close terminal?",
    });
    expect(within(confirmation).getByRole("button", { name: "Close tab" })).toHaveFocus();
    expect(endTerminal).not.toHaveBeenCalled();
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Cancel" }),
    );
    expect(screen.queryByRole("dialog", { name: "Close terminal?" })).toBeNull();
    expect(endTerminal).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Close Remote shell terminal" }));
    const confirmedDialog = await screen.findByRole("dialog", {
      name: "Close terminal?",
    });
    fireEvent.click(
      within(confirmedDialog).getByRole("button", { name: "End terminal" }),
    );

    await waitFor(() => expect(endTerminal).toHaveBeenCalledOnce());
    expect(endTerminal).toHaveBeenCalledWith(
      resource.terminalId,
      expect.objectContaining({ expectedRevision: resource.lifecycleRevision }),
    );
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Remote shell ended. Its retained terminal history was removed.",
    );
  });

  it.each(["running", "starting", "stopping"] as const)("can close a %s terminal tab without ending its session", async (lifecycle) => {
    const resource = { ...terminalResource(), lifecycle };
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(resource),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Close Remote shell terminal" }));
    const dialog = await screen.findByRole("dialog", { name: "Close terminal?" });
    if (lifecycle === "stopping") {
      expect(within(dialog).queryByRole("button", { name: "End terminal" })).toBeNull();
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(endTerminal).not.toHaveBeenCalled();
    expect(deleteTerminal).not.toHaveBeenCalled();
  });

  it.each([true, false])("disconnects an SSH terminal with confirmation %s without promising remote process termination", async (confirm) => {
    setConfirmTerminalTermination(confirm);
    const resource = { ...terminalResource(), terminationEffect: "disconnect_transport" as const };
    const endTerminal = vi.fn().mockResolvedValue({ terminal: null });
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(resource),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", {
      name: confirm ? "Close Remote shell terminal" : "Disconnect Remote shell terminal and remove history",
    }));
    if (confirm) {
      const dialog = await screen.findByRole("dialog", { name: "Close terminal?" });
      expect(dialog).toHaveTextContent("disconnect the SSH session and remove its history. Remote processes may continue running.");
      expect(within(dialog).queryByRole("button", { name: "End terminal" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Close tab" })).toHaveFocus();
      expect(endTerminal).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect and remove" }));
    } else {
      expect(screen.queryByRole("dialog")).toBeNull();
    }
    await waitFor(() => expect(endTerminal).toHaveBeenCalledWith(TERMINAL_ID, expect.objectContaining({ expectedRevision: resource.lifecycleRevision })));
    expect(deleteTerminal).not.toHaveBeenCalled();
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("removes ended SSH terminal history directly", async () => {
    const deleteTerminal = vi.fn().mockResolvedValue({ terminal: null });
    const endTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue({ ...terminalResource(), lifecycle: "exited", terminationEffect: "disconnect_transport" }),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(), endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Remote shell terminal and history" }));
    await waitFor(() => expect(deleteTerminal).toHaveBeenCalledOnce());
    expect(endTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("ends an active terminal without confirmation and prevents duplicate pending requests", async () => {
    setConfirmTerminalTermination(false);
    let finish: ((value: { terminal: null }) => void) | undefined;
    const endTerminal = vi.fn(() => new Promise<{ terminal: null }>((resolve) => { finish = resolve; }));
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(terminalResource()),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal, deleteTerminal: vi.fn(),
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    const close = await screen.findByRole("button", { name: "End Remote shell terminal and remove history" });
    fireEvent.click(close);
    fireEvent.click(close);
    await waitFor(() => expect(endTerminal).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    await act(async () => { finish?.({ terminal: null }); });
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("keeps ended terminal history open when removal fails", async () => {
    const deleteTerminal = vi.fn().mockRejectedValue(new Error("History could not be removed."));
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue({ ...terminalResource(), lifecycle: "exited" }),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      endTerminal: vi.fn(), deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove Remote shell terminal and history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("History could not be removed.");
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
  });

  it("offers only closing the view while terminal state is unknown", async () => {
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(() => new Promise(() => undefined)),
      endTerminal, deleteTerminal,
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Close Terminal terminal" }));
    const dialog = await screen.findByRole("dialog", { name: "Close terminal?" });
    expect(within(dialog).queryByRole("button", { name: "End terminal" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close tab" }));
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(endTerminal).not.toHaveBeenCalled();
    expect(deleteTerminal).not.toHaveBeenCalled();
  });

  it("resolves unknown state before removing a terminal with confirmation disabled", async () => {
    setConfirmTerminalTermination(false);
    const resource = { ...terminalResource(), lifecycle: "exited" as const, lifecycleRevision: 9 };
    const readTerminal = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValue(resource);
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn().mockResolvedValue({ terminal: null });
    Object.assign(applicationStore, { api: { readTerminal, endTerminal, deleteTerminal } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "End Terminal terminal and remove history" }));
    await waitFor(() => expect(deleteTerminal).toHaveBeenCalledWith(TERMINAL_ID, expect.objectContaining({ expectedRevision: 9 })));
    expect(readTerminal).toHaveBeenCalledTimes(2);
    expect(endTerminal).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
  });

  it("keeps an unknown terminal tab open when authoritative lookup fails", async () => {
    setConfirmTerminalTermination(false);
    const readTerminal = vi.fn()
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockRejectedValue(new Error("Terminal server unavailable."));
    const endTerminal = vi.fn();
    const deleteTerminal = vi.fn();
    Object.assign(applicationStore, { api: { readTerminal, endTerminal, deleteTerminal } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "End Terminal terminal and remove history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Terminal server unavailable.");
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    expect(endTerminal).not.toHaveBeenCalled();
    expect(deleteTerminal).not.toHaveBeenCalled();
  });

  it("shows an inactive terminal removal failure and preserves it when that tab is activated", async () => {
    const active = terminalResource();
    const inactive = { ...terminalResource(SECOND_TERMINAL_ID, "Old shell"), lifecycle: "exited" as const };
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(async (id: string) => id === TERMINAL_ID ? active : inactive),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
      deleteTerminal: vi.fn().mockRejectedValue(new Error("Old shell removal failed.")),
    } });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
    });
    fireEvent.click(await screen.findByRole("button", { name: "Remove Old shell terminal and history" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Old shell removal failed.");
    expect(store.terminalTab(SECOND_TERMINAL_ID)).toBeDefined();
    fireEvent.click(screen.getByRole("tab", { name: /Old shell/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("Old shell removal failed.");
  });


  it("gives the terminal panel menu's disabled rows a reason", async () => {
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(() => new Promise<never>(() => undefined)),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Terminals panel actions" }), { button: 0, ctrlKey: false });
    await screen.findByRole("menu");
    for (const name of ["Transcript", "Clear selection"]) {
      const item = screen.getByRole("menuitem", { name: new RegExp(`^${name}`) });
      expect(item).toHaveAttribute("aria-disabled", "true");
      expect(within(item).getByText("No terminal")).toHaveAttribute("data-slot", "dropdown-menu-item-value");
    }
  });

  it("omits terminal destruction from the panel header menu", async () => {
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn().mockResolvedValue(terminalResource()),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(),
    } });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Terminals panel actions" }), { button: 0, ctrlKey: false });
    await screen.findByRole("menu");
    expect(screen.queryByRole("menuitem", { name: /End terminal|Remove terminal/ })).toBeNull();
  });

  it("renames a terminal tab through the revision-checked terminal contract", async () => {
    const resource = terminalResource();
    const renamed = {
      ...resource,
      displayName: "Build shell",
      lifecycleRevision: resource.lifecycleRevision + 1,
    };
    const renameTerminal = vi.fn().mockResolvedValue({ terminal: renamed });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        renameTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    const tab = await screen.findByRole("tab", { name: "Remote shell" });

    fireEvent.contextMenu(tab);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Remote shell" });
    fireEvent.change(input, { target: { value: " Build shell " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameTerminal).toHaveBeenCalledOnce());
    expect(renameTerminal).toHaveBeenCalledWith(
      resource.terminalId,
      expect.objectContaining({
        expectedRevision: resource.lifecycleRevision,
        displayName: "Build shell",
        mutationId: expect.any(String),
      }),
    );
    expect(
      await screen.findByRole("tab", { name: "Build shell" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Build shell terminal renamed.",
    );
  });

  it("refreshes a conflicting terminal rename and leaves the draft retryable", async () => {
    const resource = terminalResource();
    const authoritative = {
      ...resource,
      displayName: "Remote logs",
      lifecycleRevision: resource.lifecycleRevision + 1,
    };
    const renameTerminal = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, "conflict", "The terminal changed.", false),
      )
      .mockResolvedValueOnce({
        terminal: {
          ...authoritative,
          displayName: "Build shell",
          lifecycleRevision: authoritative.lifecycleRevision + 1,
        },
      });
    const readTerminal = vi
      .fn()
      .mockResolvedValueOnce(resource)
      .mockResolvedValueOnce(authoritative);
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        renameTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.contextMenu(
      await screen.findByRole("tab", { name: "Remote shell" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Remote shell" });
    fireEvent.change(input, { target: { value: "Build shell" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The terminal changed elsewhere. Review its latest name and try again.",
    );
    expect(input).toHaveValue("Build shell");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameTerminal).toHaveBeenCalledTimes(2));
    expect(renameTerminal.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        expectedRevision: authoritative.lifecycleRevision,
        displayName: "Build shell",
      }),
    );
    expect(renameTerminal.mock.calls[1]?.[1].mutationId).not.toBe(
      renameTerminal.mock.calls[0]?.[1].mutationId,
    );
  });

  it("reuses a rename mutation id when an ambiguous request is retried", async () => {
    const resource = terminalResource();
    const renameTerminal = vi
      .fn()
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({
        terminal: {
          ...resource,
          displayName: "Build shell",
          lifecycleRevision: resource.lifecycleRevision + 1,
        },
      });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        renameTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    fireEvent.contextMenu(
      await screen.findByRole("tab", { name: "Remote shell" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Remote shell" });
    fireEvent.change(input, { target: { value: "Build shell" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Network unavailable",
    );
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(renameTerminal).toHaveBeenCalledTimes(2));
    expect(renameTerminal.mock.calls[1]?.[1].mutationId).toBe(
      renameTerminal.mock.calls[0]?.[1].mutationId,
    );
  });

  it("checks terminals already displayed in the terminal tab add menu", async () => {
    const resource = terminalResource();
    const other = terminalResource(SECOND_TERMINAL_ID, "Other shell");
    Object.assign(applicationStore, {
      api: {
        listTerminals: vi.fn().mockResolvedValue({
          terminals: [resource, other],
        }),
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: "Remote shell" });

    fireEvent.pointerDown(
      screen.getByRole("button", { name: "Open terminal tab" }),
      { button: 0, ctrlKey: false },
    );

    const displayed = await screen.findByRole("menuitem", {
      name: /Remote shell.*Running.*open/u,
    });
    expect(displayed.querySelector("svg.lucide-check")).not.toBeNull();
    expect(displayed).not.toHaveAttribute("aria-disabled");
    const otherRow = screen.getByRole("menuitem", { name: /Other shell.*Running/u });
    expect(otherRow.querySelector("svg.lucide-check")).toBeNull();
    expect(otherRow).not.toHaveAttribute("aria-disabled");
  });

  it("mounts an isolated terminal renderer when the active terminal tab changes", async () => {
    const first = terminalResource();
    const second = terminalResource(SECOND_TERMINAL_ID, "Other shell");
    const readTerminal = vi.fn((terminalId: string) =>
      Promise.resolve(terminalId === first.terminalId ? first : second),
    );
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();

    act(() => store.openTerminalTab(first.terminalId, { focus: true }));
    const firstPanel = await screen.findByRole("region", {
      name: "Remote shell terminal",
    });
    const firstInstance = firstPanel.getAttribute(
      "data-terminal-panel-instance",
    );

    act(() => store.openTerminalTab(second.terminalId, { focus: true }));
    const secondPanel = await screen.findByRole("region", {
      name: "Other shell terminal",
    });

    expect(secondPanel).toHaveAttribute("data-terminal-panel-instance");
    expect(secondPanel.getAttribute("data-terminal-panel-instance")).not.toBe(
      firstInstance,
    );
    expect(
      screen.queryByRole("region", {
        name: "Remote shell terminal",
      }),
    ).toBeNull();
  });

  it.each(["exited", "failed", "interrupted"] as const)("removes %s terminal history directly from its tab", async (lifecycle) => {
    const resource = {
      ...terminalResource(),
      lifecycle,
      exitCode: 0,
    };
    const deleteTerminal = vi.fn().mockResolvedValue({ terminal: null });
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        endTerminal: vi.fn(),
        deleteTerminal,
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });

    fireEvent.click(screen.getByRole("button", { name: "Remove Remote shell terminal and history" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    await waitFor(() => expect(deleteTerminal).toHaveBeenCalledOnce());
    await waitFor(() => expect(store.terminalTab(TERMINAL_ID)).toBeUndefined());
    expect(screen.getByRole("status")).toHaveTextContent(
      "Remote shell removed. Its retained terminal history was removed.",
    );
  });

  it("keeps a terminal visible and reports cleanup failures in its panel", async () => {
    const resource = terminalResource();
    const endTerminal = vi
      .fn()
      .mockRejectedValue(new Error("Terminal cleanup could not be confirmed."));
    Object.assign(applicationStore, {
      api: {
        readTerminal: vi.fn().mockResolvedValue(resource),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
        endTerminal,
        deleteTerminal: vi.fn(),
      },
    });
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("tab", { name: /Remote shell/ });

    fireEvent.click(screen.getByRole("button", { name: "Close Remote shell terminal" }));
    const confirmation = await screen.findByRole("dialog", {
      name: "Close terminal?",
    });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "End terminal" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Terminal cleanup could not be confirmed.",
    );
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    expect(screen.getByRole("tab", { name: /Remote shell/ })).toBeVisible();
  });

  it("reconciles a same-count inactive replacement after reconnect becomes authoritative", async () => {
    harness.applicationState = {
      ...harness.applicationState,
      snapshot: {
        threads: [
          {
            id: "thread-1",
            terminalSummary: { runningCount: 2, retainedCount: 2 },
          },
        ],
      },
    };
    const authoritative = terminalResource(TERMINAL_ID, "Active shell");
    const removed = terminalResource(SECOND_TERMINAL_ID, "Inactive shell");
    const replacement = terminalResource(
      "44444444-4444-4444-8444-444444444444",
      "Replacement shell",
    );
    const listTerminals = vi.fn(async () => ({
      terminals: [authoritative, replacement],
    }));
    Object.assign(applicationStore, {
      api: {
        listTerminals,
        readTerminal: vi.fn(async (terminalId: string) =>
          terminalId === TERMINAL_ID ? authoritative : removed,
        ),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
      store.activateTerminalTab(TERMINAL_ID);
    });

    const inactiveTab = await screen.findByRole("tab", {
      name: "Inactive shell",
    });
    expect(inactiveTab).toHaveAttribute("aria-selected", "false");
    expect(listTerminals).not.toHaveBeenCalled();

    act(() => {
      // Another client ended Inactive shell and created Replacement shell
      // while this client was disconnected. Counts did not change; the new
      // thread-summary object and authoritative transition are the signal.
      harness.applicationState = {
        ...harness.applicationState,
        connection: "connected",
        authoritative: true,
        snapshot: {
          threads: [
            {
              id: "thread-1",
              terminalSummary: { runningCount: 2, retainedCount: 2 },
            },
          ],
        },
      };
      for (const listener of harness.applicationListeners) listener();
    });

    await waitFor(() => expect(listTerminals).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(store.terminalTab(SECOND_TERMINAL_ID)).toBeUndefined(),
    );
    expect(screen.queryByRole("tab", { name: "Inactive shell" })).toBeNull();
    expect(screen.getByRole("tab", { name: "Active shell" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("ignores a stale terminal inventory response without aborting its request", async () => {
    harness.applicationState = {
      ...harness.applicationState,
      connection: "connected",
      authoritative: true,
      snapshot: {
        threads: [
          {
            id: "thread-1",
            terminalSummary: { runningCount: 2, retainedCount: 2 },
          },
        ],
      },
    };
    const active = terminalResource(TERMINAL_ID, "Active shell");
    const inactive = terminalResource(SECOND_TERMINAL_ID, "Inactive shell");
    const pending: Array<
      (result: { terminals: readonly TerminalResource[] }) => void
    > = [];
    const listTerminals = vi.fn(
      () =>
        new Promise<{ terminals: readonly TerminalResource[] }>((resolve) =>
          pending.push(resolve),
        ),
    );
    Object.assign(applicationStore, {
      api: {
        listTerminals,
        readTerminal: vi.fn(async (terminalId: string) =>
          terminalId === TERMINAL_ID ? active : inactive,
        ),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
      store.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
      store.activateTerminalTab(TERMINAL_ID);
    });
    await screen.findByRole("tab", { name: "Inactive shell" });
    await waitFor(() => expect(listTerminals).toHaveBeenCalledTimes(1));

    act(() => {
      harness.applicationState = {
        ...harness.applicationState,
        snapshot: {
          threads: [
            {
              id: "thread-1",
              terminalSummary: { runningCount: 2, retainedCount: 2 },
            },
          ],
        },
      };
      for (const listener of harness.applicationListeners) listener();
    });
    await waitFor(() => expect(listTerminals).toHaveBeenCalledTimes(2));

    act(() => {
      pending[1]?.({ terminals: [active, inactive] });
      pending[0]?.({ terminals: [active] });
    });
    await waitFor(() =>
      expect(
        screen.getByRole("tab", { name: "Inactive shell" }),
      ).toBeInTheDocument(),
    );
    expect(store.terminalTab(SECOND_TERMINAL_ID)).toBeDefined();
  });

  it("fails closed when restored storage points at another thread's terminal", async () => {
    const readTerminal = vi.fn().mockResolvedValue({
      terminalId: TERMINAL_ID,
      threadId: "thread-2",
    });
    Object.assign(applicationStore, { api: { readTerminal } });
    const store = setup();

    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: false });
    });

    expect(
      await screen.findByRole("tablist", { name: "Terminal tabs" }),
    ).toContainElement(screen.getByRole("tab", { name: "Terminal" }));
    expect(
      await screen.findByText("This terminal is no longer available."),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Terminal terminal", { exact: true }),
    ).toBeNull();
  });

  it("isolates pending terminal removal across thread switches and stale completions", async () => {
    setConfirmTerminalTermination(false);
    const first = terminalResource(TERMINAL_ID, "Thread A shell", "thread-a");
    const second = terminalResource(SECOND_TERMINAL_ID, "Thread B shell", "thread-b");
    const finish: Array<(value: { terminal: null }) => void> = [];
    const endTerminal = vi.fn(() => new Promise<{ terminal: null }>((resolve) => { finish.push(resolve); }));
    Object.assign(applicationStore, { api: {
      readTerminal: vi.fn(async (id: string) => id === TERMINAL_ID ? first : second),
      createTerminalAdmission: vi.fn(), terminalWebSocketUrl: vi.fn(), endTerminal,
    } });
    const registry = new WorkspacePanelTenantRegistry([filesTenant()]);
    const rootStore = new PanelRegionStore(registry, { storage: noStorage });
    const storeA = rootStore.forThread("thread-a");
    const storeB = rootStore.forThread("thread-b");
    storeA.openTerminalTab(TERMINAL_ID, { focus: false });
    // Simulates a stale/restored local layout carrying the same id into B.
    storeB.openTerminalTab(SECOND_TERMINAL_ID, { focus: false });
    const layout = (threadId: string, _store: PanelRegionStore) =>
      layoutElement({
        store: rootStore,
        tenants: registry,
        threadId,
        environmentTintEnabled: false,
      });
    const view = render(layout("thread-a", storeA));
    fireEvent.click(await screen.findByRole("button", { name: "End Thread A shell terminal and remove history" }));
    await waitFor(() => expect(endTerminal).toHaveBeenCalledTimes(1));
    view.rerender(layout("thread-b", storeB));
    const closeB = await screen.findByRole("button", { name: "End Thread B shell terminal and remove history" });
    expect(closeB).toBeEnabled();
    fireEvent.click(closeB);
    await waitFor(() => expect(endTerminal).toHaveBeenCalledTimes(2));
    await act(async () => { finish[0]?.({ terminal: null }); });
    expect(closeB).toBeDisabled();
    expect(storeA.terminalTab(TERMINAL_ID)).toBeDefined();
    view.rerender(layout("thread-a", storeA));
    const closeA = await screen.findByRole("button", { name: "End Thread A shell terminal and remove history" });
    expect(closeA).toBeEnabled();
    await act(async () => { finish[1]?.({ terminal: null }); });
    expect(storeA.terminalTab(TERMINAL_ID)).toBeDefined();
    expect(storeB.terminalTab(SECOND_TERMINAL_ID)).toBeDefined();
  });

  it("never reuses a cached terminal resource across a thread change", async () => {
    const threadBResource = terminalResource(
      TERMINAL_ID,
      "Thread B shell",
      "thread-b",
    );
    let rejectThreadA: ((error: unknown) => void) | undefined;
    let resolveThreadB: ((terminal: TerminalResource) => void) | undefined;
    const readTerminal = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<TerminalResource>((_resolve, reject) => {
            rejectThreadA = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<TerminalResource>((resolve) => {
            resolveThreadB = resolve;
          }),
      );
    Object.assign(applicationStore, {
      api: {
        readTerminal,
        listTerminals: vi.fn(),
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
    });
    const registry = new WorkspacePanelTenantRegistry([filesTenant()]);
    const rootStore = new PanelRegionStore(registry, { storage: noStorage });
    const storeA = rootStore.forThread("thread-a");
    const storeB = rootStore.forThread("thread-b");
    storeA.openTerminalTab(TERMINAL_ID, { focus: false });
    // Simulates a stale/restored local layout carrying the same id into B.
    storeB.openTerminalTab(TERMINAL_ID, { focus: false });
    const layout = (threadId: string, _store: PanelRegionStore) =>
      layoutElement({
        store: rootStore,
        tenants: registry,
        threadId,
        environmentTintEnabled: false,
      });
    const view = render(layout("thread-a", storeA));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledOnce());
    expect(screen.getByText("Loading terminal…")).toBeInTheDocument();

    view.rerender(layout("thread-b", storeB));
    await waitFor(() => expect(readTerminal).toHaveBeenCalledTimes(2));
    await act(async () => {
      resolveThreadB?.(threadBResource);
      await Promise.resolve();
    });
    expect(
      await screen.findByRole("tab", { name: "Thread B shell" }),
    ).toBeInTheDocument();

    await act(async () => {
      rejectThreadA?.(
        new ApiError(404, "terminal_not_found", "Terminal not found.", false),
      );
      await Promise.resolve();
    });

    expect(screen.getByRole("tab", { name: "Thread B shell" })).toBeVisible();
    expect(
      screen.queryByText("This terminal is no longer available."),
    ).toBeNull();
    expect(screen.queryByRole("tab", { name: "Thread A shell" })).toBeNull();
    expect(readTerminal).toHaveBeenCalledTimes(2);
  });

});

describe("PanelLayout mobile terminal dismissal", () => {
  it("does not close its terminal when a Settings traversal publishes before foreground cleanup", async () => {
    harness.mobile = true;
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("dialog", { name: "Terminals panel" });
    act(() => {
      pushHistoryEntry(null, "/settings/general");
      window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
    });
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    act(() => store.setActive(false));
  });

  it("does not consume Settings Back while inactive or duplicate its terminal history entry on return", async () => {
    harness.mobile = true;
    const store = setup();
    act(() => store.openTerminalTab(TERMINAL_ID, { focus: true }));
    await screen.findByRole("dialog", { name: "Terminals panel" });
    const terminalEntry = window.history.state;
    const entryCount = window.history.length;
    act(() => store.setActive(false));
    act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: terminalEntry })));
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
    act(() => store.setActive(true));
    expect(window.history.length).toBe(entryCount);
    expect(window.history.state).toEqual(terminalEntry);
    expect(store.terminalTab(TERMINAL_ID)).toBeDefined();
  });

  it("uses Escape to close only the local terminal panel", async () => {
    harness.mobile = true;
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });

    const terminalPanel = await screen.findByRole("dialog", {
      name: "Terminals panel",
    });
    const terminalTabs = screen.getByRole("tablist", {
      name: "Terminal tabs",
    });
    const terminalTab = screen.getByRole("tab", { name: "Terminal" });
    expect(terminalPanel).toContainElement(terminalTabs);
    expect(terminalTabs).toContainElement(terminalTab);
    expect(terminalTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Terminal" })).toHaveAttribute(
      "aria-labelledby",
      terminalTab.id,
    );
    expect(terminalPanel).toHaveAttribute("data-mobile-terminal-panel", "true");
    expect(terminalPanel).toHaveAccessibleDescription(
      "Closing this panel detaches this client. It does not terminate the terminal process.",
    );

    fireEvent.keyDown(terminalPanel, { key: "Escape" });

    await waitFor(() => expect(store.terminalPanel()).toBeUndefined());
    expect(store.terminalTab(TERMINAL_ID)).toBeUndefined();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Terminals panel closed. Its process was not terminated.",
    );
  });

  it("consumes browser Back before leaving the thread and detaches the viewer", async () => {
    harness.mobile = true;
    const store = setup();
    act(() => {
      store.openTerminalTab(TERMINAL_ID, { focus: true });
    });
    const terminalPanel = await screen.findByRole("dialog", {
      name: "Terminals panel",
    });
    expect(terminalPanel).toContainElement(
      screen.getByRole("tablist", { name: "Terminal tabs" }),
    );
    expect(screen.getByRole("tab", { name: "Terminal" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(window.location.pathname).toBe("/threads/thread-1");

    act(() => window.history.back());

    await waitFor(() => expect(store.terminalPanel()).toBeUndefined());
    expect(store.terminalTab(TERMINAL_ID)).toBeUndefined();
    expect(window.location.pathname).toBe("/threads/thread-1");
  });
});
