import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  openVerifiedDirectory,
  pathForOpenDescriptor,
  pathWithinOpenDirectory,
  revalidatedPathForOpenHandle,
} from "../local-file-descriptor-path.js";
import { pathIsWithin } from "../path-containment.js";
import { CanonicalMutationSerializer } from "../workspace-files/canonical-mutation-serializer.js";
import {
  WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES,
  WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES,
  WORKSPACE_TOOLS_MAXIMUM_READ_BYTES,
  WORKSPACE_TOOLS_MAXIMUM_READ_LINES,
  WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES,
} from "../../internal/sidecar-protocol/index.js";
import {
  WorkspaceToolError,
  type WorkspaceToolEdit,
  type WorkspaceToolRoot,
} from "./contracts.js";
import {
  applyWorkspaceToolEdits,
  workspaceToolEditPresentation,
} from "./edit-semantics.js";
import {
  normalizeWorkspaceToolPath,
  resolveContainedExistingPath,
  resolvePiReadPath,
  type WorkspaceToolPathGrammar,
} from "./path-grammar.js";
import {
  WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES,
  WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_ENTRIES,
  WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS,
  WORKSPACE_TOOLS_MAXIMUM_FIND_RESULTS,
  WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS,
  WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES,
  WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES,
} from "../../internal/sidecar-protocol/index.js";
import {
  normalizeDeterministicFind,
  normalizeDeterministicGrep,
  SearchBudgetExceededError,
} from "./deterministic-search.js";
import {
  TrustedSearchExecutableError,
  TrustedSearchExecutableResolver,
  type TrustedSearchExecutableEvidence,
} from "./trusted-search-executables.js";
import { detectWorkspaceToolImageMediaType } from "./image-mime.js";

const DEFAULT_LIST_LIMIT = 500;

export type WorkspaceToolEngineReadResult =
  | {
      readonly path: string;
      readonly contentKind: "text";
      readonly content: string;
      readonly sizeBytes: number;
      readonly totalLines: number;
      readonly startLine: number;
      readonly outputLines: number;
      readonly truncation?: {
        readonly reason: "byte_limit" | "line_limit" | "requested_limit";
        readonly nextOffset: number;
        readonly firstLineBytes?: number;
      };
    }
  | {
      readonly path: string;
      readonly contentKind: "image";
      readonly mediaType:
        "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp";
      readonly contentBase64: string;
      readonly sizeBytes: number;
    };

export interface WorkspaceToolEngineMutationResult {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface WorkspaceToolEngineTestHooks {
  beforeMutationCommit?(destination: string): void | Promise<void>;
}

export class WorkspaceToolEngine {
  readonly #root: WorkspaceToolRoot;
  readonly #pathGrammar: WorkspaceToolPathGrammar;
  readonly #mutations: CanonicalMutationSerializer;
  readonly #search: TrustedSearchExecutableResolver;
  readonly #testHooks: WorkspaceToolEngineTestHooks | undefined;

  constructor(input: {
    readonly root: WorkspaceToolRoot;
    readonly pathGrammar?: WorkspaceToolPathGrammar;
    readonly mutations?: CanonicalMutationSerializer;
    readonly search?: TrustedSearchExecutableResolver;
    readonly testHooks?: WorkspaceToolEngineTestHooks;
  }) {
    this.#root = input.root;
    this.#pathGrammar = input.pathGrammar ?? "semantic";
    this.#mutations = input.mutations ?? new CanonicalMutationSerializer();
    this.#search = input.search ?? new TrustedSearchExecutableResolver();
    this.#testHooks = input.testHooks;
  }

