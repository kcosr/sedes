export interface E2EServerProcessLifecycle {
  once(
    event: "SIGTERM" | "SIGINT" | "disconnect",
    listener: () => void,
  ): unknown;
  exit(code: number): unknown;
  writeError(message: string): void;
}

export function installE2EServerProcessLifecycle(
  lifecycle: E2EServerProcessLifecycle,
  close: () => Promise<void>,
): void {
  let exitRequested = false;
  const exitAfterClose = () => {
    if (exitRequested) return;
    exitRequested = true;
    void close().then(
      () => lifecycle.exit(0),
      (error) => {
        lifecycle.writeError(
          `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
        );
        lifecycle.exit(1);
      },
    );
  };

  lifecycle.once("SIGTERM", exitAfterClose);
  lifecycle.once("SIGINT", exitAfterClose);
  lifecycle.once("disconnect", exitAfterClose);
}
