import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it, onTestFinished, vi } from "vitest";
import {
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
} from "../../src/internal/sidecar-protocol/workspace-tools-v2.js";
import { WorkspaceToolEngine } from "../../src/server/workspace-tools/workspace-tool-engine.js";
import { TrustedSearchExecutableResolver } from "../../src/server/workspace-tools/trusted-search-executables.js";

it.skipIf(process.platform !== "win32")(
  "normalizes native Windows search output before validating sidecar responses",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-native-search-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, "src"));
    const resolver = new TrustedSearchExecutableResolver();
    vi.spyOn(resolver, "resolve").mockImplementation(async (kind) => trustedSearchEvidence(kind));
    vi.spyOn(resolver, "spawn").mockImplementation(async (evidence) =>
      fakeSearchChild(evidence.kind === "fd"
        ? ".\\nested\\file.txt\0nested\\other.txt\0"
        : JSON.stringify({
            type: "match",
            data: {
              path: { text: ".\\nested\\file.txt" },
              line_number: 2,
              lines: { text: "needle\r\n" },
              submatches: [{ start: 0 }],
            },
          }) + "\n", 0),
    );
    const engine = new WorkspaceToolEngine({
      root: { canonicalPath: root, homePath: root, operationKey: "native-search" },
      search: resolver,
    });
    const found = workspaceToolsSearchFindOperation.responseSchema.parse(
      await engine.find({ pattern: "*.txt", path: "src" }),
    );
    expect(found.paths).toEqual(["src/nested/file.txt", "src/nested/other.txt"]);
    const grepped = workspaceToolsSearchGrepOperation.responseSchema.parse(
      await engine.grep({ pattern: "needle", path: "src" }),
    );
    expect(grepped.matches).toEqual([
      expect.objectContaining({ path: "src/nested/file.txt", line: 2, lineText: "needle" }),
    ]);
  },
);

function trustedSearchEvidence(kind: "fd" | "rg") {
  const common = {
    source: "system_path" as const,
    executablePath: "/usr/bin/fake",
    canonicalPath: "/usr/bin/fake",
    version: "test",
    device: 1,
    inode: 2,
    size: 3,
    modifiedMilliseconds: 4,
    mode: 0o100755,
  };
  return { ...common, kind };
}

function fakeSearchChild(
  stdout: string,
  exitCode: number,
): ChildProcessWithoutNullStreams {
  const stdoutStream = new PassThrough();
  const stderrStream = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: stdoutStream,
    stderr: stderrStream,
    kill: vi.fn(() => true),
  }) as unknown as ChildProcessWithoutNullStreams;
  setImmediate(() => {
    stdoutStream.end(stdout);
    stderrStream.end();
    child.emit("close", exitCode, null);
  });
  return child;
}
