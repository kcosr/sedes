import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  WORKSPACE_CONTEXT_FILENAMES as ADVERTISED_CONTEXT_FILENAMES,
  WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES,
  WORKSPACE_CONTEXT_MAXIMUM_DEPTH,
  WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES,
  WORKSPACE_CONTEXT_MAXIMUM_FILES,
} from "../../src/internal/sidecar-protocol/workspace-context-v1.js";
import {
  WORKSPACE_CONTEXT_FILENAMES,
  WORKSPACE_CONTEXT_LIMITS,
  discoverWorkspaceContext,
} from "../../src/server/workspace-context/workspace-context-discovery.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const outerRoot = await mkdtemp(path.join(tmpdir(), "sedes-context-"));
  temporaryDirectories.push(outerRoot);
  const policyRoot = path.join(outerRoot, "projects");
  const intermediate = path.join(policyRoot, "group");
  const workspacePath = path.join(intermediate, "workspace");
  await mkdir(workspacePath, { recursive: true });
  return { outerRoot, policyRoot, intermediate, workspacePath };
}

describe("workspace context discovery", () => {
  it("uses Pi override priority while preserving root-first ancestor layering", async () => {
    const { outerRoot, policyRoot, intermediate, workspacePath } =
      await fixture();
    await writeFile(path.join(outerRoot, "AGENTS.md"), "outside authority");
    await writeFile(path.join(policyRoot, "CLAUDE.MD"), "policy");
    await writeFile(path.join(intermediate, "AGENTS.MD"), "intermediate");
    await writeFile(path.join(intermediate, "CLAUDE.md"), "lower priority");
    await writeFile(path.join(workspacePath, "AGENTS.md"), "workspace");
    await writeFile(
      path.join(workspacePath, "AGENTS.override.md"),
      "workspace override",
    );
    await writeFile(path.join(workspacePath, "AGENTS.MD"), "also lower");
    await mkdir(path.join(workspacePath, ".pi", "extensions"), {
      recursive: true,
    });
    await writeFile(
      path.join(workspacePath, ".pi", "extensions", "execute-me.ts"),
      "throw new Error('must not execute')",
    );

    const snapshot = await discoverWorkspaceContext({
      workspacePath,
      policyRoots: [outerRoot, policyRoot],
    });

    expect(WORKSPACE_CONTEXT_FILENAMES).toEqual([
      "AGENTS.override.md",
      "AGENTS.md",
      "AGENTS.MD",
      "CLAUDE.md",
      "CLAUDE.MD",
    ]);
    expect(snapshot.files).toEqual([
      expect.objectContaining({
        policyRelativePath: "CLAUDE.MD",
        content: "policy",
      }),
      expect.objectContaining({
        policyRelativePath: "group/AGENTS.MD",
        content: "intermediate",
      }),
      expect.objectContaining({
        policyRelativePath: "group/workspace/AGENTS.override.md",
        content: "workspace override",
      }),
    ]);
    const acceptedPaths = snapshot.files.map((file) => file.policyRelativePath);
    expect(acceptedPaths).not.toContain("../AGENTS.md");
    expect(acceptedPaths).not.toContain("group/workspace/AGENTS.md");
    expect(acceptedPaths).not.toContain("group/workspace/AGENTS.MD");
    expect(snapshot.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
    for (const file of snapshot.files) {
      expect(file.sha256).toBe(
        createHash("sha256").update(file.content).digest("hex"),
      );
      expect(file.sizeBytes).toBe(Buffer.byteLength(file.content));
    }
  });

  it("skips symlink and non-regular priority entries without following them", async () => {
    const { policyRoot, workspacePath } = await fixture();
    const secret = path.join(policyRoot, "secret.txt");
    await writeFile(secret, "secret");
    await symlink(secret, path.join(workspacePath, "AGENTS.override.md"));
    await mkdir(path.join(workspacePath, "AGENTS.md"));
    await mkdir(path.join(workspacePath, "AGENTS.MD"));
    await writeFile(path.join(workspacePath, "CLAUDE.md"), "safe");

    await expect(
      discoverWorkspaceContext({ workspacePath, policyRoots: [policyRoot] }),
    ).resolves.toMatchObject({
      files: [
        expect.objectContaining({
          policyRelativePath: "group/workspace/CLAUDE.md",
          content: "safe",
        }),
      ],
    });
  });

  it("rejects workspaces outside policy and symlinked workspace aliases", async () => {
    const { policyRoot, workspacePath } = await fixture();
    const alias = path.join(policyRoot, "workspace-alias");
    await symlink(workspacePath, alias);

    await expect(
      discoverWorkspaceContext({
        workspacePath: tmpdir(),
        policyRoots: [policyRoot],
      }),
    ).rejects.toMatchObject({ code: "workspace_context_not_allowed" });
    await expect(
      discoverWorkspaceContext({
        workspacePath: alias,
        policyRoots: [policyRoot],
      }),
    ).rejects.toMatchObject({ code: "workspace_context_not_allowed" });
  });

  it("restarts once from fresh descriptors after an identity race", async () => {
    const { policyRoot, workspacePath } = await fixture();
    const contextPath = path.join(workspacePath, "AGENTS.md");
    await writeFile(contextPath, "first");
    let changed = false;

    const snapshot = await discoverWorkspaceContext({
      workspacePath,
      policyRoots: [policyRoot],
      testHooks: {
        afterFileRead: async (_relativePath, attempt) => {
          if (attempt !== 1 || changed) return;
          changed = true;
          await rename(contextPath, `${contextPath}.old`);
          await writeFile(contextPath, "second");
        },
      },
    });

    expect(snapshot.files).toEqual([
      expect.objectContaining({ content: "second" }),
    ]);
  });

  it("fails as unstable when identity changes on the retry", async () => {
    const { policyRoot, workspacePath } = await fixture();
    const contextPath = path.join(workspacePath, "AGENTS.md");
    await writeFile(contextPath, "version-0");
    let version = 0;

    await expect(
      discoverWorkspaceContext({
        workspacePath,
        policyRoots: [policyRoot],
        testHooks: {
          afterFileRead: async () => {
            version += 1;
            await rename(contextPath, `${contextPath}.old-${version}`);
            await writeFile(contextPath, `version-${version}`);
          },
        },
      }),
    ).rejects.toMatchObject({ code: "workspace_context_unstable" });
  });

  it("honors cancellation during a descriptor read", async () => {
    const { policyRoot, workspacePath } = await fixture();
    await writeFile(path.join(workspacePath, "AGENTS.md"), "context");
    const controller = new AbortController();

    await expect(
      discoverWorkspaceContext({
        workspacePath,
        policyRoots: [policyRoot],
        signal: controller.signal,
        testHooks: {
          afterFileRead: () => controller.abort(new Error("cancelled")),
        },
      }),
    ).rejects.toThrow("cancelled");
  });

  it("enforces the advertised per-file and depth limits", async () => {
    expect(WORKSPACE_CONTEXT_LIMITS).toEqual({
      maximumFileBytes: 65_536,
      maximumAggregateBytes: 262_144,
      maximumFiles: 64,
      maximumDepth: 64,
    });
    expect(WORKSPACE_CONTEXT_LIMITS).toEqual({
      maximumFileBytes: WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES,
      maximumAggregateBytes: WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES,
      maximumFiles: WORKSPACE_CONTEXT_MAXIMUM_FILES,
      maximumDepth: WORKSPACE_CONTEXT_MAXIMUM_DEPTH,
    });
    expect(WORKSPACE_CONTEXT_FILENAMES).toEqual(ADVERTISED_CONTEXT_FILENAMES);
    const oversized = await fixture();
    await writeFile(
      path.join(oversized.workspacePath, "AGENTS.md"),
      Buffer.alloc(WORKSPACE_CONTEXT_LIMITS.maximumFileBytes + 1),
    );
    await expect(
      discoverWorkspaceContext({
        workspacePath: oversized.workspacePath,
        policyRoots: [oversized.policyRoot],
      }),
    ).rejects.toMatchObject({ code: "workspace_context_limit_exceeded" });

    const deep = await fixture();
    let deepest = deep.policyRoot;
    for (
      let index = 0;
      index <= WORKSPACE_CONTEXT_LIMITS.maximumDepth;
      index += 1
    ) {
      deepest = path.join(deepest, `level-${index}`);
    }
    await mkdir(deepest, { recursive: true });
    await expect(
      discoverWorkspaceContext({
        workspacePath: deepest,
        policyRoots: [deep.policyRoot],
      }),
    ).rejects.toMatchObject({ code: "workspace_context_limit_exceeded" });
  });

  it("enforces aggregate bytes and file count independently", async () => {
    const aggregate = await fixture();
    let aggregateWorkspace = aggregate.policyRoot;
    for (let index = 0; index < 5; index += 1) {
      await writeFile(
        path.join(aggregateWorkspace, "AGENTS.md"),
        Buffer.alloc(60_000, index),
      );
      aggregateWorkspace = path.join(aggregateWorkspace, `dir-${index}`);
      await mkdir(aggregateWorkspace);
    }
    await expect(
      discoverWorkspaceContext({
        workspacePath: aggregateWorkspace,
        policyRoots: [aggregate.policyRoot],
      }),
    ).rejects.toMatchObject({ code: "workspace_context_limit_exceeded" });

    const count = await fixture();
    let countWorkspace = count.policyRoot;
    for (
      let index = 0;
      index <= WORKSPACE_CONTEXT_LIMITS.maximumFiles;
      index += 1
    ) {
      await writeFile(path.join(countWorkspace, "AGENTS.md"), `${index}`);
      if (index < WORKSPACE_CONTEXT_LIMITS.maximumFiles) {
        countWorkspace = path.join(countWorkspace, `dir-${index}`);
        await mkdir(countWorkspace);
      }
    }
    await expect(
      discoverWorkspaceContext({
        workspacePath: countWorkspace,
        policyRoots: [count.policyRoot],
      }),
    ).rejects.toMatchObject({ code: "workspace_context_limit_exceeded" });
  });

  it("produces a stable content fingerprint that changes with accepted context", async () => {
    const { policyRoot, workspacePath } = await fixture();
    const contextPath = path.join(workspacePath, "AGENTS.md");
    await writeFile(contextPath, "one");
    const first = await discoverWorkspaceContext({
      workspacePath,
      policyRoots: [policyRoot],
    });
    const identical = await discoverWorkspaceContext({
      workspacePath,
      policyRoots: [policyRoot],
    });
    await writeFile(contextPath, "two");
    const changed = await discoverWorkspaceContext({
      workspacePath,
      policyRoots: [policyRoot],
    });

    expect(identical.fingerprint).toBe(first.fingerprint);
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });
});
