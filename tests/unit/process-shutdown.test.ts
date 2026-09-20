import { describe, expect, it, vi } from "vitest";
import { ProcessShutdownCoordinator } from "../../src/server/runtime/process-shutdown.js";

describe("ProcessShutdownCoordinator", () => {
  it("shares one successful shutdown", async () => {
    const close = vi.fn(async () => undefined);
    const terminate = vi.fn();
    const coordinator = new ProcessShutdownCoordinator({
      application: { close },
      deadlineMilliseconds: 100,
      report: vi.fn(),
      terminate,
    });

    const first = coordinator.shutdown();
    expect(coordinator.shutdown()).toBe(first);
    await expect(first).resolves.toEqual({ status: "closed" });
    expect(close).toHaveBeenCalledOnce();
    expect(terminate).not.toHaveBeenCalled();
  });

  it("forces the fail-closed outer fallback at the overall deadline", async () => {
    const report = vi.fn();
    const terminate = vi.fn();
    const coordinator = new ProcessShutdownCoordinator({
      application: { close: () => new Promise<void>(() => undefined) },
      deadlineMilliseconds: 10,
      report,
      terminate,
    });

    await expect(coordinator.shutdown()).resolves.toEqual({
      status: "deadline",
    });
    expect(report).toHaveBeenCalledWith(
      "Sedes shutdown exceeded its overall deadline.",
    );
    expect(terminate).toHaveBeenCalledWith(1);
  });

  it("reports cleanup failure before terminating", async () => {
    const error = new Error("cleanup failed");
    const report = vi.fn();
    const terminate = vi.fn();
    const coordinator = new ProcessShutdownCoordinator({
      application: { close: async () => Promise.reject(error) },
      deadlineMilliseconds: 100,
      report,
      terminate,
    });

    await expect(coordinator.shutdown()).resolves.toEqual({
      status: "failed",
      error,
    });
    expect(report).toHaveBeenCalledBefore(terminate);
    expect(terminate).toHaveBeenCalledWith(1);
  });
});
