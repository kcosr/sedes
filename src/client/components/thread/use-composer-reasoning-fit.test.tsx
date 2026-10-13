// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useComposerReasoningFit } from "./use-composer-reasoning-fit.js";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("yields the reference shortcut before reasoning and restores both when space returns", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 390 } as DOMRect);
  let available = 250;
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => available);
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function(this: HTMLElement) {
    return this.closest("[data-reference-collapsed]") ? 240 : 280;
  });
  function Composer() {
    const { footerRef } = useComposerReasoningFit();
    return <div ref={footerRef} data-testid="footer">
      <div className="composer-tools"><button data-composer-reference-trigger="">References</button><span data-setting-id="thinking_level"><button>Effort</button></span></div>
      <div className="send-group"><button>Queue</button><button>Stop</button></div>
    </div>;
  }
  render(<Composer />);
  const footer = screen.getByTestId("footer");
  expect(footer).toHaveAttribute("data-reference-collapsed");
  expect(footer).not.toHaveAttribute("data-reasoning-collapsed");
  available = 200;
  fireEvent(window, new Event("resize"));
  expect(footer).toHaveAttribute("data-reference-collapsed");
  expect(footer).toHaveAttribute("data-reasoning-collapsed");
  available = 300;
  fireEvent(window, new Event("resize"));
  expect(footer).not.toHaveAttribute("data-reference-collapsed");
  expect(footer).not.toHaveAttribute("data-reasoning-collapsed");
});

it("hides effort in the delivery-controls commit without waiting for observers or animation frames", () => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 360 } as DOMRect);
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function(this: HTMLElement) {
    return this.closest("[data-busy=true]") ? 180 : 270;
  });
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(240);
  function Composer() {
    const { footerRef } = useComposerReasoningFit();
    const [busy, setBusy] = useState(false);
    return <div ref={footerRef} data-testid="footer" data-busy={busy}>
      <div className="composer-tools"><span data-setting-id="thinking_level"><button>Effort</button></span></div>
      <div className="send-group"><button onClick={() => setBusy(!busy)}>{busy ? "Stop" : "Send"}</button>{busy && <button>Queue</button>}</div>
    </div>;
  }
  render(<Composer />);
  expect(screen.getByTestId("footer")).not.toHaveAttribute("data-reasoning-collapsed");
  fireEvent.click(screen.getByText("Send"));
  expect(screen.getByTestId("footer")).toHaveAttribute("data-reasoning-collapsed");
  fireEvent.click(screen.getByText("Stop"));
  expect(screen.getByTestId("footer")).not.toHaveAttribute("data-reasoning-collapsed");
  expect(screen.getByTestId("footer")).not.toHaveAttribute("data-reasoning-measuring");
});
