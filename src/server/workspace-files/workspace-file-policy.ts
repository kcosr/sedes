import path from "node:path";

/**
 * Default-closed browser file policy. It is intentionally explicit and is
 * applied before filesystem access so a denied path has the same outward
 * behavior as a missing path.
 */
export const SENSITIVE_WORKSPACE_DIRECTORIES = new Set([
  ".ssh",
  ".gnupg",
  ".aws",
  // Repository metadata is never listed, and must not be reachable by an
  // explicit content path either: it holds credentialed remotes and hooks
  // that execute on the next git command.
  ".git",
  // Also denied as a directory, not only as a basename: `.env/production`
  // is as sensitive as `.env`.
  ".env",
]);

export const SENSITIVE_WORKSPACE_BASENAMES = new Set([
  ".env",
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  ".gitconfig",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
]);

export const ALLOWED_ENV_TEMPLATE_BASENAMES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
]);

export const SENSITIVE_WORKSPACE_EXTENSIONS = new Set([
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
]);

export function isSensitiveWorkspacePath(relativePath: string): boolean {
  const components = relativePath
    .split("/")
    .map((component) => component.toLowerCase());
  if (
    components.some((component) =>
      SENSITIVE_WORKSPACE_DIRECTORIES.has(component),
    )
  ) {
    return true;
  }
  const basename = components.at(-1) ?? "";
  if (ALLOWED_ENV_TEMPLATE_BASENAMES.has(basename)) return false;
  return (
    SENSITIVE_WORKSPACE_BASENAMES.has(basename) ||
    (basename.startsWith(".env.") &&
      !ALLOWED_ENV_TEMPLATE_BASENAMES.has(basename)) ||
    SENSITIVE_WORKSPACE_EXTENSIONS.has(
      path.posix.extname(basename).toLowerCase(),
    )
  );
}

// Save temporaries are `.sedes-<name>-<uuid>.tmp` beside their target. A
// hard kill can orphan one; it must never appear as a workspace file.
const WRITE_TEMPORARY_PATTERN = /(^|\/)\.sedes-.*-[0-9a-f-]{36}\.tmp$/u;

export function isWorkspaceFileWriteTemporaryPath(
  relativePath: string,
): boolean {
  return WRITE_TEMPORARY_PATTERN.test(relativePath);
}
