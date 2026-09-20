// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../../api/ApiClient.js";
import { ThreadEnvironmentVariables } from "./ThreadEnvironmentVariables.js";

afterEach(cleanup);

describe("ThreadEnvironmentVariables", () => {
  it("shows an immutable snapshot and forks with the complete replacement thread layer", async () => {
    const result = { editable: false, snapshot: { version: 1, layers: {
      environment: { CI: { kind: "literal", value: "true" } }, backend: {}, agent: {},
      thread: { CI: { kind: "literal", value: "false" } },
    } } };
    const getThreadEnvironmentVariables = vi.fn().mockResolvedValue(result);
    const onFork = vi.fn();
    render(<ThreadEnvironmentVariables api={{ getThreadEnvironmentVariables } as unknown as ApiClient} threadId="thread-a" title="Build" onClose={vi.fn()} onFork={onFork} restoreFocus={vi.fn()} />);
    expect(await screen.findByText("false")).toBeVisible();
    expect(getThreadEnvironmentVariables).toHaveBeenCalledWith("thread-a", expect.any(AbortSignal));
    expect(screen.queryByLabelText("Value for CI")).toBeNull();
    await waitFor(() => expect(screen.getByRole("button", { name: "Fork with changes…" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Fork with changes…" }));
    fireEvent.change(screen.getByLabelText("Action for CI"), { target: { value: "inherit" } });
    fireEvent.click(screen.getByRole("button", { name: "Create fork" }));
    expect(onFork).toHaveBeenCalledWith({});
    expect(result.snapshot.layers.thread.CI.value).toBe("false");
  });

  it("keeps unavailable forks disabled without hiding saved settings", async () => {
    const api = { getThreadEnvironmentVariables: vi.fn().mockResolvedValue({ editable: false, snapshot: { version: 1, layers: { environment: {}, backend: {}, agent: {}, thread: {} } } }) } as unknown as ApiClient;
    render(<ThreadEnvironmentVariables api={api} threadId="thread-a" title="Build" onClose={vi.fn()} onFork={vi.fn()} forkUnavailableReason="No completed turn to fork." restoreFocus={vi.fn()} />);
    expect(await screen.findByText("No user-supplied variables.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Fork with changes…" })).toBeDisabled();
    expect(screen.getByText("No completed turn to fork.")).toBeVisible();
  });
});
