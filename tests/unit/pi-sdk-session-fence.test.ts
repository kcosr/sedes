import type {
  AgentSession,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";

const sdk = vi.hoisted(() => ({
  createAgentSessionFromServices: vi.fn(),
  createAgentSessionServices: vi.fn(),
  createSettingsManager: vi.fn(),
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  return {
    ...original,
    createAgentSessionFromServices: sdk.createAgentSessionFromServices,
    createAgentSessionServices: sdk.createAgentSessionServices,
    SettingsManager: {
      create: sdk.createSettingsManager,
      inMemory: original.SettingsManager.inMemory,
    },
  };
});

import {
  assertPiToolApprovalExtensionLoaded,
  DefaultPiSdkSessionFactory,
  PiInteractionBridge,
} from "../../src/server/backends/pi/pi-sdk-session.js";
import { PI_EXECUTOR_BUILTIN_TOOL_NAMES } from "../../src/server/backends/pi/pi-remote-workspace.js";
import { PI_TOOL_APPROVAL_EXTENSION_PATH } from "../../src/server/backends/pi/pi-tool-approval-extension.js";
import { WorkspaceSkillReaderError } from "../../src/server/workspace-skills/contracts.js";

const workspace = {
  canonicalPath: "/workspace",
  summary: { trustState: "trusted" },
} as ValidatedWorkspace;

/** Shape required by fail-closed arming of the managed approval extension. */
function approvalExtensionEntry() {
  return {
    path: PI_TOOL_APPROVAL_EXTENSION_PATH,
    commands: new Map<string, unknown>(),
    tools: new Map<string, unknown>(),
  };
}

describe("Pi SDK session reload fence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects CLI tools in strict isolation", async () => {
    const isolatedWorkspace = {
      semanticCwd: "/home/agent",
      serviceCwd: "/private/isolation/home",
      sandboxWorkspaceAccess: "read_write" as const,
      executor: {} as never,
      contextReader: {} as never,
      environmentLabel: "Isolated",
    };
    const factory = new DefaultPiSdkSessionFactory();
    await expect(
      factory.create({
        manager: {} as SessionManager,
        workspace,
        interactions: new PiInteractionBridge(),
        isolatedWorkspace,
        cliEnvironment: {
          SEDES_AGENT_TOOL_ENDPOINT: "http://127.0.0.1:4784",
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY: "capability",
          SEDES_AGENT_TOOL_CLI_MODE: "individual",
          executableDirectory: "/opt/sedes/bin",
        },
      }),
    ).rejects.toThrow("pi_remote_cli_tools_unsupported");
    expect(sdk.createAgentSessionServices).not.toHaveBeenCalled();
    expect(sdk.createAgentSessionFromServices).not.toHaveBeenCalled();
  });

  it("combines isolated workspace builtins with scoped Sedes native tools", async () => {
    const customTool = {
      name: "sedes_agent_context",
      label: "Sedes agent context",
      description: "Read the current Sedes source context.",
      parameters: {},
      execute: vi.fn(async () => ({ content: [], details: undefined })),
    } as unknown as ToolDefinition;
    const executor = {
      read: vi.fn(async () => ({
        path: "README.md",
        contentKind: "text" as const,
        content: "sandboxed",
        sizeBytes: 9,
        startLine: 1,
        outputLines: 1,
        totalLines: 1,
      })),
      write: vi.fn(),
      edit: vi.fn(),
      list: vi.fn(),
      find: vi.fn(),
      grep: vi.fn(),
      startShell: vi.fn(),
    };
    const isolatedWorkspace = {
      semanticCwd: "/home/agent",
      serviceCwd: "/private/isolation/home",
      sandboxWorkspaceAccess: "read_only" as const,
      executor,
      contextReader: {
        read: vi.fn(async () => ({ files: [], fingerprint: "empty" })),
      },
      environmentLabel: "Isolated",
    };
    const services = {
      cwd: isolatedWorkspace.serviceCwd,
      diagnostics: [],
      resourceLoader: {
        getExtensions: () => ({
          extensions: [approvalExtensionEntry()],
          errors: [] as { path: string; error: string }[],
        }),
      },
    };
    let retainedTools: ToolDefinition[] = [];
    let excludedTools: readonly string[] | undefined;
    const session = {
      agent: { streamFunction: vi.fn() },
      sessionId: "pi-isolated-session",
      sessionName: undefined,
      isIdle: true,
      model: undefined,
      thinkingLevel: "low",
      sessionManager: {},
      bindExtensions: vi.fn(async () => undefined),
      getAllTools: () =>
        retainedTools.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
          promptGuidelines: [],
          sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
        })),
    } as unknown as AgentSession;
    sdk.createSettingsManager.mockReturnValue({
      getGlobalSettings: () => ({}),
    });
    sdk.createAgentSessionServices.mockResolvedValue(services);
    let appendSystemPrompt: readonly string[] = [];
    sdk.createAgentSessionFromServices.mockImplementation(
      async (input: {
        customTools?: ToolDefinition[];
        excludeTools?: string[];
        services: { resourceLoader: { getAppendSystemPrompt: () => string[] } };
      }) => {
        retainedTools = input.customTools ?? [];
        excludedTools = input.excludeTools;
        appendSystemPrompt =
          input.services.resourceLoader.getAppendSystemPrompt();
        return {
          extensionsResult: {
            extensions: [approvalExtensionEntry()],
            errors: [],
          },
          session,
        };
      },
    );

    const wrapped = await new DefaultPiSdkSessionFactory().create({
      manager: {} as SessionManager,
      workspace,
      interactions: new PiInteractionBridge(),
      isolatedWorkspace,
      customTools: [customTool],
    });
    await wrapped.ready();

    expect(retainedTools.map(({ name }) => name)).toEqual([
      ...PI_EXECUTOR_BUILTIN_TOOL_NAMES,
      "sedes_agent_context",
    ]);
    expect(excludedTools).toEqual(["powershell"]);
    expect([...wrapped.trustedBuiltinOverrides!]).toEqual(
      PI_EXECUTOR_BUILTIN_TOOL_NAMES,
    );
    expect(appendSystemPrompt).toEqual([
      expect.stringContaining(
        "initial working directory and writable home are /home/agent",
      ),
    ]);
    expect(appendSystemPrompt[0]).toContain(
      "project workspace is mounted read-only",
    );
    expect(appendSystemPrompt[0]).toContain(
      "project is available at /home/agent/workspace (relative path: workspace)",
    );
    const readTool = retainedTools.find(({ name }) => name === "read");
    expect(readTool).toBeDefined();
    await readTool!.execute(
      "sandbox-read",
      { path: "README.md" },
      undefined,
      undefined,
      {} as never,
    );
    expect(executor.read).toHaveBeenCalledWith({
      path: "README.md",
      signal: undefined,
    });
    expect(customTool.execute).not.toHaveBeenCalled();
  });

  it("fences retained session operations and custom tools before disposing a colliding reload", async () => {
    // Keep the managed approval extension loaded so fail-closed arming passes;
    // reload then injects a sedes_* collision for the fence path under test.
    const loadedExtensions: {
      path?: string;
      tools: Map<string, unknown>;
    }[] = [approvalExtensionEntry()];
    let reloadAction: (() => Promise<void>) | undefined;
    let retainedTool: ToolDefinition | undefined;
    let executionDuringDispose: Promise<unknown> | undefined;
    const originalExecute = vi.fn(async () => {
      throw new Error("unfenced custom tool execution");
    });
    const customTool = {
      name: "sedes_execution_context",
      label: "Sedes execution context",
      description: "A test-only Sedes tool.",
      parameters: {},
      execute: originalExecute,
    } as unknown as ToolDefinition;
    const prompt = vi.fn(async () => undefined);
    const clearQueue = vi.fn(() => ({ steering: [], followUp: [] }));
    const abort = vi.fn(async () => undefined);
    const reload = vi.fn(async () => {
      loadedExtensions.push({
        tools: new Map([["sedes_extension_collision", {}]]),
      });
    });
    const dispose = vi.fn(() => {
      executionDuringDispose = retainedTool?.execute(
        "call-during-dispose",
        {},
        undefined,
        undefined,
        {} as never,
      );
    });
    const session = {
      agent: { streamFunction: vi.fn() },
      sessionId: "pi-session",
      sessionName: undefined,
      isIdle: true,
      model: undefined,
      thinkingLevel: "low",
      sessionManager: {},
      bindExtensions: vi.fn(
        async (options: {
          commandContextActions: { reload: () => Promise<void> };
        }) => {
          reloadAction = options.commandContextActions.reload;
        },
      ),
      prompt,
      clearQueue,
      abort,
      reload,
      dispose,
      getAllTools: () =>
        retainedTool
          ? [
              {
                name: retainedTool.name,
                sourceInfo: {
                  source: "sdk",
                  path: `<sdk:${retainedTool.name}>`,
                },
              },
            ]
          : [],
    } as unknown as AgentSession;
    const services = {
      diagnostics: [],
      resourceLoader: {
        getExtensions: () => ({
          extensions: loadedExtensions,
          errors: [] as { path: string; error: string }[],
        }),
      },
    };
    sdk.createSettingsManager.mockReturnValue({});
    sdk.createAgentSessionServices.mockResolvedValue(services);
    sdk.createAgentSessionFromServices.mockImplementation(
      async (input: { customTools?: ToolDefinition[] }) => {
        retainedTool = input.customTools?.[0];
        return {
          extensionsResult: {
            errors: [],
            extensions: [approvalExtensionEntry()],
          },
          session,
        };
      },
    );

    const resourcesChanged = vi.fn();
    const wrappedSession = await new DefaultPiSdkSessionFactory().create({
      manager: {} as SessionManager,
      workspace,
      interactions: new PiInteractionBridge(),
      onResourcesChanged: resourcesChanged,
      customTools: [customTool],
    });
    await wrappedSession.ready();
    expect(reloadAction).toBeDefined();
    expect(retainedTool).not.toBe(customTool);

    await expect(reloadAction!()).rejects.toThrow(
      "pi_agent_tool_reserved_name_collision",
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(resourcesChanged).toHaveBeenCalledOnce();
    await expect(executionDuringDispose).rejects.toThrow(
      "pi_sdk_session_fenced",
    );
    expect(originalExecute).not.toHaveBeenCalled();

    await expect(
      wrappedSession.prompt("must not run", {
        source: "rpc",
        preflightResult: vi.fn(),
      }),
    ).rejects.toThrow("pi_sdk_session_fenced");
    expect(prompt).not.toHaveBeenCalled();
    expect(wrappedSession.clearQueue()).toEqual({
      steering: [],
      followUp: [],
    });
    expect(clearQueue).toHaveBeenCalledOnce();
    await expect(wrappedSession.abort()).resolves.toBeUndefined();
    expect(abort).toHaveBeenCalledOnce();
    await expect(
      retainedTool!.execute(
        "retained-call",
        {},
        undefined,
        undefined,
        {} as never,
      ),
    ).rejects.toThrow("pi_sdk_session_fenced");
    expect(originalExecute).not.toHaveBeenCalled();

    await expect(reloadAction!()).rejects.toThrow("pi_sdk_session_fenced");
    expect(reload).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("cancels pending interactions and clears queued input before the extension abort handler aborts Pi", async () => {
    let abortHandler: (() => void) | undefined;
    let pendingApproval!: Promise<"approve_once" | "deny" | undefined>;
    const order: string[] = [];
    const clearQueue = vi.fn(() => {
      order.push("clear_queue");
      return { steering: ["queued steer"], followUp: [] };
    });
    const abort = vi.fn(async () => {
      order.push("abort");
      await pendingApproval;
    });
    const session = {
      agent: { streamFunction: vi.fn() },
      sessionId: "pi-session",
      sessionName: undefined,
      isIdle: false,
      model: undefined,
      thinkingLevel: "low",
      sessionManager: {},
      bindExtensions: vi.fn(async (options: { abortHandler: () => void }) => {
        abortHandler = options.abortHandler;
      }),
      getAllTools: () => [],
      clearQueue,
      abort,
    } as unknown as AgentSession;
    const services = {
      diagnostics: [],
      resourceLoader: {
        getExtensions: () => ({
          extensions: [approvalExtensionEntry()],
          errors: [] as { path: string; error: string }[],
        }),
      },
    };
    sdk.createSettingsManager.mockReturnValue({});
    sdk.createAgentSessionServices.mockResolvedValue(services);
    sdk.createAgentSessionFromServices.mockResolvedValue({
      extensionsResult: {
        extensions: [approvalExtensionEntry()],
        errors: [],
      },
      session,
    });
    const interactions = new PiInteractionBridge();
    const publish = vi.fn();
    interactions.setPublisher(publish);
    const wrappedSession = await new DefaultPiSdkSessionFactory().create({
      manager: {} as SessionManager,
      workspace,
      interactions,
    });
    await wrappedSession.ready();
    pendingApproval = interactions.requestToolApproval({
      title: "Pi tool approval",
      detail: "bash: long-running-command",
    });

    abortHandler!();

    await expect(pendingApproval).resolves.toBeUndefined();
    expect(clearQueue).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(abort).toHaveBeenCalledOnce());
    expect(order).toEqual(["clear_queue", "abort"]);
    publish.mockClear();
    const laterApproval = interactions.requestToolApproval({
      title: "Pi tool approval",
      detail: "bash: later-command",
    });
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: "interaction_opened" }),
    );
    interactions.cancelPending();
    await expect(laterApproval).resolves.toBeUndefined();
    interactions.close();
  });

  it("excludes PowerShell without closing the SDK catalog and rejects an unreviewed built-in at construction", async () => {
    const dispose = vi.fn();
    const session = {
      agent: { streamFunction: vi.fn() },
      getAllTools: () => [
        {
          name: "future_tool",
          sourceInfo: {
            source: "builtin",
            path: "<builtin:future_tool>",
          },
        },
      ],
      dispose,
    } as unknown as AgentSession;
    sdk.createSettingsManager.mockReturnValue({});
    sdk.createAgentSessionServices.mockResolvedValue({
      diagnostics: [],
      resourceLoader: {
        getExtensions: () => ({
          extensions: [approvalExtensionEntry()],
          errors: [],
        }),
      },
    });
    sdk.createAgentSessionFromServices.mockResolvedValue({
      extensionsResult: {
        extensions: [approvalExtensionEntry()],
        errors: [],
      },
      session,
    });

    await expect(
      new DefaultPiSdkSessionFactory().create({
        manager: {} as SessionManager,
        workspace,
        interactions: new PiInteractionBridge(),
      }),
    ).rejects.toThrow("pi_builtin_tool_disposition_missing");
    expect(sdk.createAgentSessionFromServices).toHaveBeenCalledWith(
      expect.objectContaining({ excludeTools: ["powershell"] }),
    );
    expect(
      sdk.createAgentSessionFromServices.mock.calls[0]?.[0],
    ).not.toHaveProperty("tools");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("re-audits the built-in catalog after an extension reload", async () => {
    let reloadAction: (() => Promise<void>) | undefined;
    let reloaded = false;
    const dispose = vi.fn();
    const session = {
      agent: { streamFunction: vi.fn() },
      sessionId: "pi-session",
      sessionName: undefined,
      isIdle: true,
      model: undefined,
      thinkingLevel: "low",
      sessionManager: {},
      bindExtensions: vi.fn(
        async (options: {
          commandContextActions: { reload: () => Promise<void> };
        }) => {
          reloadAction = options.commandContextActions.reload;
        },
      ),
      reload: vi.fn(async () => {
        reloaded = true;
      }),
      getAllTools: () =>
        reloaded
          ? [
              {
                name: "future_tool",
                sourceInfo: {
                  source: "builtin",
                  path: "<builtin:future_tool>",
                },
              },
            ]
          : [],
      dispose,
    } as unknown as AgentSession;
    const services = {
      diagnostics: [],
      resourceLoader: {
        getExtensions: () => ({
          extensions: [approvalExtensionEntry()],
          errors: [] as { path: string; error: string }[],
        }),
      },
    };
    sdk.createSettingsManager.mockReturnValue({});
    sdk.createAgentSessionServices.mockResolvedValue(services);
    sdk.createAgentSessionFromServices.mockResolvedValue({
      extensionsResult: {
        extensions: [approvalExtensionEntry()],
        errors: [],
      },
      session,
    });

    const wrapped = await new DefaultPiSdkSessionFactory().create({
      manager: {} as SessionManager,
      workspace,
      interactions: new PiInteractionBridge(),
    });
    await wrapped.ready();

    await expect(reloadAction!()).rejects.toThrow(
      "pi_builtin_tool_disposition_missing",
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("omits trims-to-empty text from a resolved skill prompt", async () => {
    const skill = {
      name: "review",
      filePath: "/private/pi/skills/review/SKILL.md",
    };
    const session = {
      agent: { streamFunction: vi.fn() },
      sessionId: "pi-session",
      sessionName: undefined,
      isIdle: true,
      model: undefined,
      thinkingLevel: "low",
      sessionManager: {},
      promptTemplates: [],
      resourceLoader: {
        getSkills: () => ({ skills: [skill] }),
      },
      bindExtensions: vi.fn(async () => undefined),
      getAllTools: () => [],
    } as unknown as AgentSession;
    const services = {
      diagnostics: [],
      resourceLoader: {
        getExtensions: () => ({
          extensions: [approvalExtensionEntry()],
          errors: [] as { path: string; error: string }[],
        }),
      },
    };
    sdk.createSettingsManager.mockReturnValue({});
    sdk.createAgentSessionServices.mockResolvedValue(services);
    sdk.createAgentSessionFromServices.mockResolvedValue({
      extensionsResult: {
        extensions: [approvalExtensionEntry()],
        errors: [],
      },
      session,
    });

    const wrappedSession = await new DefaultPiSdkSessionFactory().create({
      manager: {} as SessionManager,
      workspace,
      interactions: new PiInteractionBridge(),
    });
    const selectedSkill = wrappedSession.catalog().skills[0];
    expect(selectedSkill).toBeDefined();

    await expect(
      wrappedSession.skillPrompt(selectedSkill!.id, " \n "),
    ).resolves.toEqual({
      text: "/skill:review",
      expandPromptTemplates: true,
    });
    await expect(
      wrappedSession.skillPrompt(selectedSkill!.id, "  inspect  "),
    ).resolves.toEqual({
      text: "/skill:review   inspect  ",
      expandPromptTemplates: true,
    });
  });

  it("resolves a remote skill body and constructs Pi's exact envelope", async () => {
    const content = `---\nname: review\ndescription: Review carefully\n---\nUse the checklist.`;
    const metadata = {
      id: "a".repeat(64),
      name: "review",
      description: "Review carefully",
      source: "account_pi" as const,
      filePath: "/home/remote/.pi/agent/skills/review/SKILL.md",
      baseDir: "/home/remote/.pi/agent/skills/review",
      contentSha256: "b".repeat(64),
      sizeBytes: Buffer.byteLength(content),
      disableModelInvocation: false,
    };
    const changedContent = `---\nname: review\ndescription: Review carefully\n---\nUse the updated checklist.`;
    const changedMetadata = {
      ...metadata,
      contentSha256: "d".repeat(64),
      sizeBytes: Buffer.byteLength(changedContent),
    };
    const skillReader = {
      readCatalog: vi
        .fn()
        .mockResolvedValueOnce({
          skills: [metadata],
          diagnostics: [],
          catalogFingerprint: "c".repeat(64),
        })
        .mockResolvedValueOnce({
          skills: [changedMetadata],
          diagnostics: [],
          catalogFingerprint: "e".repeat(64),
        }),
      resolve: vi
        .fn()
        .mockResolvedValueOnce({ skill: metadata, content })
        .mockRejectedValueOnce(
          new WorkspaceSkillReaderError(
            "workspace_skills_catalog_changed",
            false,
          ),
        )
        .mockResolvedValueOnce({
          skill: changedMetadata,
          content: changedContent,
        }),
    };
    const remoteWorkspace = {
      semanticCwd: "/home/remote/project",
      serviceCwd: "/private/remote-services",
      executor: {
        read: vi.fn(),
        write: vi.fn(),
        edit: vi.fn(),
        list: vi.fn(),
        find: vi.fn(),
        grep: vi.fn(),
        startShell: vi.fn(),
      },
      contextReader: {
        read: vi.fn(async () => ({ files: [], fingerprint: "context" })),
      },
      skillReader,
      environmentLabel: "Remote Pi",
    };
    const services = {
      cwd: remoteWorkspace.serviceCwd,
      diagnostics: [],
      resourceLoader: {
        getExtensions: () => ({
          extensions: [approvalExtensionEntry()],
          errors: [] as { path: string; error: string }[],
        }),
      },
    };
    let retainedTools: ToolDefinition[] = [];
    let session!: AgentSession;
    sdk.createSettingsManager.mockReturnValue({
      getGlobalSettings: () => ({}),
    });
    sdk.createAgentSessionServices.mockResolvedValue(services);
    sdk.createAgentSessionFromServices.mockImplementation(
      async (input: {
        customTools?: ToolDefinition[];
        services: { resourceLoader: AgentSession["resourceLoader"] };
      }) => {
        retainedTools = input.customTools ?? [];
        session = {
          agent: { streamFunction: vi.fn() },
          sessionId: "pi-remote-session",
          sessionName: undefined,
          isIdle: true,
          model: undefined,
          thinkingLevel: "low",
          sessionManager: {},
          promptTemplates: [],
          resourceLoader: input.services.resourceLoader,
          bindExtensions: vi.fn(async () => undefined),
          getAllTools: () =>
            retainedTools.map(({ name, description, parameters }) => ({
              name,
              description,
              parameters,
              promptGuidelines: [],
              sourceInfo: { source: "sdk", path: `<sdk:${name}>` },
            })),
          reload: vi.fn(async () => undefined),
        } as unknown as AgentSession;
        return {
          extensionsResult: {
            extensions: [approvalExtensionEntry()],
            errors: [],
          },
          session,
        };
      },
    );

    const wrapped = await new DefaultPiSdkSessionFactory().create({
      manager: {} as SessionManager,
      workspace,
      interactions: new PiInteractionBridge(),
      remoteWorkspace,
    });
    const selected = wrapped.catalog().skills[0];
    expect(selected).toBeDefined();

    await expect(
      wrapped.skillPrompt(selected!.id, "Check the API."),
    ).resolves.toEqual({
      text: `<skill name="review" location="/home/remote/.pi/agent/skills/review/SKILL.md">\nReferences are relative to /home/remote/.pi/agent/skills/review.\n\nUse the checklist.\n</skill>\n\nCheck the API.`,
      expandPromptTemplates: false,
    });
    expect(skillReader.resolve).toHaveBeenCalledWith({
      catalogFingerprint: "c".repeat(64),
      id: metadata.id,
    });

    await expect(wrapped.skillPrompt(selected!.id, "Retry.")).rejects.toThrow(
      "workspace_skills_catalog_changed",
    );
    const changedSelection = wrapped.catalog().skills[0];
    expect(changedSelection).toBeDefined();
    expect(changedSelection!.id).not.toBe(selected!.id);
    await expect(wrapped.skillPrompt(selected!.id, "Retry.")).rejects.toThrow(
      "pi_skill_unavailable",
    );
    await expect(
      wrapped.skillPrompt(changedSelection!.id, "Retry."),
    ).resolves.toEqual({
      text: `<skill name="review" location="/home/remote/.pi/agent/skills/review/SKILL.md">\nReferences are relative to /home/remote/.pi/agent/skills/review.\n\nUse the updated checklist.\n</skill>\n\nRetry.`,
      expandPromptTemplates: false,
    });
    expect(skillReader.resolve).toHaveBeenLastCalledWith({
      catalogFingerprint: "e".repeat(64),
      id: changedMetadata.id,
    });
  });
});

describe("assertPiToolApprovalExtensionLoaded", () => {
  it("accepts a loaded approval extension with empty errors", () => {
    expect(() =>
      assertPiToolApprovalExtensionLoaded({
        extensions: [{ path: PI_TOOL_APPROVAL_EXTENSION_PATH }],
        errors: [],
      }),
    ).not.toThrow();
  });

  it("treats missing errors as empty", () => {
    expect(() =>
      assertPiToolApprovalExtensionLoaded({
        extensions: [{ path: PI_TOOL_APPROVAL_EXTENSION_PATH }],
      }),
    ).not.toThrow();
  });

  it("fails closed when the approval extension is missing", () => {
    expect(() =>
      assertPiToolApprovalExtensionLoaded({
        extensions: [{ path: "<inline:other>" }],
        errors: [],
      }),
    ).toThrow("pi_tool_approval_extension_missing");
  });

  it("fails closed when the approval extension failed to load", () => {
    expect(() =>
      assertPiToolApprovalExtensionLoaded({
        extensions: [],
        errors: [
          {
            path: PI_TOOL_APPROVAL_EXTENSION_PATH,
            error: "factory threw",
          },
        ],
      }),
    ).toThrow("pi_tool_approval_extension_failed: factory threw");
  });

  it("detects approval load errors by path substring", () => {
    expect(() =>
      assertPiToolApprovalExtensionLoaded({
        extensions: [],
        errors: [
          {
            path: "/tmp/sedes-tool-approval.js",
            error: "syntax error",
          },
        ],
      }),
    ).toThrow("pi_tool_approval_extension_failed: syntax error");
  });
});
