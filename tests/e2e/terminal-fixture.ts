import type {
  InteractiveTerminalEnvironmentProvider,
  InteractiveTerminalExit,
  InteractiveTerminalProcess,
  InteractiveTerminalWriteResult,
} from "../../src/server/execution/interactive-terminal.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

type FixtureWriteOutcome = InteractiveTerminalWriteResult["outcome"];

interface FixtureLaunch {
  readonly terminalId: string;
  readonly incarnationId: string;
  readonly environmentId: string;
  readonly initialCwd: string;
  readonly shellProfile: string | null;
  readonly initialRows: number;
  readonly initialColumns: number;
}

interface FixtureResize {
  readonly rows: number;
  readonly columns: number;
}

interface FixtureTerminalState extends FixtureLaunch {
  readonly writes: readonly string[];
  readonly resizes: readonly FixtureResize[];
  readonly terminateSignals: readonly ("hangup" | "terminate" | "kill")[];
  readonly closed: boolean;
  readonly nextWriteOutcome: FixtureWriteOutcome;
  readonly nextWriteDelayMilliseconds: number;
}

class FixtureTerminalProcess implements InteractiveTerminalProcess {
  readonly launch: FixtureLaunch;
  readonly #writes: string[] = [];
  readonly #resizes: FixtureResize[] = [];
  readonly #terminateSignals: Array<"hangup" | "terminate" | "kill"> = [];
  readonly #outputListeners = new Set<(bytes: Uint8Array) => void>();
  readonly #exitListeners = new Set<(exit: InteractiveTerminalExit) => void>();
  readonly #pausedOutput: Uint8Array[] = [];
  #nextWriteOutcome: FixtureWriteOutcome = "sent";
  #nextWriteDelayMilliseconds = 0;
  #commandBuffer = "";
  #closed = false;
  #paused = false;

  constructor(launch: FixtureLaunch) {
    this.launch = Object.freeze({ ...launch });
  }

