import { homedir } from "node:os";

const FORWARDED_ENVIRONMENT_NAMES = [
  "ALL_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_PROXY",
  "PATH",
  "GROK_HOME",
  "SSL_CERT_FILE",
  "TZ",
] as const;

/**
 * Curated launch environment. Provider-native HOME/GROK_HOME state is
 * preserved, while unrelated ambient credentials and Sedes authority are
 * omitted.
 */
export function buildGrokChildEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const child: Record<string, string> = {};
  for (const name of FORWARDED_ENVIRONMENT_NAMES) {
    const value = environment[name];
    if (value !== undefined) child[name] = value;
  }
  child.HOME = environment.HOME ?? homedir();
  child.NO_COLOR = "1";
  child.TERM = "dumb";
  child.GROK_OAUTH2_REFERRER = "sedes";
  return Object.freeze(child);
}

export function grokOwnedStdioArguments(input: {
  readonly sandboxProfile: "off";
}): readonly string[] {
  return Object.freeze([
    "--no-auto-update",
    "--permission-mode",
    "bypassPermissions",
    "--sandbox",
    input.sandboxProfile,
    "agent",
    "--no-leader",
    "stdio",
  ]);
}
