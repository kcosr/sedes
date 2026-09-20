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
  defaultPolicy: {
    enabled: false,
    enabledToolIds: [],
    presentation: { surface: "native", mode: "progressive" },
    accessBoundary: "environment",
  },
  resolvedPolicy: {
    enabled: false,
    enabledToolIds: [],
    presentation: { surface: "native", mode: "progressive" },
    accessBoundary: "environment",
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

describe("AgentToolPolicyEditor", () => {
  it("describes inherited, global, and group policy controls", () => {
    render(
      <AgentToolPolicyEditor
        catalog={catalog}
        value={{
          enabled: true,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        }}
        onChange={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("checkbox", { name: "Use default tool policy" }),
    ).toHaveAccessibleDescription(
      "Use the selected target’s ordinary new-thread settings.",
    );
    expect(
      screen.getByRole("checkbox", { name: "Enable Sedes tools" }),
    ).toHaveAccessibleDescription("Expose the selected tools on new threads.");
    expect(
      screen.getByRole("checkbox", { name: "Select all Threads tools" }),
    ).toHaveAccessibleDescription("Thread operations");
  });

  it("switches between inherited and explicit complete policy", () => {
    const onChange = vi.fn();
    render(<AgentToolPolicyEditor catalog={catalog} onChange={onChange} />);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Use default tool policy" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      enabled: false,
      enabledToolIds: [],
      presentation: { surface: "native", mode: "progressive" },
      accessBoundary: "environment",
    });
  });

  it("retains and permits removing unavailable selected tools", () => {
    const onChange = vi.fn();
    render(
      <AgentToolPolicyEditor
        catalog={catalog}
        value={{
          enabled: true,
          enabledToolIds: ["missing.tool"],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "unrestricted",
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Remove unavailable tool missing.tool",
      }),
    );
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      enabledToolIds: [],
      presentation: { surface: "native", mode: "progressive" },
      accessBoundary: "unrestricted",
    });
  });

  it("edits the relative environment rule and explains allow", () => {
    const onChange = vi.fn();
    const view = render(
      <AgentToolPolicyEditor
        catalog={catalog}
        value={{
          enabled: true,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("combobox", { name: "Access boundary" }),
    );
    fireEvent.click(
      screen.getByRole("option", { name: "Allow without asking" }),
    );
    expect(onChange).toHaveBeenCalledWith({
      enabled: true,
      enabledToolIds: [],
      presentation: { surface: "native", mode: "progressive" },
      accessBoundary: "unrestricted",
    });
    expect(
      screen.getByRole("combobox", { name: "Access boundary" }),
    ).toHaveAccessibleDescription(
      "For each thread created from this Agent, that thread’s execution environment is treated as its current environment.",
    );

    view.rerender(
      <AgentToolPolicyEditor
        catalog={catalog}
        value={{
          enabled: true,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "unrestricted",
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Threads created from this Agent may use enabled Sedes tools in other environments without asking. Existing threads are not changed when this Agent is edited.",
    );
  });

  it("renders independent surface and presentation selectors", () => {
    const onChange = vi.fn();
    render(
      <AgentToolPolicyEditor
        catalog={catalog}
        value={{
          enabled: true,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        }}
        onChange={onChange}
      />,
    );

    fireEvent.click(
      screen.getByRole("combobox", { name: "Sedes tool surface" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Sedes CLI" }));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        presentation: { surface: "cli", mode: "progressive" },
      }),
    );

    fireEvent.click(
      screen.getByRole("combobox", { name: "Sedes tool presentation" }),
    );
    expect(
      screen.getByRole("option", {
        name: "Progressive discovery (recommended)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "Individual operations" }),
    ).toBeVisible();
  });

  it("hides fixed selectors and falls back when a surface lacks the current mode", () => {
    const onChange = vi.fn();
    const fixedCatalog: AgentToolBootstrapDescriptor = {
      ...catalog,
      defaultPolicy: {
        ...catalog.defaultPolicy,
        presentation: { surface: "cli", mode: "progressive" },
      },
      resolvedPolicy: {
        ...catalog.resolvedPolicy,
        presentation: { surface: "cli", mode: "progressive" },
      },
      presentationOptions: [{ surface: "cli", modes: ["progressive"] }],
    };
    const view = render(
      <AgentToolPolicyEditor
        catalog={fixedCatalog}
        value={{
          enabled: true,
          enabledToolIds: [],
          presentation: { surface: "cli", mode: "progressive" },
          accessBoundary: "environment",
        }}
        onChange={onChange}
      />,
    );
    expect(
      screen.queryByRole("combobox", { name: "Sedes tool surface" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Sedes tool presentation" }),
    ).not.toBeInTheDocument();

    view.rerender(
      <AgentToolPolicyEditor
        catalog={{
          ...catalog,
          presentationOptions: [
            { surface: "native", modes: ["progressive", "individual"] },
            { surface: "cli", modes: ["individual"] },
          ],
        }}
        value={{
          enabled: true,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: "environment",
        }}
        onChange={onChange}
      />,
    );
    fireEvent.click(
      screen.getByRole("combobox", { name: "Sedes tool surface" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "Sedes CLI" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        presentation: { surface: "cli", mode: "individual" },
      }),
    );
  });
});
