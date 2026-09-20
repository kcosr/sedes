import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  directoryBrowseEntrySchema,
  directoryBrowsePathSchema,
  directoryBrowseResultSchema,
  type DirectoryBrowseResult,
} from "../../shared/protocol/directory-browser.js";
import type { EnvironmentSummary } from "../../shared/protocol/domain.js";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  pathForOpenDescriptor,
  revalidatedPathForOpenHandle,
} from "../local-file-descriptor-path.js";
import {
  commandEnvironment,
  executePosixShellCommand,
} from "../runtime/command-execution.js";
import {
  ExecutionWorkspaceAdmissionDeniedError,
  type ExecutionCommandRequest,
  type ExecutionCommandResult,
  type ExecutionDirectoryBrowseRequest,
  type ExecutionEnvironmentLease,
  type ExecutionEnvironmentLeaseRequest,
  type ExecutionEnvironmentProvider,
  type ExecutionScope,
  type ValidatedWorkspace,
} from "./contracts.js";
import { pathIsWithin } from "../path-containment.js";

export interface LocalExecutionEnvironmentOptions {
  readonly environmentId: string;
  readonly scope: RequestScope;
  readonly allowedRoots: readonly string[];
  readonly label?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly workspaceTrusted?: (
    canonicalPath: string,
  ) => boolean | Promise<boolean>;
  readonly configurationRevision: number;
  readonly activeConfigurationRevision: () => number | Promise<number>;
}

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

function isWithin(root: string, candidate: string): boolean {
  return pathIsWithin(root, candidate);
}

async function canonicalDirectory(candidate: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch (error) {
    throw new Error(
      filesystemErrorCode(error) === "ENOENT" ||
        filesystemErrorCode(error) === "ENOTDIR"
        ? "workspace_missing"
        : "workspace_not_allowed",
      { cause: error },
    );
  }
  try {
    if (!(await stat(canonical)).isDirectory()) {
      throw new Error("workspace_missing");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "workspace_missing") {
      throw error;
    }
    throw new Error(
      filesystemErrorCode(error) === "ENOENT" ||
        filesystemErrorCode(error) === "ENOTDIR"
        ? "workspace_missing"
        : "workspace_not_allowed",
      { cause: error },
    );
  }
  return canonical;
}

function filesystemErrorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

interface LocalDirectoryCursor {
  readonly version: 1;
  readonly environmentId: string;
  readonly authorityRevision: number;
  readonly kind: "roots" | "directory";
  readonly pathFingerprint: string;
  readonly pageSize: number;
  readonly offset: number;
  readonly directoryIdentity?: string;
}

const MAXIMUM_DIRECTORY_SCAN_ENTRIES = 10_000;
const MAXIMUM_DIRECTORY_SCAN_PROJECTION_BYTES = 1024 * 1024;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("directory_browse_cancelled");
  }
}

