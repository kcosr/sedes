import { createHash, randomUUID } from "node:crypto";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceToolsShellHost } from "../../src/server/sidecar/workspace-tools-shell-host.js";
import { discoverWorkspaceContext } from "../../src/server/workspace-context/workspace-context-discovery.js";
import { WorkspaceToolEngine } from "../../src/server/workspace-tools/workspace-tool-engine.js";
import {
  piManagedSearchExecutablePath,
  TrustedSearchExecutableResolver,
  type TrustedSearchExecutableEvidence,
} from "../../src/server/workspace-tools/trusted-search-executables.js";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  agentToolsCatalogOperation,
  agentToolsDescribeOperation,
  agentToolsInvokeOperation,
  controlGoAwayOperation,
  controlHelloOperation,
  composerAttachmentsMaterializationAppendOperation,
  composerAttachmentsMaterializationCommitOperation,
  composerAttachmentsMaterializationOpenOperation,
  composerAttachmentsMaterializationReleaseOperation,
  workspaceFilesListOperation,
  workspaceFilesDiffRepositoriesOperation,
  workspaceFilesDownloadStartOperation,
  workspaceFilesDownloadTerminalSchema,
  workspaceFilesReadOperation,
  workspaceFilesResolveLinkOperation,
  workspaceFilesRootCloseOperation,
  workspaceFilesRootOpenOperation,
  workspaceFilesStatusOperation,
  workspaceFilesWriteOperation,
  workspaceFilesMutationListOperation,
  workspaceFilesMutationAcknowledgeOperation,
  workspaceContextReadOperation,
  workspaceSkillsCatalogReadOperation,
  workspaceSkillsResolveOperation,
  workspaceToolsDirectoryListOperation,
  workspaceToolsFileEditOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileWriteOperation,
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
  workspaceToolsShellStartOperation,
  workspaceToolsShellListOperation,
  workspaceToolsShellAcknowledgeOperation,
  workspaceToolsMutationListOperation,
  workspaceToolsMutationAcknowledgeOperation,
  workspaceToolsShellTerminalSchema,
  workspaceToolsWorkspaceCloseOperation,
  workspaceToolsWorkspaceOpenOperation,
  type SidecarByteStream,
  type SidecarByteStreamClosure,
  type SidecarOperationContext,
  type SidecarOutboundStream,
  type WorkspaceToolsShellTerminal,
} from "../../src/internal/sidecar-protocol/index.js";

import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";
import { sidecarSocketByteStream } from "../../src/server/sidecar/sidecar-socket-byte-stream.js";
import {
  readSidecarManagementRecord,
  writeSidecarManagementRecord,
} from "../../src/internal/sidecar-protocol/service-management-channel.js";
import {
  sidecarManagementResponseSchema,
  type SidecarManagementRequest,
} from "../../src/internal/sidecar-protocol/service-management-v1.js";
import { SIDECAR_WIRE_VERSION } from "../../src/internal/sidecar-protocol/envelopes.js";

const serviceCleanups: Array<() => Promise<void>> = [];
const configuration = { environmentRevision: 1, operationsRevision: 1 };
const temporaryRoots: string[] = [];
const AGENT_TOOL_ENDPOINT_KEY = randomUUID().replaceAll("-", "").slice(0, 24);

