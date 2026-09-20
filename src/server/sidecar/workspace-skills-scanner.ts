import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  WORKSPACE_SKILLS_MAXIMUM_DEPTH,
  WORKSPACE_SKILLS_MAXIMUM_DIAGNOSTICS,
  WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES,
  WORKSPACE_SKILLS_MAXIMUM_SCAN_ENTRIES,
  WORKSPACE_SKILLS_MAXIMUM_SKILLS,
  type WorkspaceSkillDiagnostic,
  type WorkspaceSkillMetadata,
  type WorkspaceSkillsCatalogReadResponse,
} from "../../internal/sidecar-protocol/index.js";
import { revalidatedPathForOpenHandle } from "../local-file-descriptor-path.js";

type SkillSource = WorkspaceSkillMetadata["source"];

export type WorkspaceSkillsScannerErrorCode =
  | "workspace_skills_not_allowed"
  | "workspace_skills_unstable"
  | "workspace_skills_limit_exceeded";

export class WorkspaceSkillsScannerError extends Error {
  readonly code: WorkspaceSkillsScannerErrorCode;

  constructor(code: WorkspaceSkillsScannerErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "WorkspaceSkillsScannerError";
    this.code = code;
  }
}

interface ScannedSkill extends WorkspaceSkillMetadata {
  readonly content: string;
}

export interface WorkspaceSkillsScanResult extends WorkspaceSkillsCatalogReadResponse {
  readonly resolvedSkills: ReadonlyMap<string, ScannedSkill>;
}

interface Root {
  readonly source: SkillSource;
  readonly rootPath: string;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

class UnstablePathError extends Error {}

/**
 * Scans only the fixed account and workspace Agent Skills roots. It never
 * follows symlinks, executes files, loads settings, or accepts additional
 * paths from the caller.
 */
export async function scanWorkspaceSkills(input: {
  readonly workspacePath: string;
  readonly policyRootPath: string;
  readonly homeDirectory?: string;
  readonly signal?: AbortSignal;
}): Promise<WorkspaceSkillsScanResult> {
  input.signal?.throwIfAborted();
  const workspacePath = await canonicalWorkspace(
    input.workspacePath,
    input.policyRootPath,
  );
  const homePath = await realpath(input.homeDirectory ?? homedir()).catch(
    (error) => {
      throw new WorkspaceSkillsScannerError("workspace_skills_not_allowed", {
        cause: error,
      });
    },
  );
  const roots: readonly Root[] = [
    {
      source: "account_pi",
      rootPath: path.join(homePath, ".pi", "agent", "skills"),
    },
    {
      source: "account_agents",
      rootPath: path.join(homePath, ".agents", "skills"),
    },
    {
      source: "workspace_pi",
      rootPath: path.join(workspacePath, ".pi", "skills"),
    },
    {
      source: "workspace_agents",
      rootPath: path.join(workspacePath, ".agents", "skills"),
    },
  ];

  try {
    return await scanRoots(roots, input.signal);
  } catch (error) {
    if (error instanceof WorkspaceSkillsScannerError) throw error;
    if (error instanceof UnstablePathError) {
      throw new WorkspaceSkillsScannerError("workspace_skills_unstable", {
        cause: error,
      });
    }
    throw error;
  }
}

async function scanRoots(
  roots: readonly Root[],
  signal?: AbortSignal,
): Promise<WorkspaceSkillsScanResult> {
  const winners = new Map<string, ScannedSkill>();
  const diagnostics: WorkspaceSkillDiagnostic[] = [];
  let scannedEntries = 0;

  for (const root of roots) {
    signal?.throwIfAborted();
    if (!(await isCanonicalDirectory(root.rootPath))) continue;
    const pending = [{ directoryPath: root.rootPath, depth: 0 }];
    while (pending.length > 0) {
      signal?.throwIfAborted();
      const current = pending.shift();
      if (!current) break;
      const directory = await openVerifiedDirectory(
        current.directoryPath,
        root.rootPath,
      );
      try {
        const entries = await readdir(current.directoryPath, {
          withFileTypes: true,
        });
        entries.sort((left, right) =>
          left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
        );
        scannedEntries += entries.length;
        if (scannedEntries > WORKSPACE_SKILLS_MAXIMUM_SCAN_ENTRIES) {
          throw limitExceeded();
        }
        const declared = entries.find((entry) => entry.name === "SKILL.md");
        if (declared) {
          if (declared.isFile() && !declared.isSymbolicLink()) {
            const candidatePath = path.join(
              current.directoryPath,
              declared.name,
            );
            const skill = await loadSkill(candidatePath, root, signal);
            if (skill) {
              const existing = winners.get(skill.name);
              if (existing) {
                addDiagnostic(diagnostics, {
                  code: "name_collision",
                  source: skill.source,
                  filePath: skill.filePath,
                  name: skill.name,
                  winnerId: existing.id,
                });
              } else {
                if (winners.size >= WORKSPACE_SKILLS_MAXIMUM_SKILLS) {
                  throw limitExceeded();
                }
                winners.set(skill.name, skill);
              }
            } else {
              addDiagnostic(diagnostics, {
                code: "invalid_skill",
                source: root.source,
                filePath: candidatePath,
              });
            }
          } else {
            addDiagnostic(diagnostics, {
              code: "invalid_skill",
              source: root.source,
              filePath: path.join(current.directoryPath, declared.name),
            });
          }
          await verifyDirectory(directory, current.directoryPath);
          continue;
        }
        if (current.depth >= WORKSPACE_SKILLS_MAXIMUM_DEPTH) {
          if (entries.some((entry) => entry.isDirectory()))
            throw limitExceeded();
          continue;
        }
        for (const entry of entries) {
          if (
            entry.name.startsWith(".") ||
            entry.name === "node_modules" ||
            !entry.isDirectory() ||
            entry.isSymbolicLink()
          ) {
            continue;
          }
          pending.push({
            directoryPath: path.join(current.directoryPath, entry.name),
            depth: current.depth + 1,
          });
        }
        await verifyDirectory(directory, current.directoryPath);
      } finally {
        await directory.handle.close().catch(() => undefined);
      }
    }
  }

  const skills = [...winners.values()].map(({ content: _content, ...skill }) =>
    Object.freeze(skill),
  );
  const frozenDiagnostics = diagnostics.map((diagnostic) =>
    Object.freeze(diagnostic),
  );
  const catalogFingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "workspace_skills@1",
        skills.map((skill) => [
          skill.id,
          skill.name,
          skill.description,
          skill.source,
          skill.filePath,
          skill.contentSha256,
          skill.disableModelInvocation,
        ]),
        frozenDiagnostics,
      ]),
    )
    .digest("hex");
  const resolvedSkills = new Map(
    [...winners.values()].map((skill) => [skill.id, Object.freeze(skill)]),
  );
  return {
    skills,
    diagnostics: frozenDiagnostics,
    catalogFingerprint,
    resolvedSkills,
  };
}

