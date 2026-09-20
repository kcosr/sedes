import type {
  CodexManagedTuiLauncher,
  CodexManagedTuiProcess,
} from "../../src/server/backends/codex/codex-managed-tui-registry.js";

const encoder = new TextEncoder();

class ByteQueue implements AsyncIterable<Uint8Array> {
  readonly #pending: Uint8Array[] = [];
  readonly #waiters: Array<
    (result: IteratorResult<Uint8Array, undefined>) => void
  > = [];
  #closed = false;

  push(bytes: Uint8Array): void {
    if (this.#closed) return;
    const stable = Uint8Array.from(bytes);
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: stable });
      return;
    }
    this.#pending.push(stable);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array, undefined> {
    return {
      next: () => {
        const pending = this.#pending.shift();
        if (pending) {
          return Promise.resolve({ done: false as const, value: pending });
        }
        if (this.#closed) {
          return Promise.resolve({ done: true as const, value: undefined });
        }
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

type ResizeRecord = {
  readonly resourceGeneration: number;
  readonly columns: number;
  readonly rows: number;
};

export class CodexTuiE2eFixture implements CodexManagedTuiLauncher {
  #launchCount = 0;
  readonly #writes: string[] = [];
  readonly #resizes: ResizeRecord[] = [];
  readonly #closeReasons: string[] = [];

  async launch(
    input: Parameters<CodexManagedTuiLauncher["launch"]>[0],
  ): Promise<CodexManagedTuiProcess> {
    this.#launchCount += 1;
    const output = new ByteQueue();
    let closed = false;
    let resolveClosed!: (status: {
      readonly exitCode: number | null;
      readonly signal: string | null;
    }) => void;
    const closedPromise = new Promise<{
      readonly exitCode: number | null;
      readonly signal: string | null;
    }>((resolve) => {
      resolveClosed = resolve;
    });
    const close = async (reason: string) => {
      if (closed) return;
      closed = true;
      this.#closeReasons.push(reason);
      output.close();
      resolveClosed({ exitCode: 0, signal: null });
    };
    input.signal.addEventListener(
      "abort",
      () => void close("e2e_launch_aborted"),
      { once: true },
    );

    return {
      output,
      closed: closedPromise,
      write: async (bytes) => {
        if (closed) throw new Error("e2e_codex_tui_closed");
        const text = new TextDecoder().decode(bytes);
        this.#writes.push(text);
        output.push(encoder.encode(`\r\ninput:${text}`));
      },
      resize: async (columns, rows) => {
        if (closed) throw new Error("e2e_codex_tui_closed");
        this.#resizes.push({
          resourceGeneration: input.resourceGeneration,
          columns,
          rows,
        });
        output.push(
          encoder.encode(
            `\u001b[?2026h\u001b[2J\u001b[H\u001b[38;2;37;99;235mManaged Codex TUI fixture\u001b[0m\r\n\u001b[38;2;22;163;74m${columns}x${rows}\u001b[0m\u001b[?2026l`,
          ),
        );
      },
      close,
    };
  }

  state(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      launchCount: this.#launchCount,
      writes: Object.freeze([...this.#writes]),
      resizes: Object.freeze(this.#resizes.map((resize) => ({ ...resize }))),
      closeReasons: Object.freeze([...this.#closeReasons]),
    });
  }
}
