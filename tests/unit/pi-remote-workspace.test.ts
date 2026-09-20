import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import {
  assertCompletePiRemoteBuiltinOverrides,
  assertPiRemoteBuiltinDefinitionSet,
  createPiRemoteWorkspaceToolDefinitions,
  PI_REMOTE_BUILTIN_TOOL_NAMES,
  RemotePiResourceLoader,
  type RemotePiWorkspaceServices,
} from "../../src/server/backends/pi/pi-remote-workspace.js";
import { WorkspaceToolOutcomeUnknownError } from "../../src/server/workspace-tools/contracts.js";
import { WorkspaceSkillReaderError } from "../../src/server/workspace-skills/contracts.js";

function remoteFixture(): {
  readonly remote: RemotePiWorkspaceServices;
  readonly calls: Record<string, ReturnType<typeof vi.fn>>;
} {
  const shellCredit = vi.fn(async (_bytes: number) => undefined);
  const calls = {
    read: vi.fn(async () => ({
      path: "README.md",
      contentKind: "text" as const,
      content: "remote-only\n",
      sizeBytes: 12,
      totalLines: 2,
      startLine: 1,
      outputLines: 2,
    })),
    write: vi.fn(async () => ({
      path: "new.txt",
      sizeBytes: 3,
      sha256: "a".repeat(64),
    })),
    edit: vi.fn(async () => ({
      path: "edit.txt",
      sizeBytes: 3,
      sha256: "b".repeat(64),
      replacements: 1,
      diff: "diff",
      patch: "patch",
    })),
    list: vi.fn(async () => ({
      entries: [
        { name: "a", kind: "file" as const },
        { name: "b", kind: "directory" as const },
      ],
      limitReached: false,
    })),
    find: vi.fn(async () => ({ paths: ["a.ts"], limitReached: false })),
    grep: vi.fn(async () => ({
      matches: [
        {
          path: "a.ts",
          line: 2,
          column: 1,
          lineText: "match",
          lineTruncated: false,
          isMatch: true,
        },
      ],
      matchLimitReached: false,
    })),
    startShell: vi.fn(
      async (input: {
        onData(record: {
          sequence: number;
          channel: "stdout";
          bytes: Uint8Array;
        }): void | Promise<void>;
      }) => {
        const bytes = Buffer.from("remote shell");
        await input.onData({
          sequence: 0,
          channel: "stdout",
          bytes,
        });
        // The neutral executor replenishes credit only after the consumer has
        // accepted this immediate chunk. Pi must not grant it a second time.
        await shellCredit(bytes.byteLength);
        return {
          streamId: "00000000-0000-4000-8000-000000000001",
          terminal: Promise.resolve({
            outcome: "exited" as const,
            exitCode: 0,
            signal: null,
            stdoutBytes: 12,
            stderrBytes: 0,
            emittedBytes: 12,
            omittedBytes: 0,
            truncated: false,
          }),
          addCredit: shellCredit,
          cancel: vi.fn(async () => undefined),
          acknowledge: vi.fn(async () => undefined),
        };
      },
    ),
    shellCredit,
  };
  return {
    calls,
    remote: {
      semanticCwd: "/same-looking/path/that-must-not-be-local",
      serviceCwd: "/private/inert/pi",
      executor: calls,
      contextReader: {
        read: vi.fn(async () => ({ files: [], fingerprint: "empty" })),
      },
      environmentLabel: "Remote test",
    },
  };
}

