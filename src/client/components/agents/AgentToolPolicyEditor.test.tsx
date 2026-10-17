// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolBootstrapDescriptor } from "../../../shared/index.js";
import { AgentToolPolicyEditor } from "./AgentToolPolicyEditor.js";

beforeEach(() => {
  Object.assign(window.HTMLElement.prototype, { scrollIntoView: vi.fn() });
});

afterEach(cleanup);

const catalog: AgentToolBootstrapDescriptor = {
  defaultPresentation: { surface: "native", mode: "progressive" },
  defaultPolicy: {
    enabled: false,
    enabledToolIds: [],
    source: "default",
    presentation: { surface: "native", mode: "progressive" },
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
  },
  resolvedPolicy: {
    enabled: false,
    enabledToolIds: [],
    source: "default",
    presentation: { surface: "native", mode: "progressive" },
    resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false },
  },
  presentationOptions: [
    { surface: "native", modes: ["progressive", "individual"] },
    { surface: "cli", modes: ["progressive", "individual"] },
  ],
  groups: [
    {
      id: "threads",
      label: { text: "Threads" },
      description: { text: "Thread operations" },
      order: 0,
      tools: [
        {
          id: "thread.status",
          label: { text: "Thread status" },
          description: { text: "Read status" },
          order: 0,
          effects: {
            application: "read",
            modelUsage: "none",
            external: "none",
          },
          enabled: false,
          available: true,
        },
      ],
    },
  ],
};

const policySet = {
  id: "33333333-3333-4333-8333-333333333333",
  name: "Reviewer",
  enabledToolIds: ["thread.status"],
  resourceScope: { allowOtherEnvironments: true, allowOtherProjects: false },
  revision: 2, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z",
};

describe("AgentToolPolicyEditor", () => {
  it("names the inherited source, policy and saved revision", () => {
    render(<AgentToolPolicyEditor catalog={{ ...catalog, defaultPolicy: {
      ...catalog.defaultPolicy!, enabled: true, enabledToolIds: policySet.enabledToolIds,
      source: "backend", policySet: { id: policySet.id, name: policySet.name, revision: policySet.revision },
    } }} value={{ kind: "inherit" }} policySets={[policySet]} onChange={vi.fn()} onPresentationChange={vi.fn()} />);
    expect(screen.getByText("Inherited from backend settings · Reviewer · revision 2")).toBeInTheDocument();
  });

  it("keeps presentation controls available when an inherited set is missing", () => {
    const issue = { kind: "missing_policy_set" as const, source: "backend" as const, policySetId: policySet.id };
    render(<AgentToolPolicyEditor catalog={{ ...catalog, defaultPolicy: null, resolvedPolicy: null, defaultIssue: issue, resolvedIssue: issue }}
      value={{ kind: "inherit" }} policySets={[]} onChange={vi.fn()} onPresentationChange={vi.fn()} />);
    expect(screen.getByRole("switch", { name: "Use backend presentation" })).toBeEnabled();
    expect(screen.getByText(/Needs attention: the backend policy set/)).toBeInTheDocument();
    expect(screen.queryByText("The effective policy is resolved when a thread is created.")).not.toBeInTheDocument();
  });

  it("selects a reusable policy without duplicating its tools in the Agent", () => {
    const onChange = vi.fn();
    render(<AgentToolPolicyEditor id="agent-tools" catalog={catalog}
      value={{ kind: "inherit" }} policySets={[policySet]} onChange={onChange} onPresentationChange={vi.fn()} />);
    expect(screen.getByRole("region", { name: "Sedes tools" })).toHaveAttribute("id", "agent-tools");
    expect(screen.getByText("No Sedes tools are exposed.")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Tool policy" }), { target: { value: policySet.id } });
    expect(onChange).toHaveBeenCalledWith({ kind: "policy_set", policySetId: policySet.id });
    expect(screen.queryByRole("checkbox", { name: "Thread status" })).not.toBeInTheDocument();
  });

  it("shows the selected policy scope and keeps presentation at the backend default", () => {
    render(<AgentToolPolicyEditor catalog={catalog}
      value={{ kind: "policy_set", policySetId: policySet.id }} policySets={[policySet]} onChange={vi.fn()} onPresentationChange={vi.fn()} />);
    expect(screen.getByText(/1 tool · This project across all environments/)).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Use backend presentation" })).toBeChecked();
    expect(screen.queryByRole("combobox", { name: "Sedes tool surface" })).not.toBeInTheDocument();
  });

  it("distinguishes inherit from explicitly disabled", () => {
    const onChange = vi.fn();
    render(<AgentToolPolicyEditor value={{ kind: "disabled" }} policySets={[policySet]} onChange={onChange} onPresentationChange={vi.fn()} />);
    expect(screen.getByText("Explicitly disabled")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "Tool policy" }), { target: { value: "inherit" } });
    expect(onChange).toHaveBeenCalledWith({ kind: "inherit" });
  });

  it("keeps a deleted policy visible until the user replaces it", () => {
    render(<AgentToolPolicyEditor value={{ kind: "policy_set", policySetId: policySet.id }} policySets={[]} onChange={vi.fn()} onPresentationChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "Tool policy" })).toHaveValue(policySet.id);
    expect(screen.getByText(/New threads cannot use this selection/)).toBeInTheDocument();
  });

  it("changes presentation separately from the reusable policy", () => {
    const onPresentationChange = vi.fn();
    render(<AgentToolPolicyEditor catalog={catalog} value={{ kind: "inherit" }} policySets={[]}
      toolPresentation={{ surface: "native", mode: "individual" }} onChange={vi.fn()} onPresentationChange={onPresentationChange} />);
    fireEvent.click(screen.getByRole("combobox", { name: "Sedes tool surface" }));
    fireEvent.click(screen.getByRole("option", { name: "Sedes CLI" }));
    expect(onPresentationChange).toHaveBeenCalledWith({ surface: "cli", mode: "individual" });
    fireEvent.click(screen.getByRole("switch", { name: "Use backend presentation" }));
    expect(onPresentationChange).toHaveBeenLastCalledWith(undefined);
  });
});
