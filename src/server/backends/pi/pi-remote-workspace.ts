import type { ResolvedEnvironmentVariables } from "../../environment-variables/runtime-environment.js";
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createSyntheticSourceInfo,
  createWriteToolDefinition,
  truncateTail,
  type AgentToolResult,
  type LoadExtensionsResult,
  type ResourceLoader,
  type ResourceDiagnostic,
  type Skill,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
  WorkspaceToolError,
  WorkspaceToolOutcomeUnknownError,
  type WorkspaceToolExecutor,
} from "../../workspace-tools/contracts.js";
import type {
  WorkspaceContextReader,
  WorkspaceContextSnapshot,
} from "../../workspace-context/contracts.js";
import type {
  ResolvedWorkspaceSkill,
  WorkspaceSkillCatalog,
  WorkspaceSkillReader,
} from "../../workspace-skills/contracts.js";
import { WorkspaceSkillReaderError } from "../../workspace-skills/contracts.js";
import {
  assertAuditedPiBuiltinToolCatalog,
  PI_SUPPORTED_BUILTIN_TOOL_NAMES,
  type PiBuiltinToolKind,
} from "./pi-builtin-tool-policy.js";
import { processRemotePiImage } from "./pi-remote-image-processing.js";

const HOST_GLOBAL_CONTEXT_FILENAMES = Object.freeze([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const);
const HOST_GLOBAL_CONTEXT_MAXIMUM_BYTES = 64 * 1024;
const REMOTE_BASH_MAXIMUM_TIMEOUT_MILLISECONDS = 600_000;

export const PI_REMOTE_BUILTIN_TOOL_NAMES = PI_SUPPORTED_BUILTIN_TOOL_NAMES;

export const PI_REMOTE_BUILTIN_OVERRIDES: ReadonlySet<PiBuiltinToolKind> =
  new Set(PI_REMOTE_BUILTIN_TOOL_NAMES);

/** Executor-backed names are shared by SSH and local isolated workspaces. */
export const PI_EXECUTOR_BUILTIN_TOOL_NAMES = PI_REMOTE_BUILTIN_TOOL_NAMES;
export const PI_EXECUTOR_BUILTIN_OVERRIDES = PI_REMOTE_BUILTIN_OVERRIDES;

export type RemotePiWorkspaceContextReader = WorkspaceContextReader;

export interface RemotePiWorkspaceServices {
  readonly executionEnvironment?: ResolvedEnvironmentVariables;
  /** Remote semantic cwd. It is display and executor metadata, never local I/O. */
  readonly semanticCwd: string;
  /** Dedicated main-host directory used only for SDK service construction. */
  readonly serviceCwd: string;
  readonly executor: WorkspaceToolExecutor;
  readonly contextReader: RemotePiWorkspaceContextReader;
  /** Optional remote Agent Skills catalog and exact-body resolver. */
  readonly skillReader?: WorkspaceSkillReader;
  readonly environmentLabel: string;
  /** Present only for local Bubblewrap workspaces. */
  readonly sandboxWorkspaceAccess?: "read_write" | "read_only";
  /** Effective Pi settings value; omitted preserves Pi's pinned true default. */
  readonly autoResizeImages?: boolean;
}

export type PiExecutorWorkspaceServices = RemotePiWorkspaceServices;

/**
 * Data-only Pi resource view for remote workspaces. The delegate is used only
 * for the closed Sedes extension runtime created at construction. Reloads do
 * not invoke it, so host project/package/extension discovery cannot re-enter.
 */
export class RemotePiResourceLoader implements ResourceLoader {
  readonly #extensions: LoadExtensionsResult;
  readonly #contextReader: RemotePiWorkspaceContextReader;
  readonly #skillReader: WorkspaceSkillReader | undefined;
  readonly #agentDir: string | undefined;
  readonly #appendSystemPrompt: readonly string[];
  #snapshot: WorkspaceContextSnapshot = { files: [], fingerprint: "" };
  #hostGlobal:
    | {
        readonly name: string;
        readonly content: string;
        readonly sha256: string;
      }
    | undefined;
  #fingerprint = "";
  #skills: Skill[] = [];
  #skillDiagnostics: ResourceDiagnostic[] = [];
  #skillCatalog: WorkspaceSkillCatalog = {
    skills: [],
    diagnostics: [],
    catalogFingerprint: "",
  };
  #skipNextReload = false;

  constructor(input: {
    readonly extensions: LoadExtensionsResult;
    readonly contextReader: RemotePiWorkspaceContextReader;
    readonly skillReader?: WorkspaceSkillReader;
    readonly agentDir?: string;
    readonly appendSystemPrompt?: readonly string[];
  }) {
    this.#extensions = input.extensions;
    this.#contextReader = input.contextReader;
    this.#skillReader = input.skillReader;
    this.#agentDir = input.agentDir;
    this.#appendSystemPrompt = input.appendSystemPrompt ?? [];
  }

  get fingerprint(): string {
    return this.#fingerprint;
  }

  getExtensions(): LoadExtensionsResult {
    return this.#extensions;
  }
  getSkills() {
    return { skills: this.#skills, diagnostics: this.#skillDiagnostics };
  }
  getPrompts() {
    return { prompts: [], diagnostics: [] };
  }
  getThemes() {
    return { themes: [], diagnostics: [] };
  }
  getAgentsFiles() {
    return {
      agentsFiles: [
        ...(this.#hostGlobal
          ? [
              {
                path: `host-global:/${this.#hostGlobal.name}`,
                content: this.#hostGlobal.content,
              },
            ]
          : []),
        ...this.#snapshot.files.map((file) => ({
          path: `remote-workspace:/${file.policyRelativePath}`,
          content: file.content,
        })),
      ],
    };
  }
  getSystemPrompt(): string | undefined {
    return undefined;
  }
  getSystemPromptSource(): undefined {
    return undefined;
  }
  getAppendSystemPrompt(): string[] {
    return [...this.#appendSystemPrompt];
  }
  getAppendSystemPromptSources(): [] {
    return [];
  }
  extendResources(): void {
    // Remote executable and project resources are intentionally unsupported.
  }
  async reload(): Promise<void> {
    if (this.#skipNextReload) {
      this.#skipNextReload = false;
      return;
    }
    await this.refresh();
  }

  async prepareSessionReload(): Promise<boolean> {
    const changed = await this.refresh();
    if (changed) this.#skipNextReload = true;
    return changed;
  }

  async refresh(): Promise<boolean> {
    const [next, hostGlobal, skillCatalogResult] = await Promise.all([
      this.#contextReader.read(),
      readHostGlobalContext(this.#agentDir),
      this.#readSkillCatalogForRefresh(),
    ]);
    const { catalog: skillCatalog, status: skillCatalogStatus } =
      skillCatalogResult;
    const fingerprint = createHash("sha256")
      .update(hostGlobal?.name ?? "")
      .update("\0")
      .update(hostGlobal?.sha256 ?? "")
      .update("\0")
      .update(next.fingerprint)
      .update("\0")
      .update(skillCatalog.catalogFingerprint)
      .update("\0")
      .update(skillCatalogStatus)
      .digest("hex");
    if (fingerprint === this.fingerprint) return false;
    this.#snapshot = next;
    this.#hostGlobal = hostGlobal;
    this.#applySkillCatalog(skillCatalog, skillCatalogStatus);
    this.#fingerprint = fingerprint;
    return true;
  }

  async resolveSkill(filePath: string): Promise<ResolvedWorkspaceSkill> {
    if (!this.#skillReader) throw new Error("pi_remote_skill_unavailable");
    const skill = this.#skillCatalog.skills.find(
      (candidate) => candidate.filePath === filePath,
    );
    if (!skill) throw new Error("pi_remote_skill_unavailable");
    try {
      return await this.#skillReader.resolve({
        catalogFingerprint: this.#skillCatalog.catalogFingerprint,
        id: skill.id,
      });
    } catch (error) {
      if (
        error instanceof WorkspaceSkillReaderError &&
        error.code === "workspace_skills_catalog_changed"
      ) {
        await this.#repairSkillCatalogAfterDrift();
      }
      throw error;
    }
  }

  skillContentSha256(filePath: string): string {
    const skill = this.#skillCatalog.skills.find(
      (candidate) => candidate.filePath === filePath,
    );
    if (!skill) throw new Error("pi_remote_skill_unavailable");
    return skill.contentSha256;
  }

  async #readSkillCatalogForRefresh(): Promise<{
    readonly catalog: WorkspaceSkillCatalog;
    readonly status: "available" | "unavailable" | "disabled";
  }> {
    if (!this.#skillReader) {
      return { catalog: this.#skillCatalog, status: "disabled" };
    }
    try {
      return {
        catalog: await this.#skillReader.readCatalog(),
        status: "available",
      };
    } catch {
      return { catalog: this.#skillCatalog, status: "unavailable" };
    }
  }

  #applySkillCatalog(
    skillCatalog: WorkspaceSkillCatalog,
    status: "available" | "unavailable" | "disabled",
  ): void {
    this.#skillCatalog = skillCatalog;
    this.#skills = skillCatalog.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      sourceInfo: createSyntheticSourceInfo(skill.filePath, {
        source: `remote_${skill.source}`,
        scope: skill.source.startsWith("account_") ? "user" : "project",
        baseDir: skill.baseDir,
      }),
      disableModelInvocation: skill.disableModelInvocation,
    }));
    this.#skillDiagnostics = skillCatalog.diagnostics.map((diagnostic) => ({
      type: diagnostic.code === "name_collision" ? "collision" : "warning",
      message: diagnostic.code,
      path: diagnostic.filePath,
      ...(diagnostic.code === "name_collision" &&
      diagnostic.name &&
      diagnostic.winnerId
        ? {
            collision: {
              resourceType: "skill" as const,
              name: diagnostic.name,
              winnerPath:
                skillCatalog.skills.find(
                  (skill) => skill.id === diagnostic.winnerId,
                )?.filePath ?? "remote-skill-winner-unavailable",
              loserPath: diagnostic.filePath,
            },
          }
        : {}),
    }));
    if (status === "unavailable") {
      this.#skillDiagnostics.push({
        type: "warning",
        message: "pi_remote_skill_catalog_unavailable",
      });
    }
  }

  async #repairSkillCatalogAfterDrift(): Promise<void> {
    if (!this.#skillReader) return;
    try {
      this.#applySkillCatalog(
        await this.#skillReader.readCatalog(),
        "available",
      );
      this.#fingerprint = "";
    } catch {
      // Preserve the last complete catalog and the original drift failure.
    }
  }
}

