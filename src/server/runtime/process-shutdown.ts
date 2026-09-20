import type { RunningApplication } from "../production-application.js";

export type ProcessShutdownOutcome =
  | Readonly<{ status: "closed" }>
  | Readonly<{ status: "failed"; error: unknown }>
  | Readonly<{ status: "deadline" }>;

/** Single process-level deadline around the ordered application teardown. */
export class ProcessShutdownCoordinator {
  readonly #application: Pick<RunningApplication, "close">;
  readonly #deadlineMilliseconds: number;
  readonly #report: (message: string) => void;
  readonly #terminate: (code: number) => void;
  #shutdownPromise: Promise<ProcessShutdownOutcome> | undefined;

  constructor(input: {
    readonly application: Pick<RunningApplication, "close">;
    readonly deadlineMilliseconds: number;
    readonly report: (message: string) => void;
    readonly terminate: (code: number) => void;
  }) {
    if (
      !Number.isSafeInteger(input.deadlineMilliseconds) ||
      input.deadlineMilliseconds <= 0
    ) {
      throw new Error("process_shutdown_deadline_invalid");
    }
    this.#application = input.application;
    this.#deadlineMilliseconds = input.deadlineMilliseconds;
    this.#report = input.report;
    this.#terminate = input.terminate;
  }

  shutdown(): Promise<ProcessShutdownOutcome> {
    this.#shutdownPromise ??= this.#performShutdown();
    return this.#shutdownPromise;
  }

  async #performShutdown(): Promise<ProcessShutdownOutcome> {
    let timer: NodeJS.Timeout | undefined;
    const close = this.#application.close().then(
      () => Object.freeze({ status: "closed" as const }),
      (error: unknown) => Object.freeze({ status: "failed" as const, error }),
    );
    const deadline = new Promise<ProcessShutdownOutcome>((resolve) => {
      timer = setTimeout(
        () => resolve(Object.freeze({ status: "deadline" as const })),
        this.#deadlineMilliseconds,
      );
    });
    const outcome = await Promise.race([close, deadline]);
    if (timer) clearTimeout(timer);
    if (outcome.status === "closed") return outcome;
    if (outcome.status === "deadline") {
      this.#report("Sedes shutdown exceeded its overall deadline.");
    } else {
      this.#report("Sedes shutdown completed with a cleanup failure.");
    }
    // Provider/native lock implementations retain fail-closed markers before
    // this outer fallback. Forced process exit never deletes or steals them.
    this.#terminate(1);
    return outcome;
  }
}
