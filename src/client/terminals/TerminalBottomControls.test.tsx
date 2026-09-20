// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalBottomControls } from "./TerminalBottomControls.js";

afterEach(cleanup);

function controls(
  overrides: Partial<React.ComponentProps<typeof TerminalBottomControls>> = {},
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

describe("TerminalBottomControls", () => {
  it("sends the exact seven shared terminal key sequences without Enter", () => {
    const props = controls();
    render(<TerminalBottomControls {...props} />);

    const expected = [
      ["Esc", "\u001b"],
      ["Tab", "\t"],
      ["Send Ctrl+C to terminal", "\u0003"],
      ["Send left arrow to terminal", "\u001b[D"],
      ["Send down arrow to terminal", "\u001b[B"],
      ["Send up arrow to terminal", "\u001b[A"],
      ["Send right arrow to terminal", "\u001b[C"],
    ] as const;
    for (const [name, data] of expected) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(props.sendInput).toHaveBeenLastCalledWith(data);
    }
    expect(props.sendInput).toHaveBeenCalledTimes(7);
    expect(
      screen.queryByRole("button", { name: "Send enter to terminal" }),
    ).toBeNull();
  });

  it("disables every shared action while terminal input is unavailable", () => {
    const props = controls({ inputAvailable: false });
    render(<TerminalBottomControls {...props} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(props.sendInput).not.toHaveBeenCalled();
    expect(props.focusTerminal).not.toHaveBeenCalled();
  });

  it("toggles terminal focus, restores caller focus, and resynchronizes externally", () => {
    let focused = false;
    const props = controls({
      focusTerminal: vi.fn(() => { focused = true; }),
      blurTerminal: vi.fn(() => { focused = false; }),
      isTerminalFocused: vi.fn(() => focused),
      afterBlurFocus: vi.fn(),
    });
    render(
      <>
        <TerminalBottomControls {...props} />
        <button type="button">Outside</button>
      </>,
    );
    const toggle = screen.getByRole("button", {
      name: "Focus terminal keyboard",
    });

    fireEvent.click(toggle);
    expect(props.focusTerminal).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(toggle);
    expect(props.blurTerminal).toHaveBeenCalledOnce();
    expect(props.afterBlurFocus).toHaveBeenCalledOnce();
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    focused = true;
    fireEvent.focus(screen.getByRole("button", { name: "Outside" }));
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("uses pre-pointer terminal focus when the button takes focus before click", () => {
    let focused = true;
    const props = controls({
      focusTerminal: vi.fn(() => { focused = true; }),
      blurTerminal: vi.fn(() => { focused = false; }),
      isTerminalFocused: vi.fn(() => focused),
      afterBlurFocus: vi.fn(),
    });
    render(<TerminalBottomControls {...props} />);
    const toggle = screen.getByRole("button", {
      name: "Focus terminal keyboard",
    });

    fireEvent.pointerDown(toggle);
    focused = false;
    fireEvent.focus(toggle);
    fireEvent.click(toggle);

    expect(props.blurTerminal).toHaveBeenCalledOnce();
    expect(props.focusTerminal).not.toHaveBeenCalled();
    expect(props.afterBlurFocus).toHaveBeenCalledOnce();
  });

  it("renders caller-owned trailing actions after the shared focus toggle", () => {
    render(
      <TerminalBottomControls
        {...controls()}
        trailingActions={<button type="button">Stage draft</button>}
      />,
    );
    const bar = screen.getByRole("group", { name: "Terminal keys" });
    expect(bar.lastElementChild).toHaveTextContent("Stage draft");
  });
});
