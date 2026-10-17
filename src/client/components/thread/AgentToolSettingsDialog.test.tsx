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
  ToolPolicySet,
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
    readonly origin?: NormalizedThreadSnapshot["agentTools"]["origin"];
    readonly resourceScope?: { allowOtherEnvironments: boolean; allowOtherProjects: boolean };
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
      runtimeAvailability: { availability: "available" },
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
      origin: input.origin ?? null,
      resourceScope: input.resourceScope ?? { allowOtherEnvironments: false, allowOtherProjects: false },
      revision: input.revision ?? 4,
    },
  } as unknown as NormalizedThreadSnapshot;
}

function subject(
  snapshot = policySnapshot(),
  options: {
    readonly authoritative?: boolean;
    readonly disabled?: boolean;
    readonly storeOverrides?: Partial<Pick<ThreadClientStore, "listToolPolicySets" | "getToolPolicySet">>;
  } = {},
) {
  const setAgentToolPolicy = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  const store = toolPolicyStore({ setAgentToolPolicy, ...options.storeOverrides });
  const view = render(
    <AgentToolSettingsDialog
      store={store}
      snapshot={snapshot}
      authoritative={options.authoritative ?? true}
      disabled={options.disabled ?? false}
      open
      onOpenChange={onOpenChange}
    />,
  );
  return { ...view, store, setAgentToolPolicy, onOpenChange };
}

function toolPolicyStore(overrides: Partial<Pick<ThreadClientStore,
  "listToolPolicySets" | "getToolPolicySet">> & {
    readonly setAgentToolPolicy?: (input: Parameters<ThreadClientStore["setAgentToolPolicy"]>[0]) => Promise<unknown>;
  } = {}): ThreadClientStore {
  return {
    setAgentToolPolicy: vi.fn().mockResolvedValue(undefined),
    listToolPolicySets: vi.fn().mockResolvedValue({ items: [] }),
    getToolPolicySet: vi.fn().mockRejectedValue(new Error("Unexpected policy-set request")),
    ...overrides,
  } as unknown as ThreadClientStore;
}

function reusablePolicy(overrides: Partial<ToolPolicySet> = {}): ToolPolicySet {
  return {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Focused review",
    revision: 2,
    enabledToolIds: ["thread.status"],
    resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false },
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    ...overrides,
  };
}

