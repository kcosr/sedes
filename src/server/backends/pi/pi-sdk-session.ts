import { mergeResolvedEnvironment, type ResolvedEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashToolDefinition,
  SettingsManager,
  stripFrontmatter,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type SessionManager,
  type Theme,
  type ToolDefinition,
  type ToolInfo,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import type {
  BackendCatalog,
  BackendModelDescriptor,
  InteractionResponseInput,
  Unsubscribe,
} from "../contracts.js";
import type {
  BackendConversationEvent,
  DriverInteraction,
} from "../../../shared/protocol/backend.js";
import type { UsageSnapshot } from "../../../shared/protocol/conversation.js";
import { boundText } from "../../conversations/payload-policy.js";
import type { ValidatedWorkspace } from "../../execution/contracts.js";
import { piThinkingLevels } from "./pi-thread-presentation-provider.js";
import { piCancellationStream } from "./pi-cancellation-stream.js";
import { assertNoPiAgentToolExtensionCollisions } from "./pi-agent-tool-adapter.js";
import type { PiAgentToolCliEnvironment } from "./pi-agent-tool-presentation.js";
import {
  assertAuditedPiBuiltinToolCatalog,
  PI_EXCLUDED_TOOL_NAMES,
} from "./pi-builtin-tool-policy.js";
import {
  PI_TOOL_APPROVAL_APPROVE_ACTION_ID,
  PI_TOOL_APPROVAL_APPROVE_LABEL,
  PI_TOOL_APPROVAL_DENY_ACTION_ID,
  PI_TOOL_APPROVAL_DENY_LABEL,
  PiToolAccessController,
} from "./pi-tool-access.js";
import {
  createPiToolApprovalExtension,
  PI_TOOL_APPROVAL_EXTENSION_PATH,
  type PiToolApprovalDecision,
  type PiAgentToolApprovalResolver,
  type PiAgentToolApprovalRecorder,
  type PiToolApprovalRequester,
} from "./pi-tool-approval-extension.js";
import {
  assertPiExecutorBuiltinDefinitionSet,
  createPiExecutorWorkspaceToolDefinitions,
  PI_EXECUTOR_BUILTIN_OVERRIDES,
  RemotePiResourceLoader,
  type PiExecutorWorkspaceServices,
} from "./pi-remote-workspace.js";

export interface PiSdkSession {
  readonly sessionId: string;
  readonly sessionName?: string;
  readonly isIdle: boolean;
  readonly model?: {
    readonly provider: string;
    readonly id: string;
    readonly input: readonly ("text" | "image")[];
  };
  readonly thinkingLevel: string;
  readonly sessionManager: SessionManager;
  readonly trustedBuiltinOverrides?: ReadonlySet<
    import("./pi-tool-identities.js").PiBuiltinToolKind
  >;
  readonly isolatedWorkspace?: boolean;

  ready(): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): Unsubscribe;
  prompt(
    text: string,
    options: {
      readonly source: "rpc";
      readonly preflightResult: (success: boolean) => void;
      readonly expandPromptTemplates?: boolean;
      readonly images?: readonly {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }[];
    },
  ): Promise<void>;
  steer(
    text: string,
    expandSkillCommand?: boolean,
    images?: readonly {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }[],
  ): Promise<void>;
  /**
   * Withdraw generation-volatile Pi steering and follow-up messages.
   *
   * This does not mutate Sedes's durable queued-input repository. Callers use
   * the returned native texts only as cleanup evidence; durable delivery
   * reconciliation remains keyed by the authenticated application operation.
   */
  clearQueue(): {
    readonly steering: readonly string[];
    readonly followUp: readonly string[];
  };
  abort(): Promise<void>;
  compact(instructions?: string): Promise<void>;
  setSessionName(title: string): void;
  setModel(model: unknown): Promise<void>;
  setThinkingLevel(level: string): void;
  getActiveToolNames(): string[];
  getAllTools(): ToolInfo[];
  setActiveToolsByName(names: string[]): void;
  getSessionStats(): ReturnType<AgentSession["getSessionStats"]>;
  availableModels(): Promise<readonly unknown[]>;
  providerDisplayName(providerId: string): string | undefined;
  catalog(): BackendCatalog;
  skillPrompt(
    selectedSkillId: string,
    text: string,
  ): Promise<{
    readonly text: string;
    readonly expandPromptTemplates: boolean;
  }>;
  dispose(): void;
}

export interface PiSdkSessionFactory {
  create(input: {
    readonly manager: SessionManager;
    readonly workspace: ValidatedWorkspace;
    readonly interactions: PiInteractionBridge;
    readonly toolAccess?: PiToolAccessController;
    readonly onResourcesChanged?: () => void;
    readonly customTools?: readonly ToolDefinition[];
    readonly protectedAgentToolNames?: ReadonlySet<string>;
    readonly resolveAgentToolApproval?: PiAgentToolApprovalResolver;
    readonly recordAgentToolApproval?: PiAgentToolApprovalRecorder;
    readonly executionEnvironment?: ResolvedEnvironmentVariables;
    readonly cliEnvironment?: PiAgentToolCliEnvironment;
    readonly remoteWorkspace?: PiExecutorWorkspaceServices;
    /** Strict local isolation over the same executor-backed workspace facade. */
    readonly isolatedWorkspace?: PiExecutorWorkspaceServices;
  }): Promise<PiSdkSession>;
}

