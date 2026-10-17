// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicySet, ToolPolicyDefinition, ToolPolicySelectionSetting } from "../../../shared/protocol/tool-policies.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { navigate } from "../../app/router.js";
import { ToolPoliciesSettingsPage } from "./ToolPoliciesSettingsPage.js";
import { ToolPolicyScopeSettings } from "./ToolPolicyScopeSettings.js";

const stamp = "2026-10-17T00:00:00Z";
const policy: ToolPolicySet = { id: "11111111-1111-4111-8111-111111111111", name: "Everyday", revision: 3, createdAt: stamp, updatedAt: stamp, enabledToolIds: ["thread.list"], resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } };
const groups = [{ id: "threads", label: { text: "Threads" }, description: { text: "Find and read conversations." }, order: 0, tools: [{ id: "thread.list", label: { text: "List threads" }, description: { text: "Find threads." }, available: true, enabled: false, order: 0, effects: { application: "read" as const, modelUsage: "none" as const, external: "none" as const } }, { id: "thread.read", label: { text: "Read thread" }, description: { text: "Read one thread." }, available: true, enabled: false, order: 1, effects: { application: "read" as const, modelUsage: "none" as const, external: "none" as const } }] }];
function mockApi() {
  let policies = [policy];
  let settings: ToolPolicySelectionSetting[] = [{ target: { kind: "account" }, selection: { kind: "policy_set", policySetId: policy.id }, revision: 4 }];
  return {
    getToolPolicySet: vi.fn(async (id: string) => policies.find(item => item.id === id)!),
    listToolPolicySets: vi.fn(async () => ({ items: policies })),
    getToolPolicyOptions: vi.fn(async () => ({ groups })),
    listToolPolicySelections: vi.fn(async () => ({ items: settings })),
    setToolPolicySelection: vi.fn(async (input: Parameters<ApiClient["setToolPolicySelection"]>[0]) => {
      const setting = { target: input.target, selection: input.selection, revision: input.expectedRevision + 1 };
      settings = [...settings.filter(item => JSON.stringify(item.target) !== JSON.stringify(input.target)), setting];
      return { setting };
    }),
    createToolPolicySet: vi.fn(async (input: ToolPolicyDefinition) => {
      const result = { ...input, id: "22222222-2222-4222-8222-222222222222", revision: 1, createdAt: stamp, updatedAt: stamp };
      policies = [...policies, result]; return { policySet: result };
    }),
    updateToolPolicySet: vi.fn(async (id: string, input: ToolPolicyDefinition & { expectedRevision: number }) => {
      const { expectedRevision, ...definition } = input;
      const result = { ...policy, ...definition, id, revision: expectedRevision + 1 };
      policies = policies.map(item => item.id === id ? result : item); return { policySet: result };
    }),
    deleteToolPolicySet: vi.fn(async (id: string) => { policies = policies.filter(item => item.id !== id); return { deleted: true as const }; }),
  };
}
beforeEach(() => { vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} }); navigate("/settings/tool-policies", { replace: true }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); navigate("/", { replace: true }); });

describe("Tool policy settings", () => {
  it("creates one exact tool set with independent scope flags and opens its saved route", async () => {
    const api = mockApi(); const user = userEvent.setup();
    render(<ToolPoliciesSettingsPage api={api} />);
    await screen.findByRole("button", { name: "New policy set" });
    await waitFor(() => expect((screen.getByRole("button", { name: "New policy set" }) as HTMLButtonElement).disabled).toBe(false));
    await user.click(screen.getByRole("button", { name: "New policy set" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Build review");
    await user.click(screen.getByRole("switch", { name: "Allow other environments" }));
    await user.click(screen.getByRole("button", { name: "Threads" }));
    await user.click(screen.getByRole("checkbox", { name: "Read thread" }));
    await user.click(screen.getByRole("button", { name: "Create policy set" }));
    await waitFor(() => expect(api.createToolPolicySet).toHaveBeenCalledWith({ name: "Build review", enabledToolIds: ["thread.read"], resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false } }));
    await screen.findByRole("heading", { name: "Build review" });
    expect(window.location.pathname).toContain("22222222-2222-4222-8222-222222222222");
  });
  it("edits with the current revision and warns that deleting leaves references needing attention", async () => {
    const api = mockApi(); const user = userEvent.setup();
    navigate(`/settings/tool-policies/${policy.id}`, { replace: true });
    render(<ToolPoliciesSettingsPage api={api} />);
    await screen.findByRole("textbox", { name: "Name" });
    expect(screen.queryByRole("combobox", { name: "Default tool policy" })).toBeNull();
    expect(screen.getByRole("button", { name: "Account default" })).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Allow other projects" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(api.updateToolPolicySet).toHaveBeenCalledWith(policy.id, expect.objectContaining({ expectedRevision: 3, resourceScope: { allowOtherEnvironments: false, allowOtherProjects: true } })));
    await user.click(screen.getByRole("button", { name: "Delete policy set…" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/will show Needs attention/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Delete policy set" }));
    await waitFor(() => expect(api.deleteToolPolicySet).toHaveBeenCalledWith(policy.id, { expectedRevision: 4 }));
  });
  it("saves a backend replacement separately and previews its account inheritance", async () => {
    const api = mockApi();
    render(<ToolPolicyScopeSettings api={api} target={{ kind: "backend", backendId: "codex-build" }} environmentId="build" />);
    await screen.findByText("Inherited from account defaults");
    expect(screen.getByText("1 tool · This project in this environment")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Tool policy" }), { target: { value: "disabled" } });
    fireEvent.click(screen.getByRole("button", { name: "Save default" }));
    await waitFor(() => expect(api.setToolPolicySelection).toHaveBeenCalledWith({ target: { kind: "backend", backendId: "codex-build" }, selection: { kind: "disabled" }, expectedRevision: 0 }));
    await screen.findByText("Saved");
  });
  it("keeps edits visible on a revision conflict", async () => {
    const api = mockApi();
    api.updateToolPolicySet.mockRejectedValueOnce(new Error("The policy changed in another session. Reload before saving."));
    navigate(`/settings/tool-policies/${policy.id}`, { replace: true });
    render(<ToolPoliciesSettingsPage api={api} />);
    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "My unsaved revision" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("button", { name: "Reload latest" });
    expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("My unsaved revision");
    expect(api.updateToolPolicySet).toHaveBeenCalledWith(policy.id, expect.objectContaining({ expectedRevision: 3 }));
  });
});
