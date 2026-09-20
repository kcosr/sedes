import { pathForRemoteRoot } from "../execution/remote-path.js";
import { fileURLToPath } from "node:url";
import {
  WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES,
  workspaceToolsAbsolutePathSchema,
  workspaceToolsRelativePathSchema,
} from "../../internal/sidecar-protocol/index.js";
import { WorkspaceToolError } from "./contracts.js";

/**
 * Encode semantic tool paths as literal workspace-relative wire paths.
 * Known paths validate immediately; home expansion waits for execution-host
 * account identity. This function never probes paths or uses the host's HOME.
 */
export function prepareSidecarWorkspaceToolPath(
  input: unknown,
  options: { readonly workspacePath: string; readonly allowRoot: boolean },
): (homePath?: string) => string | undefined {
  const paths = pathForRemoteRoot(options.workspacePath);
  const windows = paths.sep === "\\";
  if (input === undefined && options.allowRoot) return () => undefined;
  if (
    typeof input !== "string" ||
    Buffer.byteLength(input, "utf8") > WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(input) ||
    (!windows && input.includes("\\")) ||
    (windows && /^[a-z]:(?![\\/])/iu.test(input))
  ) {
    throw new WorkspaceToolError("workspace_tools_path_invalid");
  }
  let value = input.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (windows && /^[a-z]:(?![\\/])/iu.test(value)) {
    throw new WorkspaceToolError("workspace_tools_path_invalid");
  }
  if (
    value === "~" ||
    value.startsWith("~/") ||
    (windows && value.startsWith("~\\"))
  ) {
    const homeRelativePath = value === "~" ? "." : value.slice(2);
    return (homePath) => {
      const home = workspaceToolsAbsolutePathSchema.safeParse(homePath);
      if (!home.success) {
        throw new WorkspaceToolError("workspace_tools_unavailable");
      }
      return encodeAbsolutePath(
        paths.resolve(home.data, homeRelativePath),
        options,
      );
    };
  }
  if (value.startsWith("file://")) {
    try {
      value = fileURLToPath(value, { windows });
    } catch (cause) {
      throw new WorkspaceToolError("workspace_tools_path_invalid", { cause });
    }
  }
  const encoded = encodeAbsolutePath(
    paths.resolve(options.workspacePath, value || "."),
    options,
  );
  return () => encoded;
}

function encodeAbsolutePath(
  absolute: string,
  {
    workspacePath,
    allowRoot,
  }: {
    readonly workspacePath: string;
    readonly allowRoot: boolean;
  },
): string | undefined {
  // Execution-host lexical conversion only. The sidecar still checks canonical
  // path identity, symlinks, and workspace replacement under its admission.
  const paths = pathForRemoteRoot(workspacePath);
  if (!workspaceToolsAbsolutePathSchema.safeParse(absolute).success) {
    throw new WorkspaceToolError("workspace_tools_path_invalid");
  }
  const relative = paths.relative(workspacePath, absolute);
  if (
    relative === ".." ||
    relative.startsWith(`..${paths.sep}`) ||
    paths.isAbsolute(relative)
  ) {
    throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
  }
  if (relative === "") {
    if (allowRoot) return undefined;
    throw new WorkspaceToolError("workspace_tools_path_not_file");
  }
  const wireRelative = relative.split(paths.sep).join("/");
  if (!workspaceToolsRelativePathSchema.safeParse(wireRelative).success) {
    throw new WorkspaceToolError("workspace_tools_path_invalid");
  }
  return wireRelative;
}
