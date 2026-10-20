// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary, crashDetails } from "./AppErrorBoundary.js";

let failing = true;
function Shell() {
  if (failing) throw new TypeError("Cannot read properties of undefined");
  return <p>Workspace</p>;
}

beforeEach(() => {
  failing = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppErrorBoundary", () => {
  it("replaces a crashed app with a recoverable page and tries again", () => {
    render(<AppErrorBoundary><Shell /></AppErrorBoundary>);
    expect(screen.getByRole("heading", { name: "Sedes couldn’t display this page" })).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Try again" });
    expect(retry).toHaveFocus();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    failing = false;
    fireEvent.click(retry);
    expect(screen.getByText("Workspace")).toBeInTheDocument();
  });

  it("copies the error, stack and component stack for a bug report", async () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<AppErrorBoundary><Shell /></AppErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    expect(await screen.findByText("Details copied.")).toBeInTheDocument();
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain("TypeError: Cannot read properties of undefined");
    expect(copied).toContain("Component stack:");
    expect(copied).toContain("Shell");
  });

  it("says when the details could not be copied", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error("denied"); }) } });
    render(<AppErrorBoundary><Shell /></AppErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn’t copy the details."));
  });

  it("says the details could not be copied where there is no clipboard", async () => {
    vi.stubGlobal("navigator", { ...navigator, clipboard: undefined });
    render(<AppErrorBoundary><Shell /></AppErrorBoundary>);
    fireEvent.click(screen.getByRole("button", { name: "Copy details" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn’t copy the details."));
  });

  it("formats details without a component stack", () => {
    const details = crashDetails(new Error("Broken"));
    expect(details).toMatch(/^Error: Broken/);
    expect(details).not.toContain("Component stack:");
    expect(details).toContain(`Location: ${window.location.pathname}`);
  });
});
