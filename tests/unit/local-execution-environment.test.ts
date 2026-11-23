import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-execution-"));
  temporaryDirectories.push(root);
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath);
  const provider = new LocalExecutionEnvironment({
    environmentId: "environment-1",
    scope,
    allowedRoots: [root],
    configurationRevision: 3,
    activeConfigurationRevision: () => 3,
    workspaceTrusted: (candidate) => candidate === workspacePath,
    environment: { PATH: process.env.PATH },
  });
  return { provider, root, workspacePath };
}

describe("LocalExecutionEnvironment", () => {
  it("browses configured roots and bounded immediate directory pages", async () => {
    const { provider, root, workspacePath } = await fixture();
    await mkdir(path.join(workspacePath, "bravo"));
    await mkdir(path.join(workspacePath, "alpha"));
    await mkdir(path.join(workspacePath, ".hidden"));
    await symlink(
      path.join(workspacePath, "alpha"),
      path.join(workspacePath, "linked"),
    );

    await expect(
      provider.browseDirectories(scope, {
        environmentId: "environment-1",
        location: { kind: "roots" },
        pageSize: 50,
      }),
    ).resolves.toEqual({
      location: { kind: "roots" },
      entries: [{ name: path.basename(root), path: await realpath(root) }],
      truncated: false,
    });

    const first = await provider.browseDirectories(scope, {
      environmentId: "environment-1",
      location: { kind: "directory", path: workspacePath },
      pageSize: 1,
    });
    expect(first).toMatchObject({
      location: {
        kind: "directory",
        path: workspacePath,
        parentPath: root,
      },
      entries: [{ name: "alpha", path: path.join(workspacePath, "alpha") }],
      truncated: false,
    });
    expect(first.nextCursor).toBeTruthy();
    await expect(
      provider.browseDirectories(scope, {
        environmentId: "environment-1",
        location: { kind: "directory", path: workspacePath },
        pageSize: 1,
        cursor: first.nextCursor,
      }),
    ).resolves.toMatchObject({
      entries: [{ name: "bravo", path: path.join(workspacePath, "bravo") }],
      truncated: false,
    });
  });

  it("fails closed for escaped, symlinked, and cross-scope browse requests", async () => {
    const { provider, workspacePath } = await fixture();
    const link = path.join(workspacePath, "link");
    await symlink(tmpdir(), link);
    expect(provider.directoryBrowsingAvailability(scope, "environment-1")).toBe(
      "available",
    );
    expect(
      provider.directoryBrowsingAvailability(
        { ...scope, principalId: "principal-2" },
        "environment-1",
      ),
    ).toBe("unavailable");
    for (const candidate of [tmpdir(), link]) {
      await expect(
        provider.browseDirectories(scope, {
          environmentId: "environment-1",
          location: { kind: "directory", path: candidate },
          pageSize: 50,
        }),
      ).rejects.toThrow("directory_browse_not_allowed");
    }
    await expect(
      provider.browseDirectories(
        { ...scope, principalId: "principal-2" },
        {
          environmentId: "environment-1",
          location: { kind: "roots" },
          pageSize: 50,
        },
      ),
    ).rejects.toThrow("execution_environment_unavailable");
  });

  it("omits public-contract-invalid child names without hiding valid siblings", async () => {
    const { provider, workspacePath } = await fixture();
    await mkdir(path.join(workspacePath, "valid-child"));
    await mkdir(path.join(workspacePath, "invalid\\child"));
    await mkdir(path.join(workspacePath, "invalid\u0001child"));

    await expect(
      provider.browseDirectories(scope, {
        environmentId: "environment-1",
        location: { kind: "directory", path: workspacePath },
        pageSize: 50,
      }),
    ).resolves.toMatchObject({
      entries: [
        {
          name: "valid-child",
          path: path.join(workspacePath, "valid-child"),
        },
      ],
      truncated: false,
    });
  });

  it("rejects forged and cross-directory continuation cursors", async () => {
    const { provider, workspacePath } = await fixture();
    const other = path.join(workspacePath, "other");
    await mkdir(path.join(workspacePath, "alpha"));
    await mkdir(path.join(workspacePath, "bravo"));
    await mkdir(other);
    const first = await provider.browseDirectories(scope, {
      environmentId: "environment-1",
      location: { kind: "directory", path: workspacePath },
      pageSize: 1,
    });
    const cursor = first.nextCursor!;
    const signatureStart = cursor.indexOf(".") + 1;
    const forgedCursor = `${cursor.slice(0, signatureStart)}${
      cursor[signatureStart] === "A" ? "B" : "A"
    }${cursor.slice(signatureStart + 1)}`;
    await expect(
      provider.browseDirectories(scope, {
        environmentId: "environment-1",
        location: { kind: "directory", path: other },
        pageSize: 1,
        cursor,
      }),
    ).rejects.toThrow("directory_browse_cursor_invalid");
    await expect(
      provider.browseDirectories(scope, {
        environmentId: "environment-1",
        location: { kind: "directory", path: workspacePath },
        pageSize: 1,
        cursor: forgedCursor,
      }),
    ).rejects.toThrow("directory_browse_cursor_invalid");
  });

  it("preserves the declared grant of a symlinked local root until an explicit reopen", async () => {
    const {root, workspacePath} = await fixture();
    const alias = path.join(root, "alias");
    await symlink(workspacePath, alias, "dir");
    await mkdir(path.join(workspacePath, "repo"));
    const repo = await realpath(path.join(workspacePath, "repo"));
    const initial = {id:"declared-alias",path:alias,generation:1};
    const deeper = {id:"deeper",path:repo,generation:2};
    let grants = [initial];
    const environment = new LocalExecutionEnvironment({
      scope, environmentId: "local", allowedRoots: [alias], configurationRevision: 0,
      activeConfigurationRevision: () => 0, readWorkspaceRoots: () => grants, workspaceTrusted: () => true,
    });
    const original = await environment.validateWorkspace(scope, "local", path.join(alias, "repo"));
    expect(original).toMatchObject({canonicalPath:repo, authorityRootId:initial.id, authorityRevision:1});
    grants = [initial, deeper];
    await expect(environment.revalidateWorkspace(scope, original)).resolves.toMatchObject({authorityRootId:initial.id});
    grants = [deeper];
    await expect(environment.revalidateWorkspace(scope, original)).rejects.toThrow("workspace_authority_stale");
    await expect(environment.validateWorkspace(scope, "local", repo)).resolves.toMatchObject({
      authorityRootId:deeper.id, summary: {id:original.summary.id},
    });
  });

  it.skipIf(process.platform === "win32")("preserves an admitted alias whose native POSIX destination contains a literal backslash", async () => {
    const {root} = await fixture();
    const directory = path.join(root, "project\\archive");
    await mkdir(directory);
    const alias = path.join(root, "alias");
    await symlink(directory, alias, "dir");
    const provider = new LocalExecutionEnvironment({ scope, environmentId: "local", allowedRoots: [alias],
      configurationRevision: 0, activeConfigurationRevision: () => 0, readWorkspaceRoots: () => [{id:"local", path:alias, generation:1}] });
    const workspace = await provider.validateWorkspace(scope, "local", alias);
    await mkdir(path.join(directory, "child"));
    await expect(provider.browseDirectories(scope, {environmentId:"local", location:{kind:"roots"}, pageSize:20}))
      .resolves.toMatchObject({entries:[{name:"alias",path:alias}]});
    await expect(provider.browseDirectories(scope, {environmentId:"local", location:{kind:"directory",path:alias}, pageSize:20}))
      .resolves.toMatchObject({entries:[{name:"child",path:path.join(alias,"child")}], location:{kind:"directory",path:alias}});
    expect(workspace).toMatchObject({authorityRootId:"local", canonicalPath:directory});
    await expect(provider.revalidateWorkspace(scope, workspace)).resolves.toMatchObject({authorityRevision:1});
  });

  it("validates canonical workspaces within configured roots", async () => {
    const { provider, root, workspacePath } = await fixture();
    const workspace = await provider.validateWorkspace(
      scope,
      "environment-1",
      workspacePath,
    );
    expect(workspace).toMatchObject({
      canonicalPath: await realpath(workspacePath),
      authorityRevision: 3,
      summary: {
        environmentId: "environment-1",
        displayName: "workspace",
        trustState: "trusted",
      },
    });
    await expect(
      provider.validateWorkspace(scope, "environment-1", tmpdir()),
    ).rejects.toThrow("workspace_not_allowed");
    await expect(
      provider.validateWorkspace(scope, "environment-1", "relative"),
    ).rejects.toThrow("workspace_not_allowed");
    expect(root).not.toBe(tmpdir());
  });

  it("distinguishes moved or non-directory workspaces from root denial", async () => {
    const { provider, root, workspacePath } = await fixture();
    await rm(workspacePath, { recursive: true });
    await expect(
      provider.validateWorkspace(scope, "environment-1", workspacePath),
    ).rejects.toThrow("workspace_missing");

    const filePath = path.join(root, "workspace-file");
    await writeFile(filePath, "not a directory");
    await expect(
      provider.validateWorkspace(scope, "environment-1", filePath),
    ).rejects.toThrow("workspace_missing");
    await expect(
      provider.validateWorkspace(scope, "environment-1", tmpdir()),
    ).rejects.toThrow("workspace_not_allowed");
    await expect(
      provider.validateWorkspace(
        scope,
        "environment-1",
        `${root}-missing-outside`,
      ),
    ).rejects.toThrow("workspace_not_allowed");
  });

  it("contains eager allowed-root failures as workspace admission denial", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-execution-"));
    temporaryDirectories.push(root);
    const missingRoot = path.join(root, "missing");
    const provider = new LocalExecutionEnvironment({
      environmentId: "environment-1",
      scope,
      allowedRoots: [missingRoot],
      configurationRevision: 3,
      activeConfigurationRevision: () => 3,
    });

    await expect(
      provider.validateWorkspace(scope, "environment-1", tmpdir()),
    ).rejects.toThrow("workspace_not_allowed");
  });

  it("rejects configured roots that cannot be represented by the public browser", () => {
    for (const root of [
      "/tmp/invalid\\root",
      "/tmp/invalid\u0001root",
      "/tmp/not/../normalized",
    ]) {
      expect(
        () =>
          new LocalExecutionEnvironment({
            environmentId: "environment-1",
            scope,
            allowedRoots: [root],
            configurationRevision: 3,
            activeConfigurationRevision: () => 3,
          }),
      ).toThrow("local_execution_root_not_browseable");
    }
  });

  it("fails closed when its configured authority generation is stale", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-execution-"));
    temporaryDirectories.push(root);
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    let activeRevision = 4;
    const provider = new LocalExecutionEnvironment({
      environmentId: "environment-1",
      scope,
      allowedRoots: [root],
      configurationRevision: 4,
      activeConfigurationRevision: () => activeRevision,
    });
    const workspace = await provider.validateWorkspace(
      scope,
      "environment-1",
      workspacePath,
    );
    activeRevision = 5;
    await expect(
      provider.acquireLease(scope, {
        environmentId: "environment-1",
        workspace,
      }),
    ).rejects.toThrow("execution_environment_configuration_stale");
  });

  it("owns idempotent leases separately from backend handles", async () => {
    const { provider, workspacePath } = await fixture();
    const workspace = await provider.validateWorkspace(
      scope,
      "environment-1",
      workspacePath,
    );
    const lease = await provider.acquireLease(scope, {
      environmentId: "environment-1",
      workspace,
    });
    expect(provider.activeLeaseCount).toBe(1);
    expect(() => provider.close()).toThrow("local_execution_leases_active");
    await lease.release();
    await lease.release();
    expect(provider.activeLeaseCount).toBe(0);
    provider.close();
    await expect(provider.listEnvironments(scope)).resolves.toEqual([]);
  });

  it("executes bounded commands in the validated workspace", async () => {
    const { provider, workspacePath } = await fixture();
    const workspace = await provider.validateWorkspace(
      scope,
      "environment-1",
      workspacePath,
    );
    const result = await provider.executeCommand(scope, {
      environmentId: "environment-1",
      workspace,
      command: "pwd",
      timeoutMilliseconds: 2_000,
    });
    expect(result.kind).toBe("exited");
    if (result.kind === "exited") {
      expect(Buffer.from(result.stdoutPreview).toString().trim()).toBe(
        await realpath(workspacePath),
      );
      expect(result.exitCode).toBe(0);
    }
  });

  it("rejects cross-principal and cross-environment access", async () => {
    const { provider, workspacePath } = await fixture();
    await expect(
      provider.validateWorkspace(
        { ...scope, principalId: "principal-2" },
        "environment-1",
        workspacePath,
      ),
    ).rejects.toThrow("execution_environment_unavailable");
    await expect(
      provider.validateWorkspace(scope, "environment-2", workspacePath),
    ).rejects.toThrow("execution_environment_unavailable");
  });
});
