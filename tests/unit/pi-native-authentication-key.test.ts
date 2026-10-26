import { afterEach, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadPiNativeHostAuthenticationKey } from "../../src/server/backends/pi/native/host/authentication-key.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "sedes-pi-key-")); directories.push(value); return value; }

it("atomically publishes one private key across concurrent backend starts", async () => {
  const root = await directory();
  const keys = await Promise.all(Array.from({ length: 16 }, () => loadPiNativeHostAuthenticationKey(root, "backend")));
  expect(keys.every(key => Buffer.from(key).equals(Buffer.from(keys[0]!)))).toBe(true);
  expect(Buffer.from(await loadPiNativeHostAuthenticationKey(root, "other"))).not.toEqual(Buffer.from(keys[0]!));
  expect((await stat(path.join(root, "pi-native-authentication.key"))).mode & 0o777).toBe(0o600);
  expect(await readdir(root)).toEqual(["pi-native-authentication.key"]);
  expect((await readFile(path.join(root, "pi-native-authentication.key"))).byteLength).toBe(32);
});

it("rejects public key directories, symlink files, and malformed key bytes", async () => {
  const root = await directory(), filename = path.join(root, "pi-native-authentication.key");
  await chmod(root, 0o755);
  await expect(loadPiNativeHostAuthenticationKey(root, "backend")).rejects.toThrow("pi_native_key_directory_invalid");
  await chmod(root, 0o700);
  await writeFile(path.join(root, "target"), Buffer.alloc(32), { mode: 0o600 });
  await symlink("target", filename);
  await expect(loadPiNativeHostAuthenticationKey(root, "backend")).rejects.toThrow();
  await rm(filename);
  await writeFile(filename, "short", { mode: 0o600 });
  await expect(loadPiNativeHostAuthenticationKey(root, "backend")).rejects.toThrow("pi_native_key_file_invalid");
});
