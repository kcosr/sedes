import { homedir } from "node:os";
import path from "node:path";

export type ClaudeChildEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** Immutable process environment used by every CLI child for one runtime. */
export function captureClaudeChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): ClaudeChildEnvironment {
  return Object.freeze({ ...environment });
}

/** Effective provider-native home selected by Claude Code. */
export function claudeConfigDirectory(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const configuredDirectory =
    environment.CLAUDE_CONFIG_DIR ??
    path.join(environment.HOME ?? homedir(), ".claude");
  if (
    configuredDirectory.length === 0 ||
    configuredDirectory.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(configuredDirectory) ||
    !path.isAbsolute(configuredDirectory) ||
    path.resolve(configuredDirectory) !== configuredDirectory
  ) {
    throw new Error("claude_external_config_directory_invalid");
  }
  return configuredDirectory;
}

/**
 * The SDK's typed filesystem helpers do not accept an environment and read
 * process.env internally. Fail closed rather than let them address a native
 * store other than the one selected for the runtime's CLI children.
 */
export function assertClaudeSdkHelperEnvironment(
  environment: ClaudeChildEnvironment,
): void {
  if (
    claudeConfigDirectory(environment) !== claudeConfigDirectory(process.env)
  ) {
    throw new Error("claude_sdk_helper_environment_mismatch");
  }
}
