// @vitest-environment jsdom

import { cleanup, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pierreExpandControlLabel,
  usePierreExpandControls,
} from "./pierre-expand-controls.js";

afterEach(cleanup);

/** A Pierre file host with one separator holding the given expand controls. */
function pierreHost(kinds: readonly string[]): HTMLElement {
  const host = document.createElement("diffs-container");
  const root = host.attachShadow({ mode: "open" });
  const separator = document.createElement("div");
  separator.setAttribute("data-separator", "line-info-basic");
  separator.setAttribute("data-expand-index", "1");
  for (const kind of kinds) {
    const control = document.createElement("div");
    control.setAttribute("role", "button");
    control.setAttribute("data-expand-button", "");
    control.setAttribute(kind, "");
    separator.append(control);
  }
  root.append(separator);
  return host;
}

let captured: ReturnType<typeof usePierreExpandControls> | undefined;

function Harness({ children }: { readonly children?: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  captured = usePierreExpandControls(scroller);
  return (
    <div ref={scroller} tabIndex={-1} onKeyDown={captured.onKeyDown}>
      {children}
    </div>
  );
}

describe("usePierreExpandControls", () => {
  it("names the controls after the way their chevron points", () => {
    const make = (kind: string) => {
      const element = document.createElement("div");
      element.setAttribute(kind, "");
      return element;
    };
    expect(pierreExpandControlLabel(make("data-expand-up"))).toBe("Expand down");
    expect(pierreExpandControlLabel(make("data-expand-down"))).toBe("Expand up");
    expect(pierreExpandControlLabel(make("data-expand-both"))).toBe("Expand all");
  });

  it("makes Pierre's expand controls focusable, named and operable from the keyboard", () => {
    const view = render(<Harness />);
    const host = pierreHost(["data-expand-up", "data-expand-down"]);
    view.container.firstElementChild!.append(host);
    captured!.onPostRender(host, undefined, "mount");

    const controls = [
      ...host.shadowRoot!.querySelectorAll<HTMLElement>("[data-expand-button]"),
    ];
    expect(controls.map((control) => control.tabIndex)).toEqual([0, 0]);
    expect(controls.map((control) => control.getAttribute("aria-label"))).toEqual([
      "Expand down",
      "Expand up",
    ]);
    expect(controls[0]).toHaveAttribute("title", "Expand down");

    const click = vi.fn();
    controls[1]!.addEventListener("click", click);
    fireEvent.keyDown(controls[1]!, { key: "Enter" });
    fireEvent.keyDown(controls[1]!, { key: " " });
    fireEvent.keyDown(controls[1]!, { key: "a" });
    expect(click).toHaveBeenCalledTimes(2);
  });

  it("leaves an unmounting file alone", () => {
    render(<Harness />);
    const host = pierreHost(["data-expand-both"]);
    captured!.onPostRender(host, undefined, "unmount");
    expect(
      host.shadowRoot!.querySelector("[data-expand-button]"),
    ).not.toHaveAttribute("tabindex");
  });
});