export function createPiCliBashToolDefinition(
  cwd: string,
  environment: PiAgentToolCliEnvironment | undefined,
  operations?: BashOperations,
  executionEnvironment: ResolvedEnvironmentVariables = {},
): ToolDefinition {
  return createBashToolDefinition(cwd, {
    ...(operations ? { operations } : {}),
    spawnHook: ({ command, cwd: commandCwd, env }) => {
      const sanitizedEnvironment = { ...mergeResolvedEnvironment(env, executionEnvironment) };
      delete sanitizedEnvironment.SEDES_AGENT_TOOL_ENDPOINT;
      delete sanitizedEnvironment.SEDES_AGENT_TOOL_SOURCE_CAPABILITY;
      delete sanitizedEnvironment.SEDES_AGENT_TOOL_CLIENT_TOKEN;
      delete sanitizedEnvironment.SEDES_AGENT_TOOL_CLI_MODE;
      if (!environment) return { command, cwd: commandCwd, env: sanitizedEnvironment };
      return {
        command,
        cwd: commandCwd,
        env: {
          ...sanitizedEnvironment,
          SEDES_AGENT_TOOL_ENDPOINT: environment.SEDES_AGENT_TOOL_ENDPOINT,
          SEDES_AGENT_TOOL_SOURCE_CAPABILITY:
            environment.SEDES_AGENT_TOOL_SOURCE_CAPABILITY,
          SEDES_AGENT_TOOL_CLI_MODE: environment.SEDES_AGENT_TOOL_CLI_MODE,
          PATH: sanitizedEnvironment.PATH
            ? `${environment.executableDirectory}${path.delimiter}${sanitizedEnvironment.PATH}`
            : environment.executableDirectory,
        },
      };
    },
  }) as unknown as ToolDefinition;
}

export interface DefaultPiSdkSessionFactoryOptions {
  readonly agentDir?: string;
}

interface PendingInteraction {
  readonly interaction: DriverInteraction;
  readonly choices?: readonly string[];
  readonly decisions?: ReadonlyMap<string, PiToolApprovalDecision>;
  readonly cancelValue: unknown;
  readonly resolve: (value: unknown) => void;
}

export interface PiInteractionBridgeOptions {
  readonly cancelUnpublishedRequests?: boolean;
}

function headlessTheme(): Theme {
  return {
    fg: (_color: unknown, text: string) => text,
    bg: (_color: unknown, text: string) => text,
    bold: (text: string) => text,
    italic: (text: string) => text,
    underline: (text: string) => text,
    inverse: (text: string) => text,
    strikethrough: (text: string) => text,
    getFgAnsi: () => "",
    getBgAnsi: () => "",
    getColorMode: () => "truecolor",
    getThinkingBorderColor: () => (text: string) => text,
    getBashModeBorderColor: () => (text: string) => text,
  } as unknown as Theme;
}

function boundedDisplay(
  value: string,
  maximumBytes = 4_096,
): {
  readonly text: string;
} {
  return boundText(value, maximumBytes);
}

class PiSdkSessionFence {
  #active = true;

  assertActive(): void {
    if (!this.#active) {
      throw new Error("pi_sdk_session_fenced");
    }
  }

  invalidate(): boolean {
    if (!this.#active) return false;
    this.#active = false;
    return true;
  }
}

function fencedCustomTools(
  tools: readonly ToolDefinition<any, any, any>[],
  fence: PiSdkSessionFence,
): ToolDefinition[] {
  return tools.map((tool): ToolDefinition => ({
    ...tool,
    async execute(toolCallId, params, signal, onUpdate, context) {
      fence.assertActive();
      return tool.execute(toolCallId, params, signal, onUpdate, context);
    },
  }));
}

export class PiInteractionBridge {
  readonly #pending = new Map<string, PendingInteraction>();
  readonly #acceptedResponses = new Map<string, string>();
  readonly #queuedEvents: BackendConversationEvent[] = [];
  readonly #options: PiInteractionBridgeOptions;
  #publish?: (event: BackendConversationEvent) => void;
  #closed = false;

  constructor(options: PiInteractionBridgeOptions = {}) {
    this.#options = options;
  }

  setPublisher(publish: (event: BackendConversationEvent) => void): void {
    this.#publish = publish;
    for (const event of this.#queuedEvents.splice(0)) publish(event);
  }

  uiContext(): ExtensionUIContext {
    const theme = headlessTheme();
    return {
      select: (title, options, settings) =>
        this.#requestChoice(
          title,
          options,
          settings &&
            typeof settings === "object" &&
            "detail" in settings &&
            typeof (settings as { detail?: unknown }).detail === "string"
            ? (settings as { detail: string }).detail
            : undefined,
        ),
      confirm: (title, message) => this.#requestConfirmation(title, message),
      input: (title, placeholder) =>
        this.#requestText(title, "text_input", placeholder),
      editor: (title, prefill) => this.#requestText(title, "editor", prefill),
      notify: (message, type = "info") => {
        this.#publishEvent({
          type: "notice",
          notice: {
            id: `pi-notice:${randomUUID()}`,
            tone: type === "error" ? "error" : type,
            message: boundedDisplay(message, 500),
            createdAt: new Date().toISOString(),
          },
        });
      },
      onTerminalInput: () => () => undefined,
      setStatus: () => undefined,
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: () => undefined,
      custom: async () => undefined as never,
      pasteToEditor: () => undefined,
      setEditorText: () => undefined,
      getEditorText: () => "",
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      theme,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({
        success: false,
        error: "Theme switching is unavailable in the web runtime.",
      }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
    };
  }

