import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import {
  remotePiNativeStoreNamespace,
  resolveRemotePiStorage,
} from "../../src/server/backends/pi/pi-storage.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function remoteWorkspace(
  canonicalPath: string,
  environmentId = "remote-environment",
): ValidatedWorkspace {
  return {
    canonicalPath,
    authorityRevision: 0,
    summary: {
      id: `workspace-${environmentId}`,
      environmentId,
      displayName: "remote project",
      displayPath: canonicalPath,
      availability: "available",
      trustState: "trusted",
      revision: 0,
    },
  };
}

describe("remote Pi session-store workspace paths", () => {
  it("preserves a Windows remote workspace through reservation and discovery on the main host", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-remote-pi-windows-"),
    );
    temporaryDirectories.push(root);
    const store = new PiSessionStore({
      sessionDirectory: root,
      workspacePathMode: "remote_semantic",
    });
    const workspace = remoteWorkspace("C:\\Users\\alex\\work");
    await store.reserve(workspace, "windows-remote-session");
    await expect(store.list(workspace)).resolves.toMatchObject([
      {
        backendConversationId: "windows-remote-session",
        canonicalWorkspacePath: workspace.canonicalPath,
      },
    ]);
  });

  it("pins the permanent historical remote-store locator domain", () => {
    expect(
      remotePiNativeStoreNamespace({
        backendInstanceId: "pi-first",
        executionEnvironmentId: "11111111-1111-4111-8111-111111111111",
      }),
    ).toBe("93396ecf8ac3ef0b4a4e28a033114a2106ecc050bba7a285b2b11445cd426cad");
  });
  it("rejects non-canonical remote semantic paths before SDK path normalization", () => {
    const store = new PiSessionStore({
      sessionDirectory: "/var/lib/sedes/remote-sessions",
      workspacePathMode: "remote_semantic",
    });

    expect(() =>
      store.transient(remoteWorkspace("/srv/projects/../other")),
    ).toThrow("remote Pi workspace path is invalid");
    expect(() => store.transient(remoteWorkspace("relative/project"))).toThrow(
      "remote Pi workspace path is invalid",
    );
  });

  it("compares the remote semantic header lexically without probing a same-looking main-host symlink", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-remote-pi-path-"));
    temporaryDirectories.push(root);
    const localTarget = path.join(root, "main-host-project");
    const remoteSemanticPath = path.join(root, "remote-project");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(localTarget), mkdir(sessions)]);
    await symlink(localTarget, remoteSemanticPath);
    const workspace = remoteWorkspace(remoteSemanticPath);
    const remoteStore = new PiSessionStore({
      sessionDirectory: sessions,
      workspacePathMode: "remote_semantic",
    });
    await remoteStore.reserve(workspace, "remote-session");

    await expect(remoteStore.list(workspace)).resolves.toMatchObject([
      {
        backendConversationId: "remote-session",
        canonicalWorkspacePath: remoteSemanticPath,
      },
    ]);

    // This documents the intentionally unchanged local behavior: its
    // filesystem canonicalization sees the symlink target and rejects the
    // header for the lexical workspace path.
    const localStore = new PiSessionStore({ sessionDirectory: sessions });
    await expect(localStore.list(workspace)).resolves.toEqual([]);
  });

  it("isolates identical remote workspace paths in distinct environment namespaces", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "sedes-remote-pi-environments-"),
    );
    temporaryDirectories.push(root);
    const stateDirectory = path.join(root, "state");
    const firstEnvironment = "11111111-1111-4111-8111-111111111111";
    const secondEnvironment = "22222222-2222-4222-8222-222222222222";
    const firstStorage = resolveRemotePiStorage({
      installationStateDirectory: stateDirectory,
      backendInstanceId: "pi-first",
      executionEnvironmentId: firstEnvironment,
    });
    const secondStorage = resolveRemotePiStorage({
      installationStateDirectory: stateDirectory,
      backendInstanceId: "pi-second",
      executionEnvironmentId: secondEnvironment,
    });
    await Promise.all([
      mkdir(firstStorage.sessionDirectory, { recursive: true }),
      mkdir(secondStorage.sessionDirectory, { recursive: true }),
    ]);
    const firstStore = new PiSessionStore({
      sessionDirectory: firstStorage.sessionDirectory,
      workspacePathMode: "remote_semantic",
    });
    const secondStore = new PiSessionStore({
      sessionDirectory: secondStorage.sessionDirectory,
      workspacePathMode: "remote_semantic",
    });
    const semanticPath = "/srv/projects/same-project";
    await firstStore.reserve(
      remoteWorkspace(semanticPath, firstEnvironment),
      "same-session-id",
    );
    await secondStore.reserve(
      remoteWorkspace(semanticPath, secondEnvironment),
      "same-session-id",
    );

    const [first, second] = await Promise.all([
      firstStore.list(remoteWorkspace(semanticPath, firstEnvironment)),
      secondStore.list(remoteWorkspace(semanticPath, secondEnvironment)),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.sessionFile).not.toBe(second[0]?.sessionFile);
  });
});