  state(): FixtureTerminalState {
    return Object.freeze({
      ...this.launch,
      writes: Object.freeze([...this.#writes]),
      resizes: Object.freeze(this.#resizes.map((resize) => ({ ...resize }))),
      terminateSignals: Object.freeze([...this.#terminateSignals]),
      closed: this.#closed,
      nextWriteOutcome: this.#nextWriteOutcome,
      nextWriteDelayMilliseconds: this.#nextWriteDelayMilliseconds,
    });
  }

  emit(text: string): void {
    if (this.#closed) throw new Error("e2e_terminal_closed");
    const bytes = new TextEncoder().encode(text);
    if (this.#paused) {
      this.#pausedOutput.push(bytes);
      return;
    }
    this.#deliverOutput(bytes);
  }

  pauseOutput(): void {
    this.#paused = true;
  }
  resumeOutput(): void {
    this.#paused = false;
    while (!this.#paused) {
      const bytes = this.#pausedOutput.shift();
      if (!bytes) break;
      this.#deliverOutput(bytes);
    }
  }

  armWriteOutcome(outcome: FixtureWriteOutcome): void {
    this.#nextWriteOutcome = outcome;
  }

  armWriteDelay(milliseconds: number): void {
    this.#nextWriteDelayMilliseconds = milliseconds;
  }

  exit(exit: InteractiveTerminalExit): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#exitListeners) listener(exit);
  }

  async write(bytes: Uint8Array): Promise<InteractiveTerminalWriteResult> {
    if (this.#closed) {
      return { outcome: "not_sent", diagnosticCode: "e2e_terminal_closed" };
    }
    const text = new TextDecoder().decode(bytes);
    this.#writes.push(text);
    const delayMilliseconds = this.#nextWriteDelayMilliseconds;
    this.#nextWriteDelayMilliseconds = 0;
    if (delayMilliseconds > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delayMilliseconds),
      );
    }
    const outcome = this.#nextWriteOutcome;
    this.#nextWriteOutcome = "sent";
    if (outcome !== "sent") {
      return {
        outcome,
        diagnosticCode:
          outcome === "not_sent" ? "e2e_not_sent" : "e2e_sent_outcome_unknown",
      };
    }
    this.#commandBuffer += text;
    const boundary = this.#commandBuffer.search(/[\r\n]/u);
    if (boundary >= 0) {
      const command = this.#commandBuffer.slice(0, boundary);
      this.#commandBuffer = this.#commandBuffer.slice(boundary + 1);
      queueMicrotask(() => {
        if (this.#closed) return;
        if (command === "pwd") {
          this.emit(`\r\n${this.launch.initialCwd}\r\n$ `);
        } else if (command === "cd /tmp && pwd") {
          this.emit("\r\n/tmp\r\n$ ");
        } else {
          this.emit(`\r\ninput:${command}\r\n$ `);
        }
      });
    } else if (text === "\u001b" || text === "\t" || text === "\u0003") {
      this.#commandBuffer = "";
    }
    return { outcome: "sent" };
  }

  async resize(input: FixtureResize): Promise<void> {
    if (this.#closed) throw new Error("e2e_terminal_closed");
    this.#resizes.push(Object.freeze({ ...input }));
  }

  async terminate(signal: "hangup" | "terminate" | "kill"): Promise<void> {
    this.#terminateSignals.push(signal);
    if (signal === "hangup") {
      queueMicrotask(() =>
        this.exit({
          disposition: "exited",
          exitCode: 0,
          signal: "SIGHUP",
          cleanupConfirmed: true,
        }),
      );
    }
  }

  onOutput(listener: (bytes: Uint8Array) => void): () => void {
    this.#outputListeners.add(listener);
    return () => this.#outputListeners.delete(listener);
  }

  onExit(listener: (exit: InteractiveTerminalExit) => void): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  #deliverOutput(bytes: Uint8Array): void {
    for (const listener of this.#outputListeners) listener(bytes);
  }
}

export class TerminalE2eFixture implements InteractiveTerminalEnvironmentProvider {
  readonly terminationEffect = "end_process" as const;
  readonly #environmentId: string;
  readonly #terminals = new Map<string, FixtureTerminalProcess>();

  constructor(environmentId: string) {
    this.#environmentId = environmentId;
  }

  availability(
    _scope: RequestScope,
    environmentId: string,
  ): "available" | "unavailable" {
    return environmentId === this.#environmentId ? "available" : "unavailable";
  }

  async openTerminal(
    input: Parameters<
      InteractiveTerminalEnvironmentProvider["openTerminal"]
    >[0],
  ): Promise<InteractiveTerminalProcess> {
    if (input.environmentId !== this.#environmentId) {
      throw new Error("e2e_terminal_environment_mismatch");
    }
    const process = new FixtureTerminalProcess({
      terminalId: input.terminalId,
      incarnationId: input.incarnationId,
      environmentId: input.environmentId,
      initialCwd: input.initialCwd,
      shellProfile: input.shellProfile ?? null,
      initialRows: input.rows,
      initialColumns: input.columns,
    });
    this.#terminals.set(input.terminalId, process);
    return process;
  }

  state(): readonly FixtureTerminalState[] {
    return Object.freeze(
      [...this.#terminals.values()].map((terminal) => terminal.state()),
    );
  }

  emit(terminalId: string, text: string): void {
    this.#require(terminalId).emit(text);
  }

  armWriteOutcome(terminalId: string, outcome: FixtureWriteOutcome): void {
    this.#require(terminalId).armWriteOutcome(outcome);
  }

  armWriteDelay(terminalId: string, milliseconds: number): void {
    this.#require(terminalId).armWriteDelay(milliseconds);
  }

  exit(terminalId: string, exit: InteractiveTerminalExit): void {
    this.#require(terminalId).exit(exit);
  }

  #require(terminalId: string): FixtureTerminalProcess {
    const terminal = this.#terminals.get(terminalId);
    if (!terminal) throw new Error("e2e_terminal_unknown");
    return terminal;
  }
}
