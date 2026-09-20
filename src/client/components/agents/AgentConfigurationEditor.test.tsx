// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedAgentConfigurationDescriptor } from "../../../shared/index.js";
import { AgentConfigurationEditor } from "./AgentConfigurationEditor.js";

afterEach(cleanup);

const descriptor = {
  backendTypeId: "codex",
  fields: [
    {
      id: "model",
      label: { text: "Model" },
      description: { text: "Model used for new threads" },
      options: [
        { value: "default-model", label: { text: "Default model" }, available: true },
        { value: "other-model", label: { text: "Other model" }, available: true },
      ],
      currentDefaultValue: "default-model",
      resolvedValue: "default-model",
    },
  ],
  canonicalOverrides: [],
} as NormalizedAgentConfigurationDescriptor;

describe("AgentConfigurationEditor", () => {
  it("makes inheritance explicit and creates a sparse override", () => {
    const onChange = vi.fn();
    render(
      <AgentConfigurationEditor descriptor={descriptor} onChange={onChange} />,
    );
    expect(screen.getByText("Current target default: Default model")).toBeVisible();
    fireEvent.click(screen.getByRole("checkbox", { name: "Override Model" }));
    expect(onChange).toHaveBeenCalledWith([
      { id: "model", value: "default-model" },
    ]);
  });

  it("retains an unavailable explicit value until the user removes it", () => {
    const onChange = vi.fn();
    render(
      <AgentConfigurationEditor
        descriptor={{
          ...descriptor,
          canonicalOverrides: [{ id: "model", value: "removed-model" }],
          fields: [
            {
              ...descriptor.fields[0]!,
              resolvedValue: null,
            },
          ],
        }}
        onChange={onChange}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Model" })).toHaveTextContent(
      "removed-model",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Override Model" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });
});