async function readHostGlobalContext(
  agentDir: string | undefined,
  retryUnstable = true,
): Promise<
  | { readonly name: string; readonly content: string; readonly sha256: string }
  | undefined
> {
  if (!agentDir) return undefined;
  for (const name of HOST_GLOBAL_CONTEXT_FILENAMES) {
    const candidate = path.join(agentDir, name);
    const entry = await lstat(candidate, { bigint: true }).catch(
      () => undefined,
    );
    if (!entry) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const handle = await open(
      candidate,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    ).catch((error: unknown) => {
      throw new Error("pi_remote_host_context_invalid", { cause: error });
    });
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        before.size > BigInt(HOST_GLOBAL_CONTEXT_MAXIMUM_BYTES)
      ) {
        throw new Error("pi_remote_host_context_invalid");
      }
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const current = await lstat(candidate, { bigint: true }).catch(
        () => undefined,
      );
      if (
        offset !== bytes.byteLength ||
        !sameFileIdentity(before, after) ||
        !current ||
        !sameFileIdentity(after, current)
      ) {
        if (retryUnstable) return await readHostGlobalContext(agentDir, false);
        throw new Error("pi_remote_host_context_unstable");
      }
      return {
        name,
        content: bytes.toString("utf8"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  }
  return undefined;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function assertCompletePiRemoteBuiltinOverrides(
  tools: readonly Pick<ToolInfo, "name" | "sourceInfo">[],
): void {
  assertAuditedPiBuiltinToolCatalog(tools, PI_REMOTE_BUILTIN_OVERRIDES);
}

export const assertCompletePiExecutorBuiltinOverrides =
  assertCompletePiRemoteBuiltinOverrides;

export function assertPiRemoteBuiltinDefinitionSet(
  definitions: readonly Pick<ToolDefinition, "name">[],
): void {
  const names = definitions.map(({ name }) => name);
  if (
    names.length !== PI_REMOTE_BUILTIN_TOOL_NAMES.length ||
    new Set(names).size !== PI_REMOTE_BUILTIN_TOOL_NAMES.length ||
    PI_REMOTE_BUILTIN_TOOL_NAMES.some((name) => !names.includes(name))
  ) {
    throw new Error("pi_remote_builtin_definition_set_invalid");
  }
}

export const assertPiExecutorBuiltinDefinitionSet =
  assertPiRemoteBuiltinDefinitionSet;

function toolResult<Details>(
  text: string,
  details: Details,
): AgentToolResult<Details> {
  return {
    content: [{ type: "text" as const, text }],
    details,
  };
}

function grepLine(match: {
  readonly path: string;
  readonly line: number;
  readonly lineText: string;
  readonly isMatch: boolean;
}): string {
  const separator = match.isMatch ? ":" : "-";
  return `${match.path}${separator}${match.line}${separator} ${match.lineText}`;
}

async function remoteCall<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof WorkspaceToolOutcomeUnknownError ||
      (error instanceof WorkspaceToolError &&
        error.code === "workspace_tools_outcome_unknown") ||
      (typeof error === "object" &&
        error !== null &&
        "diagnosticCode" in error &&
        error.diagnosticCode === "workspace_tools_shell_outcome_unknown")
    ) {
      throw new Error(
        "Remote operation outcome is unknown. Sedes will not replay it automatically.",
        { cause: error },
      );
    }
    throw error;
  }
}