  requestToolApproval: PiToolApprovalRequester = ({ title, detail }) => {
    const id = randomUUID();
    return this.#request(
      {
        backendInteractionId: id,
        kind: "decision",
        sourceLabel: { text: "Pi extension" },
        title: boundedDisplay(title),
        message: boundText(detail),
        openedAt: new Date().toISOString(),
        secret: false,
        destructive: true,
        cancellable: true,
        actions: [
          {
            backendActionId: PI_TOOL_APPROVAL_APPROVE_ACTION_ID,
            label: boundedDisplay(PI_TOOL_APPROVAL_APPROVE_LABEL),
            role: "primary",
          },
          {
            backendActionId: PI_TOOL_APPROVAL_DENY_ACTION_ID,
            label: boundedDisplay(PI_TOOL_APPROVAL_DENY_LABEL),
            role: "reject",
          },
        ],
      },
      undefined,
      undefined,
      new Map([
        [PI_TOOL_APPROVAL_APPROVE_ACTION_ID, "approve_once"],
        [PI_TOOL_APPROVAL_DENY_ACTION_ID, "deny"],
      ]),
    ) as Promise<PiToolApprovalDecision>;
  };

  respond(input: InteractionResponseInput): void {
    const fingerprint = JSON.stringify(input);
    const accepted = this.#acceptedResponses.get(input.applicationOperationId);
    if (accepted !== undefined) {
      if (accepted !== fingerprint) {
        throw new Error("pi_interaction_response_replay_mismatch");
      }
      return;
    }
    const pending = this.#pending.get(input.interactionId);
    if (!pending) throw new Error("pi_interaction_not_found");
    if (input.kind === "cancel") {
      this.#settle(pending, pending.cancelValue);
      this.#recordAcceptedResponse(input.applicationOperationId, fingerprint);
      return;
    }
    if (input.kind === "choice" && pending.interaction.kind === "choice") {
      if (input.selectedOptionIds.length !== 1) {
        throw new Error("pi_interaction_choice_invalid");
      }
      const selectedId = input.selectedOptionIds[0]!;
      const selectedIndex = pending.interaction.options.findIndex(
        (option) => option.backendOptionId === selectedId,
      );
      const value =
        selectedIndex >= 0 ? pending.choices?.[selectedIndex] : undefined;
      if (value === undefined) throw new Error("pi_interaction_choice_invalid");
      this.#settle(pending, value);
      this.#recordAcceptedResponse(input.applicationOperationId, fingerprint);
      return;
    }
    if (input.kind === "decision" && pending.interaction.kind === "decision") {
      const decision = pending.decisions?.get(input.selectedActionId);
      if (decision === undefined) {
        throw new Error("pi_interaction_decision_invalid");
      }
      this.#settle(pending, decision);
      this.#recordAcceptedResponse(input.applicationOperationId, fingerprint);
      return;
    }
    if (
      input.kind === "confirmation" &&
      pending.interaction.kind === "confirmation"
    ) {
      this.#settle(pending, input.confirmed);
      this.#recordAcceptedResponse(input.applicationOperationId, fingerprint);
      return;
    }
    if (
      (input.kind === "text_input" || input.kind === "editor") &&
      pending.interaction.kind === input.kind
    ) {
      this.#settle(pending, input.value);
      this.#recordAcceptedResponse(input.applicationOperationId, fingerprint);
      return;
    }
    throw new Error("pi_interaction_response_kind_invalid");
  }

  hasPending(backendInteractionId: string): boolean {
    return this.#pending.has(backendInteractionId);
  }

  cancelPending(): void {
    for (const pending of [...this.#pending.values()]) {
      this.#settle(pending, pending.cancelValue);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.cancelPending();
    this.#publish = undefined;
    this.#queuedEvents.length = 0;
    this.#acceptedResponses.clear();
  }

  #recordAcceptedResponse(
    applicationOperationId: string,
    fingerprint: string,
  ): void {
    this.#acceptedResponses.set(applicationOperationId, fingerprint);
    while (this.#acceptedResponses.size > 1_024) {
      const oldest = this.#acceptedResponses.keys().next().value;
      if (oldest === undefined) break;
      this.#acceptedResponses.delete(oldest);
    }
  }

  #requestChoice(
    title: string,
    choices: readonly string[],
    detail?: string,
  ): Promise<string | undefined> {
    if (choices.length === 0) return Promise.resolve(undefined);
    const limited = choices.slice(0, 64);
    const id = randomUUID();
    return this.#request(
      {
        backendInteractionId: id,
        kind: "choice",
        sourceLabel: { text: "Pi extension" },
        title: boundedDisplay(title),
        ...(detail !== undefined && detail.length > 0
          ? { message: boundText(detail) }
          : {}),
        openedAt: new Date().toISOString(),
        secret: false,
        // Extension choices may authorize side effects; treat as destructive
        // so the shared prompt surfaces the appropriate affordance.
        destructive: true,
        cancellable: true,
        multiple: false,
        options: limited.map((choice, index) => ({
          backendOptionId: String(index),
          label: boundedDisplay(choice),
        })),
      },
      undefined,
      limited,
    ) as Promise<string | undefined>;
  }

  #requestConfirmation(title: string, message: string): Promise<boolean> {
    return this.#request(
      {
        backendInteractionId: randomUUID(),
        kind: "confirmation",
        sourceLabel: { text: "Pi extension" },
        title: boundedDisplay(title),
        openedAt: new Date().toISOString(),
        secret: false,
        destructive: false,
        cancellable: true,
        message: boundText(message),
      },
      false,
    ) as Promise<boolean>;
  }

  #requestText(
    title: string,
    kind: "text_input" | "editor",
    initial?: string,
  ): Promise<string | undefined> {
    const base = {
      backendInteractionId: randomUUID(),
      sourceLabel: { text: "Pi extension" },
      title: boundedDisplay(title),
      openedAt: new Date().toISOString(),
      secret: false,
      destructive: false,
      cancellable: true,
    };
    const interaction: DriverInteraction =
      kind === "editor"
        ? {
            ...base,
            kind,
            ...(initial ? { initialValue: boundText(initial) } : {}),
          }
        : {
            ...base,
            kind,
            multiline: false,
            ...(initial ? { placeholder: boundedDisplay(initial) } : {}),
          };
    return this.#request(interaction, undefined) as Promise<string | undefined>;
  }

  #request(
    interaction: DriverInteraction,
    cancelValue: unknown,
    choices?: readonly string[],
    decisions?: ReadonlyMap<string, PiToolApprovalDecision>,
  ): Promise<unknown> {
    if (this.#closed) return Promise.resolve(cancelValue);
    if (!this.#publish && this.#options.cancelUnpublishedRequests) {
      return Promise.resolve(cancelValue);
    }
    return new Promise((resolve) => {
      const pending: PendingInteraction = {
        interaction,
        ...(choices ? { choices } : {}),
        ...(decisions ? { decisions } : {}),
        cancelValue,
        resolve,
      };
      this.#pending.set(interaction.backendInteractionId, pending);
      this.#publishEvent({ type: "interaction_opened", interaction });
    });
  }

  #settle(pending: PendingInteraction, value: unknown): void {
    this.#pending.delete(pending.interaction.backendInteractionId);
    pending.resolve(value);
    this.#publishEvent({
      type: "interaction_resolved",
      backendInteractionId: pending.interaction.backendInteractionId,
    });
  }

  #publishEvent(event: BackendConversationEvent): void {
    if (this.#publish) this.#publish(event);
    else this.#queuedEvents.push(event);
  }
}

