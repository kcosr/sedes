import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { LocalPiSandboxRuntime } from "../../src/server/pi-sandbox/local-pi-sandbox-runtime.js";

const roots: string[] = [];
const describeRealBubblewrap = describe.runIf(process.platform === "linux");
afterAll(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describeRealBubblewrap("local Pi sandbox worker runtime", () => {
  it("roots tools at writable home while preserving workspace mount authority", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-pi-worker-live-"));
    roots.push(root);
    const home = path.join(root, "allocation", "home");
    const workspace = path.join(home, "workspace");
    const readOnlyHome = path.join(root, "read-only-allocation", "home");
    const readOnlySource = path.join(root, "read-only-source");
    const service = path.join(root, "service");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(path.join(readOnlyHome, "workspace"), {
        recursive: true,
        mode: 0o700,
      }),
      mkdir(readOnlySource, { recursive: true, mode: 0o700 }),
      mkdir(service, { recursive: true, mode: 0o700 }),
    ]);
    await writeFile(
      path.join(workspace, "AGENTS.md"),
      "# Replaced isolated instructions\n",
    );
    await writeFile(
      path.join(workspace, "AGENTS.override.md"),
      "# Isolated override instructions\n",
    );
    await writeFile(
      path.join(readOnlySource, "AGENTS.md"),
      "# Read-only instructions\n",
    );
    await writeFile(path.join(readOnlySource, "original.txt"), "original\n");
    const workerPath = path.join(root, "worker.mjs");
    const bundle = await build({
      entryPoints: [
        path.resolve("src/server/pi-sandbox/pi-sandbox-worker-main.ts"),
      ],
      outfile: workerPath,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      packages: "bundle",
      write: false,
    });
    const output = bundle.outputFiles?.[0];
    if (!output) throw new Error("pi_sandbox_test_worker_missing");
    await writeFile(workerPath, output.contents, { mode: 0o500 });
    await chmod(workerPath, 0o500);
    const sha256 = createHash("sha256").update(output.contents).digest("hex");
    const scope = {
      tenantId: "tenant-local",
      principalId: "principal-local",
    };
    const environmentId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
    const channels = new LocalEnvironmentChannelProvider({
      scope,
      executionEnvironmentId: environmentId,
    });
    const systemMounts = ["/usr", "/bin", "/lib", "/lib64"].filter(existsSync);
    const runtime = new LocalPiSandboxRuntime({
      environmentLabel: "Local",
      channels,
      bubblewrapExecutablePath: "/usr/bin/bwrap",
      workerNodePath: process.execPath,
      workerArtifact: {
        executablePath: workerPath,
        buildId: "pi-sandbox-test",
        sha256,
      },
      systemMounts,
    });
    try {
      const lease = await runtime.acquire({
        allocationId: "allocation-1",
        scope: {
          ...scope,
          backendInstanceId: "pi-local",
          executionEnvironmentId: environmentId,
        },
        applicationThreadId: "thread-1",
        sourceWorkspaceId: "workspace-1",
        hostHomePath: home,
        hostWorkspacePath: workspace,
        serviceCwd: service,
        networkMode: "isolated",
        workspaceAccess: "writable_clone",
      });
      await lease.executor.write({
        path: "home-note.txt",
        content: "home value\n",
      });
      await lease.executor.write({
        path: "workspace/src/value.txt",
        content: "sandbox value\n",
      });
      await expect(
        lease.executor.read({ path: "workspace/src/value.txt" }),
      ).resolves.toMatchObject({
        contentKind: "text",
        content: "sandbox value\n",
      });
      await expect(
        lease.executor.find({ pattern: "*.txt" }),
      ).resolves.toMatchObject({
        paths: ["home-note.txt", "workspace/src/value.txt"],
      });
      await expect(
        lease.executor.grep({ pattern: "sandbox value" }),
      ).resolves.toMatchObject({
        matches: expect.arrayContaining([
          expect.objectContaining({ path: "workspace/src/value.txt" }),
        ]),
      });
      await expect(lease.contextReader.read()).resolves.toMatchObject({
        files: [
          expect.objectContaining({
            policyRelativePath: "AGENTS.override.md",
            content: "# Isolated override instructions\n",
          }),
        ],
      });
      let shellOutput = "";
      const shell = await lease.executor.startShell({
        command: "pwd && printf shell-ok",
        initialCreditBytes: 16 * 1024,
        timeoutMilliseconds: 5_000,
        onData: ({ bytes }) => {
          shellOutput += Buffer.from(bytes).toString("utf8");
        },
      });
      await expect(shell.terminal).resolves.toMatchObject({
        outcome: "exited",
        exitCode: 0,
      });
      expect(shellOutput).toContain("/home/agent");
      expect(shellOutput).toContain("shell-ok");
      await expect(lease.contextReader.read()).resolves.toMatchObject({
        files: [
          expect.objectContaining({
            policyRelativePath: "AGENTS.override.md",
            content: "# Isolated override instructions\n",
          }),
        ],
      });
      await lease.release();

      const readOnlyLease = await runtime.acquire({
        allocationId: "allocation-2",
        scope: {
          ...scope,
          backendInstanceId: "pi-local",
          executionEnvironmentId: environmentId,
        },
        applicationThreadId: "thread-2",
        sourceWorkspaceId: "workspace-2",
        hostHomePath: readOnlyHome,
        hostWorkspacePath: readOnlySource,
        serviceCwd: service,
        networkMode: "isolated",
        workspaceAccess: "read_only",
      });
      await readOnlyLease.executor.write({
        path: "notes.txt",
        content: "writable home\n",
      });
      await expect(
        readOnlyLease.executor.write({
          path: "workspace/original.txt",
          content: "changed\n",
        }),
      ).rejects.toThrow();
      await expect(
        readOnlyLease.executor.read({ path: "workspace/original.txt" }),
      ).resolves.toMatchObject({ content: "original\n" });
      await expect(readOnlyLease.contextReader.read()).resolves.toMatchObject({
        files: [expect.objectContaining({ policyRelativePath: "AGENTS.md" })],
      });
      let readOnlyShellOutput = "";
      const readOnlyShell = await readOnlyLease.executor.startShell({
        command:
          "pwd; printf shell-home > shell-note.txt; (printf changed > workspace/original.txt) 2>/dev/null || printf readonly-ok",
        initialCreditBytes: 16 * 1024,
        timeoutMilliseconds: 5_000,
        onData: ({ bytes }) => {
          readOnlyShellOutput += Buffer.from(bytes).toString("utf8");
        },
      });
      await expect(readOnlyShell.terminal).resolves.toMatchObject({
        outcome: "exited",
        exitCode: 0,
      });
      expect(readOnlyShellOutput).toContain("/home/agent");
      expect(readOnlyShellOutput).toContain("readonly-ok");
      await readOnlyLease.release();
      await expect(
        readFile(path.join(readOnlyHome, "notes.txt"), "utf8"),
      ).resolves.toBe("writable home\n");
      await expect(
        readFile(path.join(readOnlySource, "original.txt"), "utf8"),
      ).resolves.toBe("original\n");
    } finally {
      await runtime.close();
      await channels.close();
    }
  }, 20_000);
});
