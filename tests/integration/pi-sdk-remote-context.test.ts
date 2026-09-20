import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentSession,
  getDocsPath,
  getExamplesPath,
  getReadmePath,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DefaultPiSdkSessionFactory,
  PiInteractionBridge,
  type PiSdkSession,
} from "../../src/server/backends/pi/pi-sdk-session.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import type { WorkspaceToolExecutor } from "../../src/server/workspace-tools/contracts.js";

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Pi SDK remote workspace context", () => {
  it.each([
    { name: "matching workspace metadata", differentInputCwd: false },
    { name: "different input cwd values", differentInputCwd: true },
  ])(
    "keeps remote context through reload and the model/tool loop with $name",
    async ({ differentInputCwd }) => {
      const root = await mkdtemp(path.join(tmpdir(), "pi-remote-context-"));
      roots.push(root);
      const agentDir = path.join(root, "agent");
      const serviceCwd = path.join(root, "local-daemon-services");
      const semanticCwd = path.join(root, "remote-only", "operator");
      await Promise.all([mkdir(agentDir), mkdir(serviceCwd)]);
      await Promise.all([
        writeFile(path.join(serviceCwd, "AGENTS.md"), "LOCAL_PROJECT_SENTINEL"),
        writeFile(path.join(agentDir, "AGENTS.md"), "HOST_GLOBAL_SENTINEL"),
      ]);
      await expect(access(semanticCwd)).rejects.toThrow();
      const contextReader = {
        read: vi.fn(async () => ({
          fingerprint: "remote-context-1",
          files: [
            {
              policyRelativePath: "AGENTS.md",
              content: "REMOTE_PROJECT_SENTINEL",
              sizeBytes: 23,
              sha256: "context-1",
            },
          ],
        })),
      };
      const read = vi.fn(async () => ({
        path: "README.md",
        contentKind: "text" as const,
        content: "REMOTE_READ_SENTINEL",
        sizeBytes: 20,
        startLine: 1,
        outputLines: 1,
        totalLines: 1,
      }));
      const executor: WorkspaceToolExecutor = {
        read,
        write: vi.fn(),
        edit: vi.fn(),
        list: vi.fn(),
        find: vi.fn(),
        grep: vi.fn(),
        startShell: vi.fn(),
      };
      // Observe the native session without replacing any SDK implementation.
      const bindExtensions = vi.spyOn(AgentSession.prototype, "bindExtensions");
      let session: PiSdkSession | undefined;
      try {
        session = await new DefaultPiSdkSessionFactory({ agentDir }).create({
          manager: SessionManager.inMemory(
            differentInputCwd ? serviceCwd : semanticCwd,
          ),
          workspace: {
            canonicalPath: differentInputCwd ? serviceCwd : semanticCwd,
            summary: { trustState: "trusted" },
          } as ValidatedWorkspace,
          interactions: new PiInteractionBridge(),
          remoteWorkspace: {
            semanticCwd,
            serviceCwd,
            contextReader,
            executor,
            environmentLabel: "Remote SSH",
          },
        });
        await session.ready();
        const nativeSession = bindExtensions.mock.instances[0]! as AgentSession;
        const assertRemoteContext = () => {
          expect(nativeSession.systemPrompt).toContain(
            `<cwd>\n${semanticCwd}\n</cwd>`,
          );
          expect(nativeSession.systemPrompt).not.toContain(serviceCwd);
          expect(nativeSession.systemPrompt).not.toContain(
            "LOCAL_PROJECT_SENTINEL",
          );
          expect(nativeSession.systemPrompt).toContain(
            "REMOTE_PROJECT_SENTINEL",
          );
          expect(nativeSession.systemPrompt).toContain("HOST_GLOBAL_SENTINEL");
          expect(nativeSession.sessionManager.getCwd()).toBe(
            differentInputCwd ? serviceCwd : semanticCwd,
          );
        };
        assertRemoteContext();

        const readTool = nativeSession.agent.state.tools.find(
          (tool) => tool.name === "read",
        )!;
        const result = await readTool.execute("remote-read", {
          path: "README.md",
        });
        expect(result.content).toEqual([
          { type: "text", text: "REMOTE_READ_SENTINEL" },
        ]);
        expect(read).toHaveBeenCalledWith(
          expect.objectContaining({ path: "README.md" }),
        );

        await nativeSession.reload();
        assertRemoteContext();
        expect(contextReader.read).toHaveBeenCalledTimes(2);

        // Exercise prompt preflight, extension/context hooks, the real agent loop,
        // and the SDK stream function. Only the provider stream is replaced.
        const model = nativeSession.modelRuntime.getModels()[0]!;
        expect(model).toBeDefined();
        nativeSession.agent.state.model = model;
        vi.spyOn(
          nativeSession.modelRuntime,
          "hasConfiguredAuth",
        ).mockReturnValue(true);
        type ProviderContext = Parameters<
          typeof nativeSession.modelRuntime.streamSimple
        >[1];
        type ProviderMessage = Awaited<
          ReturnType<typeof nativeSession.modelRuntime.completeSimple>
        >;
        const outbound: ProviderContext[] = [];
        vi.spyOn(nativeSession.modelRuntime, "streamSimple").mockImplementation(
          (_model, context) => {
            outbound.push(structuredClone(context));
            const firstRequest = outbound.length === 1;
            const message: ProviderMessage = {
              role: "assistant",
              content: firstRequest
                ? [
                    {
                      type: "toolCall",
                      id: "model-read",
                      name: "read",
                      arguments: { path: "README.md" },
                    },
                  ]
                : [{ type: "text", text: "Remote read complete." }],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
              stopReason: firstRequest ? "toolUse" : "stop",
              timestamp: Date.now(),
            };
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: "done", reason: message.stopReason, message };
              },
              result: async () => message,
            } as unknown as ReturnType<
              typeof nativeSession.modelRuntime.streamSimple
            >;
          },
        );
        const preflightResult = vi.fn();
        await session.prompt("Read README.md from the current workspace.", {
          source: "rpc",
          preflightResult,
        });
        expect(preflightResult).toHaveBeenCalledWith(true);
        expect(nativeSession.agent.state.errorMessage).toBeUndefined();
        expect(outbound).toHaveLength(2);
        for (const context of outbound) {
          const systemPrompt = getCurrentSystemPrompt(context.messages);
          expect(
            getCurrentTools(context.messages).map(({ name }) => name),
          ).toContain("read");
          expect(systemPrompt).toContain(`<cwd>\n${semanticCwd}\n</cwd>`);
          expect(systemPrompt).not.toContain(`<cwd>\n${process.cwd()}\n</cwd>`);
          expect(systemPrompt).not.toContain(serviceCwd);
          expect(JSON.stringify(context)).not.toContain(
            "LOCAL_PROJECT_SENTINEL",
          );
          expect(systemPrompt).toContain("REMOTE_PROJECT_SENTINEL");
          // The stock SDK separately advertises its host installation paths.
          // Those local documentation paths are not the tool execution cwd.
          const documentationPaths = [
            getReadmePath(),
            getDocsPath(),
            getExamplesPath(),
          ];
          const documentationLines = systemPrompt
            .split("\n")
            .filter((line) =>
              documentationPaths.some((localPath) => line.includes(localPath)),
            );
          expect(documentationLines).toEqual([
            `- Main documentation: ${getReadmePath()}`,
            `- Additional docs: ${getDocsPath()}`,
            `- Examples: ${getExamplesPath()} (extensions, custom tools, SDK)`,
          ]);
        }
        expect(JSON.stringify(outbound[1]!.messages)).toContain(
          "REMOTE_READ_SENTINEL",
        );
        expect(read).toHaveBeenCalledTimes(2);
        await expect(access(semanticCwd)).rejects.toThrow();
      } finally {
        session?.dispose();
      }
    },
  );
});
