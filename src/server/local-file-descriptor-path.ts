import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";

type FileIdentity = {
  readonly dev: bigint;
  readonly ino: bigint;
};

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Returns the strongest pathname available for operations relative to an open
 * descriptor. Linux procfs supports directory traversal through the
 * descriptor. Darwin's fdesc filesystem duplicates the descriptor itself but
 * does not provide equivalent child traversal, so the already-admitted
 * canonical path remains the operation path there and on Windows.
 */
export function pathForOpenDescriptor(
  fileDescriptor: number,
  canonicalPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "linux") return `/proc/self/fd/${fileDescriptor}`;
  if (platform === "darwin" || platform === "win32") return canonicalPath;
  throw new Error(`local_file_descriptor_path_unsupported:${platform}`);
}

export function pathWithinOpenDirectory(
  handle: Pick<FileHandle, "fd">,
  canonicalDirectory: string,
  ...segments: readonly string[]
): string {
  return path.join(
    pathForOpenDescriptor(handle.fd, canonicalDirectory),
    ...segments,
  );
}

/**
 * Resolves a pathname only when it still identifies the object held by the
 * open descriptor. Linux additionally proves that procfs resolves the open
 * descriptor to that same canonical pathname. On Darwin, dev/inode identity
 * is the portable proof available to Node. Windows exposes the volume serial
 * number and file index through bigint dev/ino; a filesystem that cannot
 * provide a file index is rejected rather than treated as identity evidence.
 */
export async function revalidatedPathForOpenHandle(
  handle: Pick<FileHandle, "fd" | "stat">,
  candidatePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  const canonical = await realpath(candidatePath).catch(() => undefined);
  if (!canonical) return undefined;
  const [openedMetadata, pathMetadata] = await Promise.all([
    handle.stat({ bigint: true }).catch(() => undefined),
    stat(canonical, { bigint: true }).catch(() => undefined),
  ]);
  if (
    !openedMetadata ||
    !pathMetadata ||
    !sameIdentity(openedMetadata, pathMetadata) ||
    (platform === "win32" && openedMetadata.ino === 0n)
  ) {
    return undefined;
  }
  if (platform === "linux") {
    const descriptorCanonical = await realpath(
      pathForOpenDescriptor(handle.fd, canonical, platform),
    ).catch(() => undefined);
    return descriptorCanonical === canonical ? canonical : undefined;
  }
  if (platform === "darwin" || platform === "win32") return canonical;
  throw new Error(`local_file_descriptor_path_unsupported:${platform}`);
}

/** Windows libuv opens directories with FILE_FLAG_BACKUP_SEMANTICS, but
 * O_DIRECTORY/O_NOFOLLOW are not available there. Check type and identity
 * explicitly on every platform, including junction/symlink replacement. */
export async function openVerifiedDirectory(
  candidate: string,
): Promise<FileHandle> {
  const before = await lstat(candidate, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error("local_directory_path_invalid");
  const handle = await open(
    candidate,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const [opened, after] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(candidate, { bigint: true }),
    ]);
    if (
      !opened.isDirectory() ||
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      !sameIdentity(before, opened) ||
      !sameIdentity(opened, after) ||
      (process.platform === "win32" && opened.ino === 0n)
    )
      throw new Error("local_directory_path_unstable");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}