  async validateRoot(): Promise<void> {
    const canonical = await realpath(this.#root.canonicalPath).catch(
      () => undefined,
    );
    const metadata = canonical
      ? await stat(canonical).catch(() => undefined)
      : undefined;
    if (canonical !== this.#root.canonicalPath || !metadata?.isDirectory())
      throw new WorkspaceToolError("workspace_tools_workspace_root_replaced");
  }

  async read(input: {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolEngineReadResult> {
    input.signal?.throwIfAborted();
    await this.validateRoot();
    const absolute = await resolvePiReadPath(input.path, this.#root, this.#pathGrammar);
    const relative = this.#relative(absolute);
    const handle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    ).catch((error) => {
      throw new WorkspaceToolError("workspace_tools_path_not_found", {
        cause: error,
      });
    });
    try {
      const metadata = await handle.stat({ bigint: true });
      if (!metadata.isFile())
        throw new WorkspaceToolError("workspace_tools_path_not_file");
      const maximumSourceBytes = Math.max(
        WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES,
        WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES,
      );
      if (metadata.size > BigInt(maximumSourceBytes))
        throw new WorkspaceToolError("workspace_tools_read_failed");
      const identity = identityToken(metadata);
      const bytes = await boundedDescriptorRead(
        handle,
        Number(metadata.size),
        input.signal,
      );
      await this.#revalidateDescriptor(handle, absolute, identity);
      const mediaType = detectWorkspaceToolImageMediaType(
        bytes.subarray(0, 4_100),
      );
      if (mediaType) {
        if (bytes.byteLength > WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES) {
          throw new WorkspaceToolError("workspace_tools_read_failed");
        }
        return {
          path: relative,
          contentKind: "image",
          mediaType,
          contentBase64: bytes.toString("base64"),
          sizeBytes: bytes.byteLength,
        };
      }
      const text = decodeWorkspaceToolText(bytes);
      const lines = text.split("\n");
      const totalLines = lines.length;
      const startIndex = Math.max(0, (input.offset ?? 1) - 1);
      if (startIndex >= totalLines)
        throw new WorkspaceToolError("workspace_tools_read_failed");
      const requested =
        input.limit === undefined
          ? lines.slice(startIndex)
          : lines.slice(startIndex, startIndex + Math.max(0, input.limit));
      const retained: string[] = [];
      let retainedBytes = 0;
      let reason: "lines" | "bytes" | undefined;
      for (const line of requested) {
        if (retained.length >= WORKSPACE_TOOLS_MAXIMUM_READ_LINES) {
          reason = "lines";
          break;
        }
        const next =
          Buffer.byteLength(line, "utf8") + (retained.length > 0 ? 1 : 0);
        if (retainedBytes + next > WORKSPACE_TOOLS_MAXIMUM_READ_BYTES) {
          reason = "bytes";
          break;
        }
        retained.push(line);
        retainedBytes += next;
      }
      const hasMore = startIndex + retained.length < totalLines;
      return {
        path: relative,
        contentKind: "text",
        content: retained.join("\n"),
        sizeBytes: bytes.byteLength,
        totalLines,
        startLine: startIndex + 1,
        outputLines: retained.length,
        ...(reason || hasMore
          ? {
              truncation: {
                reason:
                  reason === "bytes"
                    ? ("byte_limit" as const)
                    : input.limit !== undefined
                      ? ("requested_limit" as const)
                      : ("line_limit" as const),
                nextOffset: startIndex + retained.length + 1,
                ...(reason === "bytes" && retained.length === 0
                  ? {
                      firstLineBytes: Buffer.byteLength(
                        requested[0] ?? "",
                        "utf8",
                      ),
                    }
                  : {}),
              },
            }
          : {}),
      };
    } finally {
      await handle.close();
    }
  }

  async write(input: {
    readonly path: string;
    readonly content: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolEngineMutationResult> {
    const bytes = Buffer.from(input.content, "utf8");
    if (
      bytes.byteLength > WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES ||
      bytes.includes(0)
    )
      throw new WorkspaceToolError("workspace_tools_write_failed");
    await this.validateRoot();
    const lexical = normalizeWorkspaceToolPath(input.path, this.#root, this.#pathGrammar);
    const parent = await this.#openOrCreateParent(
      path.dirname(lexical),
      input.signal,
    );
    try {
      const parentCanonical = await revalidatedPathForOpenHandle(
        parent,
        path.dirname(lexical),
      );
      if (!parentCanonical)
        throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
      const destination = path.join(parentCanonical, path.basename(lexical));
      return await this.#mutations.run(destination, async () =>
        this.#atomicPublish(parent, destination, bytes, input.signal),
      );
    } finally {
      await parent.close();
    }
  }

  async edit(input: {
    readonly path: string;
    readonly edits: readonly WorkspaceToolEdit[];
    readonly signal?: AbortSignal;
  }): Promise<
    WorkspaceToolEngineMutationResult & {
      readonly replacements: number;
      readonly diff: string;
      readonly patch: string;
      readonly firstChangedLine?: number;
    }
  > {
    await this.validateRoot();
    const absolute = await resolveContainedExistingPath(input.path, this.#root, this.#pathGrammar);
    const parentCanonical = path.dirname(absolute);
    return this.#mutations.run(absolute, async () => {
      input.signal?.throwIfAborted();
      const parent = await openVerifiedDirectory(parentCanonical).catch(
        (error) => {
          throw new WorkspaceToolError(
            "workspace_tools_path_outside_workspace",
            {
              cause: error,
            },
          );
        },
      );
      try {
        const handle = await open(
          pathWithinOpenDirectory(
            parent,
            parentCanonical,
            path.basename(absolute),
          ),
          fsConstants.O_RDONLY |
            fsConstants.O_NOFOLLOW |
            fsConstants.O_NONBLOCK,
        ).catch((error) => {
          throw new WorkspaceToolError("workspace_tools_path_not_found", {
            cause: error,
          });
        });
        let source: Buffer;
        let mode: number;
        try {
          const metadata = await handle.stat({ bigint: true });
          if (
            !metadata.isFile() ||
            metadata.size > BigInt(WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES)
          )
            throw new WorkspaceToolError("workspace_tools_edit_failed");
          const identity = identityToken(metadata);
          source = await boundedDescriptorRead(
            handle,
            Number(metadata.size),
            input.signal,
          );
          await this.#revalidateDescriptor(handle, absolute, identity);
          mode = Number(metadata.mode & 0o777n);
        } finally {
          await handle.close();
        }
        const applied = applyWorkspaceToolEdits(
          decodeWorkspaceToolText(source),
          input.edits,
        );
        const bytes = Buffer.from(applied.content, "utf8");
        if (bytes.byteLength > WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES)
          throw new WorkspaceToolError("workspace_tools_edit_failed");
        const result = await this.#atomicPublish(
          parent,
          absolute,
          bytes,
          input.signal,
          mode,
        );
        return {
          ...result,
          replacements: input.edits.length,
          ...workspaceToolEditPresentation(
            this.#relative(absolute),
            applied.normalizedBefore,
            applied.normalizedAfter,
          ),
        };
      } finally {
        await parent.close();
      }
    });
  }

  async list(input: {
    readonly path?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) {
    await this.validateRoot();
    const absolute = await resolveContainedExistingPath(
      input.path ?? ".",
      this.#root,
      this.#pathGrammar,
    );
    const handle = await openVerifiedDirectory(absolute).catch((error) => {
      throw new WorkspaceToolError("workspace_tools_path_not_directory", {
        cause: error,
      });
    });
    try {
      const openedPath = await revalidatedPathForOpenHandle(handle, absolute);
      if (openedPath !== absolute)
        throw new WorkspaceToolError("workspace_tools_path_not_directory");
      const directory = await opendir(
        pathForOpenDescriptor(handle.fd, openedPath),
      );
      const entries: { name: string; kind: "file" | "directory" | "other" }[] =
        [];
      const maximum = Math.min(
        input.limit ?? DEFAULT_LIST_LIMIT,
        WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES,
      );
      try {
        for await (const entry of directory) {
          input.signal?.throwIfAborted();
          if (entries.length > maximum) break;
          entries.push({
            name: entry.name,
            kind: entry.isFile()
              ? "file"
              : entry.isDirectory()
                ? "directory"
                : "other",
          });
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      entries.sort(
        (left, right) =>
          left.name
            .toLocaleLowerCase()
            .localeCompare(right.name.toLocaleLowerCase()) ||
          left.name.localeCompare(right.name),
      );
      return {
        entries: entries.slice(0, maximum),
        limitReached: entries.length > maximum,
      };
    } finally {
      await handle.close();
    }
  }

  async find(input: {
    readonly pattern: string;
    readonly path?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) {
    await this.validateRoot();
    const base = await resolveContainedExistingPath(
      input.path ?? ".",
      this.#root,
      this.#pathGrammar,
    );
    const admitted = await this.#trustedSearch("fd");
    const started = Date.now();
    const arguments_ = [
      "--glob",
      "--color=never",
      "--hidden",
      "--exclude",
      ".git",
      "--exclude",
      "node_modules",
      "--print0",
    ];
    if (!(await this.#insideGitRepository(base))) {
      arguments_.push("--no-require-git");
    }
    let effectivePattern = input.pattern;
    if (input.pattern.includes("/")) {
      arguments_.push("--full-path");
      if (
        !input.pattern.startsWith("/") &&
        !input.pattern.startsWith("**/") &&
        input.pattern !== "**"
      ) {
        effectivePattern = `**/${input.pattern}`;
      }
    }
    arguments_.push("--", effectivePattern, ".");
    const child = await this.#spawnSearch(admitted, arguments_, {
      cwd: base,
      environment: sanitizedSearchEnvironment(),
    });
    const raw = await collectSearchOutput(
      child,
      WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES,
      WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS,
      input.signal,
    );
    const paths = raw.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .map((candidate) =>
        path.posix.join(
          this.#relative(base) === "." ? "" : this.#relative(base),
          candidate.replace(/^\.\//u, ""),
        ),
      );
    try {
      const normalized = normalizeDeterministicFind(
        {
          paths,
          completed: raw.exitCode === 0,
          scannedEntries: paths.length,
          scannedBytes: raw.stdout.byteLength,
          durationMilliseconds: Date.now() - started,
        },
        {
          maximumScannedEntries: WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_ENTRIES,
          maximumScannedBytes: WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES,
          maximumDurationMilliseconds:
            WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS,
          maximumResults: input.limit ?? 1_000,
          maximumResultBytes: WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES,
        },
      );
      return {
        paths: [...normalized.paths],
        limitReached: normalized.truncated,
        ...(normalized.truncated
          ? {
              outputTruncation: {
                retainedBytes: Buffer.byteLength(
                  normalized.paths.join("\n"),
                  "utf8",
                ),
                omittedItems: Math.max(
                  1,
                  paths.length - normalized.paths.length,
                ),
                reason:
                  normalized.paths.length >= (input.limit ?? 1_000)
                    ? ("item_limit" as const)
                    : ("byte_limit" as const),
              },
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof SearchBudgetExceededError)
        throw new WorkspaceToolError("workspace_tools_search_budget_exceeded", {
          cause: error,
        });
      throw error;
    }
  }

  async grep(input: {
    readonly pattern: string;
    readonly path?: string;
    readonly glob?: string;
    readonly ignoreCase?: boolean;
    readonly literal?: boolean;
    readonly context?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }) {
    await this.validateRoot();
    const base = await resolveContainedExistingPath(
      input.path ?? ".",
      this.#root,
      this.#pathGrammar,
    );
    const admitted = await this.#trustedSearch("rg");
    const arguments_ = [
      "--json",
      "--line-number",
      "--column",
      "--color=never",
      "--hidden",
      "--sort",
      "path",
      "--glob",
      "!.git",
      "--glob",
      "!node_modules",
      ...(input.glob ? ["--glob", input.glob] : []),
      ...(input.ignoreCase ? ["--ignore-case"] : []),
      ...(input.literal ? ["--fixed-strings"] : []),
      ...(input.context !== undefined
        ? ["--context", String(input.context)]
        : []),
      "--",
      input.pattern,
      ".",
    ];
    const child = await this.#spawnSearch(admitted, arguments_, {
      cwd: base,
      environment: sanitizedSearchEnvironment(),
    });
    const raw = await collectSearchOutput(
      child,
      WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES,
      WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS,
      input.signal,
    );
    if (raw.exitCode !== 0 && raw.exitCode !== 1)
      throw new WorkspaceToolError("workspace_tools_search_failed");
    const parsedRows = raw.stdout
      .toString("utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const record = JSON.parse(line) as {
            type?: string;
            data?: {
              path?: { text?: string };
              line_number?: number;
              lines?: { text?: string };
              submatches?: { start?: number }[];
            };
          };
          if (
            (record.type !== "match" && record.type !== "context") ||
            !record.data?.path?.text ||
            !record.data.line_number
          )
            return [];
          const relativeBase = this.#relative(base);
          const resultPath = path.posix.join(
            relativeBase === "." ? "" : relativeBase,
            record.data.path.text.replace(/^\.\//u, ""),
          );
          const full = (record.data.lines?.text ?? "").replace(/\r?\n$/u, "");
          const lineText =
            full.length > WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS
              ? `${full.slice(0, WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS)}... [truncated]`
              : full;
          return [
            {
              path: resultPath,
              line: record.data.line_number,
              column: (record.data.submatches?.[0]?.start ?? 0) + 1,
              text: lineText,
              lineTruncated: lineText !== full,
              isMatch: record.type === "match",
            },
          ];
        } catch {
          throw new WorkspaceToolError("workspace_tools_search_failed");
        }
      });
    const matchRows = parsedRows.filter((row) => row.isMatch);
    const effectiveLimit = input.limit ?? 100;
    const normalized = normalizeDeterministicGrep(matchRows, {
      maximumResults: effectiveLimit,
      maximumResultBytes: WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES,
    });
    const selectedMatches = normalized.matches.map((match) => {
      const source = matchRows.find(
        (candidate) =>
          candidate.path === match.path &&
          candidate.line === match.line &&
          candidate.column === match.column,
      );
      return { ...match, lineTruncated: source?.lineTruncated ?? false };
    });
    const contextLines = input.context ?? 0;
    const presentationRows: {
      path: string;
      line: number;
      column: number;
      lineText: string;
      lineTruncated: boolean;
      isMatch: boolean;
    }[] = [];
    let presentationBytes = 0;
    let presentationOmitted = 0;
    for (const selected of selectedMatches) {
      const block = parsedRows
        .filter(
          (candidate) =>
            candidate.path === selected.path &&
            candidate.line >= selected.line - contextLines &&
            candidate.line <= selected.line + contextLines,
        )
        .sort((left, right) => left.line - right.line);
      for (const row of block) {
        const isMatch = row.line === selected.line;
        const candidate = {
          path: row.path,
          line: row.line,
          column: isMatch ? selected.column : 1,
          lineText: row.text,
          lineTruncated: row.lineTruncated,
          isMatch,
        };
        const bytes = Buffer.byteLength(
          `${candidate.path}:${candidate.line}:${candidate.column}:${candidate.lineText}\n`,
          "utf8",
        );
        if (
          presentationRows.length >= WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES ||
          presentationBytes + bytes >
            WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES
        ) {
          presentationOmitted += 1;
          continue;
        }
        presentationRows.push(candidate);
        presentationBytes += bytes;
      }
    }
    return {
      matches: presentationRows,
      matchLimitReached: normalized.truncated,
      ...(normalized.truncated || presentationOmitted > 0
        ? {
            outputTruncation: {
              retainedBytes: presentationBytes,
              omittedItems: Math.max(
                1,
                matchRows.length -
                  normalized.matches.length +
                  presentationOmitted,
              ),
              reason:
                normalized.matches.length >= effectiveLimit
                  ? ("item_limit" as const)
                  : ("byte_limit" as const),
            },
          }
        : {}),
    };
  }

  async #atomicPublish(
    parent: FileHandle,
    destination: string,
    bytes: Buffer,
    signal?: AbortSignal,
    mode = 0o644,
  ): Promise<WorkspaceToolEngineMutationResult> {
    signal?.throwIfAborted();
    const canonicalParent = path.dirname(destination);
    const parentPath = pathForOpenDescriptor(parent.fd, canonicalParent);
    const name = path.basename(destination);
    const temporaryPath = path.join(
      parentPath,
      `.sedes-tool-${name}-${randomUUID()}.tmp`,
    );
    const temporary = await open(
      temporaryPath,
      fsConstants.O_WRONLY |
        fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_NOFOLLOW,
      0o600,
    );
    let remove = true;
    try {
      await temporary.writeFile(bytes);
      await temporary.chmod(mode);
      await temporary.sync();
      signal?.throwIfAborted();
      await this.#testHooks?.beforeMutationCommit?.(destination);
      signal?.throwIfAborted();
      const openedParent = await revalidatedPathForOpenHandle(
        parent,
        canonicalParent,
      );
      if (
        openedParent !== path.dirname(destination) ||
        !pathIsWithin(this.#root.canonicalPath, openedParent)
      )
        throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
      const current = await lstat(path.join(parentPath, name)).catch(
        () => undefined,
      );
      if (current?.isSymbolicLink() || current?.isDirectory())
        throw new WorkspaceToolError("workspace_tools_path_symlink_denied");
      await temporary.close();
      await rename(temporaryPath, path.join(parentPath, name));
      remove = false;
      if (process.platform !== "win32") await parent.sync();
      return {
        path: this.#relative(destination),
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    } finally {
      await temporary.close().catch(() => undefined);
      if (remove) await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async #trustedSearch(
    kind: "fd" | "rg",
  ): Promise<TrustedSearchExecutableEvidence> {
    try {
      return await this.#search.resolve(kind);
    } catch (error) {
      if (error instanceof TrustedSearchExecutableError) {
        throw new WorkspaceToolError(
          "workspace_tools_search_prerequisite_unavailable",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #spawnSearch(
    admitted: TrustedSearchExecutableEvidence,
    arguments_: readonly string[],
    input: {
      readonly cwd: string;
      readonly environment: NodeJS.ProcessEnv;
    },
  ) {
    try {
      return await this.#search.spawn(admitted, arguments_, input);
    } catch (error) {
      if (error instanceof TrustedSearchExecutableError) {
        throw new WorkspaceToolError(
          "workspace_tools_search_prerequisite_unavailable",
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #insideGitRepository(base: string): Promise<boolean> {
    let current = base;
    for (;;) {
      if (await lstat(path.join(current, ".git")).catch(() => undefined)) {
        return true;
      }
      if (current === this.#root.canonicalPath) return false;
      const parent = path.dirname(current);
      if (
        parent === current ||
        !pathIsWithin(this.#root.canonicalPath, parent)
      ) {
        return false;
      }
      current = parent;
    }
  }

  async #openOrCreateParent(
    parentPath: string,
    signal?: AbortSignal,
  ): Promise<FileHandle> {
    const relative = path.relative(this.#root.canonicalPath, parentPath);
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
    let handle = await openVerifiedDirectory(this.#root.canonicalPath);
    let canonicalParent = this.#root.canonicalPath;
    try {
      for (const segment of relative.split(path.sep).filter(Boolean)) {
        signal?.throwIfAborted();
        const expectedChild = path.join(canonicalParent, segment);
        const child = pathWithinOpenDirectory(handle, canonicalParent, segment);
        let next = await openVerifiedDirectory(child).catch(() => undefined);
        if (!next) {
          await mkdir(child, { mode: 0o755 }).catch((error: unknown) => {
            throw new WorkspaceToolError(
              "workspace_tools_path_outside_workspace",
              { cause: error },
            );
          });
          next = await openVerifiedDirectory(child).catch((error) => {
            throw new WorkspaceToolError(
              "workspace_tools_path_outside_workspace",
              { cause: error },
            );
          });
        }
        const canonical = await revalidatedPathForOpenHandle(
          next,
          expectedChild,
        );
        if (
          canonical !== expectedChild ||
          !pathIsWithin(this.#root.canonicalPath, canonical)
        ) {
          await next.close();
          throw new WorkspaceToolError(
            "workspace_tools_path_outside_workspace",
          );
        }
        await handle.close();
        handle = next;
        canonicalParent = canonical;
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async #revalidateDescriptor(
    handle: FileHandle,
    expectedPath: string,
    identity: string,
  ): Promise<void> {
    const [openedPath, metadata] = await Promise.all([
      revalidatedPathForOpenHandle(handle, expectedPath),
      handle.stat({ bigint: true }).catch(() => undefined),
    ]);
    if (
      openedPath !== expectedPath ||
      !metadata?.isFile() ||
      identityToken(metadata) !== identity ||
      !pathIsWithin(this.#root.canonicalPath, openedPath)
    )
      throw new WorkspaceToolError("workspace_tools_path_unstable");
  }

  #relative(absolute: string): string {
    if (!pathIsWithin(this.#root.canonicalPath, absolute))
      throw new WorkspaceToolError("workspace_tools_path_outside_workspace");
    return (
      path
        .relative(this.#root.canonicalPath, absolute)
        .split(path.sep)
        .join("/") || "."
    );
  }
}

async function boundedDescriptorRead(
  handle: FileHandle,
  size: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    signal?.throwIfAborted();
    const read = await handle.read(bytes, offset, size - offset, offset);
    if (read.bytesRead === 0) break;
    offset += read.bytesRead;
  }
  if (offset !== size)
    throw new WorkspaceToolError("workspace_tools_read_failed");
  return bytes;
}

function identityToken(metadata: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
}

function decodeWorkspaceToolText(bytes: Uint8Array): string {
  // Pi 0.83 uses Buffer.toString("utf-8"): malformed sequences become U+FFFD,
  // NUL is preserved, and the leading BOM remains available to edit semantics.
  return Buffer.from(bytes).toString("utf8");
}

function sanitizedSearchEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin:/usr/local/bin",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
  };
}

async function collectSearchOutput(
  child: import("node:child_process").ChildProcessWithoutNullStreams,
  maximumBytes: number,
  maximumMilliseconds: number,
  signal?: AbortSignal,
): Promise<{ stdout: Buffer; exitCode: number | null }> {
  return await new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, maximumMilliseconds);
    signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) stop();
      else chunks.push(chunk);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted)
        reject(
          signal.reason ?? new WorkspaceToolError("workspace_tools_cancelled"),
        );
      else if (bytes > maximumBytes)
        reject(
          new WorkspaceToolError("workspace_tools_search_budget_exceeded"),
        );
      else resolve({ stdout: Buffer.concat(chunks), exitCode });
    });
  });
}