async function applyPolicy(policy = reusablePolicy()): Promise<void> {
  await screen.findByRole("option", { name: policy.name });
  fireEvent.change(screen.getByRole("combobox", { name: "Policy set" }), { target: { value: policy.id } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
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
  it("loads the latest policy into an exact draft replacement and saves only after review", async () => {
    const listed = reusablePolicy({ revision: 1, enabledToolIds: ["agent.context", "task.update"] });
    const latest = reusablePolicy({ revision: 4, resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true } });
    const listToolPolicySets = vi.fn().mockResolvedValue({ items: [listed] });
    const getToolPolicySet = vi.fn().mockResolvedValue(latest);
    const { setAgentToolPolicy } = subject(policySnapshot({
      enabled: false, workspaceEnabled: true, actionEnabled: true,
      presentationSurface: "cli", presentationMode: "individual",
      resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false },
    }), { storeOverrides: { listToolPolicySets, getToolPolicySet } });

    await applyPolicy(listed);
    expect(await screen.findByText(/Loaded Focused review \(revision 4\) into this draft/)).toBeVisible();
    expect(getToolPolicySet).toHaveBeenCalledWith(listed.id, expect.any(AbortSignal));
    expect(screen.getByRole("switch", { name: "Enable agent tools" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Agent context" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    expect(screen.getByRole("checkbox", { name: "Thread status" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Update task" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other environments" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other projects" })).toBeChecked();
    expect(screen.getByRole("combobox", { name: "Agent tool surface" })).toHaveTextContent("Sedes CLI");
    expect(screen.getByRole("combobox", { name: "Agent tool presentation" })).toHaveTextContent("Individual");
    expect(setAgentToolPolicy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledExactlyOnceWith({
      expectedPolicyRevision: 4,
      enabled: true,
      enabledToolIds: ["thread.status"],
      presentation: { surface: "cli", mode: "individual" },
      resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
    }));
  });

  it("confirms native individual tool changes before saving an applied policy", async () => {
    const selected = reusablePolicy({ enabledToolIds: ["workspace.list"] });
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationMode: "individual" }), {
      storeOverrides: {
        listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }),
        getToolPolicySet: vi.fn().mockResolvedValue(selected),
      },
    });
    await applyPolicy(selected);
    await screen.findByText(/Loaded Focused review/);
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(NATIVE_TOOL_CACHE_WARNING)).toBeVisible();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
    const confirm = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(confirm).toHaveFocus());
    fireEvent.click(confirm);
    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledExactlyOnceWith({
      expectedPolicyRevision: 4,
      enabled: true,
      enabledToolIds: ["workspace.list"],
      presentation: { surface: "native", mode: "individual" },
      resourceScope: selected.resourceScope,
    }));
  });

  it("disables policy-set selection and Apply while a native thread is running", async () => {
    const selected = reusablePolicy();
    const getToolPolicySet = vi.fn().mockResolvedValue(selected);
    const { setAgentToolPolicy } = subject(policySnapshot({ runState: "running" }), {
      storeOverrides: { listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }), getToolPolicySet },
    });
    await screen.findByRole("option", { name: selected.name });
    expect(screen.getByRole("combobox", { name: "Policy set" })).toBeDisabled();
    const apply = screen.getByRole("button", { name: "Apply" });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(getToolPolicySet).not.toHaveBeenCalled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)("returns keyboard focus to Apply after a policy GET %s", async (result) => {
    const selected = reusablePolicy();
    const request = deferred<ToolPolicySet>();
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli" }), {
      storeOverrides: {
        listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }),
        getToolPolicySet: vi.fn().mockReturnValue(request.promise),
      },
    });
    await screen.findByRole("option", { name: selected.name });
    fireEvent.change(screen.getByRole("combobox", { name: "Policy set" }), { target: { value: selected.id } });
    const apply = screen.getByRole("button", { name: "Apply" });
    apply.focus();
    fireEvent.click(apply);
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    // Browsers can release focus when a control becomes disabled.
    act(() => apply.blur());
    await act(async () => {
      if (result === "success") request.resolve(selected);
      else request.reject(new Error("Policy fetch failed."));
    });
    if (result === "success") expect(await screen.findByText(/Loaded Focused review/)).toBeVisible();
    else {
      expect(await screen.findByText("Policy fetch failed.")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Retry policy sets" })).not.toBeInTheDocument();
    }
    await waitFor(() => expect(screen.getByRole("button", { name: "Apply" })).toHaveFocus());
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("explains an equal applied policy without enabling an unnecessary Save", async () => {
    const selected = reusablePolicy({
      enabledToolIds: ["agent.context"],
      resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
    });
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli", presentationMode: "individual" }), {
      storeOverrides: {
        listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }),
        getToolPolicySet: vi.fn().mockResolvedValue(selected),
      },
    });
    await applyPolicy(selected);
    expect(await screen.findByText(/already matches/i)).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Agent tool presentation" })).toHaveTextContent("Individual");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("retains manual draft edits when the latest policy cannot be fetched", async () => {
    const selected = reusablePolicy();
    const getToolPolicySet = vi.fn().mockRejectedValue(new Error("This policy set was deleted."));
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli" }), {
      storeOverrides: { listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }), getToolPolicySet },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    await applyPolicy(selected);
    expect(await screen.findByText("This policy set was deleted.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry policy sets" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Agent context" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other environments" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.queryByText(/Loaded Focused review/)).not.toBeInTheDocument();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("refuses unsupported tool IDs without partially replacing the draft", async () => {
    const selected = reusablePolicy();
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli" }), {
      storeOverrides: {
        listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }),
        getToolPolicySet: vi.fn().mockResolvedValue(reusablePolicy({ enabledToolIds: ["workspace.list", "unsupported.tool"] })),
      },
    });
    await applyPolicy(selected);
    expect(await screen.findByText(/includes tools this thread does not support/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Retry policy sets" })).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Agent context" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other environments" })).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("retries a failed policy-set list without changing the thread", async () => {
    const selected = reusablePolicy();
    const listToolPolicySets = vi.fn()
      .mockRejectedValueOnce(new Error("Policy sets are unavailable."))
      .mockResolvedValueOnce({ items: [selected] });
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli" }), {
      storeOverrides: { listToolPolicySets },
    });
    expect(await screen.findByText("Policy sets are unavailable.")).toBeVisible();
    expect(screen.getByRole("combobox", { name: "Policy set" })).toHaveTextContent("Policy sets could not be loaded");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    const retry = screen.getByRole("button", { name: "Retry policy sets" });
    retry.focus();
    fireEvent.click(retry);
    expect(await screen.findByRole("option", { name: selected.name })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Policy set" })).toHaveFocus());
    expect(listToolPolicySets).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Policy sets are unavailable.")).not.toBeInTheDocument();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("returns keyboard focus to Retry after a policy-set list retry fails", async () => {
    const retryRequest = deferred<{ items: ToolPolicySet[] }>();
    const listToolPolicySets = vi.fn()
      .mockRejectedValueOnce(new Error("Policy sets are unavailable."))
      .mockReturnValueOnce(retryRequest.promise);
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli" }), {
      storeOverrides: { listToolPolicySets },
    });
    await screen.findByText("Policy sets are unavailable.");
    const retry = screen.getByRole("button", { name: "Retry policy sets" });
    retry.focus();
    fireEvent.click(retry);
    await act(async () => retryRequest.reject(new Error("Policy sets are still unavailable.")));
    expect(await screen.findByText("Policy sets are still unavailable.")).toBeVisible();
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry policy sets" })).toHaveFocus());
    expect(screen.getByRole("combobox", { name: "Policy set" })).toHaveTextContent("Policy sets could not be loaded");
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("does not defer Retry focus until a running native thread becomes idle", async () => {
    const selected = reusablePolicy();
    const retryRequest = deferred<{ items: ToolPolicySet[] }>();
    const listToolPolicySets = vi.fn()
      .mockRejectedValueOnce(new Error("Policy sets are unavailable."))
      .mockReturnValueOnce(retryRequest.promise);
    const { store, rerender, onOpenChange, setAgentToolPolicy } = subject(policySnapshot(), {
      storeOverrides: { listToolPolicySets },
    });
    await screen.findByText("Policy sets are unavailable.");
    const retry = screen.getByRole("button", { name: "Retry policy sets" });
    retry.focus();
    fireEvent.click(retry);
    rerender(<AgentToolSettingsDialog
      store={store} snapshot={policySnapshot({ runState: "running" })}
      authoritative disabled={false} open onOpenChange={onOpenChange}
    />);
    await act(async () => retryRequest.resolve({ items: [selected] }));
    await screen.findByRole("option", { name: selected.name });
    const select = screen.getByRole("combobox", { name: "Policy set" });
    expect(select).toBeDisabled();
    const dialog = screen.getByRole("dialog");
    act(() => dialog.focus());
    rerender(<AgentToolSettingsDialog
      store={store} snapshot={policySnapshot()}
      authoritative disabled={false} open onOpenChange={onOpenChange}
    />);
    expect(select).toBeEnabled();
    expect(dialog).toHaveFocus();
    expect(select).not.toHaveFocus();
    expect(listToolPolicySets).toHaveBeenCalledTimes(2);
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("aborts policy requests on close and ignores a late Apply response on reopen", async () => {
    const selected = reusablePolicy();
    const request = deferred<ToolPolicySet>();
    const listToolPolicySets = vi.fn().mockResolvedValue({ items: [selected] });
    const getToolPolicySet = vi.fn().mockReturnValue(request.promise);
    const snapshot = policySnapshot({ presentationSurface: "cli" });
    const { store, rerender, onOpenChange, setAgentToolPolicy } = subject(snapshot, {
      storeOverrides: { listToolPolicySets, getToolPolicySet },
    });
    await applyPolicy(selected);
    expect(screen.getByRole("button", { name: "Applying…" })).toBeDisabled();
    const applySignal = getToolPolicySet.mock.calls[0]![1] as AbortSignal;
    const listSignal = listToolPolicySets.mock.calls[0]![0] as AbortSignal;
    rerender(<AgentToolSettingsDialog store={store} snapshot={snapshot} authoritative disabled={false} open={false} onOpenChange={onOpenChange} />);
    expect(applySignal.aborted).toBe(true);
    expect(listSignal.aborted).toBe(true);
    await act(async () => request.resolve(selected));
    rerender(<AgentToolSettingsDialog store={store} snapshot={snapshot} authoritative disabled={false} open onOpenChange={onOpenChange} />);
    await screen.findByRole("option", { name: selected.name });
    expect(screen.getByRole("checkbox", { name: "Agent context" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other environments" })).not.toBeChecked();
    expect(screen.queryByText(/Loaded Focused review/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("preserves a stale manual draft when the thread changes during a policy GET", async () => {
    const selected = reusablePolicy();
    const request = deferred<ToolPolicySet>();
    const getToolPolicySet = vi.fn().mockReturnValue(request.promise);
    const { store, rerender, onOpenChange, setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli" }), {
      storeOverrides: {
        listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }),
        getToolPolicySet,
      },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    await screen.findByRole("option", { name: selected.name });
    fireEvent.change(screen.getByRole("combobox", { name: "Policy set" }), { target: { value: selected.id } });
    const apply = screen.getByRole("button", { name: "Apply" });
    apply.focus();
    fireEvent.click(apply);
    act(() => apply.blur());
    rerender(<AgentToolSettingsDialog
      store={store} snapshot={policySnapshot({ revision: 5, presentationSurface: "cli", contextEnabled: false, statusEnabled: true })}
      authoritative disabled={false} open onOpenChange={onOpenChange}
    />);
    await act(async () => request.resolve(selected));
    const loadError = await screen.findByText(/changed while the policy loaded/);
    expect(loadError).toBeVisible();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Policy set" })).toHaveFocus());
    expect(loadError).toHaveTextContent("Close and reopen Agent tools to load the latest settings before applying a policy set.");
    const staleWarning = await screen.findByText(/changed in another client/i);
    expect(staleWarning).toBeVisible();
    expect(staleWarning).toHaveTextContent("Close and reopen Agent tools to load the latest settings.");
    expect(screen.getByRole("checkbox", { name: "Agent context" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other environments" })).not.toBeChecked();
    expect(screen.queryByText(/Loaded Focused review|already matches/i)).not.toBeInTheDocument();
    expect(apply).toBeDisabled();
    expect(getToolPolicySet).toHaveBeenCalledOnce();
    fireEvent.click(apply);
    expect(getToolPolicySet).toHaveBeenCalledOnce();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("adopts the latest clean draft when an equal-original policy finishes loading after a revision change", async () => {
    const selected = reusablePolicy({
      enabledToolIds: ["agent.context"],
      resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
    });
    const request = deferred<ToolPolicySet>();
    const { store, rerender, onOpenChange, setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli", presentationMode: "individual" }), {
      storeOverrides: {
        listToolPolicySets: vi.fn().mockResolvedValue({ items: [selected] }),
        getToolPolicySet: vi.fn().mockReturnValue(request.promise),
      },
    });
    await screen.findByRole("option", { name: selected.name });
    fireEvent.change(screen.getByRole("combobox", { name: "Policy set" }), { target: { value: selected.id } });
    const apply = screen.getByRole("button", { name: "Apply" });
    apply.focus();
    fireEvent.click(apply);
    act(() => apply.blur());
    rerender(<AgentToolSettingsDialog
      store={store} snapshot={policySnapshot({
        revision: 5, presentationSurface: "cli", presentationMode: "individual",
        contextEnabled: false, workspaceEnabled: true,
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true },
      })}
      authoritative disabled={false} open onOpenChange={onOpenChange}
    />);
    await act(async () => request.resolve(selected));
    expect(await screen.findByText(/changed while the policy loaded/)).toBeVisible();
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Policy set" })).toHaveFocus());
    expect(screen.queryByText(/already matches|Loaded Focused review/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/changed in another client/i)).not.toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Agent context" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other projects" })).toBeChecked();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(setAgentToolPolicy).not.toHaveBeenCalled();
  });

  it("shows immutable creation provenance without implying current settings still match", () => {
    subject(policySnapshot({ revision: 8, origin: { source: "account", policySet: { id: "33333333-3333-4333-8333-333333333333", name: "Everyday", revision: 2 } } }));
    expect(screen.getByText(/Original policy: Everyday \(revision 2\) · from Account/)).toHaveTextContent("later default or policy-set changes do not update it");
  });

  it.each(["agent", "thread"] as const)("identifies a disabled original %s policy", (source) => {
    subject(policySnapshot({ origin: { source } }));
    expect(screen.getByText(new RegExp(`Original policy: Disabled · from ${source === "agent" ? "Agent" : "Thread"}`))).toBeInTheDocument();
  });

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
        resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
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

  it("explains runtime denial while retaining editable saved grants", async () => {
    const snapshot = policySnapshot({ presentationSurface: "cli" });
    snapshot.agentTools.runtimeAvailability = {
      availability: "unavailable",
      reason: { text: "Enable network access in this thread's execution settings." },
    };
    const { setAgentToolPolicy } = subject(snapshot);
    const runtimeStatus = screen.getByText("Sedes tools are unavailable for this thread.").closest('[role="status"]');
    expect(runtimeStatus).toHaveTextContent("Enable network access");
    expect(runtimeStatus).toHaveTextContent("Your saved tool selections are retained");
    expect(agentToolPolicySummary(snapshot.agentTools)).toBe("Unavailable");
    expect(screen.getByRole("switch", { name: "Enable agent tools" })).toBeChecked();
    const grant = screen.getByRole("checkbox", { name: "Agent context" });
    expect(grant).toBeChecked();
    expect(grant).toBeEnabled();
    fireEvent.click(grant);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledWith(expect.objectContaining({
      enabled: true,
      enabledToolIds: [],
      presentation: { surface: "cli", mode: "progressive" },
    })));
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
      "1 enabled",
    );
    expect(
      agentToolPolicySummary(
        policySnapshot({ presentationMode: "individual" }).agentTools,
      ),
    ).toBe(
      "1 enabled",
    );
    expect(agentToolPolicySummary(policySnapshot({ contextEnabled: false }).agentTools)).toBe("0 enabled");
    expect(agentToolPolicySummary(policySnapshot({ workspaceEnabled: true, presentationSurface: "cli", resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false } }).agentTools)).toBe("2 enabled");
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

  it("changes the two resource boundaries independently", async () => {
    const { setAgentToolPolicy } = subject(policySnapshot());
    expect(screen.getByRole("switch", { name: "Allow other environments" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Allow other projects" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("switch", { name: "Allow other projects" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true } }),
    ));
    expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
  });

  it("lets the user enable other environments without changing project access", async () => {
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationSurface: "cli" }));
    expect(screen.getByText(/lists and searches stay in this environment/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Allow other environments" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledWith({
      expectedPolicyRevision: 4,
      enabled: true,
      enabledToolIds: ["agent.context"],
      presentation: { surface: "cli", mode: "progressive" },
      resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false },
    }));
  });

  it("saves an environment-only native policy change without a Pi cache confirmation", async () => {
    const { setAgentToolPolicy } = subject(policySnapshot({ presentationMode: "individual" }));
    fireEvent.click(screen.getByRole("switch", { name: "Allow other environments" }));
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
        store={toolPolicyStore({ setAgentToolPolicy })}
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
    expect(screen.getByRole("switch", { name: "Enable agent tools" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Allow other environments" })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    await act(async () => mutation.resolve({ status: "completed" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not let a foreign revision mask a rejected save", async () => {
    const mutation = deferred<unknown>();
    const setAgentToolPolicy = vi.fn(() => mutation.promise);
    const onOpenChange = vi.fn();
    const store = toolPolicyStore({ setAgentToolPolicy });
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
    expect(
      screen.getByText("Policy conflict").closest('[role="alert"]'),
    ).toHaveAttribute("data-tone", "danger");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeDisabled();
  });

  it("returns focus and reopens with a clean draft after cancellation", async () => {
    const setAgentToolPolicy = vi.fn().mockResolvedValue(undefined);
    const store = toolPolicyStore({ setAgentToolPolicy });
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

    // The confirmation step offers Keep editing and Save changes; the X
    // still dismisses the whole dialog.
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
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
    const store = toolPolicyStore({ setAgentToolPolicy });
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
    const store = toolPolicyStore({ setAgentToolPolicy });
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
      screen.getByRole("switch", { name: "Enable agent tools" }),
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
      fireEvent.click(screen.getByRole("switch", { name: "Enable agent tools" }));
      fireEvent.click(screen.getByRole("checkbox", { name: "Select all Context tools" }));
      fireEvent.click(screen.getByRole("switch", { name: "Allow other environments" }));
      fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
      await waitFor(() => expect(setAgentToolPolicy).toHaveBeenCalledWith({
        expectedPolicyRevision: 4,
        enabled: true,
        enabledToolIds: ["agent.context", "workspace.list"],
        presentation: { surface: "cli", mode: presentationMode },
        resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false },
      }));
      expect(screen.queryByText(NATIVE_TOOL_CACHE_WARNING)).not.toBeInTheDocument();
    },
  );

  it("disables CLI access during a running turn and preserves latent selections", async () => {
    const { setAgentToolPolicy } = subject(policySnapshot({
      presentationSurface: "cli",
      runState: "running",
    }));
    fireEvent.click(screen.getByRole("switch", { name: "Enable agent tools" }));
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
    expect(screen.getByRole("switch", { name: "Enable agent tools" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "List workspaces" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Allow other environments" })).toBeDisabled();
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
        store={toolPolicyStore({ setAgentToolPolicy })}
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
        store={toolPolicyStore({ setAgentToolPolicy })}
        snapshot={policySnapshot({ presentationSurface: "cli" })}
        authoritative
        disabled={false}
        open
        onOpenChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "List workspaces" }));
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(
      (await screen.findByText("Policy conflict")).closest('[role="alert"]'),
    ).toHaveAttribute("data-tone", "danger");
    expect(screen.getByRole("button", { name: /^Save$/ })).toBeEnabled();
  });
});
