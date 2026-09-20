// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { getBlockingOperation } from "./blocking-operation.js";
import { runThreadCreation, runThreadFork } from "./thread-creation.js";
import { openThreadRoute } from "../workspace-panels/thread-panel-navigation.js";
vi.mock("./thread-readiness.js", () => ({
  waitForOperationThreadReady: vi.fn(async () => undefined),
}));
vi.mock("../workspace-panels/thread-panel-navigation.js", () => ({
  openThreadRoute: vi.fn(),
}));

afterEach(() => {
  getBlockingOperation()?.cancel();
  vi.clearAllMocks();
});

const presentation = "single" as const;

describe("thread creation operations", () => {
  it("suppresses navigation when creation completes after the overlay host unmounts", async () => {
    let finish!: (id: string) => void;
    const pending = new Promise<string>((resolve) => {
      finish = resolve;
    });
    const operation = runThreadCreation({
      message: "Creating thread…",
      create: () => pending,
      presentation,
    });
    expect(getBlockingOperation()?.allowCancel).toBe(false);
    getBlockingOperation()!.cancel();
    await operation;
    finish("created-child");
    await pending;
    await Promise.resolve();
    expect(openThreadRoute).not.toHaveBeenCalled();
  });

  it("retains the source request until completion after the overlay host unmounts", async () => {
    let finish!: (result: { status: "created"; childThreadId: string }) => void;
    const pending = new Promise<{ status: "created"; childThreadId: string }>(
      (resolve) => {
        finish = resolve;
      },
    );
    const releases: ReturnType<typeof vi.fn>[] = [];
    const retainSource = () => {
      const release = vi.fn();
      releases.push(release);
      return release;
    };
    const operation = runThreadFork({
      fork: () => pending,
      retainSource,
      presentation,
    });
    expect(releases).toHaveLength(2);
    expect(getBlockingOperation()?.allowCancel).toBe(false);
    getBlockingOperation()!.cancel();
    await operation;
    expect(releases[0]).toHaveBeenCalledOnce();
    expect(releases[1]).not.toHaveBeenCalled();
    finish({ status: "created", childThreadId: "child" });
    await pending;
    await Promise.resolve();
    expect(releases[1]).toHaveBeenCalledOnce();
    expect(openThreadRoute).not.toHaveBeenCalled();
  });

  it("offers same-operation recovery retry without repeating a restart", async () => {
    const fork = vi
      .fn()
      .mockResolvedValueOnce({
        status: "recovery_required",
        childThreadId: "child",
        diagnostic: "Provider binding uncertain",
        retryable: true,
      })
      .mockResolvedValueOnce({ status: "created", childThreadId: "child" });
    const operation = runThreadFork({ fork, restart: true, presentation });
    await vi.waitFor(() =>
      expect(getBlockingOperation()?.error).toBe("Provider binding uncertain"),
    );
    expect(openThreadRoute).not.toHaveBeenCalled();
    expect(getBlockingOperation()?.actions[0]?.label).toBe(
      "Open recovery thread",
    );
    getBlockingOperation()!.retry!();
    await operation;
    expect(fork.mock.calls).toEqual([[true], [false]]);
    expect(openThreadRoute).toHaveBeenCalledWith("child", presentation);
  });

  it("does not offer retry for non-retryable recovery or report it as success", async () => {
    const operation = runThreadFork({
      fork: vi
        .fn()
        .mockResolvedValue({
          status: "recovery_required",
          childThreadId: "child",
          diagnostic: "Recover in child",
          retryable: false,
        }),
      presentation,
    });
    await vi.waitFor(() =>
      expect(getBlockingOperation()?.error).toBe("Recover in child"),
    );
    expect(getBlockingOperation()?.retry).toBeUndefined();
    expect(openThreadRoute).not.toHaveBeenCalled();
    expect(getBlockingOperation()?.allowCancel).toBe(false);
    getBlockingOperation()!.cancel();
    await operation;
  });

  it("offers an explicit new fork after an aborted result", async () => {
    const operation = runThreadFork({
      fork: vi
        .fn()
        .mockResolvedValue({
          status: "aborted",
          childThreadId: "child",
          diagnostic: "Fork aborted",
        }),
      presentation,
    });
    await vi.waitFor(() =>
      expect(getBlockingOperation()?.error).toBe("Fork aborted"),
    );
    expect(getBlockingOperation()?.retry).toBeUndefined();
    expect(getBlockingOperation()?.actions[0]?.label).toBe("Start a new fork");
    expect(openThreadRoute).not.toHaveBeenCalled();
    expect(getBlockingOperation()?.allowCancel).toBe(false);
    getBlockingOperation()!.cancel();
    await operation;
  });
});