class DefaultPiSdkSession implements PiSdkSession {
  readonly #session: AgentSession;
  readonly #extensions: LoadExtensionsResult;
  readonly #diagnosticNotices: readonly { readonly text: string }[];
  readonly #ready: Promise<void>;
  readonly #fence: PiSdkSessionFence;
  readonly #prePromptRefresh?: () => Promise<void>;
  readonly #remoteResourceLoader: RemotePiResourceLoader | undefined;
  readonly trustedBuiltinOverrides: ReadonlySet<
    import("./pi-tool-identities.js").PiBuiltinToolKind
  >;
  readonly isolatedWorkspace: boolean;

  constructor(
    session: AgentSession,
    extensions: LoadExtensionsResult,
    diagnosticNotices: readonly { readonly text: string }[] = [],
    ready: Promise<void> = Promise.resolve(),
    fence = new PiSdkSessionFence(),
    trustedBuiltinOverrides: ReadonlySet<
      import("./pi-tool-identities.js").PiBuiltinToolKind
    > = new Set(),
    prePromptRefresh?: () => Promise<void>,
    isolatedWorkspace = false,
    remoteResourceLoader?: RemotePiResourceLoader,
  ) {
    this.#session = session;
    this.#extensions = extensions;
    this.#diagnosticNotices = diagnosticNotices;
    this.#ready = ready;
    this.#fence = fence;
    this.trustedBuiltinOverrides = trustedBuiltinOverrides;
    this.#prePromptRefresh = prePromptRefresh;
    this.#remoteResourceLoader = remoteResourceLoader;
    this.isolatedWorkspace = isolatedWorkspace;
  }

  async ready(): Promise<void> {
    await this.#ready;
    this.#fence.assertActive();
  }

  get sessionId(): string {
    return this.#session.sessionId;
  }
  get sessionName(): string | undefined {
    return this.#session.sessionName;
  }
  get isIdle(): boolean {
    return this.#session.isIdle;
  }
  get model():
    | {
        readonly provider: string;
        readonly id: string;
        readonly input: readonly ("text" | "image")[];
      }
    | undefined {
    return this.#session.model;
  }
  get thinkingLevel(): string {
    return this.#session.thinkingLevel;
  }
  get sessionManager(): SessionManager {
    this.#fence.assertActive();
    return this.#session.sessionManager;
  }

