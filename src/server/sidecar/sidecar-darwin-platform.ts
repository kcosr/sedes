import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SidecarPlatformOwnership, SidecarProcessIdentity, SidecarTargetLifetime } from "./sidecar-process-ownership.js";

const execute = (filename: string, args: string[], options: { timeout: number; maxBuffer: number; env?: NodeJS.ProcessEnv }) =>
  promisify(execFile)(filename, args, { ...options, encoding: "utf8" });
// Public libproc ABI provides microsecond process creation identity. ps lstart
// truncates it to seconds, which cannot authorize actions against recycled PIDs.
// Source: https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/proc_info.h
// Build locally against the host SDK; no unverified downloaded executable runs.
export const DARWIN_SIDECAR_HELPER_SOURCE = String.raw`
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <libproc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysctl.h>
#include <unistd.h>
static int fail(void) { fputs("sidecar_service_target_identity_unavailable\n", stderr); return 1; }
static int private_stat(struct stat *s, mode_t kind, mode_t mode) {
  return (s->st_mode & S_IFMT) == kind && s->st_uid == getuid() && (s->st_mode & 0777) == mode;
}
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "boot") == 0) {
    char boot[80] = {0}; size_t length = sizeof boot;
    if (sysctlbyname("kern.bootsessionuuid", boot, &length, NULL, 0) != 0 || length < 2 || length > sizeof boot) return fail();
    for (size_t i = 0; boot[i]; i++) if (!((boot[i] >= 'A' && boot[i] <= 'Z') || (boot[i] >= 'a' && boot[i] <= 'z') || (boot[i] >= '0' && boot[i] <= '9') || boot[i] == '-')) return fail();
    puts(boot); return 0;
  }
  if (argc == 3 && strcmp(argv[1], "process") == 0) {
    char *end; long pid = strtol(argv[2], &end, 10);
    if (*end || pid < 1 || pid > 2147483647) return fail();
    struct proc_bsdinfo info; memset(&info, 0, sizeof info); errno = 0;
    int size = proc_pidinfo((int)pid, PROC_PIDTBSDINFO, 0, &info, sizeof info);
    if (size == 0 && errno == ESRCH) { puts("null"); return 0; }
    if (size != (int)sizeof info || info.pbi_pid != (uint32_t)pid || info.pbi_start_tvusec >= 1000000) return fail();
    printf("%" PRIu64 "%06" PRIu64 "\n", info.pbi_start_tvsec, info.pbi_start_tvusec); return 0;
  }
  if (argc == 4 && strcmp(argv[1], "retire-lock") == 0) {
    // Compare the complete expected owner bytes through an inode-pinned
    // directory, then unlinkat that inode. A competing replacement owner can
    // never be removed through a pathname redirected after comparison.
    int dir = open(argv[2], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (dir < 0) return errno == ENOENT ? 0 : fail();
    struct stat ds, fs;
    if (fstat(dir, &ds) || !private_stat(&ds, S_IFDIR, 0700)) { close(dir); return fail(); }
    int owner = openat(dir, "owner.json", O_RDONLY | O_NOFOLLOW);
    if (owner < 0) { int absent = errno == ENOENT; close(dir); return absent ? 0 : fail(); }
    if (fstat(owner, &fs) || !private_stat(&fs, S_IFREG, 0600) || fs.st_size < 1 || fs.st_size > 65536) { close(owner); close(dir); return fail(); }
    char bytes[65537]; ssize_t count = read(owner, bytes, sizeof bytes - 1); close(owner);
    if (count != fs.st_size) { close(dir); return fail(); }
    bytes[count] = 0;
    if (strlen(argv[3]) != (size_t)count || memcmp(bytes, argv[3], count)) { close(dir); return 0; }
    if (unlinkat(dir, "owner.json", 0) && errno != ENOENT) { close(dir); return fail(); }
    close(dir);
    if (rmdir(argv[2]) && errno != ENOENT && errno != ENOTEMPTY) return fail();
    return 0;
  }
  return fail();
}
`;

