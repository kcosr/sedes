import { randomBytes, randomUUID, createHmac } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";

/** This Sedes-owned key never lives in the provider's editable session store. */
export async function loadPiNativeHostAuthenticationKey(directory: string, backendInstanceId: string): Promise<Uint8Array> {
  await mkdir(directory, { mode: 0o700, recursive: true });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0 ||
    metadata.uid !== process.getuid?.() || await realpath(directory) !== directory) throw new Error("pi_native_key_directory_invalid");
  const filename = path.join(directory, "pi-native-authentication.key");
  const temporary = path.join(directory, `.pi-native-key-${randomUUID()}`);
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try { await file.writeFile(randomBytes(32)); await file.sync(); }
    finally { await file.close(); }
    // Publish only complete key bytes. Concurrent backend starts must never
    // observe an empty key file while another caller is still writing it.
    try { await link(temporary, filename); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size !== 32 || before.uid !== metadata.uid || (before.mode & 0o077) !== 0) throw new Error("pi_native_key_file_invalid");
    const key = await file.readFile();
    const after = await lstat(filename);
    if (key.byteLength !== 32 || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs) throw new Error("pi_native_key_file_changed");
    return createHmac("sha256", key).update("sedes.pi-native.host.v1\0").update(backendInstanceId).digest();
  } finally { await file.close(); }
}
