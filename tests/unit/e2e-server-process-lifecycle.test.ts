import { describe, expect, it, vi } from "vitest";
import {
  installE2EServerProcessLifecycle,
  type E2EServerProcessLifecycle,
} from "../e2e/server-process-lifecycle.js";

function createLifecycle() {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  const errors: string[] = [];
  const lifecycle: E2EServerProcessLifecycle = {
    once(event, listener) {
      listeners.set(event, listener);
    },
    exit(code) {
      exits.push(code);
    },
    writeError(message) {
      errors.push(message);
    },
  };
  return { lifecycle, listeners, exits, errors };
}

describe("installE2EServerProcessLifecycle", () => {
  it.each(["SIGTERM", "SIGINT", "disconnect"] as const)(
    "closes and exits cleanly for %s",
    async (event) => {
      const fixture = createLifecycle();
      const close = vi.fn(async () => undefined);
      installE2EServerProcessLifecycle(fixture.lifecycle, close);

      fixture.listeners.get(event)?.();
      await vi.waitFor(() => expect(fixture.exits).toEqual([0]));
      expect(close).toHaveBeenCalledTimes(1);
      expect(fixture.errors).toEqual([]);
    },
  );

  it("runs the close path only once when shutdown events race", async () => {
    const fixture = createLifecycle();
    const close = vi.fn(async () => undefined);
    installE2EServerProcessLifecycle(fixture.lifecycle, close);

    fixture.listeners.get("SIGTERM")?.();
    fixture.listeners.get("disconnect")?.();
    fixture.listeners.get("SIGINT")?.();
    await vi.waitFor(() => expect(fixture.exits).toEqual([0]));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports close failures and exits nonzero", async () => {
    const fixture = createLifecycle();
    installE2EServerProcessLifecycle(fixture.lifecycle, async () => {
      throw new Error("close failed");
    });

    fixture.listeners.get("disconnect")?.();
    await vi.waitFor(() => expect(fixture.exits).toEqual([1]));
    expect(fixture.errors.join("\n")).toContain("close failed");
  });
});