  subscribe(listener: (event: AgentSessionEvent) => void): Unsubscribe {
    this.#fence.assertActive();
    return this.#session.subscribe(listener);
  }
  prompt(
    text: string,
    options: {
      readonly source: "rpc";
      readonly preflightResult: (success: boolean) => void;
      readonly expandPromptTemplates?: boolean;
      readonly images?: readonly {
        readonly type: "image";
        readonly data: string;
        readonly mimeType: string;
      }[];
    },
  ): Promise<void> {
    return this.#ready.then(async () => {
      this.#fence.assertActive();
      await this.#prePromptRefresh?.();
      this.#fence.assertActive();
      const { images, ...promptOptions } = options;
      return this.#session.prompt(text, {
        ...promptOptions,
        ...(images ? { images: [...images] } : {}),
      });
    });
  }
  steer(
    text: string,
    expandSkillCommand = false,
    images?: readonly {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    }[],
  ): Promise<void> {
    return this.#ready.then(() => {
      this.#fence.assertActive();
      return this.#session.prompt(text, {
        source: "rpc",
        streamingBehavior: "steer",
        expandPromptTemplates: expandSkillCommand,
        ...(images ? { images: [...images] } : {}),
      });
    });
  }
  clearQueue(): {
    readonly steering: readonly string[];
    readonly followUp: readonly string[];
  } {
    // Queue withdrawal is part of owner cleanup. Keep it available after the
    // execution fence closes, matching abort(), so retirement cannot let
    // already-admitted volatile input continue before disposal.
    return this.#session.clearQueue();
  }
  abort(): Promise<void> {
    // Keep this cleanup path available after the execution fence closes so an
    // owner can still drain a compromised session. Callers must withdraw the
    // native queue first when abort must not continue queued work.
    return this.#ready.then(() => this.#session.abort());
  }
  async compact(instructions?: string): Promise<void> {
    await this.#ready;
    this.#fence.assertActive();
    await this.#session.compact(instructions);
  }
  setSessionName(title: string): void {
    this.#fence.assertActive();
    this.#session.setSessionName(title);
  }
  setModel(model: unknown): Promise<void> {
    return this.#ready.then(() => {
      this.#fence.assertActive();
      return this.#session.setModel(
        model as Parameters<AgentSession["setModel"]>[0],
      );
    });
  }
  setThinkingLevel(level: string): void {
    this.#fence.assertActive();
    this.#session.setThinkingLevel(
      level as Parameters<AgentSession["setThinkingLevel"]>[0],
    );
  }
  getActiveToolNames(): string[] {
    this.#fence.assertActive();
    return this.#session.getActiveToolNames();
  }
  getAllTools(): ToolInfo[] {
    this.#fence.assertActive();
    return this.#session.getAllTools();
  }
  setActiveToolsByName(names: string[]): void {
    this.#fence.assertActive();
    this.#session.setActiveToolsByName(names);
  }
  getSessionStats(): ReturnType<AgentSession["getSessionStats"]> {
    this.#fence.assertActive();
    return this.#session.getSessionStats();
  }
  availableModels(): Promise<readonly unknown[]> {
    this.#fence.assertActive();
    return this.#session.modelRuntime.getAvailable();
  }
  providerDisplayName(providerId: string): string | undefined {
    this.#fence.assertActive();
    return this.#session.modelRuntime.getProvider(providerId)?.name;
  }
  catalog(): BackendCatalog {
    this.#fence.assertActive();
    const commands = this.#extensions.extensions.flatMap((extension) => [
      ...extension.commands.values(),
    ]);
    const counts = new Map<string, number>();
    for (const command of commands) {
      counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    const taken = new Set<string>();
    const extensionCommands = commands.map((command) => {
      const occurrence = (seen.get(command.name) ?? 0) + 1;
      seen.set(command.name, occurrence);
      let invocation =
        (counts.get(command.name) ?? 0) > 1
          ? `${command.name}:${occurrence}`
          : command.name;
      if (taken.has(invocation)) {
        let suffix = occurrence;
        do {
          suffix += 1;
          invocation = `${command.name}:${suffix}`;
        } while (taken.has(invocation));
      }
      taken.add(invocation);
      return {
        invocation: `/${invocation}`,
        source: "extension" as const,
        ...(command.description ? { description: command.description } : {}),
      };
    });
    const promptCommands = this.#session.promptTemplates.map((template) => ({
      invocation: `/${template.name}`,
      source: "prompt" as const,
      ...(template.description ? { description: template.description } : {}),
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
    }));
    const skills = this.#session.resourceLoader
      .getSkills()
      .skills.map((skill) => ({
        id: this.#skillId(skill.name, skill.filePath),
        name: skill.name,
        reference: `/skill:${skill.name}`,
        ...(skill.description ? { description: skill.description } : {}),
      }));
    return {
      models: [],
      commands: [...extensionCommands, ...promptCommands],
      skills,
      notices: [
        ...this.#diagnosticNotices,
        ...this.#extensions.errors.map((error) =>
          boundedDisplay(`Pi extension ${error.path}: ${error.error}`, 500),
        ),
      ],
    };
  }
  async skillPrompt(selectedSkillId: string, text: string) {
    this.#fence.assertActive();
    const skill = this.#session.resourceLoader
      .getSkills()
      .skills.find(
        (candidate) =>
          this.#skillId(candidate.name, candidate.filePath) === selectedSkillId,
      );
    if (!skill) throw new Error("pi_skill_unavailable");
    if (!this.#remoteResourceLoader) {
      return {
        text: `/skill:${skill.name}${text.trim().length > 0 ? ` ${text}` : ""}`,
        expandPromptTemplates: true,
      };
    }
    const resolved = await this.#remoteResourceLoader.resolveSkill(
      skill.filePath,
    );
    this.#fence.assertActive();
    const body = stripFrontmatter(resolved.content).trim();
    const skillBlock = `<skill name="${resolved.skill.name}" location="${resolved.skill.filePath}">\nReferences are relative to ${resolved.skill.baseDir}.\n\n${body}\n</skill>`;
    return {
      text: text.trim().length > 0 ? `${skillBlock}\n\n${text}` : skillBlock,
      expandPromptTemplates: false,
    };
  }
  #skillId(name: string, filePath: string): string {
    return piSkillId(
      name,
      filePath,
      this.#remoteResourceLoader?.skillContentSha256(filePath),
    );
  }
  dispose(): void {
    if (this.#fence.invalidate()) {
      this.#session.dispose();
    }
  }
}

