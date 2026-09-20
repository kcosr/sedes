// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyEnvironmentVariablesSnapshot, type EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { EnvironmentVariableEditor } from "./EnvironmentVariableEditor.js";
import { EnvironmentVariablesDialog } from "./EnvironmentVariablesDialog.js";
import { ConfiguredEnvironmentVariableEditor } from "./ConfiguredEnvironmentVariableEditor.js";
import { variableRows } from "./environment-variable-presentation.js";

afterEach(cleanup);

function Fixture() {
  const [value, setValue] = useState<EnvironmentVariableOverrides>({ LOG_LEVEL: { kind: "literal", value: "debug" } });
  return <EnvironmentVariableEditor scope="thread" inherited={[
    { scope: "environment", values: { LOG_LEVEL: { kind: "literal", value: "info" }, API_TOKEN: { kind: "secret", source: { kind: "environment", name: "DEV_API_TOKEN" } } } },
    { scope: "backend", values: { LOG_LEVEL: { kind: "literal", value: "warn" } } },
  ]} value={value} onChange={setValue} />;
}

describe("EnvironmentVariableEditor", () => {
  it("shows provenance and resets, unsets, and overrides inherited values without confusing empty values", () => {
    render(<Fixture />);
    expect(screen.getByLabelText("Value for LOG_LEVEL")).toHaveValue("debug");
    fireEvent.click(screen.getByRole("button", { name: "Show sources for LOG_LEVEL" }));
    const history = screen.getByLabelText("Sources for LOG_LEVEL");
    expect(within(history).getByText("info")).toBeVisible();
    expect(within(history).getByText("warn")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Action for LOG_LEVEL"), { target: { value: "inherit" } });
    expect(screen.queryByLabelText("Value for LOG_LEVEL")).toBeNull();
    expect(screen.getByText("Inherited from backend")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Action for LOG_LEVEL"), { target: { value: "unset" } });
    expect(screen.getByText("Excluded by thread")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Action for LOG_LEVEL"), { target: { value: "override" } });
    expect(screen.getByLabelText("Value for LOG_LEVEL")).toHaveValue("warn");
    fireEvent.change(screen.getByLabelText("Value for LOG_LEVEL"), { target: { value: "" } });
    expect(screen.getByLabelText("Value for LOG_LEVEL")).toHaveValue("");
    expect(screen.getByText("2 variables")).toBeVisible();
  });

  it("can exclude an ambient variable at environment scope", () => {
    const onChange = vi.fn();
    render(<EnvironmentVariableEditor scope="environment" value={{ CI: { kind: "literal", value: "true" } }} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Action for CI"), { target: { value: "unset" } });
    expect(onChange).toHaveBeenCalledWith({ CI: { kind: "unset" } });
  });

  it("allows editing a secret reference while never showing or requesting its value", () => {
    render(<Fixture />);
    expect(screen.getByLabelText("Secret value hidden")).toBeVisible();
    fireEvent.change(screen.getByLabelText("Action for API_TOKEN"), { target: { value: "override" } });
    expect(screen.getByLabelText("Secret reference for API_TOKEN")).toHaveValue("DEV_API_TOKEN");
    fireEvent.change(screen.getByLabelText("Secret reference for API_TOKEN"), { target: { value: "CI_API_TOKEN" } });
    expect(screen.getByLabelText("Secret reference for API_TOKEN")).toHaveValue("CI_API_TOKEN");
    fireEvent.change(screen.getByLabelText("Value type for API_TOKEN"), { target: { value: "protected_file" } });
    fireEvent.change(screen.getByLabelText("Secret reference for API_TOKEN"), { target: { value: "/run/credentials/api-token" } });
    expect(screen.getByLabelText("Secret reference for API_TOKEN")).toHaveValue("/run/credentials/api-token");
  });

  it("rejects protected names and duplicate names differing only in case", () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "SEDES_AGENT_TOOL_ENDPOINT" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(screen.getByRole("alert")).toBeVisible();
    fireEvent.change(screen.getByLabelText("New variable name"), { target: { value: "log_level" } });
    fireEvent.click(screen.getByRole("button", { name: /^Add$/ }));
    expect(screen.getByRole("alert")).toHaveTextContent("already exists");
  });

  it("merges casing consistently with the server", () => {
    const rows = variableRows([{ scope: "environment", values: { Path: { kind: "literal", value: "/base" } } }, { scope: "thread", values: { PATH: { kind: "unset" } } }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "PATH", scope: "thread", entry: { kind: "unset" }, history: [{ scope: "environment" }, { scope: "thread" }] });
  });

  it("keeps editing transactional when the variable dialog is cancelled", () => {
    const snapshot = emptyEnvironmentVariablesSnapshot();
    snapshot.layers.thread.CI = { kind: "literal", value: "true" };
    const onApply = vi.fn(); const onOpenChange = vi.fn();
    render(<EnvironmentVariablesDialog open snapshot={snapshot} description="Review thread variables" onApply={onApply} onOpenChange={onOpenChange} />);
    fireEvent.change(screen.getByLabelText("Value for CI"), { target: { value: "false" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(snapshot.layers.thread.CI).toEqual({ kind: "literal", value: "true" });
  });

  it("disables unsupported startup settings and explains that inherited startup values do not apply", () => {
    render(<ConfiguredEnvironmentVariableEditor scope="backend" inherited={{ execution: {}, startup: { HTTPS_PROXY: { kind: "literal", value: "http://proxy.example" } } }} startupUnavailableReason="The process is externally owned." onChange={vi.fn()} />);
    expect(screen.getByRole("tab", { name: "Backend startup" })).toBeDisabled();
    expect(screen.getByRole("note")).toHaveTextContent("Inherited startup settings are not applied");
    expect(screen.queryByText("HTTPS_PROXY")).toBeNull();
  });
});
