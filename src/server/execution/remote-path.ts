import path from "node:path";
import { normalizedAbsolutePath } from "../../shared/absolute-path.js";

export type RemotePlatform = "linux" | "darwin" | "win32";

export function remotePath(platform: RemotePlatform): typeof path.posix {
  return platform === "win32" ? path.win32 : path.posix;
}

export function isNormalizedRemotePath(
  value: string,
  platform: RemotePlatform,
): boolean {
  return (
    normalizedAbsolutePath(value) &&
    (platform === "win32" ? !value.startsWith("/") : value.startsWith("/"))
  );
}

/** Paths come from execution-environment authority, never the server OS. */
export function pathForRemoteRoot(root: string): typeof path.posix {
  return root.startsWith("/") ? path.posix : path.win32;
}

export function isWithinRemoteRoot(candidate: string, root: string): boolean {
  const platform = root.startsWith("/") ? "linux" : "win32";
  if (
    !isNormalizedRemotePath(root, platform) ||
    !isNormalizedRemotePath(candidate, platform)
  )
    return false;
  const paths = remotePath(platform);
  const relative = paths.relative(root, candidate);
  return (
    relative === "" ||
    (!paths.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${paths.sep}`))
  );
}