function piSkillId(
  name: string,
  filePath: string,
  contentSha256?: string,
): string {
  const hash = createHash("sha256").update(name).update("\0").update(filePath);
  if (contentSha256) hash.update("\0").update(contentSha256);
  return `pi_skill_${hash.digest("base64url").slice(0, 40)}`;
}

export class DefaultPiSdkSessionFactory implements PiSdkSessionFactory {
  readonly #agentDir?: string;

  constructor(options: DefaultPiSdkSessionFactoryOptions = {}) {
    this.#agentDir = options.agentDir;
  }

  async create(input: {
    readonly manager: SessionManager;
    readonly workspace: ValidatedWorkspace;
    readonly interactions: PiInteractionBridge;
    readonly toolAccess?: PiToolAccessController;
    readonly onResourcesChanged?: () => void;
    readonly customTools?: readonly ToolDefinition[];
    readonly protectedAgentToolNames?: ReadonlySet<string>;
    readonly resolveAgentToolApproval?: PiAgentToolApprovalResolver;
    readonly recordAgentToolApproval?: PiAgentToolApprovalRecorder;
    readonly executionEnvironment?: ResolvedEnvironmentVariables;
    readonly cliEnvironment?: PiAgentToolCliEnvironment;
    readonly remoteWorkspace?: PiExecutorWorkspaceServices;
    readonly isolatedWorkspace?: PiExecutorWorkspaceServices;
  }): Promise<PiSdkSession> {
    if (input.remoteWorkspace && input.isolatedWorkspace) {
      throw new Error("pi_executor_workspace_ambiguous");
    }
    const executorWorkspace = input.isolatedWorkspace ?? input.remoteWorkspace;
    const strictIsolation = input.isolatedWorkspace !== undefined;
    if (executorWorkspace && input.cliEnvironment) {
      throw new Error("pi_remote_cli_tools_unsupported");
    }
    const settingsCwd =
      executorWorkspace?.serviceCwd ?? input.workspace.canonicalPath;
    const hostSettingsManager = SettingsManager.create(
      settingsCwd,
      this.#agentDir,
      {
        projectTrusted: executorWorkspace
          ? false
          : input.workspace.summary.trustState === "trusted",
      },
    );
    const settingsManager = executorWorkspace
      ? SettingsManager.inMemory(
          remotePiSettings(hostSettingsManager.getGlobalSettings()),
          { projectTrusted: false },
        )
      : hostSettingsManager;
    const toolAccess = input.toolAccess ?? new PiToolAccessController("full");
    const services = await createAgentSessionServices({
      cwd: settingsCwd,
      ...(this.#agentDir ? { agentDir: this.#agentDir } : {}),
      settingsManager,
      resourceLoaderOptions: {
        extensionFactories: [
          createPiToolApprovalExtension({
            toolAccess,
            workspacePath:
              executorWorkspace?.semanticCwd ?? input.workspace.canonicalPath,
            ...(executorWorkspace
              ? {
                  remoteEnvironmentLabel: executorWorkspace.environmentLabel,
                }
              : {}),
            requestApproval: input.interactions.requestToolApproval,
            protectedAgentToolNames: input.protectedAgentToolNames,
            resolveAgentToolApproval: input.resolveAgentToolApproval,
            recordAgentToolApproval: input.recordAgentToolApproval,
          }),
        ],
        ...(executorWorkspace
          ? {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
            }
          : {}),
      },
      resourceLoaderReloadOptions: {
        resolveProjectTrust: async () =>
          executorWorkspace
            ? false
            : input.workspace.summary.trustState === "trusted",
      },
    });
    let remoteResourceLoader: RemotePiResourceLoader | undefined;
    if (executorWorkspace) {
      remoteResourceLoader = new RemotePiResourceLoader({
        extensions: services.resourceLoader.getExtensions(),
        contextReader: executorWorkspace.contextReader,
        ...(executorWorkspace.skillReader
          ? { skillReader: executorWorkspace.skillReader }
          : {}),
        ...(this.#agentDir ? { agentDir: this.#agentDir } : {}),
        ...(strictIsolation
          ? {
              appendSystemPrompt: [
                piSandboxLayoutPrompt(executorWorkspace.sandboxWorkspaceAccess),
              ],
            }
          : {}),
      });
      services.resourceLoader = remoteResourceLoader;
      // Only after every cwd-bound local service has been replaced may Pi see
      // the semantic remote cwd used in its system prompt and tool metadata.
      services.cwd = executorWorkspace.semanticCwd;
      await remoteResourceLoader.refresh();
    }
    assertPiToolApprovalExtensionLoaded(
      services.resourceLoader.getExtensions(),
    );
    if (input.customTools) {
      assertNoPiAgentToolExtensionCollisions(
        services.resourceLoader.getExtensions().extensions,
      );
    }
    const fence = new PiSdkSessionFence();
    const remoteTools = executorWorkspace
      ? createPiExecutorWorkspaceToolDefinitions({
          ...executorWorkspace,
          executionEnvironment: input.executionEnvironment,
          autoResizeImages: settingsManager.getImageAutoResize(),
        })
      : [];
    if (executorWorkspace) {
      assertPiExecutorBuiltinDefinitionSet(remoteTools);
      if (
        input.customTools?.some((tool) =>
          PI_EXECUTOR_BUILTIN_OVERRIDES.has(
            tool.name as import("./pi-tool-identities.js").PiBuiltinToolKind,
          ),
        )
      ) {
        throw new Error("pi_remote_builtin_definition_collision");
      }
    }
    const sessionTools = [
      ...remoteTools,
      ...(!executorWorkspace && (input.cliEnvironment || Object.keys(input.executionEnvironment ?? {}).length > 0)
        ? [
            createPiCliBashToolDefinition(
              input.workspace.canonicalPath,
              input.cliEnvironment,
              undefined,
              input.executionEnvironment,
            ),
          ]
        : []),
      ...(input.customTools ?? []),
    ];
    const result = await createAgentSessionFromServices({
      services,
      sessionManager: input.manager,
      excludeTools: [...PI_EXCLUDED_TOOL_NAMES],
      ...(sessionTools.length > 0
        ? { customTools: fencedCustomTools(sessionTools, fence) }
        : {}),
    });
    result.session.agent.streamFunction = piCancellationStream(
      result.session.agent.streamFunction,
    );
    const trustedBuiltinOverrides = new Set<
      import("./pi-tool-identities.js").PiBuiltinToolKind
    >([
      ...(executorWorkspace ? PI_EXECUTOR_BUILTIN_OVERRIDES : []),
      ...(!executorWorkspace && (input.cliEnvironment || Object.keys(input.executionEnvironment ?? {}).length > 0) ? (["bash"] as const) : []),
    ]);
    try {
      assertPiToolApprovalExtensionLoaded(result.extensionsResult);
      assertAuditedPiBuiltinToolCatalog(
        result.session.getAllTools(),
        trustedBuiltinOverrides,
      );
    } catch (error) {
      if (fence.invalidate()) result.session.dispose();
      throw error;
    }
    const ready = result.session
      .bindExtensions({
        mode: "rpc",
        uiContext: input.interactions.uiContext(),
        abortHandler: () => {
          input.interactions.cancelPending();
          result.session.clearQueue();
          void result.session.abort();
        },
        shutdownHandler: async () => undefined,
        commandContextActions: {
          waitForIdle: () => result.session.waitForIdle(),
          newSession: async () => ({ cancelled: true }),
          fork: async () => ({ cancelled: true }),
          navigateTree: async () => ({ cancelled: true }),
          switchSession: async () => ({ cancelled: true }),
          reload: async () => {
            try {
              fence.assertActive();
              await result.session.reload();
              assertPiToolApprovalExtensionLoaded(
                services.resourceLoader.getExtensions(),
              );
              if (input.customTools) {
                assertNoPiAgentToolExtensionCollisions(
                  services.resourceLoader.getExtensions().extensions,
                );
              }
              assertAuditedPiBuiltinToolCatalog(
                result.session.getAllTools(),
                trustedBuiltinOverrides,
              );
            } catch (error) {
              if (fence.invalidate()) {
                result.session.dispose();
              }
              throw error;
            } finally {
              input.onResourcesChanged?.();
            }
          },
        },
      })
      .catch((error: unknown) => {
        if (fence.invalidate()) {
          result.session.dispose();
        }
        throw error;
      });
    return new DefaultPiSdkSession(
      result.session,
      result.extensionsResult,
      services.diagnostics.map(({ type, message }) =>
        boundedDisplay(`Pi ${type}: ${message}`, 500),
      ),
      ready,
      fence,
      trustedBuiltinOverrides,
      remoteResourceLoader
        ? async () => {
            try {
              if (!(await remoteResourceLoader.prepareSessionReload())) return;
              await result.session.reload();
              assertPiToolApprovalExtensionLoaded(
                services.resourceLoader.getExtensions(),
              );
              assertAuditedPiBuiltinToolCatalog(
                result.session.getAllTools(),
                trustedBuiltinOverrides,
              );
            } catch (error) {
              if (fence.invalidate()) result.session.dispose();
              throw error;
            }
          }
        : undefined,
      strictIsolation,
      remoteResourceLoader,
    );
  }
}

function piSandboxLayoutPrompt(
  access: PiExecutorWorkspaceServices["sandboxWorkspaceAccess"],
): string {
  if (access !== "read_write" && access !== "read_only") {
    throw new Error("pi_sandbox_workspace_access_missing");
  }
  const workspaceRule =
    access === "read_only"
      ? "The project workspace is mounted read-only. Do not attempt to modify it; create patches, notes, copied experiments, build output, and other files elsewhere under /home/agent."
      : "The project workspace is a writable isolated clone; make project changes there.";
  return `You are running inside an isolated workspace. Your initial working directory and writable home are /home/agent. The project is available at /home/agent/workspace (relative path: workspace). ${workspaceRule} Relative file and Bash operations start from /home/agent; absolute paths inside the sandbox are also available.`;
}

type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;

function remotePiSettings(settings: PiSettings): Partial<PiSettings> {
  return {
    ...(settings.defaultProvider === undefined
      ? {}
      : { defaultProvider: settings.defaultProvider }),
    ...(settings.defaultModel === undefined
      ? {}
      : { defaultModel: settings.defaultModel }),
    ...(settings.defaultThinkingLevel === undefined
      ? {}
      : { defaultThinkingLevel: settings.defaultThinkingLevel }),
    ...(settings.transport === undefined
      ? {}
      : { transport: settings.transport }),
    ...(settings.cacheWarming === undefined
      ? {}
      : { cacheWarming: settings.cacheWarming }),
    ...(settings.compaction === undefined
      ? {}
      : { compaction: settings.compaction }),
    ...(settings.branchSummary === undefined
      ? {}
      : { branchSummary: settings.branchSummary }),
    ...(settings.retry === undefined ? {} : { retry: settings.retry }),
    ...(settings.images === undefined ? {} : { images: settings.images }),
    ...(settings.enabledModels === undefined
      ? {}
      : { enabledModels: settings.enabledModels }),
    ...(settings.thinkingBudgets === undefined
      ? {}
      : { thinkingBudgets: settings.thinkingBudgets }),
    ...(settings.httpIdleTimeoutMs === undefined
      ? {}
      : { httpIdleTimeoutMs: settings.httpIdleTimeoutMs }),
    ...(settings.websocketConnectTimeoutMs === undefined
      ? {}
      : { websocketConnectTimeoutMs: settings.websocketConnectTimeoutMs }),
  };
}

/**
 * Fail closed when the managed approval extension is missing. In ask mode the
 * catalog still includes mutators; without this hook there is no gate.
 */
export function assertPiToolApprovalExtensionLoaded(result: {
  readonly extensions: readonly { readonly path: string }[];
  readonly errors?: readonly {
    readonly path: string;
    readonly error: string;
  }[];
}): void {
  const errors = result.errors ?? [];
  const loadError = errors.find(
    (error) =>
      error.path === PI_TOOL_APPROVAL_EXTENSION_PATH ||
      error.path.includes("sedes-tool-approval"),
  );
  if (loadError) {
    throw new Error(`pi_tool_approval_extension_failed: ${loadError.error}`);
  }
  const loaded = result.extensions.some(
    (extension) => extension.path === PI_TOOL_APPROVAL_EXTENSION_PATH,
  );
  if (!loaded) {
    throw new Error("pi_tool_approval_extension_missing");
  }
}

export function piUsage(session: PiSdkSession): UsageSnapshot {
  const stats = session.getSessionStats();
  // Pi aggregates billed usage across all entries, including inactive branches
  // and compacted history. Match that scope when counting known extra requests.
  // Arbitrary extension usage can aggregate several calls; its cardinality is
  // unknown, so do not present a made-up request total in that case.
  const usageEntries = session.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "usage");
  const requests = usageEntries.every((entry) => entry.kind === "cache_warm")
    ? stats.assistantMessages + usageEntries.length
    : undefined;
  return {
    ...(stats.contextUsage
      ? {
          context: {
            ...(stats.contextUsage.tokens === null
              ? {}
              : { usedTokens: stats.contextUsage.tokens }),
            windowTokens: stats.contextUsage.contextWindow,
            ...(stats.contextUsage.percent === null
              ? {}
              : { percent: stats.contextUsage.percent }),
          },
        }
      : {}),
    tokens: { ...stats.tokens },
    cost: { amount: Math.max(0, stats.cost), currency: "USD" },
    counters: {
      ...(requests === undefined ? {} : { requests }),
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      toolResults: stats.toolResults,
      totalMessages: stats.totalMessages,
      compactions: session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "compaction").length,
    },
  };
}

