import { resolveEnvironmentVariables, mergeResolvedEnvironment } from "../environment-variables/runtime-environment.js";
import type { EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import path from "node:path";
import type { spawn as spawnPty, IPty } from "node-pty";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  InteractiveTerminalEnvironmentProvider,
  InteractiveTerminalExit,
  InteractiveTerminalProcess,
  InteractiveTerminalWriteResult,
} from "./interactive-terminal.js";

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.principalId === right.principalId
  );
}

export class LocalInteractiveTerminalProvider implements InteractiveTerminalEnvironmentProvider {
  readonly terminationEffect = "end_process" as const;
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #spawnPty: typeof spawnPty | undefined;
  readonly #cleanupOnNaturalExit: boolean;

  constructor(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly spawnPty?: typeof spawnPty;
    /** Persistent hosts must settle descendants before releasing ownership. */
    readonly cleanupOnNaturalExit?: boolean;
  }) {
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    this.#environment = input.environment ?? process.env;
    this.#spawnPty = input.spawnPty;
    this.#cleanupOnNaturalExit = input.cleanupOnNaturalExit ?? false;
  }

  availability(
    scope: RequestScope,
    environmentId: string,
  ): "available" | "unavailable" {
    return sameScope(scope, this.#scope) && environmentId === this.#environmentId
      ? "available"
      : "unavailable";
  }

  async openTerminal(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly terminalId: string;
    readonly incarnationId: string;
    readonly environmentVariables?: EnvironmentVariableOverrides;
    readonly initialCwd: string;
    readonly shellProfile?: string;
    readonly rows: number;
    readonly columns: number;
  }): Promise<InteractiveTerminalProcess> {
    if (this.availability(input.scope, input.environmentId) !== "available") {
      throw new Error("interactive_terminal_environment_unavailable");
    }
    if (input.shellProfile !== undefined) {
      throw new Error("interactive_terminal_shell_profile_unsupported");
    }
    const configuredShell =
      this.#environment.SHELL ??
      this.#environment.ComSpec ??
      this.#environment.COMSPEC;
    const hasConfiguredShell =
      configuredShell !== undefined && path.isAbsolute(configuredShell);
    const shell =
      hasConfiguredShell
        ? configuredShell
        : process.platform === "win32"
          ? path.join(
              this.#environment.SystemRoot ?? "C:\\Windows",
              "System32",
              "cmd.exe",
            )
          : "/bin/bash";
    const environment = mergeResolvedEnvironment(this.#environment, await resolveEnvironmentVariables(input.environmentVariables ?? {}, this.#environment));
    const spawnTerminal = this.#spawnPty ?? (await import("node-pty")).spawn;
    const pty = spawnTerminal(
      shell,
      process.platform === "win32" ? [] : ["-l"],
      {
        cwd: input.initialCwd,
        env: {
          ...environment,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
        },
        name: "xterm-256color",
        cols: input.columns,
        rows: input.rows,
        encoding: null,
      },
    );
    return new LocalInteractiveTerminalProcess(pty, this.#cleanupOnNaturalExit);
  }
}

class LocalInteractiveTerminalProcess implements InteractiveTerminalProcess {
  readonly #pty: IPty;
  readonly #outputListeners = new Set<(bytes: Uint8Array) => void>();
  readonly #pendingOutput: Uint8Array[] = [];
  readonly #exitListeners = new Set<(exit: InteractiveTerminalExit) => void>();
  #terminationRequested = false;
  #exit: InteractiveTerminalExit | undefined;
  #exited = false;
  #paused = false;
  #pendingOutputBytes = 0;
  #interruptionCode: string | undefined;
  readonly #cleanupOnNaturalExit: boolean;

  constructor(pty: IPty, cleanupOnNaturalExit: boolean) {
    this.#pty = pty;
    this.#cleanupOnNaturalExit = cleanupOnNaturalExit;
    pty.onData((chunk: string | Uint8Array) => {
      if (this.#exited) return;
      const bytes =
        typeof chunk === "string"
          ? Buffer.from(chunk, "utf8")
          : Uint8Array.from(chunk);
      if (this.#outputListeners.size === 0) {
        this.#pendingOutput.push(bytes);
        this.#pendingOutputBytes += bytes.byteLength;
        if (this.#pendingOutputBytes > 1024 * 1024) {
          this.#interruptionCode = "local_terminal_early_output_limit";
          killPty(this.#pty, "SIGHUP");
        }
      }
      else for (const listener of this.#outputListeners) listener(bytes);
    });
    pty.onExit(({ exitCode, signal }) => {
      if (this.#exited) return;
      this.#exited = true;
      void this.#publishExit(exitCode, signal ?? 0);
    });
  }

  pauseOutput(): void {
    if (this.#exited || this.#paused) return;
    this.#paused = true;
    this.#pty.pause();
  }

  resumeOutput(): void {
    if (this.#exited || !this.#paused) return;
    this.#paused = false;
    this.#pty.resume();
  }

  async write(bytes: Uint8Array): Promise<InteractiveTerminalWriteResult> {
    if (this.#exited) return { outcome: "not_sent" };
    try {
      this.#pty.write(Buffer.from(bytes));
      return { outcome: "sent" };
    } catch {
      return { outcome: "not_sent", diagnosticCode: "pty_write_failed" };
    }
  }

  async resize(input: {
    readonly rows: number;
    readonly columns: number;
  }): Promise<void> {
    if (this.#exited) throw new Error("interactive_terminal_process_exited");
    this.#pty.resize(input.columns, input.rows);
  }

  async terminate(signal: "hangup" | "terminate" | "kill"): Promise<void> {
    if (this.#exited) return;
    this.#terminationRequested = true;
    const signalName =
      signal === "hangup"
        ? "SIGHUP"
        : signal === "terminate"
          ? "SIGTERM"
          : "SIGKILL";
    if (process.platform === "win32") {
      killPty(this.#pty, signalName);
      return;
    }
    try {
      process.kill(-this.#pty.pid, signalName);
    } catch {
      killPty(this.#pty, signalName);
    }
  }

  async #publishExit(exitCode: number, signal: number): Promise<void> {
    const cleanupRequired = this.#terminationRequested || this.#cleanupOnNaturalExit;
    const cleanupConfirmed = cleanupRequired
      ? await cleanupProcessGroup(this.#pty.pid)
      : false;
    if (cleanupRequired && !cleanupConfirmed && !this.#interruptionCode) {
      this.#interruptionCode = "local_terminal_cleanup_unconfirmed";
    }
    const exit = Object.freeze({
      disposition: this.#interruptionCode ? "interrupted" as const : "exited" as const,
      exitCode,
      signal: signal === 0 ? null : String(signal),
      ...(this.#interruptionCode ? { diagnosticCode: this.#interruptionCode } : {}),
      ...(cleanupRequired ? { cleanupConfirmed } : {}),
    });
    this.#exit = exit;
    for (const listener of this.#exitListeners) listener(exit);
    this.#outputListeners.clear();
    this.#exitListeners.clear();
  }

  onOutput(listener: (bytes: Uint8Array) => void): () => void {
    this.#outputListeners.add(listener);
    for (const bytes of this.#pendingOutput.splice(0)) listener(bytes);
    this.#pendingOutputBytes = 0;
    return () => this.#outputListeners.delete(listener);
  }

  onExit(listener: (exit: InteractiveTerminalExit) => void): () => void {
    if (this.#exit) {
      listener(this.#exit);
      return () => undefined;
    }
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }
}

async function cleanupProcessGroup(pid: number): Promise<boolean> {
  if (process.platform === "win32") return waitForProcessGroupExit(pid);
  if (await waitForProcessGroupExit(pid)) return true;
  signalProcessGroup(pid, "SIGTERM");
  if (await waitForProcessGroupExit(pid)) return true;
  signalProcessGroup(pid, "SIGKILL");
  return waitForProcessGroupExit(pid);
}

async function waitForProcessGroupExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      process.kill(process.platform === "win32" ? pid : -pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function killPty(pty: IPty, signal: NodeJS.Signals): void {
  if (process.platform === "win32") pty.kill();
  else pty.kill(signal);
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The following bounded probe determines whether cleanup is confirmed.
  }
}
