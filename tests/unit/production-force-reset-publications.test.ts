import { describe, expect, it, vi } from "vitest";
import { forceResetThreadPublications } from "../../src/server/production-application.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const threadIds = ["thread-1", "thread-2"];

describe("force-reset thread publications", () => {
  it("still publishes the reset threads when retirement reconciliation fails", () => {
    const failure = new Error("retirement reconciliation failed");
    const onReconcileError = vi.fn();
    const schedulePublications = vi.fn();
    forceResetThreadPublications({
      reconcileRetirements: () => {
        throw failure;
      },
      onReconcileError,
      schedulePublications,
    })(scope, threadIds);
    expect(onReconcileError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(schedulePublications).toHaveBeenCalledExactlyOnceWith(
      scope,
      threadIds,
    );
  });

  it("reconciles first and leaves a publication failure to the reset's own reporter", () => {
    const calls: string[] = [];
    const failure = new Error("publication failed");
    const onReconcileError = vi.fn();
    const publish = forceResetThreadPublications({
      reconcileRetirements: (eventScope, ids) => {
        calls.push("reconcile");
        expect([eventScope, ids]).toEqual([scope, threadIds]);
      },
      onReconcileError,
      schedulePublications: () => {
        calls.push("publish");
        throw failure;
      },
    });
    expect(() => publish(scope, threadIds)).toThrow(failure);
    expect(calls).toEqual(["reconcile", "publish"]);
    expect(onReconcileError).not.toHaveBeenCalled();
  });
});