afterEach(async () => {
  for (const cleanup of serviceCleanups.splice(0).reverse()) await cleanup();
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("bundled sedes sidecar", () => {
  it("integrates tools, context, and Bash with a controlled trusted-search boundary", async () => {
    const policyRoot = await mkdtemp(
      path.join(tmpdir(), "sedes-controlled-tools-"),
    );
    temporaryRoots.push(policyRoot);
    const workspaceRoot = path.join(policyRoot, "workspace");
    await mkdir(workspaceRoot);
    await writeFile(path.join(policyRoot, "AGENTS.md"), "policy context\n");
    await writeFile(
      path.join(workspaceRoot, "CLAUDE.md"),
      "workspace context\n",
    );
    await writeFile(
      path.join(workspaceRoot, "AGENTS.md"),
      "replaced workspace context\n",
    );
    await writeFile(
      path.join(workspaceRoot, "AGENTS.override.md"),
      "workspace override context\n",
    );
    await writeFile(path.join(workspaceRoot, "note.txt"), "before\n");
    const localCanary = path.join(policyRoot, "same-name.txt");
    await writeFile(localCanary, "main-host canary\n");

    const search = controlledSearchResolver();
    const engine = new WorkspaceToolEngine({
      root: {
        canonicalPath: workspaceRoot,
        homePath: policyRoot,
        operationKey: "controlled-integration",
      },
      search,
    });
    await expect(engine.read({ path: "note.txt" })).resolves.toMatchObject({
      content: "before\n",
    });
    await expect(
      engine.write({ path: "same-name.txt", content: "remote value\n" }),
    ).resolves.toMatchObject({ path: "same-name.txt" });
    await expect(
      engine.edit({
        path: "same-name.txt",
        edits: [{ oldText: "remote value", newText: "edited remotely" }],
      }),
    ).resolves.toMatchObject({ replacements: 1 });
    await expect(engine.list({})).resolves.toMatchObject({
      entries: expect.arrayContaining([
        { name: "note.txt", kind: "file" },
        { name: "same-name.txt", kind: "file" },
      ]),
    });
    await expect(engine.find({ pattern: "*.txt" })).resolves.toMatchObject({
      paths: ["note.txt", "same-name.txt"],
    });
    await expect(
      engine.grep({ pattern: "edited remotely", literal: true }),
    ).resolves.toMatchObject({
      matches: [expect.objectContaining({ path: "same-name.txt", line: 1 })],
    });
    await expect(readFile(localCanary, "utf8")).resolves.toBe(
      "main-host canary\n",
    );

    await expect(
      discoverWorkspaceContext({
        workspacePath: workspaceRoot,
        policyRoots: [policyRoot],
      }),
    ).resolves.toMatchObject({
      files: [
        { policyRelativePath: "AGENTS.md", content: "policy context\n" },
        {
          policyRelativePath: "workspace/AGENTS.override.md",
          content: "workspace override context\n",
        },
      ],
    });

    const shellBytes: Buffer[] = [];
    let settleShell!: (terminal: WorkspaceToolsShellTerminal) => void;
    const shellTerminal = new Promise<WorkspaceToolsShellTerminal>(
      (resolve) => {
        settleShell = resolve;
      },
    );
    const stream: SidecarOutboundStream = {
      streamId: randomUUID(),
      send: async (_channel, bytes) => {
        shellBytes.push(Buffer.from(bytes));
      },
      terminal: async (terminal) =>
        settleShell(terminal as WorkspaceToolsShellTerminal),
    };
    const shell = new WorkspaceToolsShellHost({
      resolveWorkspace: () => workspaceRoot,
      openStream: () => stream,
      admitOperation: async (
        _workspaceHandle,
        _operationId,
        _payload,
        operation,
      ) => await operation(),
      environment: { HOME: policyRoot, PATH: "/usr/bin:/bin", LANG: "C" },
    });
    const request = {
      workspaceHandle: randomUUID(),
      operationId: randomUUID(),
      streamId: stream.streamId,
      command: "printf 'shell:%s' \"$(pwd)\"",
      initialCreditBytes: 4_096,
      timeoutMilliseconds: 5_000,
    };
    await expect(
      shell.handlers.start(request, operationContext()),
    ).resolves.toEqual({
      streamId: stream.streamId,
      admitted: true,
    });
    await expect(withTimeout(shellTerminal, 5_000)).resolves.toMatchObject({
      outcome: "exited",
      exitCode: 0,
    });
    expect(Buffer.concat(shellBytes).toString("utf8")).toBe(
      `shell:${workspaceRoot}`,
    );
    await shell.close();
  }, 15_000);

  it("serves Files, tools, context, and Bash through persistent service attachments when search tools are installed", async (context) => {
    const searchPrerequisites = await resolveSearchPrerequisites();
    if (!searchPrerequisites) {
      context.skip(
        "requires trusted rg and fd on PATH or in the current account's Pi managed-bin directory",
      );
      return;
    }
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "sedes-bundled-sidecar-"),
    );
    temporaryRoots.push(temporaryRoot);
    await chmod(temporaryRoot, 0o700);
    await copySearchToolsIntoPiHome(temporaryRoot, searchPrerequisites);
    const { bundlePath, buildId, artifactSha256 } =
      await buildFixtureBundle(temporaryRoot);

    const policyRoot = path.join(temporaryRoot, "policy");
    const workspaceRoot = path.join(policyRoot, "workspace");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "note.txt"), "before\n");
    await writeFile(path.join(policyRoot, "AGENTS.md"), "policy context\n");
    await writeFile(
      path.join(workspaceRoot, "CLAUDE.md"),
      "workspace context\n",
    );
    await writeFile(
      path.join(workspaceRoot, "AGENTS.md"),
      "replaced workspace context\n",
    );
    await writeFile(
      path.join(workspaceRoot, "AGENTS.override.md"),
      "workspace override context\n",
    );
    const localCanaryPath = path.join(temporaryRoot, "same-name.txt");
    await writeFile(localCanaryPath, "main-host canary\n");

    const sessionNonce = "integration_nonce_".padEnd(48, "n");
    const {
      child,
      stderr,
      exited,
      stream: serviceStream,
    } = await startServiceAttachment({
      home: temporaryRoot,
      bundlePath,
      buildId,
      artifactSha256,
      sessionNonce,
      carrierGeneration: 1,
    });
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test_stdio", carrierGeneration: 1 },
      stream: serviceStream,
    });
    const peer = new SidecarProtocolPeer({
      role: "sedes",
      transport,
      sessionNonce,
      registry: new SidecarOperationRegistry(),
    });
    peer.start();

    try {
      const hello = await stage(
        "hello",
        peer.call(controlHelloOperation, {
          expectedBuildId: buildId,
          expectedArtifactSha256: artifactSha256,
          authorizedSidecarCapabilities: [
            { capabilityId: "workspace_files", majorVersion: 7 },
            { capabilityId: "workspace_tools", majorVersion: 2 },
            { capabilityId: "workspace_context", majorVersion: 1 },
            { capabilityId: "composer_attachments", majorVersion: 1 },
          ],
          offeredSedesCapabilities: [],
        }),
        stderr,
      );
      expect(hello).toMatchObject({
        buildId,
        artifactSha256,
        sidecarCapabilities: expect.arrayContaining([
          expect.objectContaining({
            capabilityId: "workspace_files",
            majorVersion: 7,
          }),
        ]),
      });

      const attachmentBytes = Buffer.from([0, 255, 1, 128, 42]);
      const attachmentId = randomUUID();
      const threadId = randomUUID();
      const attachmentSha256 = createHash("sha256")
        .update(attachmentBytes)
        .digest("hex");
      const attachmentOpen = await stage(
        "attachment_open",
        peer.call(composerAttachmentsMaterializationOpenOperation, {
          admissionId: randomUUID(),
          scopeKey: "a".repeat(64),
          threadId,
          attachmentId,
          sha256: attachmentSha256,
          sizeBytes: attachmentBytes.byteLength,
          extension: ".bin",
        }),
        stderr,
      );
      if (attachmentOpen.state !== "upload") {
        throw new Error("bundled_sidecar_attachment_unexpectedly_ready");
      }
      await stage(
        "attachment_append",
        peer.call(composerAttachmentsMaterializationAppendOperation, {
          uploadHandle: attachmentOpen.uploadHandle,
          offset: 0,
          decodedBytes: attachmentBytes.byteLength,
          chunkSha256: attachmentSha256,
          contentBase64: attachmentBytes.toString("base64"),
        }),
        stderr,
      );
      const attachmentCommitted = await stage(
        "attachment_commit",
        peer.call(composerAttachmentsMaterializationCommitOperation, {
          uploadHandle: attachmentOpen.uploadHandle,
        }),
        stderr,
      );
      expect(attachmentCommitted).toMatchObject({
        sha256: attachmentSha256,
        sizeBytes: attachmentBytes.byteLength,
      });
      await expect(readFile(attachmentCommitted.agentPath)).resolves.toEqual(
        attachmentBytes,
      );
      await expect(
        stage(
          "attachment_release",
          peer.call(composerAttachmentsMaterializationReleaseOperation, {
            scopeKey: "a".repeat(64),
            threadId,
            attachmentId,
            expectedSha256: attachmentSha256,
          }),
          stderr,
        ),
      ).resolves.toEqual({ released: true });

      const opened = await stage(
        "root_open",
        peer.call(workspaceFilesRootOpenOperation, {
          admissionId: randomUUID(),
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspaceRoot,
          policyRootPath: policyRoot,
        }),
        stderr,
      );
      await expect(
        stage(
          "list",
          peer.call(workspaceFilesListOperation, {
            rootHandle: opened.rootHandle,
            pageSize: 100,
          }),
          stderr,
        ),
      ).resolves.toMatchObject({
        entries: ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "note.txt"],
      });
      const read = await stage(
        "read",
        peer.call(workspaceFilesReadOperation, {
          rootHandle: opened.rootHandle,
          path: "note.txt",
        }),
        stderr,
      );
      expect(read).toMatchObject({
        contentKind: "text",
        content: "before\n",
        editable: true,
      });
      const written = await stage(
        "write",
        peer.call(workspaceFilesWriteOperation, {
          operationId: randomUUID(),
          rootHandle: opened.rootHandle,
          path: "note.txt",
          content: "after\n",
          expectedRevision: read.revision,
        }),
        stderr,
      );
      expect(written).toMatchObject({ path: "note.txt", sizeBytes: 6 });
      await expect(
        readFile(path.join(workspaceRoot, "note.txt"), "utf8"),
      ).resolves.toBe("after\n");
      const downloadStreamId = randomUUID();
      const downloadChunks: Uint8Array[] = [];
      let resolveDownloadTerminal!: (value: unknown) => void;
      const downloadTerminal = new Promise<unknown>((resolve) => {
        resolveDownloadTerminal = resolve;
      });
      const incomingDownload = peer.registerIncomingStream({
        streamId: downloadStreamId,
        capabilityId: "workspace_files",
        majorVersion: 7,
        initialCreditBytes: 512 * 1024,
        terminalSchema: workspaceFilesDownloadTerminalSchema,
        onData: ({ channel, bytes }) => {
          expect(channel).toBe("data");
          downloadChunks.push(bytes);
        },
        onTerminal: resolveDownloadTerminal,
      });
      const downloadMetadata = await stage(
        "download_start",
        peer.call(workspaceFilesDownloadStartOperation, {
          rootHandle: opened.rootHandle,
          path: "note.txt",
          expectedRevision: written.revision,
          streamId: downloadStreamId,
          initialCreditBytes: 512 * 1024,
        }),
        stderr,
      );
      expect(downloadMetadata).toEqual({
        path: "note.txt",
        fileName: "note.txt",
        sizeBytes: 6,
        revision: written.revision,
      });
      await expect(downloadTerminal).resolves.toEqual({
        outcome: "complete",
        sizeBytes: 6,
        revision: written.revision,
      });
      expect(
        Buffer.concat(downloadChunks.map((chunk) => Buffer.from(chunk))),
      ).toEqual(Buffer.from("after\n"));
      incomingDownload.unregister();
      await expect(
        stage(
          "status",
          peer.call(workspaceFilesStatusOperation, {
            rootHandle: opened.rootHandle,
          }),
          stderr,
        ),
      ).resolves.toMatchObject({
        isGitRepository: false,
        entries: [],
      });
      await expect(
        stage(
          "diff_repositories",
          peer.call(workspaceFilesDiffRepositoriesOperation, {
            rootHandle: opened.rootHandle,
          }),
          stderr,
        ),
      ).resolves.toEqual({ status: "available", repositories: [] });
      await expect(
        stage(
          "resolve_link",
          peer.call(workspaceFilesResolveLinkOperation, {
            rootHandle: opened.rootHandle,
            reference: { kind: "workspace_relative", path: "note.txt" },
          }),
          stderr,
        ),
      ).resolves.toEqual({ status: "resolved", path: "note.txt" });
      await expect(
        stage(
          "root_close",
          peer.call(workspaceFilesRootCloseOperation, {
            rootHandle: opened.rootHandle,
          }),
          stderr,
        ),
      ).resolves.toEqual({ closed: true });

      const toolsWorkspace = await stage(
        "tools_workspace_open",
        peer.call(workspaceToolsWorkspaceOpenOperation, {
          admissionId: randomUUID(),
          declaredPath: workspaceRoot,
          policyRootPath: policyRoot,
        }),
        stderr,
      );
      await expect(
        stage(
          "tools_read",
          peer.call(workspaceToolsFileReadOperation, {
            workspaceHandle: toolsWorkspace.workspaceHandle,
            path: "note.txt",
          }),
          stderr,
        ),
      ).resolves.toMatchObject({
        path: "note.txt",
        contentKind: "text",
        content: "after\n",
      });
      await expect(
        stage(
          "tools_write",
          peer.call(workspaceToolsFileWriteOperation, {
            workspaceHandle: toolsWorkspace.workspaceHandle,
            operationId: randomUUID(),
            path: "same-name.txt",
            content: "sidecar workspace value\n",
          }),
          stderr,
        ),
      ).resolves.toMatchObject({ path: "same-name.txt", sizeBytes: 24 });
      await expect(readFile(localCanaryPath, "utf8")).resolves.toBe(
        "main-host canary\n",
      );
      await expect(
        readFile(path.join(workspaceRoot, "same-name.txt"), "utf8"),
      ).resolves.toBe("sidecar workspace value\n");
      await expect(
        stage(
          "tools_edit",
          peer.call(workspaceToolsFileEditOperation, {
            workspaceHandle: toolsWorkspace.workspaceHandle,
            operationId: randomUUID(),
            path: "same-name.txt",
            edits: [
              {
                oldText: "sidecar workspace value",
                newText: "edited remotely",
              },
            ],
          }),
          stderr,
        ),
      ).resolves.toMatchObject({
        path: "same-name.txt",
        replacements: 1,
      });
      await expect(
        stage(
          "tools_list",
          peer.call(workspaceToolsDirectoryListOperation, {
            workspaceHandle: toolsWorkspace.workspaceHandle,
          }),
          stderr,
        ),
      ).resolves.toMatchObject({
        entries: expect.arrayContaining([
          { name: "note.txt", kind: "file" },
          { name: "same-name.txt", kind: "file" },
        ]),
        limitReached: false,
      });

      const context = await stage(
        "workspace_context",
        peer.call(workspaceContextReadOperation, {
          admissionId: randomUUID(),
          declaredPath: workspaceRoot,
          policyRootPath: policyRoot,
        }),
        stderr,
      );
      expect(context.files).toMatchObject([
        {
          policyRelativePath: "AGENTS.md",
          content: "policy context\n",
        },
        {
          policyRelativePath: "workspace/AGENTS.override.md",
          content: "workspace override context\n",
        },
      ]);

      const findResult = await stage(
        "tools_find",
        peer.call(workspaceToolsSearchFindOperation, {
          workspaceHandle: toolsWorkspace.workspaceHandle,
          pattern: "*.txt",
        }),
        stderr,
      );
      expect(findResult).toMatchObject({
        paths: expect.arrayContaining(["note.txt", "same-name.txt"]),
      });
      const grepResult = await stage(
        "tools_grep",
        peer.call(workspaceToolsSearchGrepOperation, {
          workspaceHandle: toolsWorkspace.workspaceHandle,
          pattern: "edited remotely",
          literal: true,
        }),
        stderr,
      );
      expect(grepResult).toMatchObject({
        matches: [expect.objectContaining({ path: "same-name.txt", line: 1 })],
      });

      const streamId = randomUUID();
      const shellBytes: Buffer[] = [];
      let settleTerminal!: (value: WorkspaceToolsShellTerminal) => void;
      const shellTerminal = new Promise<WorkspaceToolsShellTerminal>(
        (resolve) => {
          settleTerminal = resolve;
        },
      );
      const stream = peer.registerIncomingStream({
        streamId,
        capabilityId: "workspace_tools",
        majorVersion: 2,
        initialCreditBytes: 4_096,
        terminalSchema: workspaceToolsShellTerminalSchema,
        onData: ({ bytes }) => shellBytes.push(Buffer.from(bytes)),
        onTerminal: settleTerminal,
      });
      try {
        await expect(
          stage(
            "tools_shell_start",
            peer.call(workspaceToolsShellStartOperation, {
              workspaceHandle: toolsWorkspace.workspaceHandle,
              operationId: randomUUID(),
              streamId,
              command: "printf 'shell:%s' \"$(pwd)\"",
              initialCreditBytes: 4_096,
              timeoutMilliseconds: 5_000,
            }),
            stderr,
          ),
        ).resolves.toEqual({ streamId, admitted: true });
        await expect(withTimeout(shellTerminal, 5_000)).resolves.toMatchObject({
          outcome: "exited",
          exitCode: 0,
          omittedBytes: 0,
          truncated: false,
        });
        expect(Buffer.concat(shellBytes).toString("utf8")).toBe(
          `shell:${workspaceRoot}`,
        );
      } finally {
        stream.unregister();
      }
      await expect(
        stage(
          "tools_workspace_close",
          peer.call(workspaceToolsWorkspaceCloseOperation, {
            workspaceHandle: toolsWorkspace.workspaceHandle,
          }),
          stderr,
        ),
      ).resolves.toEqual({ closed: true });
      await acknowledgeRetainedResults(peer);
      await expect(
        stage(
          "go_away",
          peer.call(controlGoAwayOperation, {
            reason: "integration_complete",
          }),
          stderr,
        ),
      ).resolves.toEqual({ accepted: true });

      await expect(withTimeout(exited, 5_000)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    } finally {
      await peer.close("integration_cleanup").catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await withTimeout(exited, 5_000).catch(() => undefined);
      }
    }
  }, 30_000);

  it.each([false, true])(
    "admits terminal capabilities only with verified native assets (missing=%s)",
    async (missing) => {
      const temporaryRoot = await mkdtemp(
        path.join(tmpdir(), "sedes-optional-pty-"),
      );
      temporaryRoots.push(temporaryRoot);
      await chmod(temporaryRoot, 0o700);
      const { bundlePath, buildId, artifactSha256 } =
        await buildFixtureBundle(temporaryRoot);
      if (missing)
        await rm(path.join(temporaryRoot, "native"), {
          recursive: true,
          force: true,
        });
      const workspaceRoot = path.join(temporaryRoot, "workspace");
      await mkdir(workspaceRoot);
      await writeFile(
        path.join(workspaceRoot, "note.txt"),
        "Files stay available\n",
      );
      const sessionNonce = `optional_pty_${randomUUID()}`.replaceAll("-", "_");
      const { child, stderr, exited, stream } = await startServiceAttachment({
        home: temporaryRoot,
        bundlePath,
        buildId,
        artifactSha256,
        sessionNonce,
        carrierGeneration: 1,
      });
      const peer = new SidecarProtocolPeer({
        role: "sedes",
        sessionNonce,
        registry: new SidecarOperationRegistry(),
        transport: new LengthPrefixedSidecarFrameTransport({
          assurance: { kind: "test_stdio", carrierGeneration: 1 },
          stream,
        }),
      });
      peer.start();
      try {
        const hello = await peer.call(controlHelloOperation, {
          expectedBuildId: buildId,
          expectedArtifactSha256: artifactSha256,
          authorizedSidecarCapabilities: [
            { capabilityId: "workspace_files", majorVersion: 7 },
            { capabilityId: "codex_runtime", majorVersion: 1 },
            { capabilityId: "interactive_terminal", majorVersion: 2 },
            { capabilityId: "codex_managed_tui", majorVersion: 1 },
          ],
          offeredSedesCapabilities: [],
        });
        const capabilities = hello.sidecarCapabilities.map(
          (capability) => capability.capabilityId,
        );
        expect(capabilities).toContain("workspace_files");
        expect(capabilities).toContain("codex_runtime");
        expect(capabilities.includes("interactive_terminal")).toBe(!missing);
        expect(capabilities.includes("codex_managed_tui")).toBe(!missing);
        expect(
          hello.capabilityEvidence.some(
            (evidence) => evidence.capabilityId === "interactive_terminal",
          ),
        ).toBe(!missing);
        const root = await peer.call(workspaceFilesRootOpenOperation, {
          admissionId: randomUUID(),
          rootId: "primary",
          rootKind: "primary",
          declaredPath: workspaceRoot,
          policyRootPath: temporaryRoot,
        });
        const listing = await peer.call(workspaceFilesListOperation, {
          rootHandle: root.rootHandle,
          pageSize: 100,
        });
        expect(listing.entries).toContain("note.txt");
        expect(Buffer.concat(stderr).toString("utf8")).toBe("");
      } finally {
        await peer.close("integration_cleanup").catch(() => undefined);
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGTERM");
          await withTimeout(exited, 5_000).catch(() => undefined);
        }
      }
    },
    30_000,
  );

  it("advertises workspace_tools without a search-executable preflight", async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "sedes-bundled-sidecar-refusal-"),
    );
    temporaryRoots.push(temporaryRoot);
    await chmod(temporaryRoot, 0o700);
    const policyRoot = path.join(temporaryRoot, "policy");
    const workspaceRoot = path.join(policyRoot, "workspace");
    const accountSkillDirectory = path.join(
      temporaryRoot,
      ".pi",
      "agent",
      "skills",
      "remote-review",
    );
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(accountSkillDirectory, { recursive: true });
    const skillContent = `---\nname: remote-review\ndescription: Review from the remote account\n---\nUse the remote checklist.`;
    await writeFile(path.join(accountSkillDirectory, "SKILL.md"), skillContent);
    const { bundlePath, buildId, artifactSha256 } =
      await buildFixtureBundle(temporaryRoot);
    const sessionNonce = `integration_refusal_${randomUUID()}`.replaceAll(
      "-",
      "_",
    );
    const {
      child,
      stderr,
      exited,
      stream: serviceStream,
    } = await startServiceAttachment({
      home: temporaryRoot,
      bundlePath,
      buildId,
      artifactSha256,
      sessionNonce,
      carrierGeneration: 1,
      environment: {
        PATH: path.join(temporaryRoot, "same-looking-local-path"),
      },
    });
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test_stdio", carrierGeneration: 1 },
      stream: serviceStream,
    });
    const peer = new SidecarProtocolPeer({
      role: "sedes",
      transport,
      sessionNonce,
      registry: new SidecarOperationRegistry(),
    });
    peer.start();
    try {
      const hello = await peer.call(controlHelloOperation, {
        expectedBuildId: buildId,
        expectedArtifactSha256: artifactSha256,
        authorizedSidecarCapabilities: [
          { capabilityId: "workspace_tools", majorVersion: 2 },
          { capabilityId: "workspace_context", majorVersion: 1 },
          { capabilityId: "workspace_skills", majorVersion: 1 },
        ],
        offeredSedesCapabilities: [],
      });
      expect(hello.capabilityEvidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capabilityId: "workspace_tools",
            majorVersion: 2,
          }),
          expect.objectContaining({
            capabilityId: "workspace_context",
            majorVersion: 1,
          }),
          expect.objectContaining({
            capabilityId: "workspace_skills",
            majorVersion: 1,
          }),
        ]),
      );
      const catalog = await peer.call(workspaceSkillsCatalogReadOperation, {
        admissionId: randomUUID(),
        declaredPath: workspaceRoot,
        policyRootPath: policyRoot,
      });
      expect(catalog.skills).toEqual([
        expect.objectContaining({
          name: "remote-review",
          source: "account_pi",
          filePath: path.join(accountSkillDirectory, "SKILL.md"),
        }),
      ]);
      await expect(
        peer.call(workspaceSkillsResolveOperation, {
          admissionId: randomUUID(),
          declaredPath: workspaceRoot,
          policyRootPath: policyRoot,
          catalogFingerprint: catalog.catalogFingerprint,
          id: catalog.skills[0]!.id,
        }),
      ).resolves.toMatchObject({ content: skillContent });
      expect(
        hello.capabilityEvidence.some(
          (evidence) => "searchExecutables" in evidence,
        ),
      ).toBe(false);
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    } finally {
      await peer.close("integration_cleanup").catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await withTimeout(exited, 5_000).catch(() => undefined);
      }
    }
  }, 30_000);

  it("dispatches the bundled CLI through negotiated owner-only UDS ingress", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "hbc-"));
    temporaryRoots.push(temporaryRoot);
    await chmod(temporaryRoot, 0o700);
    const sidecarStateDirectory = path.join(
      temporaryRoot,
      ".local",
      "state",
      "sedes",
      "sidecar",
    );
    await mkdir(sidecarStateDirectory, { recursive: true, mode: 0o700 });
    await chmod(sidecarStateDirectory, 0o700);
    const { bundlePath, buildId, artifactSha256 } =
      await buildFixtureBundle(temporaryRoot);
    const sessionNonce = `integration_cli_${randomUUID()}`.replaceAll("-", "_");
    const malformedConfiguration = spawn(
      process.execPath,
      [
        bundlePath,
        "service",
        "connect",
        "--expected-digest",
        artifactSha256,
        "--expected-build",
        buildId,
        "--service-scope",
        encode({
          installationId: "invalid-fixture",
          tenantId: "tenant",
          principalId: "principal",
          executionEnvironmentId: "remote",
        }),
        "--configuration",
        "*",
        "--agent-tool-endpoint-key",
        AGENT_TOOL_ENDPOINT_KEY,
      ],
      {
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, HOME: temporaryRoot },
      },
    );
    const malformedStderr: Buffer[] = [];
    malformedConfiguration.stderr.on("data", (chunk: Buffer) =>
      malformedStderr.push(Buffer.from(chunk)),
    );
    await expect(childExit(malformedConfiguration)).resolves.toEqual({
      code: 1,
      signal: null,
    });
    expect(Buffer.concat(malformedStderr).toString("utf8")).toBe(
      "sidecar_arguments_invalid\n",
    );
    const {
      child,
      stderr,
      exited,
      stream: serviceStream,
    } = await startServiceAttachment({
      home: temporaryRoot,
      bundlePath,
      buildId,
      artifactSha256,
      sessionNonce,
      carrierGeneration: 7,
    });
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test_stdio", carrierGeneration: 7 },
      stream: serviceStream,
    });
    const registry = new SidecarOperationRegistry();
    registry.register(agentToolsCatalogOperation, (request) => {
      expect(request.sourceCapability).toBe("c".repeat(48));
      return { outcome: "ok" as const, tools: [] };
    });
    registry.register(agentToolsDescribeOperation, () => ({
      outcome: "ok" as const,
      tools: [],
    }));
    registry.register(agentToolsInvokeOperation, () => {
      throw new Error("unexpected_agent_tool_invoke");
    });
    const peer = new SidecarProtocolPeer({
      role: "sedes",
      transport,
      sessionNonce,
      registry,
    });
    peer.start();

    try {
      const hello = await stage(
        "hello",
        peer.call(controlHelloOperation, {
          expectedBuildId: buildId,
          expectedArtifactSha256: artifactSha256,
          authorizedSidecarCapabilities: [
            { capabilityId: "workspace_files", majorVersion: 7 },
          ],
          offeredSedesCapabilities: [
            {
              capabilityId: "agent_tools_cli",
              majorVersion: 3,
              operations: [
                agentToolsDescribeOperation.operation,
                agentToolsCatalogOperation.operation,
                agentToolsInvokeOperation.operation,
              ],
            },
          ],
        }),
        stderr,
      );
      expect(hello).toMatchObject({
        buildId,
        artifactSha256,
        capabilityEvidence: [],
        sidecarCapabilities: expect.arrayContaining([
          expect.objectContaining({
            capabilityId: "workspace_files",
            majorVersion: 7,
          }),
        ]),
        sedesCapabilities: [
          {
            capabilityId: "agent_tools_cli",
            majorVersion: 3,
            operations: ["catalog.describe", "catalog.list", "tool.invoke"],
          },
        ],
        agentToolCli: {
          endpoint: `unix://${path.join(
            await realpath("/tmp"),
            `sedes-agent-tools-${process.geteuid!()}`,
            AGENT_TOOL_ENDPOINT_KEY,
            "agent-tools.sock",
          )}`,
          executableDirectory: temporaryRoot,
        },
      });
      const ingressPath = hello.agentToolCli!.endpoint.slice("unix://".length);
      expect((await lstat(ingressPath)).mode & 0o777).toBe(0o600);
      expect((await lstat(path.dirname(ingressPath))).mode & 0o777).toBe(0o700);
      const sourceCapability = "c".repeat(48);
      const cli = spawn(
        process.execPath,
        [bundlePath, "tool", "list", "--json"],
        {
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            SEDES_AGENT_TOOL_ENDPOINT: hello.agentToolCli!.endpoint,
            SEDES_AGENT_TOOL_SOURCE_CAPABILITY: sourceCapability,
            SEDES_AGENT_TOOL_CLI_MODE: "progressive",
          },
        },
      );
      const cliStdout: Buffer[] = [];
      const cliStderr: Buffer[] = [];
      cli.stdout.on("data", (chunk: Buffer) =>
        cliStdout.push(Buffer.from(chunk)),
      );
      cli.stderr.on("data", (chunk: Buffer) =>
        cliStderr.push(Buffer.from(chunk)),
      );
      await expect(withTimeout(childExit(cli), 5_000)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      expect(Buffer.concat(cliStdout).toString("utf8")).toBe('{"tools":[]}\n');
      expect(Buffer.concat(cliStderr).toString("utf8")).toBe("");

      await expect(
        peer.call(controlGoAwayOperation, { reason: "integration_complete" }),
      ).resolves.toEqual({ accepted: true });
      await expect(withTimeout(exited, 5_000)).resolves.toEqual({
        code: 0,
        signal: null,
      });
      expect(Buffer.concat(stderr).toString("utf8")).toBe("");
    } finally {
      await peer.close("integration_cleanup").catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await withTimeout(exited, 5_000).catch(() => undefined);
      }
    }
  }, 30_000);
});

