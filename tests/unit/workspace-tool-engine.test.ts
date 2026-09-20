import { randomUUID } from "node:crypto";
import {
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { CanonicalMutationSerializer } from "../../src/server/workspace-files/canonical-mutation-serializer.js";
import { WorkspaceToolError } from "../../src/server/workspace-tools/contracts.js";
import { WorkspaceToolEngine } from "../../src/server/workspace-tools/workspace-tool-engine.js";
import { WorkspaceFilesEngine } from "../../src/server/workspace-files/workspace-files-engine.js";
import { WorkspaceFilesSidecarHost } from "../../src/server/sidecar/workspace-files-sidecar-host.js";
import { WorkspaceToolsSidecarHost } from "../../src/server/sidecar/workspace-tools-sidecar-host.js";
import {
  TrustedSearchExecutableError,
  TrustedSearchExecutableResolver,
} from "../../src/server/workspace-tools/trusted-search-executables.js";

const execFileAsync = promisify(execFile);

describe("WorkspaceToolEngine", () => {
  async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-tools-"));
    return {
      root,
      engine: new WorkspaceToolEngine({
        root: {
          canonicalPath: root,
          homePath: path.dirname(root),
          operationKey: "test",
        },
      }),
    };
  }

  it("supports Pi path normalization and rejects absolute escape without probing it", async () => {
    const { root, engine } = await fixture();
    await writeFile(path.join(root, "space name.txt"), "ok");
    await expect(
      engine.read({ path: "@space\u00a0name.txt" }),
    ).resolves.toMatchObject({ content: "ok" });
    await expect(
      engine.read({ path: "/tmp/same-looking-canary" }),
    ).rejects.toMatchObject({ code: "workspace_tools_path_outside_workspace" });
  });

  it("returns bounded images and rejects unsupported binary content", async () => {
    const { root, engine } = await fixture();
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
    ]);
    await writeFile(path.join(root, "renamed.txt"), png);
    await expect(engine.read({ path: "renamed.txt" })).resolves.toMatchObject({
      contentKind: "image",
      mediaType: "image/png",
      contentBase64: png.toString("base64"),
    });
    await writeFile(path.join(root, "spoof.png"), "ordinary text");
    await expect(engine.read({ path: "spoof.png" })).resolves.toMatchObject({
      contentKind: "text",
      content: "ordinary text",
    });
    await writeFile(path.join(root, "binary.dat"), Buffer.from([1, 0, 2]));
    await expect(engine.read({ path: "binary.dat" })).resolves.toMatchObject({
      contentKind: "text",
      content: "\u0001\u0000\u0002",
    });
    await writeFile(path.join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await expect(engine.read({ path: "invalid.txt" })).resolves.toMatchObject({
      contentKind: "text",
      content: "\uFFFD(",
    });
  });

  it("publishes writes atomically, creates contained parents, and denies symlink escape", async () => {
    const { root, engine } = await fixture();
    await expect(
      engine.write({ path: "nested/file.txt", content: "hello" }),
    ).resolves.toMatchObject({ path: "nested/file.txt", sizeBytes: 5 });
    await expect(
      readFile(path.join(root, "nested/file.txt"), "utf8"),
    ).resolves.toBe("hello");
    await symlink("/tmp", path.join(root, "outside"));
    await expect(
      engine.write({ path: "outside/no.txt", content: "no" }),
    ).rejects.toBeInstanceOf(WorkspaceToolError);
  });

  it("preserves BOM and CRLF while applying one all-or-nothing edit", async () => {
    const { root, engine } = await fixture();
    await writeFile(path.join(root, "edit.txt"), "\uFEFFone\r\ntwo\r\n");
    await expect(
      engine.edit({
        path: "edit.txt",
        edits: [{ oldText: "two", newText: "three" }],
      }),
    ).resolves.toMatchObject({ replacements: 1 });
    await expect(readFile(path.join(root, "edit.txt"), "utf8")).resolves.toBe(
      "\uFEFFone\r\nthree\r\n",
    );
  });

  it("preserves untouched fuzzy text and matches Pi line-ending rules", async () => {
    const { root, engine } = await fixture();
    await writeFile(
      path.join(root, "fuzzy.txt"),
      "untouched “smart” text  \nreplace — me\r\nlast",
    );
    await expect(
      engine.edit({
        path: "fuzzy.txt",
        edits: [{ oldText: "replace - me", newText: "changed" }],
      }),
    ).resolves.toMatchObject({ replacements: 1 });
    await expect(readFile(path.join(root, "fuzzy.txt"), "utf8")).resolves.toBe(
      "untouched “smart” text  \nchanged\nlast",
    );

    await writeFile(path.join(root, "classic.txt"), "one\rtwo\rthree");
    await engine.edit({
      path: "classic.txt",
      edits: [{ oldText: "two\nthree", newText: "changed" }],
    });
    await expect(
      readFile(path.join(root, "classic.txt"), "utf8"),
    ).resolves.toBe("one\nchanged");
  });

  it("rejects an exact edit when fuzzy-equivalent text is ambiguous", async () => {
    const { root, engine } = await fixture();
    await writeFile(path.join(root, "ambiguous.txt"), "say 'yes'\nsay ‘yes’\n");
    await expect(
      engine.edit({
        path: "ambiguous.txt",
        edits: [{ oldText: "say 'yes'", newText: "accepted" }],
      }),
    ).rejects.toMatchObject({
      code: "workspace_tools_edit_ambiguous_match",
    });
  });

  it("rejects FIFOs without waiting for a writer", async () => {
    const { root, engine } = await fixture();
    const fifo = path.join(root, "pipe");
    await execFileAsync("mkfifo", [fifo]);
    await expect(
      Promise.race([
        engine.read({ path: "pipe" }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("fifo_read_blocked")), 500),
        ),
      ]),
    ).rejects.toMatchObject({ code: "workspace_tools_path_not_file" });
    await expect(
      Promise.race([
        engine.edit({
          path: "pipe",
          edits: [{ oldText: "before", newText: "after" }],
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("fifo_edit_blocked")), 500),
        ),
      ]),
    ).rejects.toMatchObject({ code: "workspace_tools_edit_failed" });
  });

  it("matches Pi's lossy UTF-8 edit decoding, including NUL text", async () => {
    const { root, engine } = await fixture();
    await writeFile(
      path.join(root, "lossy.txt"),
      Buffer.from([0xc3, 0x28, 0x00, 0x61]),
    );
    await expect(
      engine.edit({
        path: "lossy.txt",
        edits: [{ oldText: "\uFFFD(\u0000a", newText: "replaced" }],
      }),
    ).resolves.toMatchObject({ replacements: 1 });
    await expect(readFile(path.join(root, "lossy.txt"), "utf8")).resolves.toBe(
      "replaced",
    );
  });

  it("fails closed when the destination parent is swapped for a symlink", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "h-workspace-tools-parent-"),
    );
    const outside = await mkdtemp(
      path.join(tmpdir(), "h-workspace-tools-outside-"),
    );
    await mkdir(path.join(root, "nested"));
    const engine = new WorkspaceToolEngine({
      root: {
        canonicalPath: root,
        homePath: path.dirname(root),
        operationKey: "parent-race",
      },
      testHooks: {
        beforeMutationCommit: async () => {
          await rename(path.join(root, "nested"), path.join(root, "moved"));
          await symlink(outside, path.join(root, "nested"));
        },
      },
    });
    await expect(
      engine.write({ path: "nested/file.txt", content: "denied" }),
    ).rejects.toMatchObject({ code: "workspace_tools_path_outside_workspace" });
    await expect(readFile(path.join(outside, "file.txt"))).rejects.toThrow();
  });

  it("lists hidden entries deterministically with directory kinds", async () => {
    const { root, engine } = await fixture();
    await mkdir(path.join(root, "z"));
    await writeFile(path.join(root, ".env"), "secret");
    await writeFile(path.join(root, "A"), "a");
    await expect(engine.list({})).resolves.toEqual({
      entries: [
        { name: ".env", kind: "file" },
        { name: "A", kind: "file" },
        { name: "z", kind: "directory" },
      ],
      limitReached: false,
    });
  });

  it("uses Pi-compatible full-path and non-repository fd arguments", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-find-"));
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, ".gitignore"), "ignored\n");
    const resolver = new TrustedSearchExecutableResolver();
    vi.spyOn(resolver, "resolve").mockResolvedValue(
      trustedSearchEvidence("fd"),
    );
    const spawned = vi
      .spyOn(resolver, "spawn")
      .mockImplementation(async (_evidence, arguments_) => {
        expect(arguments_).toContain("--no-require-git");
        expect(arguments_).toContain("--full-path");
        expect(arguments_).toContain("**/src/**/*.spec.ts");
        return fakeSearchChild("./src/a.spec.ts\0", 0);
      });
    const engine = new WorkspaceToolEngine({
      root: {
        canonicalPath: root,
        homePath: path.dirname(root),
        operationKey: "find",
      },
      search: resolver,
    });
    await expect(
      engine.find({ pattern: "src/**/*.spec.ts" }),
    ).resolves.toMatchObject({ paths: ["src/a.spec.ts"] });
    expect(spawned).toHaveBeenCalledOnce();
  });

  it("defaults grep to 100 matches and preserves requested context lines", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-grep-"));
    const resolver = new TrustedSearchExecutableResolver();
    vi.spyOn(resolver, "resolve").mockResolvedValue(
      trustedSearchEvidence("rg"),
    );
    const rows = [
      grepJson("context", 1, "before\n"),
      grepJson("match", 2, "needle\n"),
      grepJson("context", 3, "after\n"),
      ...Array.from({ length: 100 }, (_, index) =>
        grepJson("match", index + 4, `needle ${index}\n`),
      ),
    ].join("\n");
    vi.spyOn(resolver, "spawn").mockImplementation(async () =>
      fakeSearchChild(rows, 0),
    );
    const engine = new WorkspaceToolEngine({
      root: {
        canonicalPath: root,
        homePath: path.dirname(root),
        operationKey: "grep",
      },
      search: resolver,
    });
    const result = await engine.grep({ pattern: "needle", context: 1 });
    expect(result.matchLimitReached).toBe(true);
    expect(result.matches.slice(0, 3)).toEqual([
      expect.objectContaining({ line: 1, lineText: "before", isMatch: false }),
      expect.objectContaining({ line: 2, lineText: "needle", isMatch: true }),
      expect.objectContaining({ line: 3, lineText: "after", isMatch: false }),
    ]);
    expect(result.matches.filter((row) => row.isMatch)).toHaveLength(100);
  });

  it("fails only the search tool whose executable is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-lazy-search-"));
    await writeFile(path.join(root, "note.txt"), "available\n");
    const resolver = new TrustedSearchExecutableResolver();
    vi.spyOn(resolver, "resolve").mockImplementation(async (kind) => {
      if (kind === "rg") {
        throw new TrustedSearchExecutableError("trusted_search_rg_unavailable");
      }
      return trustedSearchEvidence("fd");
    });
    vi.spyOn(resolver, "spawn").mockImplementation(async () =>
      fakeSearchChild("./note.txt\0", 0),
    );
    const engine = new WorkspaceToolEngine({
      root: {
        canonicalPath: root,
        homePath: path.dirname(root),
        operationKey: "lazy-search",
      },
      search: resolver,
    });

    await expect(engine.read({ path: "note.txt" })).resolves.toMatchObject({
      content: "available\n",
    });
    await expect(engine.find({ pattern: "*.txt" })).resolves.toMatchObject({
      paths: ["note.txt"],
    });
    await expect(engine.grep({ pattern: "available" })).rejects.toMatchObject({
      code: "workspace_tools_search_prerequisite_unavailable",
    });
  });

  it("keeps grep available when only the fd executable is absent", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-lazy-fd-"));
    await writeFile(path.join(root, "note.txt"), "available\n");
    const resolver = new TrustedSearchExecutableResolver();
    vi.spyOn(resolver, "resolve").mockImplementation(async (kind) => {
      if (kind === "fd") {
        throw new TrustedSearchExecutableError("trusted_search_fd_unavailable");
      }
      return trustedSearchEvidence("rg");
    });
    vi.spyOn(resolver, "spawn").mockImplementation(async () =>
      fakeSearchChild(grepJson("match", 1, "available\n"), 0),
    );
    const engine = new WorkspaceToolEngine({
      root: {
        canonicalPath: root,
        homePath: path.dirname(root),
        operationKey: "lazy-fd",
      },
      search: resolver,
    });

    await expect(engine.find({ pattern: "*.txt" })).rejects.toMatchObject({
      code: "workspace_tools_search_prerequisite_unavailable",
    });
    await expect(engine.grep({ pattern: "available" })).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "file.txt", line: 1 })],
    });
  });

  it("maps a search executable replacement before spawn to tool-local unavailability", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-search-race-"));
    const resolver = new TrustedSearchExecutableResolver();
    vi.spyOn(resolver, "resolve").mockResolvedValue(
      trustedSearchEvidence("fd"),
    );
    vi.spyOn(resolver, "spawn").mockRejectedValue(
      new TrustedSearchExecutableError("trusted_search_fd_revalidation_failed"),
    );
    const engine = new WorkspaceToolEngine({
      root: {
        canonicalPath: root,
        homePath: path.dirname(root),
        operationKey: "search-race",
      },
      search: resolver,
    });

    await expect(engine.find({ pattern: "*.txt" })).rejects.toMatchObject({
      code: "workspace_tools_search_prerequisite_unavailable",
    });
  });

  it("shares one canonical destination serializer across Files and tools", async () => {
    const serializer = new CanonicalMutationSerializer();
    const order: string[] = [];
    let release!: () => void;
    const first = serializer.run("/canonical/file", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      order.push("first:end");
    });
    await Promise.resolve();
    const second = serializer.run("/canonical/file", async () => {
      order.push("second");
    });
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("serializes real Files and tool publications to the same canonical destination", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "h-workspace-cross-cap-"));
    const filename = path.join(root, "shared.txt");
    await writeFile(filename, "before");
    const mutations = new CanonicalMutationSerializer();
    let entered!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continueCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const files = new WorkspaceFilesEngine({
      mutations,
      testHooks: {
        beforeWriteCommit: async () => {
          entered();
          await continueCommit;
        },
      },
    });
    const fileRoot = { canonicalPath: root, operationKey: "files" };
    const initial = await files.read(fileRoot, "shared.txt");
    const tools = new WorkspaceToolEngine({
      root: {
        canonicalPath: root,
        homePath: path.dirname(root),
        operationKey: "tools",
      },
      mutations,
    });
    const filesWrite = files.write(fileRoot, {
      path: "shared.txt",
      content: "files",
      expectedRevision: initial.revision,
    });
    await atCommit;
    let toolSettled = false;
    const toolWrite = tools
      .write({ path: "shared.txt", content: "tools" })
      .finally(() => {
        toolSettled = true;
      });
    await Promise.resolve();
    expect(toolSettled).toBe(false);
    release();
    await Promise.all([filesWrite, toolWrite]);
    await expect(readFile(filename, "utf8")).resolves.toBe("tools");
    files.close();
  });

  it("shares canonical mutation serialization across sidecar Files and tool hosts", async () => {
    const policy = await mkdtemp(path.join(tmpdir(), "h-sidecar-cross-cap-"));
    const root = path.join(policy, "workspace");
    await mkdir(root);
    await writeFile(path.join(root, "shared.txt"), "before");
    const mutations = new CanonicalMutationSerializer();
    let entered!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const continueCommit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const filesEngine = new WorkspaceFilesEngine({
      mutations,
      testHooks: {
        beforeWriteCommit: async () => {
          entered();
          await continueCommit;
        },
      },
    });
    const files = new WorkspaceFilesSidecarHost({
      sessionNonce: "n".repeat(32),
      engine: filesEngine,
      sendInvalidation: async () => undefined,
      sendWatchFailure: async () => undefined,
      openDownloadStream: () => {
        throw new Error("unexpected_download_stream");
      },
      onDownloadCleanupFailure: () => undefined,
    });
    const trusted = {
      canonicalPath: "/usr/bin/fake",
      device: 1,
      inode: 2,
      size: 3,
      modifiedMilliseconds: 4,
      mode: 0o100755,
    };
    const tools = new WorkspaceToolsSidecarHost({
      sessionNonce: "n".repeat(32),
      mutations,
      search: new TrustedSearchExecutableResolver({
        inspectPath: async () => trusted,
        readVersion: async (candidate) =>
          candidate.endsWith("rg") ? "ripgrep 15.2.0\n" : "fd 10.3.0\n",
      }),
    });
    const filesRoot = await files.handlers.rootOpen(
      {
        admissionId: "de8e220b-0000-4000-8000-000000000201",
        rootId: "primary",
        rootKind: "primary",
        declaredPath: root,
        policyRootPath: policy,
      },
      sidecarContext(),
    );
    const toolsRoot = await tools.handlers.openWorkspace(
      {
        admissionId: "de8e220b-0000-4000-8000-000000000202",
        declaredPath: root,
        policyRootPath: policy,
      },
      sidecarContext(),
    );
    const initial = await files.handlers.read(
      { rootHandle: filesRoot.rootHandle, path: "shared.txt" },
      sidecarContext(),
    );
    const filesWrite = files.handlers.write(
      {
        operationId: randomUUID(),
        rootHandle: filesRoot.rootHandle,
        path: "shared.txt",
        content: "files",
        expectedRevision: initial.revision,
      },
      sidecarContext(),
    );
    await atCommit;
    let toolsSettled = false;
    const toolsWrite = Promise.resolve(
      tools.handlers.writeFile(
        {
          workspaceHandle: toolsRoot.workspaceHandle,
          operationId: "de8e220b-0000-4000-8000-000000000203",
          path: "shared.txt",
          content: "tools",
        },
        sidecarContext(),
      ),
    ).finally(() => {
      toolsSettled = true;
    });
    await Promise.resolve();
    expect(toolsSettled).toBe(false);
    release();
    await Promise.all([filesWrite, toolsWrite]);
    await expect(readFile(path.join(root, "shared.txt"), "utf8")).resolves.toBe(
      "tools",
    );
    tools.close();
    files.close();
  });
});

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

function grepJson(type: "match" | "context", line: number, text: string) {
  return JSON.stringify({
    type,
    data: {
      path: { text: "file.txt" },
      line_number: line,
      lines: { text },
      ...(type === "match" ? { submatches: [{ start: 0 }] } : {}),
    },
  });
}

function sidecarContext() {
  return {
    requestId: "de8e220b-0000-4000-8000-000000000299",
    signal: new AbortController().signal,
  };
}
