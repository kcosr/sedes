import {
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  renameSession,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type ListSessionsOptions,
  type Options,
  type Query,
  type SDKSessionInfo,
  type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import {
  assertClaudeSdkHelperEnvironment,
  type ClaudeChildEnvironment,
} from "./claude-child-environment.js";

export interface ClaudeCliAuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod?: string;
  readonly apiProvider?: string;
  readonly subscriptionType?: string;
  readonly apiKeySource?: string;
}

/**
 * Reads only the non-identifying fields from `claude auth status --json`.
 * The CLI also returns account identity fields; those deliberately never cross
 * this provider-private boundary.
 */
export async function readClaudeCliAuthStatus(
  executablePath: string,
  timeoutMs: number,
  environment?: Readonly<Record<string, string | undefined>>,
  cwd?: string,
  signal?: AbortSignal,
): Promise<ClaudeCliAuthStatus> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(
      executablePath,
      ["auth", "status", "--json"],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 4_096,
        ...(signal ? { signal } : {}),
        ...(environment ? { env: { ...environment } } : {}),
        ...(cwd ? { cwd } : {}),
      },
      (error, value) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(value);
      },
    );
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
  const authMethod = readOptionalString(decoded, "authMethod");
  const apiProvider = readOptionalString(decoded, "apiProvider");
  const subscriptionType = readOptionalString(decoded, "subscriptionType");
  const apiKeySource = readOptionalString(decoded, "apiKeySource");
  return Object.freeze({
    loggedIn: decoded.loggedIn,
    ...(authMethod !== undefined ? { authMethod } : {}),
    ...(apiProvider !== undefined ? { apiProvider } : {}),
    ...(subscriptionType !== undefined ? { subscriptionType } : {}),
    ...(apiKeySource !== undefined ? { apiKeySource } : {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(
  value: Readonly<Record<string, unknown>>,
  field: string,
): string | undefined {
  const candidate = value[field];
  if (candidate === undefined || candidate === null) return undefined;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(candidate)
  ) {
    throw new Error("claude_cli_auth_status_output_invalid");
  }
  return candidate;
}

/** Exact SDK release whose exported contracts this backend compiles against. */
export const CLAUDE_AGENT_SDK_RELEASE = "0.3.274";

export interface ClaudeQueryInput {
  readonly prompt: Parameters<typeof query>[0]["prompt"];
  readonly options: Options;
}

/**
 * Injectable, provider-private boundary around the official SDK. Tests fake
 * this interface rather than recreating Claude Code's private wire protocol.
 */
export interface ClaudeSdkFacade {
  readCliRelease(
    executablePath: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<string>;
  readCliAuthStatus(
    executablePath: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<ClaudeCliAuthStatus>;
  createQuery(input: ClaudeQueryInput): Query;
  listSessions(
    options: ListSessionsOptions,
    environment: ClaudeChildEnvironment,
  ): Promise<SDKSessionInfo[]>;
  getSessionInfo(
    sessionId: string,
    options: GetSessionInfoOptions,
    environment: ClaudeChildEnvironment,
  ): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(
    sessionId: string,
    options: GetSessionMessagesOptions,
    environment: ClaudeChildEnvironment,
  ): Promise<SessionMessage[]>;
  renameSession(
    sessionId: string,
    title: string,
    options: { readonly dir: string },
    environment: ClaudeChildEnvironment,
  ): Promise<void>;
}

export class OfficialClaudeSdkFacade implements ClaudeSdkFacade {
  readCliRelease(
    executablePath: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        executablePath,
        ["--version"],
        {
          encoding: "utf8",
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 4_096,
          ...(signal ? { signal } : {}),
          ...(environment ? { env: { ...environment } } : {}),
          ...(cwd ? { cwd } : {}),
        },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          const match = /^([^\s]+) \(Claude Code\)\s*$/u.exec(stdout);
          if (!match) {
            reject(new Error("claude_cli_release_output_invalid"));
            return;
          }
          resolve(match[1]!);
        },
      );
    });
  }

  readCliAuthStatus(
    executablePath: string,
    timeoutMs: number,
    environment?: Readonly<Record<string, string | undefined>>,
    cwd?: string,
    signal?: AbortSignal,
  ): Promise<ClaudeCliAuthStatus> {
    return readClaudeCliAuthStatus(
      executablePath,
      timeoutMs,
      environment,
      cwd,
      signal,
    );
  }

  createQuery(input: ClaudeQueryInput): Query {
    return query({ prompt: input.prompt, options: input.options });
  }

  listSessions(
    options: ListSessionsOptions,
    environment: ClaudeChildEnvironment,
  ): Promise<SDKSessionInfo[]> {
    assertClaudeSdkHelperEnvironment(environment);
    return listSessions(options);
  }

  getSessionInfo(
    sessionId: string,
    options: GetSessionInfoOptions,
    environment: ClaudeChildEnvironment,
  ): Promise<SDKSessionInfo | undefined> {
    assertClaudeSdkHelperEnvironment(environment);
    return getSessionInfo(sessionId, options);
  }

  getSessionMessages(
    sessionId: string,
    options: GetSessionMessagesOptions,
    environment: ClaudeChildEnvironment,
  ): Promise<SessionMessage[]> {
    assertClaudeSdkHelperEnvironment(environment);
    return getSessionMessages(sessionId, options);
  }

  renameSession(
    sessionId: string,
    title: string,
    options: { readonly dir: string },
    environment: ClaudeChildEnvironment,
  ): Promise<void> {
    assertClaudeSdkHelperEnvironment(environment);
    return renameSession(sessionId, title, options);
  }
}