function directoryIdentity(value: {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}): string {
  return `${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
}

/**
 * Local host execution and workspace validation without backend knowledge.
 *
 * Conversation actors own leases. A backend may use the validated workspace,
 * but it never releases the lease itself.
 */
export class LocalExecutionEnvironment implements ExecutionEnvironmentProvider {
  readonly environment: EnvironmentSummary;
  readonly #scope: RequestScope;
  readonly #roots: Promise<readonly string[]>;
  readonly #workspaceIds = new Map<string, string>();
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #workspaceTrusted: (
    canonicalPath: string,
  ) => boolean | Promise<boolean>;
  readonly #leases = new Set<object>();
  readonly #configurationRevision: number;
  readonly #activeConfigurationRevision: () => number | Promise<number>;
  readonly #directoryCursorKey = randomBytes(32);
  #closed = false;

  constructor(options: LocalExecutionEnvironmentOptions) {
    if (options.allowedRoots.length === 0) {
      throw new Error("local_execution_roots_required");
    }
    if (options.allowedRoots.length > 256) {
      throw new Error("local_execution_roots_limit_exceeded");
    }
    if (options.allowedRoots.some((root) => !path.isAbsolute(root))) {
      throw new Error("local_execution_root_not_absolute");
    }
    if (
      options.allowedRoots.some(
        (root) => !directoryBrowsePathSchema.safeParse(root).success,
      )
    ) {
      throw new Error("local_execution_root_not_browseable");
    }
    this.#scope = options.scope;
    this.#environment = options.environment ?? process.env;
    this.#workspaceTrusted = options.workspaceTrusted ?? (() => false);
    if (
      !Number.isSafeInteger(options.configurationRevision) ||
      options.configurationRevision < 0
    ) {
      throw new Error("local_execution_configuration_revision_invalid");
    }
    this.#configurationRevision = options.configurationRevision;
    this.#activeConfigurationRevision = options.activeConfigurationRevision;
    this.#roots = Promise.all(
      [...new Set(options.allowedRoots.map((root) => path.resolve(root)))].map(
        async (root) => {
          const canonical = await canonicalDirectory(root);
          if (!directoryBrowsePathSchema.safeParse(canonical).success) {
            throw new Error("local_execution_root_not_browseable");
          }
          return canonical;
        },
      ),
    );
    // Root canonicalization starts eagerly so every later admission uses one
    // immutable authority set. Attach a handler immediately: configuration
    // errors may settle before the first workspace request reaches this
    // provider, and must not become process-level unhandled rejections.
    void this.#roots.catch(() => undefined);
    this.environment = {
      id: options.environmentId,
      label: options.label ?? "Local",
      availability: "available",
      diagnosticCode: null,
      revision: 0,
    };
  }

  async listEnvironments(
    scope: ExecutionScope,
  ): Promise<readonly EnvironmentSummary[]> {
    return !this.#closed && sameScope(scope, this.#scope)
      ? [this.environment]
      : [];
  }

  directoryBrowsingAvailability(
    scope: ExecutionScope,
    environmentId: string,
  ): "available" | "unavailable" {
    return !this.#closed &&
      sameScope(scope, this.#scope) &&
      environmentId === this.environment.id
      ? "available"
      : "unavailable";
  }

  async browseDirectories(
    scope: ExecutionScope,
    request: ExecutionDirectoryBrowseRequest,
  ): Promise<DirectoryBrowseResult> {
    await this.#assertActive(scope, request.environmentId);
    throwIfAborted(request.signal);
    const roots = await this.#roots.catch(() => {
      throw new Error("directory_browse_not_allowed");
    });
    if (request.location.kind === "roots") {
      const cursor = request.cursor
        ? this.#decodeDirectoryCursor(request.cursor)
        : undefined;
      if (
        cursor &&
        (cursor.kind !== "roots" ||
          cursor.pathFingerprint !== "" ||
          cursor.pageSize !== request.pageSize)
      ) {
        throw new Error("directory_browse_cursor_invalid");
      }
      const offset = cursor?.offset ?? 0;
      const entries = roots
        .map((root) => ({ name: path.basename(root) || root, path: root }))
        .sort(
          (left, right) =>
            left.name.localeCompare(right.name) ||
            left.path.localeCompare(right.path),
        );
      const page = entries.slice(offset, offset + request.pageSize);
      const nextOffset = offset + page.length;
      const nextCursor =
        nextOffset < entries.length
          ? this.#encodeDirectoryCursor({
              version: 1,
              environmentId: this.environment.id,
              authorityRevision: this.#configurationRevision,
              kind: "roots",
              pathFingerprint: "",
              pageSize: request.pageSize,
              offset: nextOffset,
            })
          : undefined;
      return directoryBrowseResultSchema.parse({
        location: { kind: "roots" },
        entries: page,
        ...(nextCursor ? { nextCursor } : {}),
        truncated: false,
      });
    }

    if (!path.isAbsolute(request.location.path)) {
      throw new Error("directory_browse_not_allowed");
    }
    let candidateStat;
    let canonicalPath: string;
    try {
      candidateStat = await lstat(request.location.path);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
        throw new Error("directory_browse_not_allowed");
      }
      canonicalPath = await realpath(request.location.path);
    } catch {
      throw new Error("directory_browse_not_allowed");
    }
    const containingRoot = roots
      .filter((root) => isWithin(root, canonicalPath))
      .sort((left, right) => right.length - left.length)[0];
    if (!containingRoot) throw new Error("directory_browse_not_allowed");

    let handle;
    try {
      handle = await open(
        canonicalPath,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      const before = await handle.stat();
      if (!before.isDirectory())
        throw new Error("directory_browse_not_allowed");
      const identity = directoryIdentity(before);
      const cursor = request.cursor
        ? this.#decodeDirectoryCursor(request.cursor)
        : undefined;
      if (
        cursor &&
        (cursor.kind !== "directory" ||
          cursor.pathFingerprint !==
            this.#directoryPathFingerprint(canonicalPath) ||
          cursor.pageSize !== request.pageSize ||
          cursor.directoryIdentity !== identity)
      ) {
        throw new Error("directory_browse_cursor_invalid");
      }
      throwIfAborted(request.signal);
      const entries: { name: string; path: string }[] = [];
      let scanTruncated = false;
      let scanned = 0;
      let projectedBytes = 0;
      const openedPath = await revalidatedPathForOpenHandle(
        handle,
        canonicalPath,
      );
      if (openedPath !== canonicalPath) {
        throw new Error("directory_browse_not_allowed");
      }
      const directory = await opendir(
        pathForOpenDescriptor(handle.fd, openedPath),
      );
      try {
        for await (const value of directory) {
          throwIfAborted(request.signal);
          scanned += 1;
          if (scanned > MAXIMUM_DIRECTORY_SCAN_ENTRIES) {
            scanTruncated = true;
            break;
          }
          if (
            value.name.startsWith(".") ||
            value.isSymbolicLink() ||
            !value.isDirectory()
          ) {
            continue;
          }
          const entryPath = path.join(canonicalPath, value.name);
          const entry = { name: value.name, path: entryPath };
          if (!directoryBrowseEntrySchema.safeParse(entry).success) continue;
          try {
            const entryStat = await lstat(entryPath);
            if (!entryStat.isDirectory() || entryStat.isSymbolicLink())
              continue;
          } catch {
            continue;
          }
          const entryBytes =
            Buffer.byteLength(value.name, "utf8") +
            Buffer.byteLength(entryPath, "utf8");
          if (
            projectedBytes + entryBytes >
            MAXIMUM_DIRECTORY_SCAN_PROJECTION_BYTES
          ) {
            scanTruncated = true;
            break;
          }
          projectedBytes += entryBytes;
          entries.push(entry);
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      const after = await handle.stat();
      if (directoryIdentity(after) !== identity) {
        throw new Error("directory_browse_cursor_invalid");
      }
      entries.sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.path.localeCompare(right.path),
      );
      const offset = cursor?.offset ?? 0;
      if (offset > entries.length) {
        throw new Error("directory_browse_cursor_invalid");
      }
      const page = entries.slice(offset, offset + request.pageSize);
      const nextOffset = offset + page.length;
      const nextCursor =
        nextOffset < entries.length
          ? this.#encodeDirectoryCursor({
              version: 1,
              environmentId: this.environment.id,
              authorityRevision: this.#configurationRevision,
              kind: "directory",
              pathFingerprint: this.#directoryPathFingerprint(canonicalPath),
              pageSize: request.pageSize,
              offset: nextOffset,
              directoryIdentity: identity,
            })
          : undefined;
      const parent = path.dirname(canonicalPath);
      return directoryBrowseResultSchema.parse({
        location: {
          kind: "directory",
          path: canonicalPath,
          ...(canonicalPath !== containingRoot &&
          isWithin(containingRoot, parent)
            ? { parentPath: parent }
            : {}),
        },
        entries: page,
        ...(nextCursor ? { nextCursor } : {}),
        truncated: scanTruncated,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "directory_browse_cursor_invalid" ||
          error.message === "directory_browse_cancelled")
      ) {
        throw error;
      }
      throw new Error("directory_browse_not_allowed");
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async validateWorkspace(
    scope: ExecutionScope,
    environmentId: string,
    candidatePath: string,
  ): Promise<ValidatedWorkspace> {
    await this.#assertActive(scope, environmentId);
    if (!path.isAbsolute(candidatePath)) {
      throw new ExecutionWorkspaceAdmissionDeniedError();
    }
    const roots = await this.#roots.catch(() => {
      throw new Error("workspace_not_allowed");
    });
    // Do not reveal whether an arbitrary path outside operator-owned roots
    // exists. Only lexically admitted candidates may receive the distinct
    // moved-or-removed classification; canonical containment is checked again
    // below to reject symlink escape.
    const lexicalPath = path.resolve(candidatePath);
    if (!roots.some((root) => isWithin(root, lexicalPath))) {
      throw new ExecutionWorkspaceAdmissionDeniedError();
    }
    const canonicalPath = await canonicalDirectory(candidatePath);
    if (!roots.some((root) => isWithin(root, canonicalPath))) {
      throw new ExecutionWorkspaceAdmissionDeniedError();
    }
    const id = this.#workspaceIds.get(canonicalPath) ?? randomUUID();
    this.#workspaceIds.set(canonicalPath, id);
    return {
      canonicalPath,
      authorityRevision: this.#configurationRevision,
      summary: {
        id,
        environmentId: this.environment.id,
        displayName: path.basename(canonicalPath) || canonicalPath,
        displayPath: canonicalPath,
        availability: "available",
        trustState: (await this.#workspaceTrusted(canonicalPath))
          ? "trusted"
          : "untrusted",
        revision: 0,
      },
    };
  }

  async revalidateWorkspace(
    scope: ExecutionScope,
    workspace: ValidatedWorkspace,
  ): Promise<ValidatedWorkspace> {
    const reopened = await this.validateWorkspace(
      scope,
      workspace.summary.environmentId,
      workspace.canonicalPath,
    );
    this.#workspaceIds.set(reopened.canonicalPath, workspace.summary.id);
    return {
      ...reopened,
      summary: {
        ...reopened.summary,
        id: workspace.summary.id,
        revision: workspace.summary.revision,
      },
    };
  }

  async acquireLease(
    scope: ExecutionScope,
    request: ExecutionEnvironmentLeaseRequest,
  ): Promise<ExecutionEnvironmentLease> {
    await this.#assertActive(scope, request.environmentId);
    if (request.workspace.authorityRevision !== this.#configurationRevision) {
      throw new Error("workspace_authority_stale");
    }
    const workspace = await this.revalidateWorkspace(scope, request.workspace);
    if (workspace.canonicalPath !== request.workspace.canonicalPath) {
      throw new Error("workspace_identity_changed");
    }
    const token = {};
    this.#leases.add(token);
    let released = false;
    return {
      scope,
      environment: this.environment,
      workspace,
      release: async () => {
        if (released) return;
        released = true;
        this.#leases.delete(token);
      },
    };
  }

  async executeCommand(
    scope: ExecutionScope,
    request: ExecutionCommandRequest,
  ): Promise<ExecutionCommandResult> {
    await this.#assertActive(scope, request.environmentId);
    if (request.workspace.authorityRevision !== this.#configurationRevision) {
      throw new Error("workspace_authority_stale");
    }
    const workspace = await this.revalidateWorkspace(scope, request.workspace);
    if (workspace.canonicalPath !== request.workspace.canonicalPath) {
      throw new Error("workspace_identity_changed");
    }
    return executePosixShellCommand({
      command: request.command,
      cwd: workspace.canonicalPath,
      timeoutMilliseconds: request.timeoutMilliseconds,
      environment: commandEnvironment(this.#environment),
      ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  close(): void {
    if (this.#leases.size > 0) {
      throw new Error("local_execution_leases_active");
    }
    this.#closed = true;
  }

  get activeLeaseCount(): number {
    return this.#leases.size;
  }

  #encodeDirectoryCursor(cursor: LocalDirectoryCursor): string {
    const body = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    const signature = createHmac("sha256", this.#directoryCursorKey)
      .update(body)
      .digest("base64url");
    return `${body}.${signature}`;
  }

  #directoryPathFingerprint(value: string): string {
    return createHmac("sha256", this.#directoryCursorKey)
      .update(`directory-path\0${value}`)
      .digest("base64url");
  }

  #decodeDirectoryCursor(value: string): LocalDirectoryCursor {
    const [body, signature, extra] = value.split(".");
    if (!body || !signature || extra !== undefined) {
      throw new Error("directory_browse_cursor_invalid");
    }
    const expected = createHmac("sha256", this.#directoryCursorKey)
      .update(body)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new Error("directory_browse_cursor_invalid");
    }
    if (
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      throw new Error("directory_browse_cursor_invalid");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw new Error("directory_browse_cursor_invalid");
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("environmentId" in parsed) ||
      parsed.environmentId !== this.environment.id ||
      !("authorityRevision" in parsed) ||
      parsed.authorityRevision !== this.#configurationRevision ||
      !("kind" in parsed) ||
      (parsed.kind !== "roots" && parsed.kind !== "directory") ||
      !("pathFingerprint" in parsed) ||
      typeof parsed.pathFingerprint !== "string" ||
      parsed.pathFingerprint.length > 64 ||
      !("pageSize" in parsed) ||
      !Number.isSafeInteger(parsed.pageSize) ||
      !("offset" in parsed) ||
      !Number.isSafeInteger(parsed.offset) ||
      (parsed.offset as number) < 0 ||
      ("directoryIdentity" in parsed &&
        typeof parsed.directoryIdentity !== "string")
    ) {
      throw new Error("directory_browse_cursor_invalid");
    }
    return parsed as unknown as LocalDirectoryCursor;
  }

  #assertAvailable(scope: RequestScope, environmentId: string): void {
    if (
      this.#closed ||
      !sameScope(scope, this.#scope) ||
      environmentId !== this.environment.id
    ) {
      throw new Error("execution_environment_unavailable");
    }
  }

  async #assertActive(
    scope: RequestScope,
    environmentId: string,
  ): Promise<void> {
    this.#assertAvailable(scope, environmentId);
    let activeRevision: number;
    try {
      activeRevision = await this.#activeConfigurationRevision();
    } catch {
      throw new Error("execution_environment_configuration_unavailable");
    }
    if (activeRevision !== this.#configurationRevision) {
      throw new Error("execution_environment_configuration_stale");
    }
  }
}
