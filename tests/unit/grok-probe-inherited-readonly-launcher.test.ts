import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const launcher = fileURLToPath(
  new URL(
    "../../scripts/grok-probes/inherited-readonly-launcher.mjs",
    import.meta.url,
  ),
);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map(
        async (directory) =>
          await rm(directory, { recursive: true, force: true }),
      ),
  );
});

describe("probe-local inherited read-only launcher", () => {
  it("passes only the verified file object as descriptor 3", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "grok-probe-launcher-test-"),
    );
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "candidate");
    const bytes = Buffer.from("verified-candidate-bytes");
    await writeFile(sourcePath, bytes, { mode: 0o500 });
    await chmod(sourcePath, 0o500);
    const metadata = await stat(sourcePath, { bigint: true });
    const configuration = JSON.stringify({
      arguments: [
        "--input-type=module",
        "-e",
        "import fs from 'node:fs';process.stdout.write(fs.readFileSync(3))",
      ],
      device: metadata.dev.toString(),
      environment: {},
      executablePath: process.execPath,
      expectedBytes: bytes.byteLength,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      inode: metadata.ino.toString(),
      sourcePath,
      workingDirectory: directory,
    });

    const result = await execFileAsync(process.execPath, [
      launcher,
      configuration,
    ]);
    expect(result.stdout).toBe(bytes.toString("utf8"));
    expect(result.stderr).toBe("");
  });

  it("fails closed without exposing the configured path", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "grok-probe-launcher-test-"),
    );
    temporaryDirectories.push(directory);
    const sourcePath = path.join(directory, "candidate-secret-name");
    const bytes = Buffer.from("candidate");
    await writeFile(sourcePath, bytes, { mode: 0o500 });
    const metadata = await stat(sourcePath, { bigint: true });
    const configuration = JSON.stringify({
      arguments: [],
      device: metadata.dev.toString(),
      environment: {},
      executablePath: process.execPath,
      expectedBytes: bytes.byteLength,
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      inode: (metadata.ino + 1n).toString(),
      sourcePath,
      workingDirectory: directory,
    });

    await expect(
      execFileAsync(process.execPath, [launcher, configuration]),
    ).rejects.toMatchObject({
      stderr: "grok_probe_inherited_launcher_failed\n",
    });
  });
});