describe("Pi remote workspace integration", () => {
  it("replaces the exact seven built-ins with SDK identities", () => {
    const { remote } = remoteFixture();
    const definitions = createPiRemoteWorkspaceToolDefinitions(remote);
    expect(() => assertPiRemoteBuiltinDefinitionSet(definitions)).not.toThrow();
    expect(definitions.map(({ name }) => name)).toEqual(
      PI_REMOTE_BUILTIN_TOOL_NAMES,
    );
    assertCompletePiRemoteBuiltinOverrides(
      definitions.map(({ name }) => ({
        name,
        sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
      })) as ToolInfo[],
    );
    for (const omitted of PI_REMOTE_BUILTIN_TOOL_NAMES) {
      expect(() =>
        assertCompletePiRemoteBuiltinOverrides(
          definitions
            .filter(({ name }) => name !== omitted)
            .map(({ name }) => ({
              name,
              sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
            })) as ToolInfo[],
        ),
      ).toThrow("pi_executor_builtin_override_incomplete");
    }
    expect(() =>
      assertCompletePiRemoteBuiltinOverrides(
        definitions.map(({ name }) => ({
          name,
          sourceInfo: {
            source: name === "grep" ? "builtin" : "sdk",
            path: `<${name === "grep" ? "builtin" : "sdk"}:${name}>`,
          },
        })) as ToolInfo[],
      ),
    ).toThrow("pi_executor_host_builtin_residual");
    expect(() =>
      assertCompletePiRemoteBuiltinOverrides([
        ...definitions.map(({ name }) => ({
          name,
          sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
        })),
        {
          name: "powershell",
          sourceInfo: {
            source: "builtin",
            path: "<builtin:powershell>",
          },
        },
      ] as ToolInfo[]),
    ).toThrow("pi_builtin_tool_intentionally_unsupported");
    expect(() =>
      assertCompletePiRemoteBuiltinOverrides([
        ...definitions.map(({ name }) => ({
          name,
          sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
        })),
        {
          name: "future_tool",
          sourceInfo: {
            source: "builtin",
            path: "<builtin:future_tool>",
          },
        },
      ] as ToolInfo[]),
    ).toThrow("pi_builtin_tool_disposition_missing");
  });

  it("routes every execute through the neutral executor without local fallback", async () => {
    const { remote, calls } = remoteFixture();
    const [bash, read, write, edit, grep, find, ls] =
      createPiRemoteWorkspaceToolDefinitions(remote);
    await read.execute(
      "r",
      { path: "README.md" },
      undefined,
      undefined,
      {} as never,
    );
    await write.execute(
      "w",
      { path: "new.txt", content: "new" },
      undefined,
      undefined,
      {} as never,
    );
    await edit.execute(
      "e",
      { path: "edit.txt", edits: [{ oldText: "a", newText: "b" }] },
      undefined,
      undefined,
      {} as never,
    );
    await ls.execute("l", {}, undefined, undefined, {} as never);
    await find.execute(
      "f",
      { pattern: "*.ts" },
      undefined,
      undefined,
      {} as never,
    );
    await grep.execute(
      "g",
      { pattern: "match" },
      undefined,
      undefined,
      {} as never,
    );
    await bash.execute(
      "b",
      { command: "pwd" },
      undefined,
      undefined,
      {} as never,
    );

    expect(calls.read).toHaveBeenCalledWith({
      path: "README.md",
      signal: undefined,
    });
    expect(calls.write).toHaveBeenCalledWith(
      expect.not.objectContaining({ operationId: expect.anything() }),
    );
    expect(calls.edit).toHaveBeenCalledWith(
      expect.not.objectContaining({ operationId: expect.anything() }),
    );
    expect(calls.list).toHaveBeenCalledOnce();
    expect(calls.find).toHaveBeenCalledOnce();
    expect(calls.grep).toHaveBeenCalledOnce();
    expect(calls.startShell).toHaveBeenCalledOnce();
    expect(calls.shellCredit).toHaveBeenCalledTimes(1);
    expect(calls.shellCredit).toHaveBeenCalledWith(
      Buffer.byteLength("remote shell"),
    );
  });

  it("reports the remote bash duration limit before wire validation", async () => {
    const { remote } = remoteFixture();
    const [bash] = createPiRemoteWorkspaceToolDefinitions(remote);
    await expect(
      bash.execute(
        "long-bash",
        { command: "sleep 601", timeout: 601 },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("Remote bash timeout cannot exceed 600 seconds.");
    expect(remote.executor.startShell).not.toHaveBeenCalled();
  });

  it("reloads only supplied data and never grows executable resources", async () => {
    const reader = vi
      .fn()
      .mockResolvedValueOnce({
        fingerprint: "one",
        files: [
          {
            policyRelativePath: "AGENTS.md",
            content: "remote instructions",
            sizeBytes: 19,
            sha256: "a".repeat(64),
          },
        ],
      })
      .mockResolvedValueOnce({
        fingerprint: "two",
        files: [
          {
            policyRelativePath: "project/CLAUDE.md",
            content: "changed remote instructions",
            sizeBytes: 27,
            sha256: "b".repeat(64),
          },
        ],
      });
    const extensions = { extensions: [], errors: [], runtime: {} } as never;
    const loader = new RemotePiResourceLoader({
      extensions,
      contextReader: { read: reader },
    });
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      expect.objectContaining({
        path: "remote-workspace:/AGENTS.md",
        content: "remote instructions",
      }),
    ]);
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles[0]?.path).toBe(
      "remote-workspace:/project/CLAUDE.md",
    );
    expect(loader.getExtensions()).toBe(extensions);
    expect(loader.getSkills().skills).toEqual([]);
    expect(loader.getPrompts().prompts).toEqual([]);
    expect(loader.getThemes().themes).toEqual([]);
  });

  it("keeps required context refreshes available when optional skill discovery fails", async () => {
    const metadata = {
      id: "a".repeat(64),
      name: "review",
      description: "Review carefully",
      source: "account_pi" as const,
      filePath: "/home/remote/.pi/agent/skills/review/SKILL.md",
      baseDir: "/home/remote/.pi/agent/skills/review",
      contentSha256: "b".repeat(64),
      sizeBytes: 128,
      disableModelInvocation: false,
    };
    const readContext = vi
      .fn()
      .mockResolvedValueOnce({ files: [], fingerprint: "context-one" })
      .mockResolvedValueOnce({ files: [], fingerprint: "context-two" })
      .mockResolvedValueOnce({ files: [], fingerprint: "context-three" });
    const readCatalog = vi
      .fn()
      .mockResolvedValueOnce({
        skills: [metadata],
        diagnostics: [],
        catalogFingerprint: "c".repeat(64),
      })
      .mockRejectedValueOnce(new Error("transient discovery failure"))
      .mockResolvedValueOnce({
        skills: [metadata],
        diagnostics: [],
        catalogFingerprint: "c".repeat(64),
      });
    const loader = new RemotePiResourceLoader({
      extensions: { extensions: [], errors: [], runtime: {} } as never,
      contextReader: { read: readContext },
      skillReader: {
        readCatalog,
        resolve: vi.fn(),
      },
    });

    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.getSkills().skills).toHaveLength(1);

    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.getSkills().skills).toHaveLength(1);
    expect(loader.getSkills().diagnostics).toContainEqual({
      type: "warning",
      message: "pi_remote_skill_catalog_unavailable",
    });

    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.getSkills().skills).toHaveLength(1);
    expect(loader.getSkills().diagnostics).not.toContainEqual({
      type: "warning",
      message: "pi_remote_skill_catalog_unavailable",
    });
  });

  it("starts with an empty skill catalog when initial optional discovery fails", async () => {
    const loader = new RemotePiResourceLoader({
      extensions: { extensions: [], errors: [], runtime: {} } as never,
      contextReader: {
        read: vi.fn(async () => ({
          files: [
            {
              policyRelativePath: "AGENTS.md",
              content: "remote instructions",
              sizeBytes: 19,
              sha256: "a".repeat(64),
            },
          ],
          fingerprint: "context",
        })),
      },
      skillReader: {
        readCatalog: vi.fn(async () => {
          throw new Error("discovery unavailable");
        }),
        resolve: vi.fn(),
      },
    });

    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.getAgentsFiles().agentsFiles).toHaveLength(1);
    expect(loader.getSkills()).toEqual({
      skills: [],
      diagnostics: [
        {
          type: "warning",
          message: "pi_remote_skill_catalog_unavailable",
        },
      ],
    });
  });

  it("reinstalls a reverted catalog after repairing drift", async () => {
    const skill = {
      id: "a".repeat(64),
      name: "review",
      description: "Review carefully",
      source: "account_pi" as const,
      filePath: "/home/remote/.pi/agent/skills/review/SKILL.md",
      baseDir: "/home/remote/.pi/agent/skills/review",
      contentSha256: "b".repeat(64),
      sizeBytes: 128,
      disableModelInvocation: false,
    };
    const changedSkill = { ...skill, contentSha256: "c".repeat(64) };
    const originalCatalog = {
      skills: [skill],
      diagnostics: [],
      catalogFingerprint: "d".repeat(64),
    };
    const changedCatalog = {
      skills: [changedSkill],
      diagnostics: [],
      catalogFingerprint: "e".repeat(64),
    };
    const readCatalog = vi
      .fn()
      .mockResolvedValueOnce(originalCatalog)
      .mockResolvedValueOnce(changedCatalog)
      .mockResolvedValueOnce(originalCatalog);
    const loader = new RemotePiResourceLoader({
      extensions: { extensions: [], errors: [], runtime: {} } as never,
      contextReader: {
        read: vi.fn(async () => ({ files: [], fingerprint: "context" })),
      },
      skillReader: {
        readCatalog,
        resolve: vi.fn(async () => {
          throw new WorkspaceSkillReaderError(
            "workspace_skills_catalog_changed",
            false,
          );
        }),
      },
    });

    await loader.refresh();
    await expect(loader.resolveSkill(skill.filePath)).rejects.toThrow(
      "workspace_skills_catalog_changed",
    );
    expect(loader.skillContentSha256(skill.filePath)).toBe(
      changedSkill.contentSha256,
    );

    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.skillContentSha256(skill.filePath)).toBe(skill.contentSha256);
  });

  it("prefers one host-global override and skips invalid higher-priority candidates", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "h-pi-agent-dir-"));
    await writeFile(path.join(agentDir, "AGENTS.md"), "host instructions");
    await writeFile(
      path.join(agentDir, "AGENTS.override.md"),
      "host override instructions",
    );
    const loader = new RemotePiResourceLoader({
      extensions: { extensions: [], errors: [], runtime: {} } as never,
      agentDir,
      contextReader: {
        read: async () => ({
          fingerprint: "remote",
          files: [
            {
              policyRelativePath: "project/CLAUDE.md",
              content: "remote instructions",
              sizeBytes: 19,
              sha256: "a".repeat(64),
            },
          ],
        }),
      },
    });
    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([
      {
        path: "host-global:/AGENTS.override.md",
        content: "host override instructions",
      },
      {
        path: "remote-workspace:/project/CLAUDE.md",
        content: "remote instructions",
      },
    ]);
    const firstFingerprint = loader.fingerprint;
    await writeFile(
      path.join(agentDir, "AGENTS.override.md"),
      "changed host override",
    );
    await expect(loader.refresh()).resolves.toBe(true);
    expect(loader.fingerprint).not.toBe(firstFingerprint);

    const linkedDir = await mkdtemp(path.join(tmpdir(), "h-pi-agent-link-"));
    await symlink(
      path.join(agentDir, "AGENTS.override.md"),
      path.join(linkedDir, "AGENTS.override.md"),
    );
    await writeFile(path.join(linkedDir, "AGENTS.md"), "fallback agents");
    await writeFile(path.join(linkedDir, "CLAUDE.md"), "fallback global");
    const linked = new RemotePiResourceLoader({
      extensions: { extensions: [], errors: [], runtime: {} } as never,
      agentDir: linkedDir,
      contextReader: {
        read: async () => ({ files: [], fingerprint: "remote" }),
      },
    });
    await expect(linked.refresh()).resolves.toBe(true);
    expect(linked.getAgentsFiles().agentsFiles).toEqual([
      { path: "host-global:/AGENTS.md", content: "fallback agents" },
    ]);
  });

  it("turns delivered mutation uncertainty into an explicit no-replay result", async () => {
    const { remote } = remoteFixture();
    remote.executor.write = vi.fn(async () => {
      throw new WorkspaceToolOutcomeUnknownError();
    });
    const [, , write] = createPiRemoteWorkspaceToolDefinitions(remote);
    await expect(
      write.execute(
        "uncertain-write",
        { path: "result.txt", content: "maybe" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(
      "Remote operation outcome is unknown. Sedes will not replay it automatically.",
    );
    expect(remote.executor.write).toHaveBeenCalledOnce();
  });

  it("normalizes shell delivery uncertainty into the same explicit no-replay result", async () => {
    const { remote } = remoteFixture();
    remote.executor.startShell = vi.fn(async () => {
      throw Object.assign(new Error("carrier closed"), {
        diagnosticCode: "workspace_tools_shell_outcome_unknown" as const,
      });
    });
    const [bash] = createPiRemoteWorkspaceToolDefinitions(remote);
    await expect(
      bash.execute(
        "uncertain-shell",
        { command: "make deploy" },
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow(
      "Remote operation outcome is unknown. Sedes will not replay it automatically.",
    );
    expect(remote.executor.startShell).toHaveBeenCalledOnce();
  });
});
