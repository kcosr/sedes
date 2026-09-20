export const SSH_ENVIRONMENT_NOT_VALIDATED_DIAGNOSTIC =
  "ssh_environment_not_validated";

export type EnvironmentOperationalState =
  | "unvalidated"
  | "available"
  | "unavailable";

export function environmentOperationalState(input: {
  readonly availability: "available" | "unavailable";
  readonly diagnosticCode: string | null;
}): EnvironmentOperationalState {
  if (input.availability === "available") return "available";
  return input.diagnosticCode === SSH_ENVIRONMENT_NOT_VALIDATED_DIAGNOSTIC
    ? "unvalidated"
    : "unavailable";
}

export function environmentAdmitsForegroundOperation(input: {
  readonly availability: "available" | "unavailable";
  readonly diagnosticCode: string | null;
}): boolean {
  return environmentOperationalState(input) !== "unavailable";
}
