import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, realpath, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installClaudeWorkerBundle } from "../../src/server/backends/claude/worker/claude-sidecar-worker-artifact.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function directory() {
  const value = await realpath(await mkdtemp(path.join(tmpdir(), "claude-artifact-")));
  directories.push(value);
  await chmod(value, 0o700);
  return value;
}
function bundle(source = "export {};\n") {
  return { source, manifest: JSON.stringify({
    schemaVersion: 1, artifactId: "openai.sedes.claude-runtime-worker",
    filename: "sedes-claude-runtime-worker.mjs", modes: ["claude_runtime"],
    sha256: createHash("sha256").update(source).digest("hex"), bytes: Buffer.byteLength(source),
    buildId: "sedes-test", minimumNodeVersion: "24.18.0",
  }) };
}

describe("embedded Claude sidecar worker", () => {
  it("installs independent verified worker bytes and reuses the exact artifact", async () => {
    const root = await directory();
    const input = bundle();
    const first = await installClaudeWorkerBundle(root, input);
    const again = await installClaudeWorkerBundle(root, input);
    expect(first).toEqual(again);
    expect(await readFile(first.executablePath, "utf8")).toBe(input.source);
    const second = await installClaudeWorkerBundle(root, bundle("export const version = 2;\n"));
    expect(second.executableDirectory).not.toBe(first.executableDirectory);
    expect(await readFile(first.executablePath, "utf8")).toBe(input.source);
  });

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "prunes superseded unreferenced worker builds after a verified install",
    async () => {
      const root = await directory();
      const workers = path.join(root, "claude-workers");
      await mkdir(workers, { mode: 0o700 });
      const superseded = ["a", "b", "c", "d"].map(label => createHash("sha256").update(label).digest("hex"));
      for (const [index, name] of superseded.entries()) {
        await mkdir(path.join(workers, name), { mode: 0o700 });
        await writeFile(path.join(workers, name, "sedes-claude-runtime-worker.mjs"), "old\n", { mode: 0o500 });
        const time = new Date(Date.now() - (index + 2) * 60 * 60 * 1_000);
        await utimes(path.join(workers, name), time, time);
      }
      const installed = await installClaudeWorkerBundle(root, bundle());
      // The installed build plus the two newest superseded builds remain.
      expect((await readdir(workers)).sort()).toEqual(
        [installed.artifactSha256, superseded[0]!, superseded[1]!].sort(),
      );
    },
  );

  it("rejects digest mismatch and malformed manifest before publishing", async () => {
    const root = await directory();
    await expect(installClaudeWorkerBundle(root, { ...bundle(), source: "changed" })).rejects.toThrow("bundle_invalid");
    const input = bundle();
    input.manifest = JSON.stringify({ ...JSON.parse(input.manifest), filename: "unregistered.mjs" });
    await expect(installClaudeWorkerBundle(root, input)).rejects.toThrow("managed_worker_manifest_invalid");
  });

  it("fails closed on artifact tampering rather than replacing evidence", async () => {
    const root = await directory();
    const input = bundle();
    const installed = await installClaudeWorkerBundle(root, input);
    await chmod(installed.executablePath, 0o700);
    await writeFile(installed.executablePath, "changed\n");
    await chmod(installed.executablePath, 0o500);
    await expect(installClaudeWorkerBundle(root, input)).rejects.toThrow("managed_worker_artifact");
    expect(await readFile(installed.executablePath, "utf8")).toBe("changed\n");
  });

  it("denies symlinked or publicly accessible installation roots", async () => {
    const root = await directory();
    const target = await directory();
    await symlink(target, path.join(root, "claude-workers"));
    await expect(installClaudeWorkerBundle(root, bundle())).rejects.toThrow("directory_invalid");
    await chmod(target, 0o755);
    await expect(installClaudeWorkerBundle(target, bundle())).rejects.toThrow("directory_invalid");
  });
});
