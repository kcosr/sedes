// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalMobileControls } from "./TerminalMobileControls.js";

afterEach(cleanup);

function props(
  overrides: Partial<React.ComponentProps<typeof TerminalMobileControls>> = {},
) {
  return {
    inputAvailable: true,
    sendInput: vi.fn(() => true),
    focusTerminal: vi.fn(),
    blurTerminal: vi.fn(),
    isTerminalFocused: vi.fn(() => false),
    ...overrides,
  };
}

describe("TerminalMobileControls", () => {
  it("sends a staged command with or without Enter and clears accepted text", () => {
    const input = props();
    render(<TerminalMobileControls {...input} />);
    const command = screen.getByRole("textbox", { name: "Terminal command" });

    fireEvent.change(command, { target: { value: "pwd" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Stage command in terminal" }),
    );
    expect(input.sendInput).toHaveBeenLastCalledWith("pwd");
    expect(
      screen.getByRole("textbox", { name: "Terminal command" }),
    ).toHaveValue("");

    fireEvent.change(
      screen.getByRole("textbox", { name: "Terminal command" }),
      { target: { value: "ls -la" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Send command to terminal" }),
    );
    expect(input.sendInput).toHaveBeenLastCalledWith("ls -la\r");
  });

  it("uses Enter to submit, Shift+Enter for multiline, and empty Send for Enter", () => {
    const input = props();
    render(<TerminalMobileControls {...input} />);
    const command = screen.getByRole("textbox", { name: "Terminal command" });

    fireEvent.change(command, { target: { value: "echo one" } });
    command.focus();
    fireEvent.keyDown(command, { key: "Enter", shiftKey: true });
    expect(input.sendInput).not.toHaveBeenCalled();
    fireEvent.keyDown(command, { key: "Enter" });
    expect(input.sendInput).toHaveBeenLastCalledWith("echo one\r");
    expect(document.activeElement).toBe(command);

    fireEvent.click(
      screen.getByRole("button", { name: "Send command to terminal" }),
    );
    expect(input.sendInput).toHaveBeenLastCalledWith("\r");
  });

  it("does not submit an IME confirmation reported with keyCode 229", () => {
    const input = props();
    render(<TerminalMobileControls {...input} />);
    const command = screen.getByRole("textbox", { name: "Terminal command" });
    fireEvent.change(command, { target: { value: "\u4f60\u597d" } });

    fireEvent.keyDown(command, { key: "Enter", keyCode: 229 });

    expect(input.sendInput).not.toHaveBeenCalled();
    expect(command).toHaveValue("\u4f60\u597d");
  });

  it("retains rejected input and disables the native field without control", () => {
    const rejected = props({ sendInput: vi.fn(() => false) });
    const view = render(<TerminalMobileControls {...rejected} />);
    const command = screen.getByRole("textbox", { name: "Terminal command" });
    fireEvent.change(command, { target: { value: "keep me" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Send command to terminal" }),
    );
    expect(command).toHaveValue("keep me");

    view.rerender(
      <TerminalMobileControls {...rejected} inputAvailable={false} />,
    );
    expect(command).toBeDisabled();
    expect(command).toHaveAttribute("placeholder", "Take control to type");
  });
});