async function loadSkill(
  filePath: string,
  root: Root,
  signal?: AbortSignal,
): Promise<ScannedSkill | undefined> {
  const bytes = await readStableFile(filePath, root.rootPath, signal);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const content = Buffer.from(bytes).toString("utf8");
  let frontmatter: Record<string, unknown>;
  try {
    const parsed = parseSkillFrontmatter(content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    frontmatter = parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const description = frontmatter.description;
  if (
    typeof description !== "string" ||
    description.trim() === "" ||
    description.length > 1_024 ||
    Buffer.byteLength(description, "utf8") > 4_096
  ) {
    return undefined;
  }
  const declaredName = frontmatter.name;
  const name =
    typeof declaredName === "string" && declaredName !== ""
      ? declaredName
      : path.basename(path.dirname(filePath));
  if (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) {
    return undefined;
  }
  const relativePath = posixRelative(root.rootPath, filePath);
  return {
    id: createHash("sha256")
      .update(JSON.stringify(["workspace_skills@1", root.source, relativePath]))
      .digest("hex"),
    name,
    description,
    source: root.source,
    filePath,
    baseDir: path.dirname(filePath),
    contentSha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.byteLength,
    disableModelInvocation: frontmatter["disable-model-invocation"] === true,
    content,
  };
}

function parseSkillFrontmatter(content: string): unknown {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith("---")) return {};
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex === -1) return {};
  const yaml = normalized.slice(4, endIndex);
  return yaml === "" ? {} : parseYaml(yaml);
}

