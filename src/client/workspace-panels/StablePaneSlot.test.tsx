// @vitest-environment jsdom

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StablePaneSlot } from "./StablePaneSlot.js";

afterEach(cleanup);

describe("StablePaneSlot", () => {
  it("moves a portal target across recursive topology without remounting its subtree", () => {
    const target = document.createElement("section");
    target.dataset.testid = "stable-target";
    const mounted = vi.fn();
    const unmounted = vi.fn();

    function StatefulPane(): React.JSX.Element {
      const [value, setValue] = useState(0);
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return (
        <button type="button" onClick={() => setValue((current) => current + 1)}>
          Count {value}
        </button>
      );
    }

    function Layout({ nested }: { readonly nested: boolean }): React.JSX.Element {
      return (
        <>
          {nested ? (
            <div data-testid="split">
              <div data-testid="split-child">
                <StablePaneSlot data-testid="nested-slot" target={target} />
              </div>
            </div>
          ) : (
            <StablePaneSlot data-testid="root-slot" target={target} />
          )}
          {createPortal(<StatefulPane />, target, "stable-pane")}
        </>
      );
    }

    const rendered = render(<Layout nested={false} />);
    const originalButton = screen.getByRole("button", { name: "Count 0" });
    fireEvent.click(originalButton);
    expect(originalButton).toHaveTextContent("Count 1");
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    rendered.rerender(<Layout nested />);

    const movedButton = screen.getByRole("button", { name: "Count 1" });
    expect(movedButton).toBe(originalButton);
    expect(target.parentElement).toBe(screen.getByTestId("nested-slot"));
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();

    rendered.unmount();
    expect(target.parentNode).toBeNull();
    expect(unmounted).toHaveBeenCalledTimes(1);
  });

  it("does not remove a target that another host adopted before cleanup", () => {
    const target = document.createElement("section");
    const nextHost = document.createElement("div");
    document.body.append(nextHost);
    const rendered = render(<StablePaneSlot target={target} />);

    nextHost.append(target);
    rendered.unmount();

    expect(target.parentNode).toBe(nextHost);
    nextHost.remove();
  });
});
