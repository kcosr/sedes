import { CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION } from "../../src/server/backends/claude/worker/claude-runtime-host-support.js";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { ClaudeManagedRuntimeOwner } from "../../src/server/backends/claude/claude-managed-runtime-owner.js";
import {
  CLAUDE_RUNTIME_WORKER_ARTIFACT_ID,
  CLAUDE_RUNTIME_WORKER_FILENAME,
  loadClaudeRuntimeWorkerArtifact,
} from "../../src/server/backends/claude/worker/claude-runtime-worker-artifact.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const roots: string[] = [];

afterAll(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("local managed Claude runtime", () => {
  it.each(["explicit", "home", "environment"] as const)("runs the release worker with the %s native config directory", async selection => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-claude-local-"));
    roots.push(root);
    const configDirectory = path.join(root, selection === "home" ? ".claude" : "claude-config");
    const workspace = path.join(root, "workspace");
    const releaseDirectory = path.join(root, "release");
    await Promise.all([
      mkdir(configDirectory, { mode: 0o700 }),
      mkdir(workspace, { mode: 0o700 }),
      mkdir(releaseDirectory, { mode: 0o700 }),
    ]);

    const buildId = "claude-managed-local-test";
    const outputPath = path.join(releaseDirectory, CLAUDE_RUNTIME_WORKER_FILENAME);
    const result = await build({
      entryPoints: [
        path.resolve(
          "src/server/backends/claude/worker/claude-runtime-worker-main.ts",
        ),
      ],
      outfile: outputPath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      packages: "bundle",
      sourcemap: false,
      legalComments: "none",
      define: {
        __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__: JSON.stringify(buildId),
      },
      write: false,
    });
    const output = result.outputFiles?.find(
      (candidate) => path.resolve(candidate.path) === outputPath,
    );
    if (!output) throw new Error("claude_runtime_test_worker_missing");
    await writeFile(outputPath, output.contents, { mode: 0o500 });
    await chmod(outputPath, 0o500);
    const manifestPath = path.join(releaseDirectory, "manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 1,
        artifactId: CLAUDE_RUNTIME_WORKER_ARTIFACT_ID,
        filename: CLAUDE_RUNTIME_WORKER_FILENAME,
        modes: ["claude_runtime"],
        sha256: createHash("sha256").update(output.contents).digest("hex"),
        bytes: output.contents.byteLength,
        buildId,
        minimumNodeVersion: CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION,
      })}\n`,
      { mode: 0o400 },
    );
    await chmod(manifestPath, 0o400);

    const artifact = await loadClaudeRuntimeWorkerArtifact(manifestPath);
    const requestScope = {
      tenantId: "tenant-local",
      principalId: "principal-local",
    };
    const executionEnvironmentId = "environment-local";
    const channels = new LocalEnvironmentChannelProvider({
      scope: requestScope,
      executionEnvironmentId,
    });
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    const previousHome = process.env.HOME;
    process.env.HOME = root;
    if (selection === "home") delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = selection === "environment" ? configDirectory : "/not/the/selected/native/store";
    const owner = new ClaudeManagedRuntimeOwner({
      scope: {
        ...requestScope,
        backendInstanceId: "claude-local",
        executionEnvironmentId,
      },
      environmentKind: "local",
      artifact,
      channels,
      workingDirectory: "/",
      executablePath: process.execPath,
      ...(selection === "explicit" ? { configDirectory } : {}),
      initializationTimeoutMs: 10_000,
    });
    try {
      await expect(
        owner.listSessions(
          {
            dir: workspace,
            limit: 20,
            offset: 0,
            includeWorktrees: false,
            includeProgrammatic: true,
          },
          {},
        ),
      ).resolves.toEqual([]);
    } finally {
      await owner.close();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    }
  }, 30_000);
});
