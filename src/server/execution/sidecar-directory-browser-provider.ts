import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  isNormalizedRemotePath,
  isWithinRemoteRoot,
  remotePath,
  type RemotePlatform,
} from "./remote-path.js";
import {
  SidecarOperationError,
  SidecarProtocolDeliveryError,
  directoryBrowserListImmediateOperation,
} from "../../internal/sidecar-protocol/index.js";
import {
  directoryBrowseResultSchema,
  type DirectoryBrowseResult,
} from "../../shared/protocol/directory-browser.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import {
  SidecarUnavailableError,
  type SidecarRuntimeOwner,
} from "../sidecar/sidecar-runtime.js";
import type {
  ExecutionDirectoryBrowseRequest,
  ExecutionScope,
} from "./contracts.js";

/** Environment-scoped adapter for the managed remote directory browser. */
export class SidecarDirectoryBrowserProvider {
  readonly #paths: ReturnType<typeof remotePath>;
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #policyRoots: readonly string[];
  readonly #runtime: SidecarRuntimeOwner<SidecarClientSession>;
  readonly #rootCursorKey = randomBytes(32);

  constructor(input: {
    readonly platform: RemotePlatform;
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly policyRoots: readonly string[];
    readonly runtime: SidecarRuntimeOwner<SidecarClientSession>;
  }) {
    if (
      !input.scope.tenantId ||
      !input.scope.principalId ||
      !input.environmentId ||
      input.policyRoots.length < 1 ||
      input.policyRoots.length > 16 ||
      input.policyRoots.some(
        (root) => !isNormalizedRemotePath(root, input.platform),
      )
    ) {
      throw new Error("sidecar_directory_browser_configuration_invalid");
    }
    this.#paths = remotePath(input.platform);
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    this.#policyRoots = Object.freeze([...new Set(input.policyRoots)]);
    this.#runtime = input.runtime;
  }

  directoryBrowsingAvailability(
    scope: ExecutionScope,
    environmentId: string,
  ): "available" | "unavailable" {
    return this.#sameAuthority(scope, environmentId)
      ? "available"
      : "unavailable";
  }

