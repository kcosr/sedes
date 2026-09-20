import { normalizedAbsolutePath } from "../../shared/absolute-path.js";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pathIsWithin } from "../path-containment.js";
import { WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES, workspaceToolsRelativePathSchema } from "../../internal/sidecar-protocol/index.js";
import { WorkspaceToolError, type WorkspaceToolRoot } from "./contracts.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/gu;

export type WorkspaceToolPathGrammar = "semantic" | "workspace_relative";

export function normalizeWorkspaceToolPath(
  input: string,
  root: WorkspaceToolRoot,
  grammar: WorkspaceToolPathGrammar = "semantic",
): string {
  if (grammar === "workspace_relative") {
    // The carrier has already expanded user-facing path syntax. Treat every
    // wire segment literally, including @, ~ and Unicode-space filenames.
    // A dot is used internally only for an omitted directory/search operand.
    if (input === ".") return root.canonicalPath;
    if (!workspaceToolsRelativePathSchema.safeParse(input).success)
      throw new WorkspaceToolError("workspace_tools_path_invalid");
    const absolute = path.resolve(root.canonicalPath, input);
    if (!pathIsWithin(root.canonicalPath, absolute))
      throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
    return absolute;
  }
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    Buffer.byteLength(input, "utf8") > WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES
  ) {
    throw new WorkspaceToolError("workspace_tools_path_invalid");
  }
  let value = input.replace(UNICODE_SPACES, " ");
  if (value.startsWith("@")) value = value.slice(1);
  if (value === "~") value = root.homePath;
  else if (value.startsWith("~/"))
    value = path.join(root.homePath, value.slice(2));
  if (/^file:\/\//u.test(value)) {
    try {
      value = fileURLToPath(value);
    } catch (error) {
      throw new WorkspaceToolError("workspace_tools_path_invalid", {
        cause: error,
      });
    }
  }
  const absolute = path.isAbsolute(value)
    ? path.resolve(value)
    : path.resolve(root.canonicalPath, value || ".");
  if (process.platform === "win32" && !normalizedAbsolutePath(absolute))
    throw new WorkspaceToolError("workspace_tools_path_invalid");
  if (!pathIsWithin(root.canonicalPath, absolute)) {
    throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
  }
  return absolute;
}

export async function resolveContainedExistingPath(
  input: string,
  root: WorkspaceToolRoot,
  grammar: WorkspaceToolPathGrammar = "semantic",
): Promise<string> {
  const lexical = normalizeWorkspaceToolPath(input, root, grammar);
  const canonical = await realpath(lexical).catch((error) => {
    throw new WorkspaceToolError("workspace_tools_path_not_found", {
      cause: error,
    });
  });
  if (!pathIsWithin(root.canonicalPath, canonical)) {
    throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
  }
  return canonical;
}

export async function resolvePiReadPath(
  input: string,
  root: WorkspaceToolRoot,
  grammar: WorkspaceToolPathGrammar = "semantic",
): Promise<string> {
  const base = normalizeWorkspaceToolPath(input, root, grammar);
  const nfd = base.normalize("NFD");
  const variants = [
    base,
    base.replace(/ (AM|PM)\./giu, "\u202F$1."),
    nfd,
    base.replace(/'/gu, "\u2019"),
    nfd.replace(/'/gu, "\u2019"),
  ];
  for (const candidate of new Set(variants)) {
    const metadata = await lstat(candidate).catch(() => undefined);
    if (!metadata) continue;
    const canonical = await realpath(candidate).catch(() => undefined);
    if (canonical && pathIsWithin(root.canonicalPath, canonical))
      return canonical;
  }
  throw new WorkspaceToolError("workspace_tools_path_not_found");
}
