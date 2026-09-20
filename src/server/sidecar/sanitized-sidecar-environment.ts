const FIXED_NAMES = new Set([
  "HOME",
  "PATH",
  "LANG",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "CLAUDE_CONFIG_DIR",
]);
// Native Windows tools locate the account, configuration, temporary files, and
// system executables through these values. They are account environment, not
// provider credentials or process-loader overrides.
const WINDOWS_NAMES = new Map([
  ["SYSTEMROOT", "SystemRoot"],
  ["WINDIR", "windir"],
  ["COMSPEC", "ComSpec"],
  ["USERPROFILE", "USERPROFILE"],
  ["HOMEDRIVE", "HOMEDRIVE"],
  ["HOMEPATH", "HOMEPATH"],
  ["APPDATA", "APPDATA"],
  ["LOCALAPPDATA", "LOCALAPPDATA"],
  ["TEMP", "TEMP"],
  ["TMP", "TMP"],
  ["PATHEXT", "PATHEXT"],
  ["USERNAME", "USERNAME"],
]);
const NAME = /^[A-Z_][A-Z0-9_]{0,63}$/u;
const VALUE = /^[^\u0000\r\n]{0,4096}$/u;
const LOCALE_VALUE = /^[A-Za-z0-9_@.+-]{1,128}$/u;

/** Rebuilds the environment from account values; never merges a host env. */
export function buildSanitizedSidecarEnvironment(
  source: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  // A supplied account directory is authority, not an optional ambient hint.
  // Reject malformed input instead of selecting a different provider home.
  if (
    source.CLAUDE_CONFIG_DIR !== undefined &&
    !VALUE.test(source.CLAUDE_CONFIG_DIR)
  ) {
    throw new Error("sidecar_claude_config_directory_invalid");
  }
  const result: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv;
  const seen = new Set<string>();
  for (const [sourceName, value] of Object.entries(source)) {
    const name = platform === "win32" ? sourceName.toUpperCase() : sourceName;
    const outputName = platform === "win32" ? WINDOWS_NAMES.get(name) ?? name : name;
    // Windows keys are case insensitive. Do not let object insertion order
    // choose between conflicting PATH/Path (or other duplicate) values.
    if (seen.has(outputName)) {
      delete result[outputName];
      continue;
    }
    seen.add(outputName);
    if (
      value === undefined ||
      !NAME.test(name) ||
      !VALUE.test(value) ||
      (!FIXED_NAMES.has(name) && !name.startsWith("LC_") &&
        !(platform === "win32" && WINDOWS_NAMES.has(name))) ||
      ((name === "LANG" || name.startsWith("LC_")) &&
        value.length > 0 &&
        !LOCALE_VALUE.test(value))
    ) {
      continue;
    }
    result[outputName] = value;
  }
  return Object.freeze(result);
}