type UnscopedManagementRequest = SidecarManagementRequest extends infer Request
  ? Request extends { scope: unknown }
    ? Omit<Request, "scope">
    : never
  : never;

async function buildFixtureBundle(directory: string) {
  const child = spawn(
    process.execPath,
    ["scripts/build-sidecar.mjs", "--output-directory", directory],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const diagnostics: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => diagnostics.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk));
  const result = await withTimeout(childExit(child), 20_000);
  if (result.code !== 0)
    throw new Error(
      `bundled_sidecar_build_failed:${Buffer.concat(diagnostics).toString("utf8")}`,
    );
  const manifest = JSON.parse(
    await readFile(path.join(directory, "manifest.json"), "utf8"),
  );
  return {
    bundlePath: path.join(directory, "sedes"),
    buildId: manifest.buildId as string,
    artifactSha256: manifest.sha256 as string,
  };
}

async function startServiceAttachment(input: {
  home: string;
  bundlePath: string;
  buildId: string;
  artifactSha256: string;
  sessionNonce: string;
  carrierGeneration: number;
  environment?: NodeJS.ProcessEnv;
}) {
  const scope = {
    installationId: randomUUID(),
    tenantId: "tenant",
    principalId: "principal",
    executionEnvironmentId: "remote",
  };
  const paths = persistentSidecarPaths(input.home, process.getuid!(), scope);
  await mkdir(paths.stateRoot, { recursive: true, mode: 0o700 });
  const open = async () => {
    const socket = connect(paths.endpointPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    return sidecarSocketByteStream(socket);
  };
  const management = async (request: UnscopedManagementRequest) => {
    const stream = await open();
    try {
      await writeSidecarManagementRecord(stream, { ...request, scope });
      return (
        await readSidecarManagementRecord(
          stream,
          sidecarManagementResponseSchema,
          AbortSignal.timeout(5_000),
        )
      ).value;
    } finally {
      await stream.close("fixture_management_complete");
    }
  };
  const attachRequest = (
    sessionNonce: string,
    mode: "normal" | "recovery",
  ) => ({
    managementVersion: 1 as const,
    requestId: randomUUID(),
    scope,
    operation: "attach" as const,
    expectedBuildId: input.buildId,
    expectedArtifactSha256: input.artifactSha256,
    runtimeWireVersion: SIDECAR_WIRE_VERSION,
    sessionNonce,
    carrierGeneration: input.carrierGeneration,
    configuration,
    mode,
  });
  serviceCleanups.push(async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const observed = await management({
        managementVersion: 1,
        requestId: randomUUID(),
        operation: "status",
      });
      if (observed.outcome !== "ok")
        throw new Error(
          `fixture_service_status_failed:${JSON.stringify(observed)}`,
        );
      const status = observed.status;
      const stopped = await management({
        managementVersion: 1,
        requestId: randomUUID(),
        operation: "stop",
        expectedServiceIncarnation: status.serviceIncarnation,
        controllerEpoch: status.controllerEpoch,
        expectedConfiguration: status.desiredConfiguration,
        expectedResourcesFingerprint: status.resourcesFingerprint,
        force: true,
      });
      if (stopped.outcome === "ok" && stopped.status.state === "stopped") {
        await vi.waitFor(async () => {
          const descriptor = JSON.parse(
            await readFile(paths.descriptorPath, "utf8"),
          );
          expect(descriptor.state).toBe("stopped");
        });
        await rm(paths.socketDirectory, { recursive: true, force: true });
        return;
      }
      if (
        stopped.outcome !== "error" ||
        stopped.code !== "sidecar_resource_handoff_pending"
      )
        throw new Error(
          `fixture_service_stop_failed:${JSON.stringify(stopped)}`,
        );
      // Failures in an assertion must still hand off any finite results before
      // cleanup retires the persistent service and removes its private state.
      const stream = await open();
      const sessionNonce =
        randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "");
      await writeSidecarManagementRecord(
        stream,
        attachRequest(sessionNonce, "recovery"),
      );
      const attached = await readSidecarManagementRecord(
        stream,
        sidecarManagementResponseSchema,
        AbortSignal.timeout(5_000),
      );
      if (attached.value.outcome !== "ok")
        throw new Error("fixture_recovery_attach_failed");
      const peer = new SidecarProtocolPeer({
        role: "sedes",
        sessionNonce,
        registry: new SidecarOperationRegistry(),
        transport: new LengthPrefixedSidecarFrameTransport({
          assurance: {
            kind: "fixture_recovery",
            carrierGeneration: input.carrierGeneration,
          },
          stream: attached.stream,
        }),
      });
      peer.start();
      try {
        await peer.call(controlHelloOperation, {
          expectedBuildId: input.buildId,
          expectedArtifactSha256: input.artifactSha256,
          authorizedSidecarCapabilities: [
            { capabilityId: "workspace_files", majorVersion: 7 },
            { capabilityId: "workspace_tools", majorVersion: 2 },
            { capabilityId: "workspace_context", majorVersion: 1 },
          ],
          offeredSedesCapabilities: [],
        });
        await acknowledgeRetainedResults(peer);
      } finally {
        await peer.close("fixture_results_transferred");
      }
    }
    throw new Error("fixture_service_retirement_unconfirmed");
  });
  const child = spawn(
    process.execPath,
    [
      input.bundlePath,
      "service",
      "connect",
      "--expected-digest",
      input.artifactSha256,
      "--expected-build",
      input.buildId,
      "--service-scope",
      encode(scope),
      "--configuration",
      encode(configuration),
      "--agent-tool-endpoint-key",
      AGENT_TOOL_ENDPOINT_KEY,
    ],
    {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: input.home, ...input.environment },
    },
  );
  const stderr: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
  const exited = childExit(child);
  const stream = childProcessByteStream(child);
  await writeSidecarManagementRecord(
    stream,
    attachRequest(input.sessionNonce, "normal"),
  );
  const response = await readSidecarManagementRecord(
    stream,
    sidecarManagementResponseSchema,
    AbortSignal.timeout(10_000),
  );
  if (response.value.outcome !== "ok")
    throw new Error(
      `fixture_service_attach_failed:${JSON.stringify(response.value)}`,
    );
  return { child, stderr, exited, stream: response.stream };
}

