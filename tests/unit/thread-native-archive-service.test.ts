import { describe, expect, it, vi } from "vitest";
import { ThreadNativeArchiveService } from "../../src/server/domain/thread-native-archive-service.js";
import { DomainError } from "../../src/server/domain/errors.js";
import { BackendError, type NativeConversationArchiveInput, type NativeConversationArchiveResult } from "../../src/server/backends/contracts.js";
import { PiConversationBackendDriver } from "../../src/server/backends/pi/pi-conversation-driver.js";
import { CodexConversationBackendDriver } from "../../src/server/backends/codex/codex-conversation-driver.js";
import { ClaudeConversationBackendDriver } from "../../src/server/backends/claude/claude-conversation-driver.js";
import { GrokConversationBackendDriver } from "../../src/server/backends/grok/grok-conversation-driver.js";
import { OpenCodeConversationBackendDriver } from "../../src/server/backends/opencode/opencode-conversation-driver.js";

const scope = { tenantId: "tenant", principalId: "principal" };

function fixture() {
  let inventoryState = "archived";
  let uncertain = false;
  const operations = {
    hasUncertain: vi.fn(() => uncertain),
    begin: vi.fn(() => { uncertain = true; return "native-sync-mutation"; }),
    complete: vi.fn(() => { uncertain = false; }),
  };
  const nativeArchive = vi.fn<(input: NativeConversationArchiveInput) => Promise<NativeConversationArchiveResult>>(
    async () => {
      expect(uncertain).toBe(true);
      return { state: "archived", changed: true };
    },
  );
  const getInventory = vi.fn((requestedScope: typeof scope) => {
    if (requestedScope.principalId !== scope.principalId || requestedScope.tenantId !== scope.tenantId) {
      throw new DomainError("not_found", "Thread not found.");
    }
    return { inventoryState } as never;
  });
  const target = {
    scope,
    binding: { applicationThreadId: "thread", backendConversationId: "native-thread" },
    workspace: { canonicalPath: "/workspace" },
    driver: { nativeArchive },
  };
  const resolve = vi.fn(async () => target as never);
  const onError = vi.fn();
  const onResult = vi.fn();
  const service = new ThreadNativeArchiveService({
    inventory: { getInventory }, targets: { resolve }, operations, onError, onResult,
  });
  return { service, nativeArchive, getInventory, target, resolve, operations, onError, onResult,
    setState: (state: string) => { inventoryState = state; } };
}

describe("native archive synchronization", () => {
  it("uses the scoped binding after local commit without starting an execution runtime", async () => {
    const current = fixture();
    await current.service.archive(scope, ["thread"]);
    expect(current.nativeArchive).toHaveBeenCalledExactlyOnceWith({
      scope, binding: current.target.binding, workspace: current.target.workspace,
      action: "archive", signal: expect.any(AbortSignal),
    });
    expect(current.onResult).toHaveBeenCalledWith("thread", "archive", { state: "archived", changed: true });
  });

  it("does not rearchive a restored thread or restore a newly archived thread", async () => {
    const current = fixture();
    current.setState("active");
    await current.service.archive(scope, ["thread"]);
    current.setState("archived");
    await current.service.restore(scope, "thread");
    expect(current.resolve).not.toHaveBeenCalled();
    expect(current.nativeArchive).not.toHaveBeenCalled();
  });

  it("restores the native thread after the local restore commits", async () => {
    const current = fixture();
    current.setState("active");
    await current.service.restore(scope, "thread");
    expect(current.nativeArchive).toHaveBeenCalledWith(expect.objectContaining({ action: "restore" }));
  });

  it("keeps missing and unavailable backend failures from rejecting committed inventory", async () => {
    const current = fixture();
    current.resolve.mockRejectedValueOnce(new DomainError("runtime_unavailable", "Backend removed."));
    await expect(current.service.archive(scope, ["thread"])).resolves.toBeUndefined();
    expect(current.onError).toHaveBeenCalledOnce();
    current.nativeArchive.mockRejectedValueOnce(new Error("provider_disconnected"));
    current.onError.mockImplementation(() => { throw new Error("observer_failed"); });
    await expect(current.service.archive(scope, ["thread"])).resolves.toBeUndefined();
  });

  it.each(["active", "archived", "missing", "busy", "disabled"] as const)(
    "completes the durable operation after conclusive native state %s",
    async (state) => {
      const current = fixture();
      current.nativeArchive.mockResolvedValue({ state, changed: false });
      await current.service.archive(scope, ["thread"]);
      expect(current.operations.complete).toHaveBeenCalledExactlyOnceWith(scope, "native-sync-mutation");
      expect(current.operations.hasUncertain()).toBe(false);
    },
  );

  it("clears uncertainty when cancellation or failed delivery proves no native mutation was sent", async () => {
    const current = fixture();
    current.nativeArchive.mockRejectedValue(new BackendError({
      category: "unavailable", retryable: true, crossedSubmissionBoundary: false,
      backendCode: "codex_native_archive_cancelled", safeMessage: "Stopped before sending.",
    }));
    await current.service.archive(scope, ["thread"]);
    expect(current.operations.complete).toHaveBeenCalledExactlyOnceWith(scope, "native-sync-mutation");
    expect(current.operations.hasUncertain()).toBe(false);
  });

  it("retains an unknown native outcome and does not issue another mutation during local restore", async () => {
    const current = fixture();
    current.nativeArchive.mockRejectedValue(new BackendError({
      category: "unavailable", retryable: false, crossedSubmissionBoundary: true,
      safeMessage: "Archive outcome unknown.",
    }));
    await expect(current.service.archive(scope, ["thread"])).resolves.toBeUndefined();
    expect(current.operations.complete).not.toHaveBeenCalled();
    expect(current.operations.hasUncertain()).toBe(true);
    current.setState("active");
    await expect(current.service.restore(scope, "thread")).resolves.toBeUndefined();
    expect(current.nativeArchive).toHaveBeenCalledOnce();
  });

  it("reports the unattempted family members after the shared time budget expires", async () => {
    const current = fixture();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    current.nativeArchive.mockImplementation(async () => {
      controller.abort(new Error("deadline"));
      return { state: "archived", changed: true };
    });
    try {
      await current.service.archive(scope, ["thread", "remaining-1", "remaining-2"]);
      expect(current.nativeArchive).toHaveBeenCalledOnce();
      expect(current.onError).toHaveBeenCalledExactlyOnceWith("remaining-1", expect.objectContaining({
        message: expect.stringContaining("2 remaining threads were not attempted"),
      }));
    } finally { timeout.mockRestore(); }
  });

  it("does not resolve a foreign principal or tenant's native binding", async () => {
    const current = fixture();
    await current.service.archive({ ...scope, principalId: "foreign" }, ["thread"]);
    await current.service.archive({ ...scope, tenantId: "foreign" }, ["thread"]);
    expect(current.resolve).not.toHaveBeenCalled();
    expect(current.nativeArchive).not.toHaveBeenCalled();
    expect(current.onError).toHaveBeenCalledTimes(2);
  });

  it("implements native archive only for Codex and leaves other native stores unsupported", () => {
    expect(CodexConversationBackendDriver.prototype.nativeArchive).toBeTypeOf("function");
    for (const driver of [PiConversationBackendDriver, ClaudeConversationBackendDriver,
      GrokConversationBackendDriver, OpenCodeConversationBackendDriver]) {
      expect(driver.prototype).not.toHaveProperty("nativeArchive");
    }
  });
});
