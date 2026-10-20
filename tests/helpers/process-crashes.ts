/**
 * Collects process-level crash signals (uncaught exceptions and unhandled
 * rejections) for the duration of a test body.
 */
export function captureProcessCrashes(): {
  readonly errors: unknown[];
  dispose(): void;
} {
  const errors: unknown[] = [];
  const record = (error: unknown) => errors.push(error);
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  return {
    errors,
    dispose() {
      process.off("uncaughtException", record);
      process.off("unhandledRejection", record);
    },
  };
}
