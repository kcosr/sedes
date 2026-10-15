import { describe, expect, it, vi } from "vitest";
import { AutomationForkTargetResolver } from "../../src/server/runtime/automation-fork-target.js";
import { DomainError } from "../../src/server/domain/errors.js";

const input = {
  scope: { tenantId: "tenant", principalId: "principal" }, automationId: "automation",
  automationRunId: "run", anchorThreadId: "source", dispatchMutationId: "dispatch",
  claimToken: "claim", runMode: "clone" as const, prompt: "Update", resultTitleSuffix: " today",
};

function fixture(options: {
  backingState?: "bound" | "unbound" | "creating" | "creation_unknown";
  boundChild?: string;
  copyReceipt?: string;
  nativeAttempt?: boolean;
  missingChild?: boolean;
  resetThreadId?: string;
} = {}) {
  const getThread = vi.fn((_scope, id: string) => {
    if (options.missingChild && id !== "source") throw new DomainError("not_found", "The result was deleted.");
    return { thread: { backingState: options.backingState ?? "unbound", title: "Source", workspaceId: "workspace" }, inventory: { inventoryState: "active" } };
  });
  const run = { ...input, id: "run", childThreadId: options.boundChild ?? null, forceResetAt: null, state: "dispatching" };
  const bindResultChild = vi.fn();
  const create = vi.fn(async (_scope, _source, _request, automation) => {
    automation.assertAdmission();
    automation.bindResult("copy", 100);
    return { threadId: "copy" };
  });
  const getReceipt = vi.fn(() => options.copyReceipt ? { applicationThreadId: options.copyReceipt } : undefined);
  const resolver = new AutomationForkTargetResolver({
    automations: { getRun: () => run, bindResultChild },
    bindings: { findThreadConfigurationCopyReceipt: getReceipt },
    creation: { findByMutationId: () => options.nativeAttempt ? { creationKind: "fork" } : undefined },
    inventory: { getThread, assertWorkspaceActive: vi.fn(), isThreadCreationForceReset: (_scope: unknown, id: string) => options.resetThreadId === id },
    savedAgents: { createAutomationForkFromDraft: create },
    policy: { assertCanAutomate: vi.fn() },
  } as unknown as ConstructorParameters<typeof AutomationForkTargetResolver>[0]);
  return { resolver, create, bindResultChild, getThread, getReceipt, run };
}

describe("automation Fork target selection", () => {
  it("copies an unbound source and binds this run before submission", async () => {
    const setup = fixture();
    expect(await setup.resolver.resolve(input)).toEqual({ kind: "child", childThreadId: "copy" });
    expect(setup.create).toHaveBeenCalledWith(input.scope, "source", { mutationId: "dispatch", title: "Source today" }, expect.objectContaining({ automationId: "automation", automationRunId: "run" }));
    expect(setup.bindResultChild).toHaveBeenCalledWith(input.scope, "automation", "run", { childThreadId: "copy", claimToken: "claim", now: 100 });
  });

  it("uses a bound source's native fork path without a settings-copy fallback", async () => {
    const setup = fixture({ backingState: "bound" });
    expect(await setup.resolver.resolve(input)).toEqual({ kind: "native" });
    expect(setup.create).not.toHaveBeenCalled();
  });

  it.each(["creating", "creation_unknown"] as const)("defers a %s source before creating any result", async (backingState) => {
    const setup = fixture({ backingState });
    await expect(setup.resolver.resolve(input)).rejects.toMatchObject({ reason: backingState === "creating" ? "source_materializing" : "source_recovery" });
    expect(setup.create).not.toHaveBeenCalled();
  });

  it("recovers a copied result before inspecting a source which is now bound", async () => {
    const setup = fixture({ backingState: "bound", boundChild: "previous-copy" });
    expect(await setup.resolver.resolve(input)).toEqual({ kind: "child", childThreadId: "previous-copy" });
    expect(setup.getThread).not.toHaveBeenCalledWith(input.scope, "source");
    expect(setup.create).not.toHaveBeenCalled();
  });

  it("recovers a copy receipt before the source's new backing state", async () => {
    const setup = fixture({ backingState: "bound", copyReceipt: "previous-copy" });
    expect(await setup.resolver.resolve(input)).toEqual({ kind: "child", childThreadId: "previous-copy" });
    expect(setup.bindResultChild).toHaveBeenCalledOnce();
    expect(setup.create).not.toHaveBeenCalled();
  });

  it("never replaces a deleted result", async () => {
    const setup = fixture({ boundChild: "deleted-copy", missingChild: true });
    await expect(setup.resolver.resolve(input)).rejects.toMatchObject({ code: "not_found" });
    expect(setup.create).not.toHaveBeenCalled();
  });

  it.each(["binding", "receipt"] as const)("rejects a reset result recovered from its %s without copying again", async (artifact) => {
    const setup = fixture({ resetThreadId: "reset-copy", ...(artifact === "binding" ? { boundChild: "reset-copy" } : { copyReceipt: "reset-copy" }) });
    await expect(setup.resolver.resolve(input)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(setup.create).not.toHaveBeenCalled();
    expect(setup.bindResultChild).not.toHaveBeenCalled();
    expect(setup.getThread).not.toHaveBeenCalledWith(input.scope, "source");
  });

  it("rejects a force-reset source instead of deferring it forever", async () => {
    const setup = fixture({ backingState: "creation_unknown", resetThreadId: "source" });
    await expect(setup.resolver.resolve(input)).rejects.toMatchObject({ code: "invalid_transition" });
    expect(setup.create).not.toHaveBeenCalled();
  });

  it("resumes an existing native attempt even if the source appears unbound", async () => {
    const setup = fixture({ nativeAttempt: true });
    expect(await setup.resolver.resolve(input)).toEqual({ kind: "native" });
    expect(setup.getThread).not.toHaveBeenCalled();
    expect(setup.create).not.toHaveBeenCalled();
  });

  it("rejects a reset run without choosing another target", async () => {
    const setup = fixture();
    Object.assign(setup.run, { forceResetAt: 100 });
    await expect(setup.resolver.resolve(input)).rejects.toMatchObject({ code: "conflict" });
    expect(setup.create).not.toHaveBeenCalled();
  });
});
