import { describe, expect, it, vi } from "vitest";
import type { BackendModuleRuntime } from "../../src/server/backends/module.js";
import type { DatabaseConversationTargetStore } from "../../src/server/conversations/database-conversation-adapters.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import {
  ManagedTerminalCarrierError,
  type ManagedTerminalResourceAuthority,
  type ManagedTerminalViewerSession,
} from "../../src/server/terminal/managed-terminal-carrier.js";
import { ProductionManagedTerminalAuthority } from "../../src/server/terminal/production-managed-terminal-authority.js";

const scope = Object.freeze({
  tenantId: "tenant-1",
  principalId: "principal-1",
});
const applicationThreadId = "00000000-0000-4000-8000-000000000001";

describe("production managed terminal authority", () => {
  it("selects only the backend runtime from the server-resolved binding", async () => {
    const provider = fakeProvider();
    const targets = fakeTargets(scope, "codex-1");
    const authority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: new Map([
        ["codex-1", fakeRuntime(scope, "codex-1", provider)],
        ["codex-other", fakeRuntime(scope, "codex-other", fakeProvider())],
      ]),
    });

    await expect(
      authority.authorizeAdmission({ scope, applicationThreadId }),
    ).resolves.toEqual({ resourceGeneration: 9 });
    expect(targets.actor).toHaveBeenCalledWith(scope, applicationThreadId);
    expect(provider.authorizeAdmission).toHaveBeenCalledWith({
      scope,
      applicationThreadId,
    });

    const emit = vi.fn();
    const viewer = {
      scope,
      applicationThreadId,
      resourceGeneration: 9,
      viewerId: "viewer-1",
    };
    const session = await authority.attachViewer(viewer, emit);
    expect(provider.attachViewer).toHaveBeenCalledWith(viewer, emit);
    const bytes = new Uint8Array([1, 2]);
    const dimensions = { columns: 80, rows: 24 };
    await session.sendInput(bytes);
    await session.resize(dimensions);
    await session.requestSync();
    await session.requestRefit(dimensions);
    await session.close();
    expect(provider.session.sendInput).toHaveBeenCalledWith(bytes);
    expect(provider.session.resize).toHaveBeenCalledWith(dimensions);
    expect(provider.session.requestSync).toHaveBeenCalled();
    expect(provider.session.requestRefit).toHaveBeenCalledWith(dimensions);
    expect(provider.session.close).toHaveBeenCalled();
    expect(targets.assertThreadWorkspaceActive).toHaveBeenCalledWith(scope, applicationThreadId);
  });

  it("fails closed when the durable binding has no matching scoped runtime", async () => {
    const targets = fakeTargets(scope, "missing-backend");
    const authority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: new Map(),
    });

    await expect(
      authority.authorizeAdmission({ scope, applicationThreadId }),
    ).rejects.toMatchObject({
      code: "terminal_unavailable",
      retryable: true,
    } satisfies Partial<ManagedTerminalCarrierError>);
  });

  it("does not delegate when the resolved runtime belongs to another scope", async () => {
    const provider = fakeProvider();
    const targets = fakeTargets(scope, "codex-1");
    const authority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: new Map([
        [
          "codex-1",
          fakeRuntime(
            { tenantId: scope.tenantId, principalId: "other-principal" },
            "codex-1",
            provider,
          ),
        ],
      ]),
    });

    await expect(
      authority.authorizeAdmission({ scope, applicationThreadId }),
    ).rejects.toMatchObject({ code: "terminal_unavailable" });
    expect(provider.authorizeAdmission).not.toHaveBeenCalled();
  });

  it("denies removed projects before resolving or admitting a provider terminal", async () => {
    const provider = fakeProvider();
    const targets = fakeTargets(scope, "codex-1");
    const authority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: new Map([["codex-1", fakeRuntime(scope, "codex-1", provider)]]),
    });
    removeProject(targets);

    await expect(authority.authorizeAdmission({ scope, applicationThreadId }))
      .rejects.toMatchObject({ code: "terminal_unavailable", retryable: false });
    await expect(authority.attachViewer({ scope, applicationThreadId, resourceGeneration: 9, viewerId: "viewer-1" }, vi.fn()))
      .rejects.toMatchObject({ code: "terminal_unavailable" });
    expect(targets.actor).not.toHaveBeenCalled();
    expect(provider.authorizeAdmission).not.toHaveBeenCalled();
    expect(provider.attachViewer).not.toHaveBeenCalled();
  });

  it("rejects admission when the project is removed during the provider check", async () => {
    const provider = fakeProvider();
    const targets = fakeTargets(scope, "codex-1");
    provider.authorizeAdmission.mockImplementation(async () => {
      removeProject(targets);
      return { resourceGeneration: 9 };
    });
    const authority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: new Map([["codex-1", fakeRuntime(scope, "codex-1", provider)]]),
    });

    await expect(authority.authorizeAdmission({ scope, applicationThreadId }))
      .rejects.toMatchObject({ code: "terminal_unavailable" });
  });

  it("closes a viewer whose project was removed while attachment was pending", async () => {
    const provider = fakeProvider();
    const targets = fakeTargets(scope, "codex-1");
    provider.attachViewer.mockImplementation(async () => {
      removeProject(targets);
      return provider.session;
    });
    const authority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: new Map([["codex-1", fakeRuntime(scope, "codex-1", provider)]]),
    });

    await expect(authority.attachViewer({ scope, applicationThreadId, resourceGeneration: 9, viewerId: "viewer-1" }, vi.fn()))
      .rejects.toMatchObject({ code: "terminal_unavailable" });
    expect(provider.session.close).toHaveBeenCalledOnce();
  });

  it("blocks retained viewer effects after removal while allowing cleanup", async () => {
    const provider = fakeProvider();
    const targets = fakeTargets(scope, "codex-1");
    const authority = new ProductionManagedTerminalAuthority({
      targets,
      runtimes: new Map([["codex-1", fakeRuntime(scope, "codex-1", provider)]]),
    });
    const session = await authority.attachViewer({ scope, applicationThreadId, resourceGeneration: 9, viewerId: "viewer-1" }, vi.fn());
    removeProject(targets);

    expect(() => session.sendInput(new Uint8Array([1]))).toThrow(ManagedTerminalCarrierError);
    expect(() => session.resize({ columns: 80, rows: 24 })).toThrow(ManagedTerminalCarrierError);
    expect(() => session.requestSync()).toThrow(ManagedTerminalCarrierError);
    expect(() => session.requestRefit({ columns: 80, rows: 24 })).toThrow(ManagedTerminalCarrierError);
    await session.close();
    expect(provider.session.sendInput).not.toHaveBeenCalled();
    expect(provider.session.resize).not.toHaveBeenCalled();
    expect(provider.session.requestSync).not.toHaveBeenCalled();
    expect(provider.session.requestRefit).not.toHaveBeenCalled();
    expect(provider.session.close).toHaveBeenCalledOnce();
  });
});

