// @vitest-environment jsdom
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolPolicySet } from "../../../shared/protocol/tool-policies.js";
import { ToolPolicySelector, describeToolPolicyScope } from "./ToolPolicySelector.js";

afterEach(cleanup);
const policy: ToolPolicySet = { id: "11111111-1111-4111-8111-111111111111", name: "Reviewer", revision: 3, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z", enabledToolIds: ["thread.list"], resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false } };

describe("ToolPolicySelector", () => {
  it("keeps disabled, inherit and a named replacement distinct", () => {
    const change = vi.fn();
    const view = render(<ToolPolicySelector value={{ kind: "inherit" }} onChange={change} policySets={[policy]} inheritedLabel="account defaults" inheritedPolicy={{ ...policy, enabled: true }} />);
    expect(screen.getByText("Inherited from account defaults")).toBeTruthy();
    expect(screen.getByText("1 tool · This project across all environments")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Tool policy" }), { target: { value: "disabled" } });
    expect(change).toHaveBeenLastCalledWith({ kind: "disabled" });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: policy.id } });
    expect(change).toHaveBeenLastCalledWith({ kind: "policy_set", policySetId: policy.id });
    view.rerender(<ToolPolicySelector value={{ kind: "disabled" }} onChange={change} policySets={[policy]} />);
    expect(screen.getByText("Explicitly disabled")).toBeTruthy();
    expect(screen.getByText("No Sedes tools are exposed.")).toBeTruthy();
  });
  it("retains a missing reference and explains the blocked creation", () => {
    render(<ToolPolicySelector value={{ kind: "policy_set", policySetId: policy.id }} onChange={vi.fn()} policySets={[]} />);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(policy.id);
    expect(screen.getByText(/New threads cannot use this selection/)).toBeTruthy();
    expect(screen.getByRole("option", { name: "Needs attention — missing policy set" })).toBeTruthy();
  });
  it("describes all four independent resource boundaries", () => {
    expect(describeToolPolicyScope({ allowOtherEnvironments: false, allowOtherProjects: false })).toBe("This project in this environment");
    expect(describeToolPolicyScope({ allowOtherEnvironments: true, allowOtherProjects: false })).toBe("This project across all environments");
    expect(describeToolPolicyScope({ allowOtherEnvironments: false, allowOtherProjects: true })).toBe("All projects in this environment");
    expect(describeToolPolicyScope({ allowOtherEnvironments: true, allowOtherProjects: true })).toBe("All projects across all environments");
  });
});

it.each(["loading", "error"] as const)("does not mistake %s policy choices for a missing set", state => {
  render(<ToolPolicySelector value={{ kind: "policy_set", policySetId: policy.id }} policySets={[]} catalogState={state} onChange={vi.fn()} />);
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(screen.queryByText(/Needs attention/)).toBeNull();
  expect(screen.getByRole("option", { name: /Selected policy/ })).toHaveValue(policy.id);
});

it("names the inherited set and revision alongside its source", () => {
  render(<ToolPolicySelector value={{ kind: "inherit" }} policySets={[policy]} inheritedLabel="environment defaults"
    inheritedPolicy={{ ...policy, enabled: true, policySet: { name: policy.name, revision: policy.revision } }} onChange={vi.fn()} />);
  expect(screen.getByText("Inherited from environment defaults · Reviewer · revision 3")).toBeTruthy();
});

it("lets the parent show one source-aware missing-policy message", () => {
  render(<ToolPolicySelector value={{ kind: "policy_set", policySetId: policy.id }} policySets={[]} hidePreview suppressMissingMessage onChange={vi.fn()} />);
  expect(screen.getByRole("option", { name: "Needs attention — missing policy set" })).toBeTruthy();
  expect(screen.queryByText(/New threads cannot use/)).toBeNull();
  expect(screen.queryByText(/Choose another policy or inherit/)).toBeNull();
});
