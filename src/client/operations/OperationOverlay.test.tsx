// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperationOverlayHost } from "./OperationOverlay.js";
import {
  getBlockingOperation,
  runBlockingOperation,
} from "./blocking-operation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  act(() => {
    getBlockingOperation()?.cancel();
  });
  cleanup();
});

describe("operation overlay", () => {
  it("blocks dismissal and keyboard shortcuts while keeping explicit Cancel reachable", async () => {
    const user = userEvent.setup();
    const request = deferred<string>();
    const navigate = vi.fn();
    const shortcut = vi.fn();
    render(
      <>
        <button>Underlying action</button>
        <OperationOverlayHost />
      </>,
    );
    window.addEventListener("keydown", shortcut, true);
    let completion!: Promise<void>;
    act(() => {
      completion = runBlockingOperation({
        message: "Creating thread…",
        run: () => request.promise,
        onSuccess: navigate,
      });
    });
    await user.keyboard("{Escape}");
    fireEvent.keyDown(window, { key: "1", ctrlKey: true });
    expect(shortcut).not.toHaveBeenCalled();
    const copy = new KeyboardEvent("keydown", {
      key: "c",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    screen.getByRole("dialog").dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(false);
    expect(shortcut).not.toHaveBeenCalled();
    fireEvent.pointerDown(
      document.querySelector(".operation-overlay-backdrop")!,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    await user.tab();
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(
      true,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await completion;
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => {
      request.resolve("created");
      await request.promise;
    });
    expect(navigate).not.toHaveBeenCalled();
    window.removeEventListener("keydown", shortcut, true);
  });

  it("keeps the operation pending through errors and retries then waits for the handoff", async () => {
    render(<OperationOverlayHost />);
    const handoff = deferred<void>();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error("Try again"))
      .mockResolvedValue("thread");
    let finished = false;
    act(() => {
      void runBlockingOperation({
        message: "Creating thread…",
        run,
        retry: true,
        allowCancel: false,
        onSuccess: () => handoff.promise,
      }).then(() => {
        finished = true;
      });
    });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Try again",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close" }),
    );
    expect(finished).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("status").textContent).toContain(
      "Creating thread…",
    );
    expect(document.activeElement).toBe(
      screen.getByRole("dialog"),
    );
    await act(async () => {
      handoff.resolve();
      await handoff.promise;
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(finished).toBe(true);
  });

  it("keeps non-dismissible progress open until completion", async () => {
    const user = userEvent.setup();
    const request = deferred<string>();
    const navigate = vi.fn();
    render(<OperationOverlayHost />);
    act(() => {
      void runBlockingOperation({
        message: "Creating fork…",
        allowCancel: false,
        run: () => request.promise,
        onSuccess: navigate,
      });
    });
    expect(screen.queryByRole("button")).toBeNull();
    await user.keyboard("{Escape}");
    fireEvent.pointerDown(document.querySelector(".operation-overlay-backdrop")!);
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("dialog"));
    expect(navigate).not.toHaveBeenCalled();
    await act(async () => {
      request.resolve("child");
      await request.promise;
    });
    expect(navigate).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not let a canceled old result dismiss a newer operation", async () => {
    const old = deferred<string>();
    const newer = deferred<string>();
    render(<OperationOverlayHost />);
    act(() => {
      void runBlockingOperation({ message: "Old", run: () => old.promise });
    });
    act(() => {
      getBlockingOperation()!.cancel();
    });
    act(() => {
      void runBlockingOperation({ message: "New", run: () => newer.promise });
    });
    await act(async () => {
      old.resolve("old");
      await old.promise;
    });
    expect(screen.getByRole("status").textContent).toContain("New");
  });
});
