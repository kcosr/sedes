import { describe, expect, it, vi } from "vitest";
import { SidecarDirectoryBrowserProvider } from "../../src/server/execution/sidecar-directory-browser-provider.js";
import type { SidecarClientSession } from "../../src/server/sidecar/sidecar-client-session.js";
import type { SidecarRuntimeOwner } from "../../src/server/sidecar/sidecar-runtime.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978406";

describe("SidecarDirectoryBrowserProvider", () => {
  it("browses native Windows children without using the main host path grammar", async () => {
    const root = "C:\\Users\\alex\\work";
    const directory = `${root}\\project`;
    const call = vi
      .fn()
      .mockResolvedValue({
        directoryPath: directory,
        entries: [{ name: "src", path: `${directory}\\src` }],
        truncated: false,
      });
    const release = vi.fn();
    const runtime = {
      acquireOperation: vi
        .fn()
        .mockResolvedValue({
          session: { call },
          carrierGeneration: 1,
          release,
        }),
    } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
    const provider = new SidecarDirectoryBrowserProvider({
      platform: "win32",
      scope,
      environmentId,
      policyRoots: [root],
      runtime,
    });
    await expect(
      provider.browseDirectories(scope, {
        environmentId,
        location: { kind: "directory", path: directory },
        pageSize: 50,
      }),
    ).resolves.toMatchObject({
      location: { path: directory, parentPath: root },
      entries: [{ name: "src", path: `${directory}\\src` }],
    });
    expect(release).toHaveBeenCalledOnce();
    await expect(
      provider.browseDirectories(scope, {
        environmentId,
        location: { kind: "directory", path: "D:\\work" },
        pageSize: 50,
      }),
    ).rejects.toThrow("directory_browse_not_allowed");
    call.mockResolvedValueOnce({
      directoryPath: directory,
      entries: [{ name: "src", path: "D:\\src" }],
      truncated: false,
    });
    await expect(
      provider.browseDirectories(scope, {
        environmentId,
        location: { kind: "directory", path: directory },
        pageSize: 50,
      }),
    ).rejects.toThrow("directory_browse_unavailable");
  });

  it("pages configured roots without acquiring the remote runtime", async () => {
    const acquireOperation = vi.fn();
    const provider = createProvider(acquireOperation);
    const first = await provider.browseDirectories(scope, {
      environmentId,
      location: { kind: "roots" },
      pageSize: 1,
    });
    expect(first.entries).toEqual([
      { name: "nested", path: "/srv/worktrees/nested" },
    ]);
    expect(first.nextCursor).toBeDefined();
    expect(first.truncated).toBe(false);
    const second = await provider.browseDirectories(scope, {
      environmentId,
      location: { kind: "roots" },
      pageSize: 1,
      cursor: first.nextCursor,
    });
    expect(second.entries).toEqual([
      { name: "worktrees", path: "/srv/worktrees" },
    ]);
    expect(acquireOperation).not.toHaveBeenCalled();
  });

  it("selects the deepest root and releases the demand-started operation lease", async () => {
    const release = vi.fn();
    const call = vi.fn().mockResolvedValue({
      directoryPath: "/srv/worktrees/nested/project",
      entries: [
        {
          name: "child",
          path: "/srv/worktrees/nested/project/child",
        },
      ],
      truncated: false,
    });
    const acquireOperation = vi.fn().mockResolvedValue({
      session: { call },
      carrierGeneration: 1,
      release,
    });
    const provider = createProvider(acquireOperation);
    await expect(
      provider.browseDirectories(scope, {
        environmentId,
        location: {
          kind: "directory",
          path: "/srv/worktrees/nested/project",
        },
        pageSize: 50,
      }),
    ).resolves.toEqual({
      location: {
        kind: "directory",
        path: "/srv/worktrees/nested/project",
        parentPath: "/srv/worktrees/nested",
      },
      entries: [
        {
          name: "child",
          path: "/srv/worktrees/nested/project/child",
        },
      ],
      truncated: false,
    });
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        capabilityId: "directory_browser",
        majorVersion: 1,
        operation: "directories.list",
      }),
      {
        rootPath: "/srv/worktrees/nested",
        directoryPath: "/srv/worktrees/nested/project",
        pageSize: 50,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(release).toHaveBeenCalledOnce();
  });

  it("denies wrong scope and out-of-root paths without touching the runtime", async () => {
    const acquireOperation = vi.fn();
    const provider = createProvider(acquireOperation);
    expect(
      provider.directoryBrowsingAvailability(
        { ...scope, principalId: "other" },
        environmentId,
      ),
    ).toBe("unavailable");
    await expect(
      provider.browseDirectories(scope, {
        environmentId,
        location: { kind: "directory", path: "/etc" },
        pageSize: 50,
      }),
    ).rejects.toThrow("directory_browse_not_allowed");
    expect(acquireOperation).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "different returned location",
      result: {
        directoryPath: "/etc",
        entries: [],
        truncated: false,
      },
    },
    {
      label: "path outside the requested directory",
      result: {
        directoryPath: "/srv/worktrees/project",
        entries: [{ name: "passwd", path: "/etc/passwd" }],
        truncated: false,
      },
    },
    {
      label: "name and immediate path mismatch",
      result: {
        directoryPath: "/srv/worktrees/project",
        entries: [
          {
            name: "child",
            path: "/srv/worktrees/project/other",
          },
        ],
        truncated: false,
      },
    },
    {
      label: "nested descendant",
      result: {
        directoryPath: "/srv/worktrees/project",
        entries: [
          {
            name: "grandchild",
            path: "/srv/worktrees/project/child/grandchild",
          },
        ],
        truncated: false,
      },
    },
    {
      label: "duplicate entry",
      result: {
        directoryPath: "/srv/worktrees/project",
        entries: [
          { name: "child", path: "/srv/worktrees/project/child" },
          { name: "child", path: "/srv/worktrees/project/child" },
        ],
        truncated: false,
      },
    },
  ])("rejects a malformed sidecar response: $label", async ({ result }) => {
    const release = vi.fn();
    const acquireOperation = vi.fn().mockResolvedValue({
      session: { call: vi.fn().mockResolvedValue(result) },
      carrierGeneration: 1,
      release,
    });
    const provider = createProvider(acquireOperation);
    await expect(
      provider.browseDirectories(scope, {
        environmentId,
        location: {
          kind: "directory",
          path: "/srv/worktrees/project",
        },
        pageSize: 50,
      }),
    ).rejects.toThrow("directory_browse_unavailable");
    expect(release).toHaveBeenCalledOnce();
  });
});

function createProvider(acquireOperation: ReturnType<typeof vi.fn>) {
  const runtime = {
    acquireOperation,
  } as unknown as SidecarRuntimeOwner<SidecarClientSession>;
  return new SidecarDirectoryBrowserProvider({
    platform: "linux",
    scope,
    environmentId,
    policyRoots: ["/srv/worktrees", "/srv/worktrees/nested"],
    runtime,
  });
}