function fakeProvider() {
  const session: ManagedTerminalViewerSession = {
    sendInput: vi.fn(),
    resize: vi.fn(),
    requestSync: vi.fn(),
    requestRefit: vi.fn(),
    close: vi.fn(),
  };
  return {
    session,
    authorizeAdmission: vi.fn(async () => ({ resourceGeneration: 9 })),
    attachViewer: vi.fn(async () => session),
  } satisfies ManagedTerminalResourceAuthority & {
    readonly session: ManagedTerminalViewerSession;
  };
}

function fakeTargets(requestScope: RequestScope, backendInstanceId: string) {
  return {
    assertThreadWorkspaceActive: vi.fn((resolvedScope: RequestScope) => {
      if (
        resolvedScope.tenantId !== requestScope.tenantId ||
        resolvedScope.principalId !== requestScope.principalId
      ) {
        throw new DomainError("not_found", "The thread is unavailable.");
      }
    }),
    actor: vi.fn(async (resolvedScope: RequestScope) => {
      if (
        resolvedScope.tenantId !== requestScope.tenantId ||
        resolvedScope.principalId !== requestScope.principalId
      ) {
        throw new Error("wrong_scope");
      }
      return {
        binding: { backendInstanceId },
      };
    }),
  } as unknown as DatabaseConversationTargetStore & {
    readonly assertThreadWorkspaceActive: ReturnType<typeof vi.fn>;
    readonly actor: ReturnType<typeof vi.fn>;
  };
}

function removeProject(targets: ReturnType<typeof fakeTargets>): void {
  targets.assertThreadWorkspaceActive.mockImplementation(() => {
    throw new DomainError("invalid_transition", "The project has been removed.");
  });
}

function fakeRuntime(
  requestScope: RequestScope,
  backendInstanceId: string,
  managedProviderTerminals: ManagedTerminalResourceAuthority,
): BackendModuleRuntime {
  return {
    scope: requestScope,
    instance: { id: backendInstanceId },
    managedProviderTerminals,
  } as BackendModuleRuntime;
}
