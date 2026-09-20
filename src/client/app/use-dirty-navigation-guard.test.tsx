// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { navigate, routePath, useRoute } from "./router.js";
import { useDirtyNavigationGuard } from "./use-dirty-navigation-guard.js";

function Fixture({ dirty }: { readonly dirty: boolean }): React.JSX.Element {
  const route = useRoute();
  const guard = useDirtyNavigationGuard(dirty);
  return (
    <div>
      <output>{routePath(route)}</output>
      <button onClick={() => navigate("/archived")}>Leave</button>
      <button onClick={() => navigate("/settings/backends", { replace: true })}>Replace</button>
      {guard.pendingRoute && (
        <div role="dialog" aria-label="Discard changes">
          <button onClick={guard.cancel}>Keep editing</button>
          <button onClick={guard.discardAndContinue}>Discard</button>
        </div>
      )}
    </div>
  );
}

afterEach(() => {
  cleanup();
  navigate("/", { replace: true });
});

describe("useDirtyNavigationGuard", () => {
  it("blocks a dirty route once and continues only after confirmation", () => {
    render(<Fixture dirty />);
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    expect(window.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(window.location.pathname).toBe("/");

    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(window.location.pathname).toBe("/archived");
  });

  it("retains replace intent rather than pushing a new entry after confirmation", () => {
    render(<Fixture dirty />);
    const length = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    expect(window.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(window.location.pathname).toBe("/settings/backends");
    expect(window.history.length).toBe(length);
  });

  it("cancels and resumes browser Back while keeping subsequent Back and Forward usable", async () => {
    navigate("/settings/general", { replace: true });
    navigate("/settings/appearance");
    navigate("/settings/backends");
    const length = window.history.length;
    const view = render(<Fixture dirty />);
    act(() => window.history.back());
    await screen.findByRole("dialog", { name: "Discard changes" });
    await waitFor(() => expect(window.location.pathname).toBe("/settings/backends"));
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(window.history.length).toBe(length);
    act(() => window.history.back());
    await screen.findByRole("dialog", { name: "Discard changes" });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/settings/appearance"));
    expect(window.location.pathname).toBe("/settings/appearance");
    expect(window.history.length).toBe(length);
    expect(screen.queryByRole("dialog", { name: "Discard changes" })).toBeNull();
    view.rerender(<Fixture dirty={false} />);
    act(() => window.history.back());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/settings/general"));
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/settings/appearance"));
    act(() => window.history.forward());
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("/settings/backends"));
  });

  it("marks browser exit only while dirty", async () => {
    const view = render(<Fixture dirty />);
    const blocked = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(blocked);
    expect(blocked.defaultPrevented).toBe(true);

    view.rerender(<Fixture dirty={false} />);
    await waitFor(() => {
      const allowed = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(allowed);
      expect(allowed.defaultPrevented).toBe(false);
    });
  });
});
