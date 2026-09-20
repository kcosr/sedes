import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createWindowsSidecarPlatform } from "../../src/server/sidecar/sidecar-windows-platform.js";

/** Real Windows PowerShell/ACL contract, also runnable with Node's type stripper. */
export async function verifyWindowsSidecarPrivacyBatch(
  parentDirectory = tmpdir(),
): Promise<void> {
  assert.equal(process.platform, "win32");
  const execute = promisify(execFile);
  let processes = 0;
  let batchEvidence: unknown;
  const platform = createWindowsSidecarPlatform(async (executable, args, options) => {
    processes += 1;
    const result = await execute(executable, args, options);
    if (options.env.SEDES_SIDECAR_PRIVATE_BATCH !== undefined) {
      batchEvidence = JSON.parse(result.stdout.trim());
    }
    return result;
  });

  await platform.privacyBatch([]);
  assert.equal(processes, 0, "An empty batch must not launch PowerShell.");
  const parent = path.resolve(parentDirectory);
  const root = await mkdtemp(path.join(parent, "sedes-privacy-contract-"));
  try {
    // Scalar preparation deliberately isolates the real batch-reading contract.
    // These names also exercise literal path handling across JSON/PowerShell.
    const directory = path.join(root, "private [雪] ' $folder");
    const filename = path.join(directory, "private [file].json");
    const executable = path.join(directory, "sealed ' executable.bin");
    await platform.privacy(root, "ensure-directory");
    await platform.privacy(directory, "ensure-directory");
    await writeFile(filename, "private fixture");
    await platform.privacy(filename, "secure-file");
    await writeFile(executable, "sealed fixture");
    await platform.privacy(executable, "secure-executable");

    const entries = [
      { filename: root, operation: "assert-directory" as const },
      { filename: directory, operation: "assert-directory" as const },
      { filename, operation: "assert-file" as const },
      { filename: executable, operation: "assert-executable" as const },
    ];
    let before = processes;
    await platform.privacyBatch([entries[2]!]);
    assert.equal(processes - before, 1);
    before = processes;
    await platform.privacyBatch(entries);
    assert.equal(processes - before, 1, "A small mixed batch uses one process.");
    assert.equal(await readFile(filename, "utf8"), "private fixture");
    await assert.rejects(writeFile(executable, "overwrite"));

    // Inspect an existing OS-owned directory without modifying its ACL. Assert
    // the actual owner differs, so a different ACL failure cannot mask this case.
    const systemRoot = process.env.SystemRoot;
    assert.ok(systemRoot);
    await assert.rejects(
      platform.privacyBatch([
        entries[2]!,
        { filename: systemRoot, operation: "assert-directory" },
      ]),
      /sidecar_windows_privacy_invalid/u,
    );
    assert.ok(Array.isArray(batchEvidence));
    const wrongOwner = batchEvidence[1]?.evidence;
    assert.equal(typeof wrongOwner?.owner, "string");
    assert.equal(typeof wrongOwner?.sid, "string");
    assert.notEqual(wrongOwner.owner, wrongOwner.sid);
  } finally {
    // Only remove this invocation's newly created fixture, never a caller path.
    assert.equal(path.dirname(path.resolve(root)), parent);
    assert.ok(path.basename(root).startsWith("sedes-privacy-contract-"));
    await rm(root, { recursive: true, force: true });
  }
}