let helperPromise: Promise<string> | undefined;
export async function prepareDarwinSidecarHelper(): Promise<string> {
  helperPromise ??= buildHelper().catch((error: unknown) => { helperPromise = undefined; throw error; });
  return helperPromise;
}
async function buildHelper(): Promise<string> {
  if (process.platform !== "darwin") throw new Error("sidecar_service_platform_unsupported");
  const home = await realpath(homedir());
  const digest = createHash("sha256").update(DARWIN_SIDECAR_HELPER_SOURCE).digest("hex");
  let directory = home;
  for (const entry of [".local", "state", "sedes", "sidecar", "platform", `darwin-${process.arch}-${digest}`]) {
    directory = path.join(directory, entry);
    await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o022) !== 0) throw new Error("sidecar_service_namespace_invalid");
  }
  const ready = path.join(directory, "ready");
  const filename = path.join(ready, "helper");
  const marker = path.join(ready, "checksum");
  const inspect = async () => {
    try {
      const readyMetadata = await lstat(ready);
      if (!readyMetadata.isDirectory() || readyMetadata.isSymbolicLink() || readyMetadata.uid !== process.getuid?.() || (readyMetadata.mode & 0o777) !== 0o700) throw new Error("sidecar_platform_helper_invalid");
      const [metadata, checksumMetadata] = await Promise.all([lstat(filename), lstat(marker)]);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o500 || metadata.size > 1024 * 1024 ||
        !checksumMetadata.isFile() || checksumMetadata.isSymbolicLink() || checksumMetadata.uid !== process.getuid?.() || (checksumMetadata.mode & 0o777) !== 0o400 || checksumMetadata.size !== 64) throw new Error("sidecar_platform_helper_invalid");
      if (createHash("sha256").update(await readFile(filename)).digest("hex") !== await readFile(marker, "utf8")) throw new Error("sidecar_platform_helper_invalid");
      return true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  };
  if (await inspect()) return filename;
  const staging = path.join(directory, randomUUID());
  await mkdir(staging, { mode: 0o700 });
  try {
    const source = path.join(staging, "helper.c");
    const binary = path.join(staging, "helper");
    await writeFile(source, DARWIN_SIDECAR_HELPER_SOURCE, { flag: "wx", mode: 0o600 });
    try { await execute("/usr/bin/cc", ["-std=c11", "-D_DARWIN_C_SOURCE", "-O2", "-Wall", "-Wextra", "-Werror", source, "-lproc", "-o", binary], { timeout: 60_000, maxBuffer: 64 * 1024, env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: home } }); }
    catch (error) { throw new Error("sidecar_macos_command_line_tools_required", { cause: error }); }
    await chmod(binary, 0o500);
    const checksum = createHash("sha256").update(await readFile(binary)).digest("hex");
    await writeFile(path.join(staging, "checksum"), checksum, { flag: "wx", mode: 0o400 });
    // Publish as one directory so concurrent first-use compiles cannot combine
    // a binary from one build with the checksum of another.
    await rename(staging, ready).catch((error: NodeJS.ErrnoException) => { if (!["EEXIST", "ENOTEMPTY"].includes(error.code ?? "")) throw error; });
    if (!await inspect()) throw new Error("sidecar_platform_helper_invalid");
    return filename;
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function createDarwinSidecarPlatform(run: (args: readonly string[]) => Promise<string>): SidecarPlatformOwnership & { retireStartupLock(directory: string, expectedBytes: string): Promise<void> } {
  const boot = async () => {
    const value = (await run(["boot"])).trim();
    if (!/^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$/u.test(value)) throw new Error("sidecar_service_target_identity_unavailable");
    return value;
  };
  return {
    async readProcess(pid: number): Promise<SidecarProcessIdentity | undefined> {
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("sidecar_service_target_identity_unavailable");
      const bootId = await boot();
      const startTime = (await run(["process", String(pid)])).trim();
      if (await boot() !== bootId) throw new Error("sidecar_service_target_identity_unavailable");
      if (startTime === "null") return undefined;
      if (!/^[0-9]{7,26}$/u.test(startTime)) throw new Error("sidecar_service_target_identity_unavailable");
      return { pid, startTime, bootId, pidNamespace: "macos" };
    },
    async readTargetLifetime(): Promise<SidecarTargetLifetime> {
      return { bootId: await boot(), pidNamespace: "macos", namespaceInitStartTime: "0", boottimeOffset: { seconds: "0", nanoseconds: 0 } };
    },
    async retireStartupLock(directory: string, expectedBytes: string) { await run(["retire-lock", directory, expectedBytes]); },
  };
}
export const darwinSidecarPlatform = createDarwinSidecarPlatform(async args => {
  const helper = await prepareDarwinSidecarHelper();
  return (await execute(helper, [...args], { timeout: 5_000, maxBuffer: 128 * 1024 })).stdout;
});
