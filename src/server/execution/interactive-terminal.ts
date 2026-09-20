import type { EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import type { RequestScope } from "../identity/identity-provider.js";

/** A launch may have committed on the execution host; only attach may recover it. */
export class InteractiveTerminalStartUncertainError extends Error {
  constructor(options?: ErrorOptions) {
    super("terminal_start_outcome_unknown", options);
    this.name = "InteractiveTerminalStartUncertainError";
  }
}

export type InteractiveTerminalWriteResult =
  | { readonly outcome: "sent" }
  | { readonly outcome: "not_sent"; readonly diagnosticCode?: string }
  | {
      readonly outcome: "sent_outcome_unknown";
      readonly diagnosticCode?: string;
    };

export type InteractiveTerminalExit = {
  readonly disposition: "exited" | "interrupted";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly diagnosticCode?: string;
  /** True only when an explicitly requested cleanup was verified complete. */
  readonly cleanupConfirmed?: boolean;
  /** The owned transport actually exited; says nothing about remote descendants. */
  readonly transportClosed?: boolean;
};

export interface InteractiveTerminalProcess {
  /** Present only when the execution host owns continuity across main restart. */
  readonly persistent?: {
    /** The remote emulator answers device queries; main must not answer twice. */
    readonly ownsDeviceReplies: true;
    start(handlers: {
      readonly restore: (snapshot: { readonly bytes: Uint8Array; readonly rows: number; readonly columns: number }) => Promise<void>;
      readonly resize: (size: { readonly rows: number; readonly columns: number }) => Promise<void>;
      readonly unavailable: () => void;
    }): Promise<void>;
    detach(): Promise<void>;
    /** Called only after the final checkpoint and status are durable on main. */
    acknowledgeFinal(): Promise<void>;
    forget(): Promise<void>;
    inputHighWater(producerId: string): Promise<number>;
  };
  /** Stop delivery of provider output without terminating the PTY. Idempotent. */
  pauseOutput(): void;
  /** Resume delivery after pauseOutput. Idempotent. */
  resumeOutput(): void;
  write(bytes: Uint8Array, producer?: { readonly producerId: string; readonly inputSeq: number }): Promise<InteractiveTerminalWriteResult>;
  resize(input: {
    readonly rows: number;
    readonly columns: number;
  }): Promise<void>;
  terminate(signal: "hangup" | "terminate" | "kill"): Promise<void>;
  onOutput(listener: (bytes: Uint8Array) => void): () => void;
  onExit(listener: (exit: InteractiveTerminalExit) => void): () => void;
}

export interface InteractiveTerminalEnvironmentProvider {
  readonly terminationEffect: "end_process" | "disconnect_transport";
  /** Existing incarnations may be recovered; this must never start a child. */
  readonly attachTerminal?: (input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly terminalId: string;
    readonly incarnationId: string;
  }) => Promise<InteractiveTerminalProcess>;
  /** Attach only to an existing sidecar; never starts or upgrades a runtime. */
  readonly recoverTerminal?: (input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly terminalId: string;
    readonly incarnationId: string;
  }) => Promise<InteractiveTerminalProcess>;
  availability(
    scope: RequestScope,
    environmentId: string,
  ): "available" | "unavailable";
  openTerminal(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly terminalId: string;
    readonly incarnationId: string;
    readonly environmentVariables?: EnvironmentVariableOverrides;
    readonly initialCwd: string;
    readonly shellProfile?: string;
    readonly rows: number;
    readonly columns: number;
  }): Promise<InteractiveTerminalProcess>;
}
