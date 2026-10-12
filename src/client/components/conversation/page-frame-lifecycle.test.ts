import { describe, expect, it, vi } from "vitest";
import { PageFrameBudget, PageFrameLoadGuard } from "./page-frame-lifecycle.js";

describe("page frame lifetime budget", () => {
  it("rejects same-context navigation while admitting trusted context replacement", () => {
    const guard = new PageFrameLoadGuard();
    const initial = {} as Window;
    const replacement = {} as Window;
    expect(guard.accept(initial)).toBe("initial");
    expect(guard.accept(initial)).toBe("rejected");
    expect(guard.accept(replacement)).toBe("replacement");
    expect(guard.accept(replacement)).toBe("rejected");
    expect(guard.accept(null)).toBe("rejected");
    guard.reset();
    expect(guard.accept(replacement)).toBe("initial");
  });
  it("limits scripts, admits foreground requests, and releases offscreen frames", () => {
    const budget = new PageFrameBudget(2);
    const callbacks = [vi.fn(), vi.fn(), vi.fn()];
    const ids = callbacks.map((callback) => budget.register(callback));
    for (const id of ids) budget.request(id, true);
    expect(callbacks[0]).toHaveBeenLastCalledWith(false);
    expect(callbacks[1]).toHaveBeenLastCalledWith(true);
    expect(callbacks[2]).toHaveBeenLastCalledWith(true);
    budget.request(ids[0]!, true, true);
    expect(callbacks[0]).toHaveBeenLastCalledWith(true);
    expect(callbacks[1]).toHaveBeenLastCalledWith(false);
    budget.request(ids[2]!, false);
    expect(callbacks[2]).toHaveBeenLastCalledWith(false);
    expect(callbacks[1]).toHaveBeenLastCalledWith(true);
    budget.remove(ids[0]!);
    expect(callbacks[1]).toHaveBeenLastCalledWith(true);
  });
});
