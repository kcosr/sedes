import { describe, expect, it, vi } from "vitest";
import { RemoteExecutionEnvironment } from "../../src/server/execution/remote-execution-environment.js";

const scope = { tenantId: "tenant-ssh", principalId: "principal-ssh" };

function provider(
  input: {
    readonly configurationRevision?: number;
    readonly activeConfigurationRevision?: () => number | Promise<number>;
    readonly reportAvailability?: (
      available: boolean,
      diagnosticCode?: string,
    ) => void | Promise<void>;
  } = {},
) {
  return new RemoteExecutionEnvironment({
    kind: "ssh",
    platform: "linux",
    environmentId: "ssh-environment",
    scope,
    allowedRoots: ["/srv/workspaces", "/opt/shared"],
    configurationRevision: input.configurationRevision ?? 7,
    activeConfigurationRevision: input.activeConfigurationRevision ?? (() => 7),
    directoryBrowser: () => undefined,
    ...(input.reportAvailability
      ? { reportAvailability: input.reportAvailability }
      : {}),
  });
}

describe("RemoteExecutionEnvironment", () => {
  it.each([
    ["darwin", "/Users/alex/work", "/Users/alex/work/project"],
    ["win32", "C:\\Users\\alex\\work", "C:\\Users\\alex\\work\\project"],
  ] as const)(
    "admits outbound %s workspaces only while connected",
    async (platform, root, candidate) => {
      let connected = true;
      const execution = new RemoteExecutionEnvironment({
        kind: "outbound",
        platform,
        environmentId: "outbound",
        scope,
        allowedRoots: [root],
        configurationRevision: 3,
        activeConfigurationRevision: () => 3,
        isExecutionAvailable: () => connected,
        directoryBrowser: () => ({
          directoryBrowsingAvailability: () => "available",
          browseDirectories: vi.fn(),
        }),
      });
      const workspace = await execution.validateWorkspace(
        scope,
        "outbound",
        candidate,
      );
      expect(workspace.summary.displayName).toBe("project");
      expect(execution.directoryBrowsingAvailability(scope, "outbound")).toBe(
        "available",
      );
      connected = false;
      await execution.observeAvailability(true);
      expect(execution.environment.availability).toBe("unavailable");
      await expect(
        execution.validateWorkspace(scope, "outbound", candidate),
      ).rejects.toThrow("outbound_environment_unavailable");
      await expect(
        execution.acquireLease(scope, { environmentId: "outbound", workspace }),
      ).rejects.toThrow("outbound_environment_unavailable");
      expect(execution.directoryBrowsingAvailability(scope, "outbound")).toBe(
        "unavailable",
      );
      expect(await execution.listEnvironments(scope)).toHaveLength(1);
      connected = true;
      expect(
        (await execution.validateWorkspace(scope, "outbound", candidate))
          .summary.id,
      ).toBe(workspace.summary.id);
      await expect(
        execution.validateWorkspace(
          { ...scope, principalId: "other" },
          "outbound",
          candidate,
        ),
      ).rejects.toThrow("outbound_environment_unavailable");
    },
  );

  it("admits normalized POSIX paths lexically under operator-configured roots", async () => {
    const execution = provider();

    const validated = await execution.validateWorkspace(
      scope,
      "ssh-environment",
      "/srv/workspaces/project",
    );
    expect(validated).toMatchObject({
      canonicalPath: "/srv/workspaces/project",
      authorityRevision: 7,
      summary: {
        environmentId: "ssh-environment",
        displayName: "project",
        trustState: "untrusted",
      },
    });
    expect(
      (
        await execution.validateWorkspace(
          scope,
          "ssh-environment",
          "/opt/shared",
        )
      ).canonicalPath,
    ).toBe("/opt/shared");

    for (const denied of [
      "/srv/workspaces-other/project",
      "/srv/workspaces/../secret",
      "/srv/workspaces/project/",
      "/srv//workspaces/project",
      "srv/workspaces/project",
      "/srv/workspaces/project\nother",
      "/srv/workspaces/project\0other",
    ]) {
      await expect(
        execution.validateWorkspace(scope, "ssh-environment", denied),
      ).rejects.toThrow("workspace_not_allowed");
    }
  });

  it("revalidates and leases solely against scoped configuration authority", async () => {
    let activeRevision = 9;
    const execution = new RemoteExecutionEnvironment({
      kind: "ssh",
      platform: "linux",
      environmentId: "ssh-environment",
      scope,
      allowedRoots: ["/srv/workspaces"],
      configurationRevision: 9,
      activeConfigurationRevision: () => activeRevision,
      directoryBrowser: () => undefined,
    });
    const workspace = await execution.validateWorkspace(
      scope,
      "ssh-environment",
      "/srv/workspaces/project",
    );
    const revalidated = await execution.revalidateWorkspace(scope, workspace);
    expect(revalidated.summary.id).toBe(workspace.summary.id);

    const lease = await execution.acquireLease(scope, {
      environmentId: "ssh-environment",
      workspace,
    });
    expect(lease.workspace).toMatchObject({
      canonicalPath: workspace.canonicalPath,
      authorityRevision: 9,
    });
    await lease.release();

    activeRevision = 10;
    await expect(
      execution.acquireLease(scope, {
        environmentId: "ssh-environment",
        workspace,
      }),
    ).rejects.toThrow("ssh_environment_configuration_stale");
  });

  it("rejects stale workspace authority before attempting lease admission", async () => {
    const execution = new RemoteExecutionEnvironment({
      kind: "ssh",
      platform: "linux",
      environmentId: "ssh-environment",
      scope,
      allowedRoots: ["/srv/workspaces"],
      configurationRevision: 12,
      activeConfigurationRevision: () => 12,
      directoryBrowser: () => undefined,
    });
    await expect(
      execution.acquireLease(scope, {
        environmentId: "ssh-environment",
        workspace: {
          canonicalPath: "/srv/workspaces/project",
          authorityRevision: 11,
          summary: {
            id: "workspace",
            environmentId: "ssh-environment",
            displayName: "project",
            displayPath: "/srv/workspaces/project",
            availability: "available",
            trustState: "untrusted",
            revision: 0,
          },
        },
      }),
    ).rejects.toThrow("workspace_authority_stale");
  });

  it("retains principal scope and truthfully reports command execution as unsupported", async () => {
    const execution = provider();
    await expect(
      execution.validateWorkspace(
        { ...scope, principalId: "other" },
        "ssh-environment",
        "/srv/workspaces/project",
      ),
    ).rejects.toThrow("ssh_environment_unavailable");
    const workspace = await execution.validateWorkspace(
      scope,
      "ssh-environment",
      "/srv/workspaces/project",
    );
    await expect(
      execution.executeCommand(scope, {
        environmentId: "ssh-environment",
        workspace,
        command: "true",
        timeoutMilliseconds: 1_000,
      }),
    ).resolves.toMatchObject({
      kind: "unavailable",
      diagnosticCode: "ssh_command_execution_unsupported",
    });
  });

  it("does not publish connectivity from lexical workspace admission", async () => {
    const reportAvailability = vi.fn();
    const execution = provider({ reportAvailability });
    await execution.validateWorkspace(
      scope,
      "ssh-environment",
      "/srv/workspaces/project",
    );
    expect(reportAvailability).not.toHaveBeenCalled();
  });

  it("rejects directory browsing from a stale environment revision before delegating", async () => {
    const browseDirectories = vi.fn();
    const execution = new RemoteExecutionEnvironment({
      kind: "ssh",
      platform: "linux",
      environmentId: "ssh-environment",
      scope,
      allowedRoots: ["/srv/workspaces"],
      configurationRevision: 7,
      activeConfigurationRevision: () => 8,
      directoryBrowser: () => ({
        directoryBrowsingAvailability: () => "available",
        browseDirectories,
      }),
    });
    await expect(
      execution.browseDirectories(scope, {
        environmentId: "ssh-environment",
        location: { kind: "roots" },
        pageSize: 50,
      }),
    ).rejects.toThrow("ssh_environment_configuration_stale");
    expect(browseDirectories).not.toHaveBeenCalled();
  });
});