async function acknowledgeRetainedResults(
  peer: SidecarProtocolPeer,
): Promise<void> {
  for (const streamId of (await peer.call(workspaceToolsShellListOperation, {}))
    .streamIds) {
    expect(
      await peer.call(workspaceToolsShellAcknowledgeOperation, { streamId }),
    ).toEqual({ acknowledged: true });
  }
  for (const operationId of (
    await peer.call(workspaceFilesMutationListOperation, {})
  ).operationIds) {
    expect(
      await peer.call(workspaceFilesMutationAcknowledgeOperation, {
        operationId,
      }),
    ).toEqual({ acknowledged: true });
  }
  for (const operationId of (
    await peer.call(workspaceToolsMutationListOperation, {})
  ).operationIds) {
    expect(
      await peer.call(workspaceToolsMutationAcknowledgeOperation, {
        operationId,
      }),
    ).toEqual({ acknowledged: true });
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function childProcessByteStream(
  child: ChildProcessWithoutNullStreams,
): SidecarByteStream {
  let closed = false;
  let resolveClosed!: (closure: SidecarByteStreamClosure) => void;
  const closure = new Promise<SidecarByteStreamClosure>((resolve) => {
    resolveClosed = resolve;
  });
  const settle = (reason: string, cause?: Error) => {
    if (closed) return;
    closed = true;
    resolveClosed({ reason, ...(cause ? { cause } : {}) });
  };
  child.once("error", (error) => settle("child_error", error));
  child.once("close", () => settle("child_closed"));
  return {
    bytes: (async function* () {
      for await (const chunk of child.stdout) {
        yield new Uint8Array(Buffer.from(chunk));
      }
    })(),
    closed: closure,
    write: async (bytes, options) => {
      if (closed || !child.stdin.writable) {
        throw Object.assign(new Error("child_stdin_closed"), {
          delivery: "not_sent" as const,
        });
      }
      if (options?.signal?.aborted) {
        throw Object.assign(new Error("child_stdin_write_aborted"), {
          delivery: "not_sent" as const,
        });
      }
      await new Promise<void>((resolve, reject) => {
        child.stdin.write(Buffer.from(bytes), (error) => {
          if (error) {
            reject(
              Object.assign(error, {
                delivery: "sent_outcome_unknown" as const,
              }),
            );
          } else {
            resolve();
          }
        });
      });
    },
    close: async (reason) => {
      settle(reason);
      if (!child.stdin.destroyed) {
        await new Promise<void>((resolve) => child.stdin.end(resolve));
      }
    },
  };
}

function childExit(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("bundled_sidecar_test_timeout")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function stage<T>(
  name: string,
  promise: Promise<T>,
  stderr: readonly Buffer[],
): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (error instanceof Error) {
      const childDiagnostic = Buffer.concat(stderr).toString("utf8").trim();
      error.message =
        `bundled_sidecar_${name}_failed:${error.message};stderr=` +
        (childDiagnostic || "<empty>");
      throw error;
    }
    throw new Error(`bundled_sidecar_${name}_failed`);
  }
}

async function resolveSearchPrerequisites(): Promise<
  readonly TrustedSearchExecutableEvidence[] | undefined
> {
  const resolver = new TrustedSearchExecutableResolver();
  try {
    return await Promise.all([resolver.resolve("rg"), resolver.resolve("fd")]);
  } catch {
    return undefined;
  }
}

async function copySearchToolsIntoPiHome(
  homeDirectory: string,
  evidence: readonly TrustedSearchExecutableEvidence[],
): Promise<void> {
  const binDirectory = path.join(homeDirectory, ".pi", "agent", "bin");
  await mkdir(binDirectory, { recursive: true, mode: 0o755 });
  for (const executable of evidence) {
    const destination = piManagedSearchExecutablePath(
      executable.kind,
      homeDirectory,
    );
    await copyFile(executable.canonicalPath, destination);
    await chmod(destination, 0o755);
  }
}

function controlledSearchEvidence(
  kind: "fd" | "rg",
): TrustedSearchExecutableEvidence {
  return {
    kind,
    source: "pi_managed",
    executablePath: `/controlled/${kind}`,
    canonicalPath: `/controlled/${kind}`,
    version: kind === "fd" ? "10.3.0" : "15.2.0",
    device: 1,
    inode: kind === "fd" ? 1 : 2,
    size: 1,
    modifiedMilliseconds: 1,
    mode: 0o100755,
  };
}

function controlledSearchResolver(): TrustedSearchExecutableResolver {
  return {
    resolve: async (kind: "fd" | "rg") => controlledSearchEvidence(kind),
    revalidate: async () => undefined,
    spawn: async (
      evidence: TrustedSearchExecutableEvidence,
      _arguments: readonly string[],
      input: { readonly cwd: string; readonly environment: NodeJS.ProcessEnv },
    ) => {
      const output =
        evidence.kind === "fd"
          ? "process.stdout.write('note.txt\\0same-name.txt\\0')"
          : `process.stdout.write(JSON.stringify({type:'match',data:{path:{text:'same-name.txt'},line_number:1,lines:{text:'edited remotely\\n'},submatches:[{start:0}]}})+'\\n')`;
      return spawn(process.execPath, ["-e", output], {
        cwd: input.cwd,
        env: input.environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    },
  } as unknown as TrustedSearchExecutableResolver;
}

function operationContext(): SidecarOperationContext {
  return {
    requestId: randomUUID(),
    signal: new AbortController().signal,
  };
}