/**
 * Thinking levels a Pi model supports, mirroring `getSupportedThinkingLevels`
 * from the Pi SDK's model registry (pi-coding-agent 0.83): non-reasoning
 * models accept only "off"; reasoning models accept every canonical level
 * except ones the model's `thinkingLevelMap` explicitly maps to null, with
 * "xhigh"/"max" additionally requiring an explicit mapping. Kept private to
 * the Pi backend because the level namespace and the map are Pi-native.
 */
export function piSupportedThinkingLevels(model: {
  readonly reasoning?: unknown;
  readonly thinkingLevelMap?: unknown;
}): readonly string[] {
  if (model.reasoning !== true) return ["off"];
  const map =
    typeof model.thinkingLevelMap === "object" &&
    model.thinkingLevelMap !== null
      ? (model.thinkingLevelMap as Readonly<Record<string, unknown>>)
      : {};
  return piThinkingLevels.filter((level) => {
    if (map[level] === null) return false;
    if (level === "xhigh" || level === "max") return map[level] !== undefined;
    return true;
  });
}

export async function piModels(
  session: PiSdkSession,
): Promise<readonly BackendModelDescriptor[]> {
  const models = (await session.availableModels()) as ReadonlyArray<{
    provider?: unknown;
    id?: unknown;
    name?: unknown;
    reasoning?: unknown;
    thinkingLevelMap?: unknown;
    input?: unknown;
  }>;
  return models.flatMap((model) =>
    typeof model.provider === "string" && typeof model.id === "string"
      ? [
          {
            provider: model.provider,
            id: model.id,
            label: piModelDisplayLabel(
              model.provider,
              typeof model.name === "string" && model.name
                ? model.name
                : model.id,
              session.providerDisplayName(model.provider),
            ),
            inputModalities:
              Array.isArray(model.input) && model.input.includes("image")
                ? ["text", "image"]
                : ["text"],
            supportedReasoningEfforts: piSupportedThinkingLevels(model),
          },
        ]
      : [],
  );
}

function piModelDisplayLabel(
  providerId: string,
  modelLabel: string,
  runtimeProviderName: string | undefined,
): string {
  const trimmedRuntimeName = runtimeProviderName?.trim();
  const providerLabel =
    trimmedRuntimeName && trimmedRuntimeName !== providerId
      ? trimmedRuntimeName
      : `${providerId.charAt(0).toUpperCase()}${providerId.slice(1)}`;
  return `${providerLabel} / ${modelLabel}`;
}
