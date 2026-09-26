import type { Options, SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import path from "node:path";
import {
  type ClaudeCliAuthStatus,
  type ClaudeQueryInput,
  type ClaudeSdkFacade,
} from "../claude-sdk-facade.js";
import type { ClaudeChildEnvironment } from "../claude-child-environment.js";
import type { ClaudeChildProcessSupervisor } from "./claude-child-process-supervisor.js";

/** Processes launched for one SDK query, with the facade that launches them. */
export interface ClaudeQueryProcessScope {
  readonly sdk: ClaudeSdkFacade;
  /**
   * Settles after every Claude process this scope launched has exited and its
   * process tree is proven gone; rejects when any cleanup is unproven.
   */
  settled(): Promise<void>;
}

/** Adds owned-process supervision to the official SDK facade used in a worker. */
export class TrackedClaudeSdkFacade implements ClaudeSdkFacade {
  readonly #delegate: ClaudeSdkFacade;
  readonly #supervisor: ClaudeChildProcessSupervisor;

  constructor(input: {
    readonly delegate: ClaudeSdkFacade;
    readonly supervisor: ClaudeChildProcessSupervisor;
  }) {
    this.#delegate = input.delegate;
    this.#supervisor = input.supervisor;
  }

  async readCliRelease(
    executablePath: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const stdout = await this.#supervisor.executeProbe({
      executablePath,
      arguments: ["--version"],
      timeoutMilliseconds: timeoutMs,
      ...(environment ? { environment } : {}),
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
    });
    const match = /^([^\s]+) \(Claude Code\)\s*$/u.exec(stdout);
    if (!match) throw new Error("claude_cli_release_output_invalid");
    return match[1]!;
  }

  async readCliAuthStatus(
    executablePath: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<ClaudeCliAuthStatus> {
    const stdout = await this.#supervisor.executeProbe({
      executablePath,
      arguments: ["auth", "status", "--json"],
      timeoutMilliseconds: timeoutMs,
      ...(environment ? { environment } : {}),
      ...(cwd ? { cwd } : {}),
      ...(signal ? { signal } : {}),
    });
    let decoded: unknown;
    try {
      decoded = JSON.parse(stdout);
    } catch {
      throw new Error("claude_cli_auth_status_output_invalid");
    }
    if (!isRecord(decoded) || typeof decoded.loggedIn !== "boolean") {
      throw new Error("claude_cli_auth_status_output_invalid");
    }
    return Object.freeze({
      loggedIn: decoded.loggedIn,
      ...optionalAuthField(decoded, "authMethod"),
      ...optionalAuthField(decoded, "apiProvider"),
      ...optionalAuthField(decoded, "subscriptionType"),
      ...optionalAuthField(decoded, "apiKeySource"),
    });
  }

  createQuery(input: ClaudeQueryInput) {
    return this.#createQuery(input, () => undefined);
  }

  /** Returns a facade whose query processes can be awaited as one scope. */
  createQueryScope(): ClaudeQueryProcessScope {
    const processes: SpawnedProcess[] = [];
    const sdk: ClaudeSdkFacade = {
      readCliRelease: (...input) => this.readCliRelease(...input),
      readCliAuthStatus: (...input) => this.readCliAuthStatus(...input),
      createQuery: (input) =>
        this.#createQuery(input, (spawned) => processes.push(spawned)),
      listSessions: (...input) => this.listSessions(...input),
      getSessionInfo: (...input) => this.getSessionInfo(...input),
      getSessionMessages: (...input) => this.getSessionMessages(...input),
      renameSession: (...input) => this.renameSession(...input),
    };
    return Object.freeze({
      sdk,
      settled: async () => {
        await Promise.all(
          processes.map((spawned) => this.#supervisor.processCleanup(spawned)),
        );
      },
    });
  }

  #createQuery(
    input: ClaudeQueryInput,
    onSpawn: (spawned: SpawnedProcess) => void,
  ) {
    const executablePath = input.options.pathToClaudeCodeExecutable;
    if (
      typeof executablePath !== "string" ||
      !path.isAbsolute(executablePath) ||
      input.options.spawnClaudeCodeProcess !== undefined
    ) {
      throw new Error("claude_worker_query_executable_invalid");
    }
    const options: Options = {
      ...input.options,
      spawnClaudeCodeProcess: (spawnOptions) => {
        if (
          spawnOptions.command !== executablePath &&
          spawnOptions.args.filter((value) => value === executablePath)
            .length !== 1
        ) {
          throw new Error("claude_worker_query_executable_mismatch");
        }
        const spawned = this.#supervisor.spawnClaudeCodeProcess(spawnOptions);
        onSpawn(spawned);
        return spawned;
      },
    };
    return this.#delegate.createQuery({ ...input, options });
  }

  listSessions(...input: Parameters<ClaudeSdkFacade["listSessions"]>) {
    return this.#delegate.listSessions(...input);
  }

  getSessionInfo(...input: Parameters<ClaudeSdkFacade["getSessionInfo"]>) {
    return this.#delegate.getSessionInfo(...input);
  }

  getSessionMessages(
    ...input: Parameters<ClaudeSdkFacade["getSessionMessages"]>
  ) {
    return this.#delegate.getSessionMessages(...input);
  }

  hasSessionTranscript(...input: Parameters<ClaudeSdkFacade["hasSessionTranscript"]>) {
    return this.#delegate.hasSessionTranscript(...input);
  }

  renameSession(...input: Parameters<ClaudeSdkFacade["renameSession"]>) {
    return this.#delegate.renameSession(...input);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalAuthField(
  value: Readonly<Record<string, unknown>>,
  field: "authMethod" | "apiProvider" | "subscriptionType" | "apiKeySource",
): Partial<ClaudeCliAuthStatus> {
  const candidate = value[field];
  if (candidate === undefined || candidate === null) return {};
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new Error("claude_cli_auth_status_output_invalid");
  }
  return { [field]: candidate };
}
