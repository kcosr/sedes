import { describe, expect, it, vi } from "vitest";
import type { EnvironmentSummary } from "../../src/shared/protocol/domain.js";
import type {
  ExecutionEnvironmentProvider,
  ExecutionScope,
  ValidatedWorkspace,
} from "../../src/server/execution/contracts.js";
import { CompositeExecutionEnvironment } from "../../src/server/execution/composite-execution-environment.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const otherScope = { tenantId: "tenant-1", principalId: "principal-2" };

function environment(id: string): EnvironmentSummary {
  return {
    id,
    label: id,
    availability: "available",
    diagnosticCode: null,
    revision: 0,
  };
}

function workspace(environmentId: string): ValidatedWorkspace {
  return {
    canonicalPath: "/workspace",
    authorityRevision: 2,
    summary: {
      id: `workspace-${environmentId}`,
      environmentId,
      displayName: "workspace",
      displayPath: "/workspace",
      availability: "available",
      trustState: "trusted",
      revision: 0,
    },
  };
}

function provider(id: string): ExecutionEnvironmentProvider {
  const validated = workspace(id);
  return {
    listEnvironments: vi.fn(async () => [environment(id)]),
    directoryBrowsingAvailability: vi.fn(() => "available" as const),
    browseDirectories: vi.fn(async () => ({
      location: { kind: "roots" as const },
      entries: [],
      truncated: false,
    })),
    validateWorkspace: vi.fn(async () => validated),
    revalidateWorkspace: vi.fn(async () => validated),
    acquireLease: vi.fn(async (requestScope: ExecutionScope) => ({
      scope: requestScope,
      environment: environment(id),
      workspace: validated,
      release: vi.fn(async () => undefined),
    })),
    executeCommand: vi.fn(async () => ({
      kind: "unavailable" as const,
      stdoutPreview: new Uint8Array(),
      stderrPreview: new Uint8Array(),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMilliseconds: 0,
      diagnosticCode: `unavailable-${id}`,
    })),
  };
}

describe("CompositeExecutionEnvironment", () => {
  it("supports an empty catalog and scoped reconciliation without replacing the router", async () => {
    const composite = new CompositeExecutionEnvironment({
      scope,
      environments: new Map(),
    });
    expect(await composite.listEnvironments(scope)).toEqual([]);
    const first = provider("environment-1");
    const next = provider("environment-1");
    composite.set(scope, "environment-1", first);
    await composite.validateWorkspace(scope, "environment-1", "/workspace");
    composite.set(scope, "environment-1", next);
    await composite.validateWorkspace(scope, "environment-1", "/workspace");
    expect(first.validateWorkspace).toHaveBeenCalledOnce();
    expect(next.validateWorkspace).toHaveBeenCalledOnce();
    expect(() => composite.remove(otherScope, "environment-1")).toThrow(
      "execution_environment_unavailable",
    );
    expect(() => composite.set(otherScope, "environment-1", first)).toThrow(
      "execution_environment_unavailable",
    );
    composite.remove(scope, "environment-1");
    await expect(
      composite.validateWorkspace(scope, "environment-1", "/workspace"),
    ).rejects.toThrow("execution_environment_unavailable");
  });

  it("lists and delegates by the exact environment ID", async () => {
    const first = provider("environment-1");
    const second = provider("environment-2");
    const composite = new CompositeExecutionEnvironment({
      scope,
      environments: new Map([
        ["environment-1", first],
        ["environment-2", second],
      ]),
    });

    await expect(composite.listEnvironments(scope)).resolves.toEqual([
      environment("environment-1"),
      environment("environment-2"),
    ]);
    await composite.validateWorkspace(scope, "environment-2", "/workspace");
    await composite.browseDirectories(scope, {
      environmentId: "environment-2",
      location: { kind: "roots" },
      pageSize: 50,
    });
    await composite.revalidateWorkspace(scope, workspace("environment-2"));
    await composite.executeCommand(scope, {
      environmentId: "environment-1",
      workspace: workspace("environment-1"),
      command: "true",
      timeoutMilliseconds: 100,
    });

    expect(second.validateWorkspace).toHaveBeenCalledOnce();
    expect(second.browseDirectories).toHaveBeenCalledOnce();
    expect(second.revalidateWorkspace).toHaveBeenCalledOnce();
    expect(first.validateWorkspace).not.toHaveBeenCalled();
    expect(first.executeCommand).toHaveBeenCalledOnce();
    expect(second.executeCommand).not.toHaveBeenCalled();
  });

  it("fails closed for unknown IDs and wrong-principal scopes", async () => {
    const only = provider("environment-1");
    const composite = new CompositeExecutionEnvironment({
      scope,
      environments: new Map([["environment-1", only]]),
    });

    await expect(composite.listEnvironments(otherScope)).resolves.toEqual([]);
    await expect(
      composite.validateWorkspace(scope, "missing", "/workspace"),
    ).rejects.toThrow("execution_environment_unavailable");
    await expect(
      composite.validateWorkspace(otherScope, "environment-1", "/workspace"),
    ).rejects.toThrow("execution_environment_unavailable");
    await expect(
      composite.executeCommand(scope, {
        environmentId: "environment-1",
        workspace: workspace("environment-2"),
        command: "true",
        timeoutMilliseconds: 100,
      }),
    ).rejects.toThrow("execution_environment_provider_contract_invalid");
    expect(only.validateWorkspace).not.toHaveBeenCalled();
    expect(only.executeCommand).not.toHaveBeenCalled();
  });

  it("rejects a provider that returns another environment's authority", async () => {
    const mismatched = provider("environment-2");
    const composite = new CompositeExecutionEnvironment({
      scope,
      environments: new Map([["environment-1", mismatched]]),
    });

    await expect(composite.listEnvironments(scope)).rejects.toThrow(
      "execution_environment_provider_contract_invalid",
    );
    await expect(
      composite.validateWorkspace(scope, "environment-1", "/workspace"),
    ).rejects.toThrow("execution_environment_provider_contract_invalid");
  });
});