  async browseDirectories(
    scope: ExecutionScope,
    request: ExecutionDirectoryBrowseRequest,
  ): Promise<DirectoryBrowseResult> {
    this.#assertAuthority(scope, request.environmentId);
    if (request.signal?.aborted) {
      throw request.signal.reason ?? new Error("directory_browse_cancelled");
    }
    if (request.location.kind === "roots") {
      return this.#browseRoots(request);
    }
    if (request.cursor?.startsWith("roots.")) {
      throw new Error("directory_browse_cursor_invalid");
    }
    const directoryPath = request.location.path;
    const policyRoot = this.#policyRoots
      .filter((root) => isWithinRemoteRoot(directoryPath, root))
      .sort((left, right) => right.length - left.length)[0];
    if (!policyRoot) throw new Error("directory_browse_not_allowed");

    const signal = request.signal ?? new AbortController().signal;
    let lease: Awaited<
      ReturnType<SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]>
    >;
    try {
      lease = await this.#runtime.acquireOperation(
        scope,
        request.environmentId,
        signal,
      );
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw classifySidecarError(error);
    }
    try {
      const result = await lease.session.call(
        directoryBrowserListImmediateOperation,
        {
          rootPath: policyRoot,
          directoryPath,
          pageSize: request.pageSize,
          ...(request.cursor ? { cursor: request.cursor } : {}),
        },
        { signal },
      );
      validateSidecarResponse(result, directoryPath, policyRoot, this.#paths);
      const parent = this.#paths.dirname(result.directoryPath);
      return directoryBrowseResultSchema.parse({
        location: {
          kind: "directory",
          path: result.directoryPath,
          ...(result.directoryPath !== policyRoot &&
          isWithinRemoteRoot(parent, policyRoot)
            ? { parentPath: parent }
            : {}),
        },
        entries: result.entries,
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
        truncated: result.truncated,
      });
    } catch (error) {
      if (signal.aborted) throw signal.reason ?? error;
      throw classifySidecarError(error);
    } finally {
      lease.release();
    }
  }

  #browseRoots(
    request: ExecutionDirectoryBrowseRequest,
  ): DirectoryBrowseResult {
    const decoded = request.cursor
      ? this.#decodeRootCursor(request.cursor)
      : undefined;
    if (decoded && decoded.pageSize !== request.pageSize) {
      throw new Error("directory_browse_cursor_invalid");
    }
    const offset = decoded?.offset ?? 0;
    if (offset > this.#policyRoots.length) {
      throw new Error("directory_browse_cursor_invalid");
    }
    const entries = this.#policyRoots
      .map((root) => ({ name: this.#paths.basename(root) || root, path: root }))
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) ||
          left.path.localeCompare(right.path),
      );
    const page = entries.slice(offset, offset + request.pageSize);
    const nextOffset = offset + page.length;
    return directoryBrowseResultSchema.parse({
      location: { kind: "roots" },
      entries: page,
      ...(nextOffset < entries.length
        ? { nextCursor: this.#encodeRootCursor(nextOffset, request.pageSize) }
        : {}),
      truncated: false,
    });
  }

  #encodeRootCursor(offset: number, pageSize: number): string {
    const payload = `roots.${offset.toString(36)}.${pageSize.toString(36)}`;
    const signature = createHmac("sha256", this.#rootCursorKey)
      .update(`${this.#environmentId}\0${payload}`)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  #decodeRootCursor(cursor: string): {
    readonly offset: number;
    readonly pageSize: number;
  } {
    const [kind, offsetText, pageSizeText, signature, ...extra] =
      cursor.split(".");
    if (
      kind !== "roots" ||
      !offsetText ||
      !pageSizeText ||
      !signature ||
      extra.length
    ) {
      throw new Error("directory_browse_cursor_invalid");
    }
    const payload = `${kind}.${offsetText}.${pageSizeText}`;
    const expected = createHmac("sha256", this.#rootCursorKey)
      .update(`${this.#environmentId}\0${payload}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new Error("directory_browse_cursor_invalid");
    }
    const offset = Number.parseInt(offsetText, 36);
    const pageSize = Number.parseInt(pageSizeText, 36);
    if (
      actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected) ||
      !Number.isSafeInteger(offset) ||
      offset <= 0 ||
      !Number.isSafeInteger(pageSize) ||
      pageSize <= 0
    ) {
      throw new Error("directory_browse_cursor_invalid");
    }
    return { offset, pageSize };
  }

  #sameAuthority(scope: RequestScope, environmentId: string): boolean {
    return (
      scope.tenantId === this.#scope.tenantId &&
      scope.principalId === this.#scope.principalId &&
      environmentId === this.#environmentId
    );
  }

  #assertAuthority(scope: RequestScope, environmentId: string): void {
    if (!this.#sameAuthority(scope, environmentId)) {
      throw new Error("directory_browse_unavailable");
    }
  }
}

function validateSidecarResponse(
  result: {
    readonly directoryPath: string;
    readonly entries: readonly {
      readonly name: string;
      readonly path: string;
    }[];
  },
  requestedDirectoryPath: string,
  policyRoot: string,
  pathsModule: ReturnType<typeof remotePath>,
): void {
  if (result.directoryPath !== requestedDirectoryPath) {
    throw new Error("directory_browser_response_invalid");
  }
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const entry of result.entries) {
    const expectedPath = pathsModule.join(requestedDirectoryPath, entry.name);
    if (
      entry.path !== expectedPath ||
      pathsModule.dirname(entry.path) !== requestedDirectoryPath ||
      pathsModule.basename(entry.path) !== entry.name ||
      !isWithinRemoteRoot(entry.path, policyRoot) ||
      names.has(entry.name) ||
      paths.has(entry.path)
    ) {
      throw new Error("directory_browser_response_invalid");
    }
    names.add(entry.name);
    paths.add(entry.path);
  }
}

function classifySidecarError(error: unknown): Error {
  if (error instanceof SidecarOperationError) {
    if (error.code === "directory_browser_cursor_invalid") {
      return new Error("directory_browse_cursor_invalid", { cause: error });
    }
    if (error.code === "directory_browser_directory_not_found") {
      return new Error("directory_browse_not_allowed", { cause: error });
    }
    if (error.code === "directory_browser_cancelled") {
      return new Error("directory_browse_cancelled", { cause: error });
    }
  }
  if (
    error instanceof SidecarProtocolDeliveryError ||
    error instanceof SidecarUnavailableError ||
    error instanceof SidecarOperationError
  ) {
    return new Error("directory_browse_unavailable", { cause: error });
  }
  return new Error("directory_browse_unavailable", { cause: error });
}
