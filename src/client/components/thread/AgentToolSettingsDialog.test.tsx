// @vitest-environment jsdom

import { useRef, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentToolPresentationMode,
  AgentToolPresentationOption,
  AgentToolPresentationSurface,
  NormalizedThreadSnapshot,
} from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import {
  AgentToolSettingsDialog,
  NATIVE_TOOL_CACHE_WARNING,
  agentToolPolicySummary,
} from "./AgentToolSettingsDialog.js";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function policySnapshot(
  input: {
    readonly revision?: number;
    readonly enabled?: boolean;
    readonly contextEnabled?: boolean;
    readonly contextAvailable?: boolean;
    readonly workspaceEnabled?: boolean;
    readonly statusEnabled?: boolean;
    readonly actionEnabled?: boolean;
    readonly presentationSurface?: AgentToolPresentationSurface;
    readonly presentationMode?: AgentToolPresentationMode;
    readonly presentationOptions?: readonly AgentToolPresentationOption[];
    readonly accessBoundary?: "thread" | "environment" | "unrestricted";
    readonly toolAccessMode?: "read_only" | "ask" | "full";
    readonly runState?: NormalizedThreadSnapshot["runState"];
  } = {},
): NormalizedThreadSnapshot {
  const readEffects = {
    application: "read" as const,
    modelUsage: "none" as const,
    external: "none" as const,
  };
  const writeEffects = {
    application: "write" as const,
    modelUsage: "none" as const,
    external: "none" as const,
  };
  return {
    runState: input.runState ?? "idle",
    settings: {
      revision: 1,
      values: [
        {
          id: "tool_access",
          desiredValue: input.toolAccessMode ?? "ask",
          effectiveValue: input.toolAccessMode ?? "ask",
          applicationState: "effective",
        },
      ],
    },
    agentTools: {
      enabled: input.enabled ?? true,
      groups: [
        {
          id: "context",
          label: { text: "Context" },
          description: { text: "Inspect the source context and workspaces." },
          order: 10,
          tools: [
            {
              id: "agent.context",
              label: { text: "Agent context" },
              description: { text: "Show the associated source thread." },
              order: 10,
              effects: readEffects,
              enabled: input.contextEnabled ?? true,
              available: input.contextAvailable ?? true,
              ...(input.contextAvailable === false
                ? {
                    unavailableReason: {
                      text: "The Grok CLI executable was not found.",
                    },
                  }
                : {}),
            },
            {
              id: "workspace.list",
              label: { text: "List workspaces" },
              order: 20,
              effects: readEffects,
              enabled: input.workspaceEnabled ?? false,
              available: true,
            },
          ],
        },
        {
          id: "threads",
          label: { text: "Threads" },
          description: { text: "Inspect and create threads." },
          order: 20,
          tools: [
            {
              id: "thread.status",
              label: { text: "Thread status" },
              order: 10,
              effects: readEffects,
              enabled: input.statusEnabled ?? false,
              available: true,
            },
            {
              id: "task.update",
              label: { text: "Update task" },
              order: 20,
              effects: writeEffects,
              enabled: input.actionEnabled ?? false,
              available: true,
            },
          ],
        },
      ],
      presentation: {
        surface: input.presentationSurface ?? "native",
        mode: input.presentationMode ?? "progressive",
      },
      presentationOptions: input.presentationOptions ?? [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      accessBoundary: input.accessBoundary ?? "environment",
      revision: input.revision ?? 4,
    },
  } as unknown as NormalizedThreadSnapshot;
}

function subject(
  snapshot = policySnapshot(),
  options: {
    readonly authoritative?: boolean;
    readonly disabled?: boolean;
  } = {},
) {
  const setAgentToolPolicy = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const view = render(
    <AgentToolSettingsDialog
      store={{ setAgentToolPolicy } as unknown as ThreadClientStore}
      snapshot={snapshot}
      authoritative={options.authoritative ?? true}
      disabled={options.disabled ?? false}
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { ...view, setAgentToolPolicy, onOpenChange };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AgentToolSettingsDialog", () => {
  it("shows a runtime-unavailable tool disabled with its startup diagnostic", () => {
    subject(policySnapshot({ contextAvailable: false }));

    expect(
      screen.getByRole("checkbox", { name: "Agent context" }),
    ).toBeDisabled();
    expect(
      screen.getByText("The Grok CLI executable was not found."),
    ).toBeVisible();
  });

  it("derives all, none, and indeterminate group state and batches exact IDs", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({ presentationSurface: "cli" }),
    );
    const group = screen.getByRole("checkbox", {
      name: "Select all Context tools",
    });
    expect(group).toHaveAttribute("data-state", "indeterminate");

    fireEvent.click(group);
    expect(
      screen.getByRole("checkbox", { name: "Agent context" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "List workspaces" }),
    ).toBeChecked();
    fireEvent.click(group);
    expect(
      screen.getByRole("checkbox", { name: "Agent context" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "List workspaces" }),
    ).not.toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Thread status" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(setAgentToolPolicy).toHaveBeenCalledWith({
        expectedPolicyRevision: 4,
        enabled: true,
        enabledToolIds: ["workspace.list", "thread.status"],
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "environment",
      }),
    );
  });

  it("selects every tool when a fully unchecked group select-all is activated", () => {
    subject(
      policySnapshot({
        contextEnabled: false,
        workspaceEnabled: false,
        presentationSurface: "cli",
      }),
    );
    const group = screen.getByRole("checkbox", {
      name: "Select all Context tools",
    });
    const target = group.closest("label");
    expect(target).toHaveClass("agent-tool-group-toggle-target");
    expect(group).not.toBeChecked();

    fireEvent.click(target!);

    expect(
      screen.getByRole("checkbox", { name: "Agent context" }),
    ).toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "List workspaces" }),
    ).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    expect(group).toBeChecked();
  });

  it("retains latent selections while the master switch is off", () => {
    subject(policySnapshot({ enabled: false }));
    expect(
      screen.getByRole("checkbox", { name: "Agent context" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("checkbox", { name: "Agent context" }),
    ).toBeChecked();
    expect(
      agentToolPolicySummary(policySnapshot({ enabled: false }).agentTools),
    ).toBe("Off");
  });

  it("shows visible canonical descriptions and effect copy", () => {
    subject();
    expect(
      screen.getByText("Inspect the source context and workspaces."),
    ).toBeVisible();
    expect(
      screen.getByText("Show the associated source thread."),
    ).toBeVisible();
    expect(screen.getAllByText("Reads Sedes data").length).toBeGreaterThan(0);
    expect(
      screen.getByRole("checkbox", { name: "Agent context" }),
    ).toHaveAccessibleDescription(
      "Show the associated source thread. Reads Sedes data",
    );
    expect(
      screen.getByRole("checkbox", { name: "List workspaces" }),
    ).toHaveAccessibleDescription("Reads Sedes data");
  });

  it("confirms individual-native catalog changes with the exact cache warning and focuses confirmation", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({ presentationMode: "individual" }),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByText(NATIVE_TOOL_CACHE_WARNING)).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      NATIVE_TOOL_CACHE_WARNING,
    );
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Save changes" });
    expect(confirm).toHaveAccessibleDescription(NATIVE_TOOL_CACHE_WARNING);
    await waitFor(() => expect(confirm).toHaveFocus());
    fireEvent.click(confirm);
    expect(setAgentToolPolicy).toHaveBeenCalledOnce();
  });

  it("does not warn when progressive IDs change inside an existing gateway lane", async () => {
    const { setAgentToolPolicy } = subject();
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledOnce());
    expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
  });

  it("warns when a progressive policy adds its first action gateway", async () => {
    const { setAgentToolPolicy } = subject();
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Update task" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    expect(screen.getByText(NATIVE_TOOL_CACHE_WARNING)).toBeVisible();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("does not add an action gateway in progressive read-only mode", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({ toolAccessMode: "read_only" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Update task" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledOnce());
    expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
  });

  it("renders all closed presentation labels and truthful summaries", () => {
    subject();
    expect(
      screen.getByRole("combobox", { name: "Agent tool surface" }),
    ).toHaveTextContent("Native tools");
    expect(
      screen.getByRole("combobox", { name: "Agent tool presentation" }),
    ).toHaveTextContent("Progressive");
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent tool surface" }),
    );
    expect(
      screen.getByRole("option", { name: "Native tools" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "Sedes CLI" })).toBeVisible();
    fireEvent.keyDown(document, { key: "Escape" });
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent tool presentation" }),
    );
    expect(
      screen.getByRole("option", {
        name: "Progressive discovery (recommended)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "Individual operations" }),
    ).toBeVisible();

    expect(agentToolPolicySummary(policySnapshot().agentTools)).toBe(
      "1 enabled · Ask outside this environment · Native · Progressive",
    );
    expect(
      agentToolPolicySummary(
        policySnapshot({ presentationMode: "individual" }).agentTools,
      ),
    ).toBe(
      "1 enabled · Ask outside this environment · Native · Individual",
    );
  });

  it("hides a fixed surface while retaining the CLI presentation selector", () => {
    subject(
      policySnapshot({
        presentationSurface: "cli",
        presentationOptions: [
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
      }),
    );

    expect(
      screen.queryByRole("combobox", { name: "Agent tool surface" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Agent tool presentation" }),
    ).toHaveTextContent("Progressive");
  });

  it("preserves a supported mode across surfaces and warns for changed native exposure", () => {
    const { setAgentToolPolicy } = subject();
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent tool surface" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Sedes CLI" }));
    expect(
      screen.getByRole("combobox", { name: "Agent tool presentation" }),
    ).toHaveTextContent("Progressive");

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByText(NATIVE_TOOL_CACHE_WARNING)).toBeVisible();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("switches a CLI-first thread to MCP-backed native tools after the cache warning", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({
        presentationSurface: "cli",
        presentationMode: "individual",
        presentationOptions: [
          { surface: "cli", modes: ["progressive", "individual"] },
          { surface: "native", modes: ["progressive", "individual"] },
        ],
      }),
    );
    expect(
      screen.getByRole("combobox", { name: "Agent tool surface" }),
    ).toHaveTextContent("Sedes CLI");
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent tool surface" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Native tools" }));
    expect(
      screen.getByRole("combobox", { name: "Agent tool presentation" }),
    ).toHaveTextContent("Individual");
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByText(NATIVE_TOOL_CACHE_WARNING)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(setAgentToolPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          presentation: { surface: "native", mode: "individual" },
        }),
      ),
    );
  });

  it("falls back to the first supported mode when the surface changes", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({
        enabled: false,
        presentationOptions: [
          { surface: "native", modes: ["progressive", "individual"] },
          { surface: "cli", modes: ["individual"] },
        ],
      }),
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent tool surface" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Sedes CLI" }));
    expect(
      screen.queryByRole("combobox", { name: "Agent tool presentation" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(setAgentToolPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          presentation: { surface: "cli", mode: "individual" },
        }),
      ),
    );
  });

  it("saves CLI-only presentation changes without a Pi warning", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({
        presentationSurface: "cli",
        presentationOptions: [
          { surface: "native", modes: ["progressive"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
      }),
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Agent tool presentation" }),
    );
    fireEvent.click(
      screen.getByRole("option", { name: "Individual operations" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(setAgentToolPolicy).toHaveBeenCalledWith(
        expect.objectContaining({
          presentation: { surface: "cli", mode: "individual" },
        }),
      ),
    );
    expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
  });

  it("saves the thread boundary without granting global access", async () => {
    const { setAgentToolPolicy } = subject(policySnapshot());
    fireEvent.click(screen.getByRole("combobox", { name: "Access boundary" }));
    fireEvent.click(screen.getByRole("option", { name: "Ask outside this thread" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ accessBoundary: "thread" }),
    ));
  });

  it("defaults the environment selector from the strict snapshot and saves allow", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({ presentationSurface: "cli", accessBoundary: "environment" }),
    );
    const selector = screen.getByRole("combobox", {
      name: "Access boundary",
    });
    expect(selector).toHaveTextContent("Ask outside this environment");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();

    fireEvent.click(selector);
    fireEvent.click(
      screen.getByRole("option", { name: /Allow without asking/ }),
    );
    expect(selector).toHaveTextContent("Allow without asking");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() =>
      expect(setAgentToolPolicy).toHaveBeenCalledWith({
        expectedPolicyRevision: 4,
        enabled: true,
        enabledToolIds: ["agent.context"],
        presentation: { surface: "cli", mode: "progressive" },
        accessBoundary: "unrestricted",
      }),
    );
  });

  it("saves an environment-only native policy change without a Pi cache confirmation", async () => {
    const { setAgentToolPolicy } = subject(
      policySnapshot({
        presentationMode: "individual",
        accessBoundary: "environment",
      }),
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Access boundary" }),
    );
    fireEvent.click(
      screen.getByRole("option", { name: /Allow without asking/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledOnce());
    expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
  });

  it("uses the first Escape to return from confirmation and the second to close", async () => {
    const { onOpenChange, setAgentToolPolicy } = subject(
      policySnapshot({ presentationMode: "individual" }),
    );
    const selection = screen.getByRole("checkbox", { name: "List workspaces" });
    fireEvent.click(selection);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toHaveFocus(),
    );

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
    expect(selection).toBeChecked();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("closes from the mutation promise without waiting for a revision event", async () => {
    const mutation = deferred<unknown>();
    const setAgentToolPolicy = vi.fn(() => mutation.promise);
    const onOpenChange = vi.fn();
    render(
      <AgentToolSettingsDialog
        store={{ setAgentToolPolicy } as unknown as ThreadClientStore}
        snapshot={policySnapshot({ runState: "running", presentationSurface: "cli" })}
        authoritative
        disabled={false}
        open
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Enable agent tools" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Access boundary" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => mutation.resolve({ status: "completed" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not let a foreign revision mask a rejected save", async () => {
    const mutation = deferred<unknown>();
    const setAgentToolPolicy = vi.fn(() => mutation.promise);
    const onOpenChange = vi.fn();
    const store = { setAgentToolPolicy } as unknown as ThreadClientStore;
    const { rerender } = render(
      <AgentToolSettingsDialog
        store={store}
        snapshot={policySnapshot({ presentationSurface: "cli" })}
        authoritative
        disabled={false}
        open
        onOpenChange={onOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    rerender(
      <AgentToolSettingsDialog
        store={store}
        snapshot={policySnapshot({
          revision: 5,
          presentationSurface: "cli",
          statusEnabled: true,
        })}
        authoritative
        disabled={false}
        open
        onOpenChange={onOpenChange}
      />,
    );
    expect(
      screen.queryByText(/changed in another client/i),
    ).not.toBeInTheDocument();
    expect(document.querySelector(".agent-tool-dialog-notices")).toBeNull();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => mutation.reject(new Error("Policy conflict")));

    expect(screen.getByText(/changed in another client/i)).toBeVisible();
    expect(screen.getByText("Policy conflict")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  });

  it("returns focus and reopens with a clean draft after cancellation", async () => {
    const setAgentToolPolicy = vi.fn().mockResolvedValue(undefined);
    const store = { setAgentToolPolicy } as unknown as ThreadClientStore;
    function Sedes() {
      const [open, setOpen] = useState(true);
      const triggerRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>
            Open agent tools
          </button>
          <AgentToolSettingsDialog
            store={store}
            snapshot={policySnapshot({ presentationMode: "individual" })}
            authoritative
            disabled={false}
            open={open}
            onOpenChange={setOpen}
            returnFocusRef={triggerRef}
          />
        </>
      );
    }
    render(<Sedes />);
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.getByText(NATIVE_TOOL_CACHE_WARNING)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const trigger = screen.getByRole("button", { name: "Open agent tools" });
    await waitFor(() => expect(trigger).toHaveFocus());
    fireEvent.click(trigger);

    expect(
      screen.getByRole("checkbox", { name: "List workspaces" }),
    ).not.toBeChecked();
    expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("disables a pending confirmation if the thread starts running", async () => {
    const setAgentToolPolicy = vi.fn().mockResolvedValue(undefined);
    const store = { setAgentToolPolicy } as unknown as ThreadClientStore;
    const { rerender } = render(
      <AgentToolSettingsDialog
        store={store}
        snapshot={policySnapshot({ presentationMode: "individual" })}
        authoritative
        disabled={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    const confirm = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(confirm).toHaveFocus());

    rerender(
      <AgentToolSettingsDialog
        store={store}
        snapshot={policySnapshot({
          presentationMode: "individual",
          runState: "running",
        })}
        authoritative
        disabled={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("keeps a dirty draft bound to its base revision when a newer snapshot arrives", async () => {
    const setAgentToolPolicy = vi.fn().mockResolvedValue(undefined);
    const store = { setAgentToolPolicy } as unknown as ThreadClientStore;
    const { rerender } = render(
      <AgentToolSettingsDialog
        store={store}
        snapshot={policySnapshot({ runState: "running", presentationSurface: "cli" })}
        authoritative
        disabled={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    rerender(
      <AgentToolSettingsDialog
        store={store}
        snapshot={policySnapshot({
          revision: 5,
          runState: "running", presentationSurface: "cli",
          statusEnabled: true,
        })}
        authoritative
        disabled={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    expect(await screen.findByText(/changed in another client/i)).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "List workspaces" }),
    ).toBeChecked();
    const save = screen.getByRole("button", { name: /^Save$/ });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("disables editing while the thread is running", () => {
    subject(policySnapshot({ runState: "running" }));
    expect(
      screen.getByRole("checkbox", { name: "Enable agent tools" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
    expect(
      screen.getByText("Agent tools can be changed when the thread is idle."),
    ).toBeVisible();
  });

  it.each(["progressive", "individual"] as const)(
    "saves CLI enablement, selection, and environment access during a running %s turn",
    async (presentationMode) => {
      const { setAgentToolPolicy } = subject(policySnapshot({
        enabled: false,
        presentationSurface: "cli",
        presentationMode,
        runState: "running",
      }));
      expect(screen.getByRole("combobox", { name: "Agent tool surface" })).toBeDisabled();
      expect(screen.getByRole("combobox", { name: "Agent tool presentation" })).toBeDisabled();
      fireEvent.click(screen.getByRole("checkbox", { name: "Enable agent tools" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all Context tools" }));
      fireEvent.click(screen.getByRole("combobox", { name: "Access boundary" }));
      fireEvent.click(screen.getByRole("option", { name: /Allow without asking/ }));
      fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
      await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledWith({
        expectedPolicyRevision: 4,
        enabled: true,
        enabledToolIds: ["agent.context", "workspace.list"],
        presentation: { surface: "cli", mode: presentationMode },
        accessBoundary: "unrestricted",
      }));
      expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
    },
  );

  it("disables CLI access during a running turn and preserves latent selections", async () => {
    const { setAgentToolPolicy } = subject(policySnapshot({
      presentationSurface: "cli",
      runState: "running",
    }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Enable agent tools" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false, enabledToolIds: ["agent.context"] }),
    ));
  });

  it.each([
    { authoritative: false, disabled: false },
    { authoritative: true, disabled: true },
  ])("preserves authority and availability guards for running CLI settings: %j", (options) => {
    subject(policySnapshot({ presentationSurface: "cli", runState: "running" }), options);
    expect(screen.getByRole("checkbox", { name: "Enable agent tools" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Access boundary" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  });

  it.each(["surface", "mode"] as const)(
    "blocks a draft CLI presentation %s change when a turn starts",
    (change) => {
      const { rerender, setAgentToolPolicy, onOpenChange } = subject(
        policySnapshot({ presentationSurface: "cli" }),
      );
      fireEvent.click(screen.getByRole("combobox", {
        name: change === "surface" ? "Agent tool surface" : "Agent tool presentation",
      }));
      fireEvent.click(screen.getByRole("option", {
        name: change === "surface" ? "Native tools" : "Individual operations",
      }));
      rerender(<AgentToolSettingsDialog
        store={{ setAgentToolPolicy } as unknown as ThreadClientStore}
        snapshot={policySnapshot({ presentationSurface: "cli", runState: "running" })}
        authoritative disabled={false} open onOpenChange={onOpenChange}
      />);
      expect(screen.getByRole("combobox", { name: "Agent tool surface" })).toBeDisabled();
      const save = screen.getByRole("button", { name: /^Save$/ });
      expect(save).toBeDisabled();
      expect(screen.getByText("Wait until the thread is idle to save presentation changes.")).toBeVisible();
      fireEvent.click(save);
      expect(setAgentToolPolicy).not.toHaveBeenCalled();
    },
  );

  it("retains mutation errors and the draft for retry", async () => {
    const setAgentToolPolicy = vi
      .fn()
      .mockRejectedValue(new Error("Policy conflict"));
    render(
      <AgentToolSettingsDialog
        store={{ setAgentToolPolicy } as unknown as ThreadClientStore}
        snapshot={policySnapshot({ presentationSurface: "cli" })}
        authoritative
        disabled={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(await screen.findByText("Policy conflict")).toHaveAttribute(
      "role",
      "alert",
    );
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();
  });
});
