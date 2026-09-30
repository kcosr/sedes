// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useChatAutofocus } from "./use-chat-autofocus.js";

let fineDesktop = true;

beforeEach(() => {
  fineDesktop = true;
  vi.stubGlobal("matchMedia", () => ({
    matches: fineDesktop,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Probe({ name }: { name: string }) {
  return <output data-testid={name}>{String(useChatAutofocus())}</output>;
}

function pointerDown(pointerType: string): void {
  const event = new Event("pointerdown", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(document.body, event);
}

it.each(["touch", "pen"])("carries %s selection into a newly mounted thread on a fine-pointer device", (type) => {
  const view = render(<Probe name="panel" />);
  expect(screen.getByTestId("panel")).toHaveTextContent("true");
  pointerDown(type);
  view.rerender(<><Probe name="panel" /><Probe name="cold-thread" /></>);
  expect(screen.getByTestId("panel")).toHaveTextContent("false");
  expect(screen.getByTestId("cold-thread")).toHaveTextContent("false");
  pointerDown("mouse");
  expect(screen.getByTestId("panel")).toHaveTextContent("true");
  expect(screen.getByTestId("cold-thread")).toHaveTextContent("true");
});

it("restores keyboard navigation without treating a touch modifier as keyboard selection", () => {
  render(<Probe name="panel" />);
  pointerDown("touch");
  fireEvent.keyDown(document.body, { key: "Shift" });
  expect(screen.getByTestId("panel")).toHaveTextContent("false");
  fireEvent.keyDown(document.body, { key: "ArrowDown" });
  expect(screen.getByTestId("panel")).toHaveTextContent("true");
});

it("does not autofocus a wide coarse-pointer tablet even before its first pointer event", () => {
  fineDesktop = false;
  render(<Probe name="panel" />);
  expect(screen.getByTestId("panel")).toHaveTextContent("false");
  pointerDown("touch");
  expect(screen.getByTestId("panel")).toHaveTextContent("false");
});
