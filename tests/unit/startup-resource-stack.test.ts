import { describe, expect, it, vi } from "vitest";
import { StartupResourceStack } from "../../src/server/runtime/startup-resource-stack.js";

describe("StartupResourceStack", () => {
  it("unwinds every resource in exact reverse acquisition order", async () => {
    const order: string[] = [];
    const resources = new StartupResourceStack();
    resources.defer("first lock", () => {
      order.push("first");
    });
    resources.defer("second runtime", async () => {
      order.push("second");
    });
    resources.defer("listener", () => {
      order.push("listener");
    });

    await resources.dispose();
    await resources.dispose();
    expect(order).toEqual(["listener", "second", "first"]);
  });

  it("continues cleanup while preserving the primary startup failure", async () => {
    const primary = new Error("second module failed to start");
    const order: string[] = [];
    const resources = new StartupResourceStack();
    resources.defer("first lock", () => {
      order.push("first");
    });
    resources.defer("first module", () => {
      order.push("module");
      throw new Error("module cleanup failed");
    });
    resources.defer("second lock", () => {
      order.push("second");
    });

    await expect(resources.dispose(primary)).rejects.toBe(primary);
    expect(order).toEqual(["second", "module", "first"]);
  });

  it("reports the first cleanup failure only after later cleanup completes", async () => {
    const order: string[] = [];
    const resources = new StartupResourceStack();
    resources.defer("lock", () => {
      order.push("lock");
      throw new Error("lock cleanup failed");
    });
    resources.defer("runtime", () => {
      order.push("runtime");
      throw new Error("runtime cleanup failed");
    });

    await expect(resources.dispose()).rejects.toMatchObject({
      message: expect.stringContaining("runtime"),
      cause: expect.objectContaining({ message: "runtime cleanup failed" }),
    });
    expect(order).toEqual(["runtime", "lock"]);
  });

  it("rejects resources registered after unwind begins", async () => {
    const resources = new StartupResourceStack();
    await resources.dispose();
    expect(() => resources.defer("late", () => undefined)).toThrow(
      "startup_resource_stack_already_disposed",
    );
  });

  it("runs an ownership-safe fallback at the deadline and continues unwinding", async () => {
    const order: string[] = [];
    const resources = new StartupResourceStack();
    resources.defer("lock", () => {
      order.push("lock");
    });
    resources.defer(
      "blocked client",
      () => new Promise<void>(() => undefined),
      {
        deadlineMilliseconds: 10,
        onDeadline: () => order.push("detach-client-only"),
      },
    );

    const first = resources.dispose();
    expect(resources.dispose()).toBe(first);
    await expect(first).rejects.toMatchObject({
      message: expect.stringContaining("blocked client"),
      cause: expect.objectContaining({
        message: expect.stringContaining("exceeded its cleanup deadline"),
      }),
    });
    expect(order).toEqual(["detach-client-only", "lock"]);
  });

  it("does not advance past ownership-critical cleanup before it settles", async () => {
    const order: string[] = [];
    const resources = new StartupResourceStack();
    resources.defer("database", () => {
      order.push("database");
    });
    let release!: () => void;
    resources.defer(
      "detached discovery",
      () =>
        new Promise<void>((resolve) => {
          order.push("discovery-cancelling");
          release = () => {
            order.push("discovery-settled");
            resolve();
          };
        }),
      { mode: "ownership_critical" },
    );

    let disposed = false;
    const disposal = resources.dispose().then(() => (disposed = true));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(disposed).toBe(false);
    expect(order).toEqual(["discovery-cancelling"]);

    release();
    await disposal;
    expect(order).toEqual([
      "discovery-cancelling",
      "discovery-settled",
      "database",
    ]);
  });

  it("rejects invalid cleanup deadlines before acquiring ownership", () => {
    const resources = new StartupResourceStack();
    expect(() =>
      resources.defer("invalid", () => undefined, {
        deadlineMilliseconds: 0,
      }),
    ).toThrow("startup_resource_cleanup_deadline_invalid");
  });
});
