import { DomainError } from "../domain/errors.js";

interface RuntimeFailureCause {
  readonly kind: "runtime_failure";
  readonly code: string;
}

export function normalizeRuntimeError(error: unknown): DomainError {
  if (error instanceof DomainError) {
    return error;
  }
  const code = error instanceof Error ? error.message : "";
  const options = {
    cause: {
      kind: "runtime_failure",
      code,
    } satisfies RuntimeFailureCause,
  };
  if (code === "workspace_missing") {
    return new DomainError(
      "workspace_missing",
      "The workspace directory was moved or removed.",
      false,
      options,
    );
  }
  if (code === "workspace_not_allowed") {
    return new DomainError(
      "invalid_transition",
      "The workspace is outside the configured execution roots.",
      false,
      options,
    );
  }
  if (code === "directory_browse_not_allowed") {
    return new DomainError(
      "invalid_transition",
      "The directory cannot be browsed in this execution environment.",
      false,
      options,
    );
  }
  if (code === "directory_browse_cursor_invalid") {
    return new DomainError(
      "cursor_invalid",
      "The directory page changed or its continuation is no longer valid.",
      false,
      options,
    );
  }
  if (code === "directory_browse_unavailable") {
    return new DomainError(
      "runtime_unavailable",
      "Directory browsing is unavailable for this execution environment.",
      true,
      options,
    );
  }
  return new DomainError(
    "runtime_unavailable",
    "The execution environment could not complete the operation.",
    true,
    options,
  );
}

export function runtimeFailureCode(error: unknown): string | undefined {
  if (!(error instanceof DomainError)) return undefined;
  const cause = error.cause;
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("kind" in cause) ||
    cause.kind !== "runtime_failure" ||
    !("code" in cause) ||
    typeof cause.code !== "string"
  ) {
    return undefined;
  }
  return cause.code;
}

export async function callRuntime<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizeRuntimeError(error);
  }
}
