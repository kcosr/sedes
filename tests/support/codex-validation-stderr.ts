/** Preserve strict stderr validation unless this known container warning is allowed. */
export function codexValidationStderr(
  stderr: string,
  allowArg0CleanupWarning = false,
): string {
  if (!allowArg0CleanupWarning) return stderr;
  return stderr.replace(
    /^WARNING: failed to clean up stale arg0 temp dirs: Permission denied \(os error 13\)(?:\r?\n|$)/gm,
    "",
  );
}