async function readStableFile(
  filePath: string,
  rootPath: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const entry = await lstat(filePath, { bigint: true }).catch((error) => {
    throw new UnstablePathError("skill entry changed", { cause: error });
  });
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new UnstablePathError("skill entry changed");
  }
  if (
    entry.size <= 0n ||
    entry.size > BigInt(WORKSPACE_SKILLS_MAXIMUM_FILE_BYTES)
  ) {
    throw limitExceeded();
  }
  const handle = await open(
    filePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  ).catch((error) => {
    throw new UnstablePathError("skill entry changed", { cause: error });
  });
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameIdentity(identity(entry), identity(before))) {
      throw new UnstablePathError("skill entry changed");
    }
    const expectedBytes = Number(before.size);
    const bytes = Buffer.allocUnsafe(expectedBytes + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      signal?.throwIfAborted();
      const result = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const [after, currentEntry, openedPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
      revalidatedPathForOpenHandle(handle, filePath),
    ]).catch((error) => {
      throw new UnstablePathError("skill entry changed", { cause: error });
    });
    if (
      offset !== expectedBytes ||
      !after.isFile() ||
      !currentEntry.isFile() ||
      currentEntry.isSymbolicLink() ||
      !sameIdentity(identity(before), identity(after)) ||
      !sameIdentity(identity(before), identity(currentEntry)) ||
      openedPath !== filePath ||
      !isWithin(rootPath, openedPath)
    ) {
      throw new UnstablePathError("skill entry changed");
    }
    return bytes.subarray(0, expectedBytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function canonicalWorkspace(
  workspacePath: string,
  policyRootPath: string,
): Promise<string> {
  if (!path.isAbsolute(workspacePath) || !path.isAbsolute(policyRootPath)) {
    throw new WorkspaceSkillsScannerError("workspace_skills_not_allowed");
  }
  const [workspace, policyRoot] = await Promise.all([
    realpath(workspacePath),
    realpath(policyRootPath),
  ]).catch((error) => {
    throw new WorkspaceSkillsScannerError("workspace_skills_not_allowed", {
      cause: error,
    });
  });
  if (
    workspace !== path.resolve(workspacePath) ||
    policyRoot !== path.resolve(policyRootPath) ||
    !isWithin(policyRoot, workspace)
  ) {
    throw new WorkspaceSkillsScannerError("workspace_skills_not_allowed");
  }
  return workspace;
}

async function isCanonicalDirectory(candidate: string): Promise<boolean> {
  try {
    const entry = await lstat(candidate);
    if (!entry.isDirectory() || entry.isSymbolicLink()) return false;
    return (await realpath(candidate)) === path.resolve(candidate);
  } catch (error) {
    if (isMissing(error)) return false;
    throw new UnstablePathError("skill root changed", { cause: error });
  }
}

async function openVerifiedDirectory(directoryPath: string, rootPath: string) {
  const entry = await lstat(directoryPath, { bigint: true }).catch((error) => {
    throw new UnstablePathError("skill directory changed", { cause: error });
  });
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new UnstablePathError("skill directory changed");
  }
  const handle = await open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  ).catch((error) => {
    throw new UnstablePathError("skill directory changed", { cause: error });
  });
  try {
    const openedPath = await revalidatedPathForOpenHandle(
      handle,
      directoryPath,
    );
    const descriptor = await handle.stat({ bigint: true });
    if (
      openedPath !== directoryPath ||
      !isWithin(rootPath, openedPath) ||
      !descriptor.isDirectory() ||
      !sameIdentity(identity(entry), identity(descriptor))
    ) {
      throw new UnstablePathError("skill directory changed");
    }
    return { handle, identity: identity(descriptor) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function verifyDirectory(
  directory: Awaited<ReturnType<typeof openVerifiedDirectory>>,
  directoryPath: string,
): Promise<void> {
  const [descriptor, current, openedPath] = await Promise.all([
    directory.handle.stat({ bigint: true }),
    lstat(directoryPath, { bigint: true }),
    revalidatedPathForOpenHandle(directory.handle, directoryPath),
  ]).catch((error) => {
    throw new UnstablePathError("skill directory changed", { cause: error });
  });
  if (
    openedPath !== directoryPath ||
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameIdentity(directory.identity, identity(descriptor)) ||
    !sameIdentity(directory.identity, identity(current))
  ) {
    throw new UnstablePathError("skill directory changed");
  }
}

function addDiagnostic(
  diagnostics: WorkspaceSkillDiagnostic[],
  diagnostic: WorkspaceSkillDiagnostic,
): void {
  if (diagnostics.length >= WORKSPACE_SKILLS_MAXIMUM_DIAGNOSTICS) {
    throw limitExceeded();
  }
  diagnostics.push(diagnostic);
}

function identity(value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): FileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function posixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function limitExceeded(): WorkspaceSkillsScannerError {
  return new WorkspaceSkillsScannerError("workspace_skills_limit_exceeded");
}
