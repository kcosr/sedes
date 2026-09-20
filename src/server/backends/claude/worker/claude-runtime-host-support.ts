export const CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION = "24.18.0";

/** The supervised Claude worker requires POSIX process ownership and Node 24.18+. */
export function supportsClaudeRuntimeHost(platform: string, nodeVersion: string): boolean {
  if (platform !== "linux" && platform !== "darwin") return false;
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(nodeVersion)) return false;
  const actual = nodeVersion.split(".").map(Number);
  const minimum = CLAUDE_RUNTIME_WORKER_MINIMUM_NODE_VERSION.split(".").map(Number);
  if (actual.some(value => !Number.isSafeInteger(value))) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}