function formatRemoteReadText(
  result: Extract<
    Awaited<ReturnType<WorkspaceToolExecutor["read"]>>,
    { contentKind: "text" }
  >,
  requestedPath: string,
): string {
  const truncation = result.truncation;
  if (!truncation) return result.content;
  if (truncation.firstLineBytes !== undefined) {
    return `[Line ${result.startLine} is ${formatBytes(truncation.firstLineBytes)}, exceeds 50.0KB limit. Use bash: sed -n '${result.startLine}p' ${requestedPath} | head -c 51200]`;
  }
  const endLine = result.startLine + result.outputLines - 1;
  if (truncation.reason === "requested_limit") {
    const remaining = Math.max(0, result.totalLines - endLine);
    return `${result.content}\n\n[${remaining} more lines in file. Use offset=${truncation.nextOffset} to continue.]`;
  }
  const bound = truncation.reason === "byte_limit" ? " (50.0KB limit)" : "";
  return `${result.content}\n\n[Showing lines ${result.startLine}-${endLine} of ${result.totalLines}${bound}. Use offset=${truncation.nextOffset} to continue.]`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  return `${(bytes / 1_024).toFixed(1)}KB`;
}

/** Complete execute replacements. No Pi operations hook or local path helper runs. */
export function createPiRemoteWorkspaceToolDefinitions(
  remote: RemotePiWorkspaceServices,
) {
  const read = createReadToolDefinition(remote.semanticCwd);
  const write = createWriteToolDefinition(remote.semanticCwd);
  const edit = createEditToolDefinition(remote.semanticCwd);
  const ls = createLsToolDefinition(remote.semanticCwd);
  const find = createFindToolDefinition(remote.semanticCwd);
  const grep = createGrepToolDefinition(remote.semanticCwd);
  const bash = createBashToolDefinition(remote.semanticCwd, {
    exposeSessionEnvironment: false,
  });
  const remoteRead: typeof read = {
    ...read,
    async execute(_id, input, signal, _onUpdate, context) {
      const result = await remoteCall(() =>
        remote.executor.read({
          path: input.path,
          ...(input.offset === undefined ? {} : { offset: input.offset }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          signal,
        }),
      );
      if (result.contentKind === "image") {
        const processed = await processRemotePiImage(result, {
          autoResizeImages: remote.autoResizeImages ?? true,
        });
        const nonVisionNote =
          context?.model && !context.model.input.includes("image")
            ? "[Current model does not support images. The image will be omitted from this request.]"
            : undefined;
        if (!processed.ok || !processed.data || !processed.mimeType) {
          const notes = [
            `Read image file [${result.mediaType}]`,
            processed.message ?? "[Image omitted: processing failed.]",
            nonVisionNote,
          ].filter((value): value is string => Boolean(value));
          return {
            content: [{ type: "text" as const, text: notes.join("\n") }],
            details: undefined,
          };
        }
        const notes = [
          `Read image file [${processed.mimeType}]`,
          ...(processed.hints ?? []),
          nonVisionNote,
        ].filter((value): value is string => Boolean(value));
        return {
          content: [
            { type: "text" as const, text: notes.join("\n") },
            {
              type: "image" as const,
              data: processed.data,
              mimeType: processed.mimeType,
            },
          ],
          details: undefined,
        };
      }
      return toolResult(formatRemoteReadText(result, input.path), undefined);
    },
  };
  const remoteWrite: typeof write = {
    ...write,
    async execute(_toolCallId, input, signal) {
      await remoteCall(() =>
        remote.executor.write({
          path: input.path,
          content: input.content,
          signal,
        }),
      );
      return toolResult(
        `Successfully wrote ${input.content.length} bytes to ${input.path}`,
        undefined,
      );
    },
  };
  const remoteEdit: typeof edit = {
    ...edit,
    async execute(_toolCallId, input, signal) {
      const result = await remoteCall(() =>
        remote.executor.edit({
          path: input.path,
          edits: input.edits,
          signal,
        }),
      );
      return toolResult(
        `Successfully replaced ${result.replacements} block(s) in ${input.path}.`,
        {
          diff: result.diff,
          patch: result.patch,
          ...(result.firstChangedLine === undefined
            ? {}
            : { firstChangedLine: result.firstChangedLine }),
        },
      );
    },
    // Pi's edit renderer probes the path locally to prepare a preview.
    renderCall: undefined,
    renderResult: undefined,
  };
  const remoteLs: typeof ls = {
    ...ls,
    async execute(_id, input, signal) {
      const result = await remoteCall(() =>
        remote.executor.list({
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          signal,
        }),
      );
      const output =
        result.entries.length === 0
          ? "(empty directory)"
          : result.entries
              .map(
                (entry) =>
                  `${entry.name}${entry.kind === "directory" ? "/" : ""}`,
              )
              .join("\n");
      return toolResult(
        result.limitReached
          ? `${output}\n\n[${input.limit ?? result.entries.length} entries limit reached]`
          : output,
        result.limitReached
          ? { entryLimitReached: input.limit ?? result.entries.length }
          : undefined,
      );
    },
  };
  const remoteFind: typeof find = {
    ...find,
    async execute(_id, input, signal) {
      const result = await remoteCall(() =>
        remote.executor.find({
          pattern: input.pattern,
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          signal,
        }),
      );
      const output =
        result.paths.length === 0
          ? "No files found matching pattern"
          : result.paths.join("\n");
      return toolResult(
        result.limitReached
          ? `${output}\n\n[${input.limit ?? result.paths.length} results limit reached]`
          : output,
        result.limitReached
          ? { resultLimitReached: input.limit ?? result.paths.length }
          : undefined,
      );
    },
  };
  const remoteGrep: typeof grep = {
    ...grep,
    async execute(_id, input, signal) {
      const result = await remoteCall(() =>
        remote.executor.grep({
          pattern: input.pattern,
          ...(input.path === undefined ? {} : { path: input.path }),
          ...(input.glob === undefined ? {} : { glob: input.glob }),
          ...(input.ignoreCase === undefined
            ? {}
            : { ignoreCase: input.ignoreCase }),
          ...(input.literal === undefined ? {} : { literal: input.literal }),
          ...(input.context === undefined ? {} : { context: input.context }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
          signal,
        }),
      );
      const output =
        result.matches.length === 0
          ? "No matches found"
          : result.matches.map(grepLine).join("\n");
      const retainedMatches = result.matches.filter(
        (match) => match.isMatch,
      ).length;
      return toolResult(
        result.matchLimitReached
          ? `${output}\n\n[${input.limit ?? retainedMatches} matches limit reached]`
          : output,
        result.matchLimitReached
          ? { matchLimitReached: input.limit ?? retainedMatches }
          : undefined,
      );
    },
  };
  const remoteBash: typeof bash = {
    ...bash,
    async execute(_id, input, signal, onUpdate) {
      const timeoutMilliseconds =
        input.timeout === undefined
          ? REMOTE_BASH_MAXIMUM_TIMEOUT_MILLISECONDS
          : input.timeout * 1_000;
      if (timeoutMilliseconds > REMOTE_BASH_MAXIMUM_TIMEOUT_MILLISECONDS) {
        throw new Error("Remote bash timeout cannot exceed 600 seconds.");
      }
      const decoder = new TextDecoder("utf-8");
      let output = "";
      let truncation: ReturnType<typeof truncateTail> | undefined;
      const process = await remoteCall(() =>
        remote.executor.startShell({
          command: input.command,
          environmentVariables: remote.executionEnvironment,
          initialCreditBytes: 64 * 1024,
          timeoutMilliseconds,
          signal,
          async onData(record) {
            output += decoder.decode(record.bytes, { stream: true });
            truncation = truncateTail(output);
            output = truncation.content;
            onUpdate?.(
              toolResult(
                output,
                truncation.truncated ? { truncation } : undefined,
              ),
            );
          },
        }),
      );
      const terminal = await remoteCall(() => process.terminal);
      output += decoder.decode();
      truncation = truncateTail(output);
      output = truncation.content;
      if (terminal.truncated)
        output +=
          "\n[Remote command output was incomplete; inspect the retained command result in environment recovery.]";
      // The tool has consumed the definitive completion. Lost acknowledgments
      // leave a management-visible receipt; they do not change the command result.
      if (!terminal.truncated)
        await process.acknowledge().catch(() => undefined);
      if (terminal.outcome !== "exited" || terminal.exitCode !== 0) {
        throw new Error(
          `${output}${output ? "\n" : ""}Remote command ${terminal.outcome}${terminal.exitCode === null ? "" : ` with code ${terminal.exitCode}`}`,
        );
      }
      return toolResult(
        output,
        truncation.truncated ? { truncation } : undefined,
      );
    },
  };
  return [
    remoteBash,
    remoteRead,
    remoteWrite,
    remoteEdit,
    remoteGrep,
    remoteFind,
    remoteLs,
  ] as const;
}

export const createPiExecutorWorkspaceToolDefinitions =
  createPiRemoteWorkspaceToolDefinitions;
