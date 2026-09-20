import { mkdtemp, readFile, readdir, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("electron", () => ({ app: {}, safeStorage: {} }));
const { CredentialStore } = await import("../../packages/electron-client-credentials/electron/dist/plugin.mjs");
const directories = [];
const credential = "sedes_test_secret_0123456789";
const identity = { profileId: "device-1", serverUrl: "https://server.example" };
async function fixture(backend = "gnome_libsecret") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-credentials-"));
  directories.push(directory);
  const storage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5),
    decryptString: (value) => Buffer.from(value).map((byte) => byte ^ 0xa5).toString(),
  };
  return { directory, store: new CredentialStore({ directory, storage }) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });
describe("Electron credential persistence", () => {
  it("encrypts credentials, restores exact bindings, and removes them", async () => {
    const { directory, store } = await fixture();
    await store.setCredential({ ...identity, credential });
    expect(await store.getCredential(identity)).toEqual({ credential });
    expect(await store.getCredential({ ...identity, serverUrl: "https://server.example:443/" })).toEqual({ credential });
    expect(await store.getCredential({ ...identity, serverUrl: "https://other.example" })).toEqual({ credential: null });
    expect(await store.getCredential({ ...identity, profileId: "device-2" })).toEqual({ credential: null });
    const profileDirectory = store.profileDirectory(identity.profileId);
    const files = await readdir(profileDirectory);
    expect(files).toHaveLength(1);
    expect((await readFile(path.join(profileDirectory, files[0]))).includes(Buffer.from(credential))).toBe(false);
    await store.removeCredential(identity);
    expect(await store.getCredential(identity)).toEqual({ credential: null });
  });
  it("removes all origins of one profile while retaining other profiles", async () => {
    const { store } = await fixture();
    await store.setCredential({ ...identity, credential });
    await store.setCredential({ ...identity, serverUrl: "http://localhost:12345", credential });
    await store.setCredential({ ...identity, profileId: "device-2", credential });
    await store.removeProfileCredentials({ profileId: identity.profileId });
    expect(await store.getCredential(identity)).toEqual({ credential: null });
    expect(await store.getCredential({ ...identity, serverUrl: "http://localhost:12345" })).toEqual({ credential: null });
    expect(await store.getCredential({ ...identity, profileId: "device-2" })).toEqual({ credential });
  });
  it("rejects swapped encrypted records across profiles", async () => {
    const { directory, store } = await fixture();
    await store.setCredential({ ...identity, credential });
    const [first] = await readdir(store.profileDirectory(identity.profileId));
    await store.setCredential({ ...identity, profileId: "device-2", credential });
    const [second] = await readdir(store.profileDirectory("device-2"));
    await copyFile(path.join(store.profileDirectory(identity.profileId), first), path.join(store.profileDirectory("device-2"), second));
    await expect(store.getCredential({ ...identity, profileId: "device-2" })).rejects.toThrow("credential_binding_invalid");
  });
  it("fails closed when Linux safeStorage uses basic_text", async () => {
    const { store, directory } = await fixture("basic_text");
    await expect(store.setCredential({ ...identity, credential })).rejects.toThrow("OS keyring");
    expect(await readdir(directory)).toEqual([]);
  });
  it("rejects invalid destinations and token header injection", async () => {
    const { store } = await fixture();
    for (const serverUrl of ["file:///tmp", "https://user@server.example", "https://server.example/api", "https://server.example/#secret"]) {
      await expect(store.setCredential({ ...identity, serverUrl, credential })).rejects.toThrow();
    }
    await expect(store.setCredential({ ...identity, credential: `${credential}\r\nX-Test: yes` })).rejects.toThrow("credential_invalid");
  });
});
