import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { app, safeStorage } from "electron";

function profileId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(value)) throw new Error("credential_profile_invalid");
  return value;
}
function identity(input) {
  if (typeof input?.profileId !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/u.test(input.profileId)) {
    throw new Error("credential_profile_invalid");
  }
  const url = new URL(input.serverUrl);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) throw new Error("credential_origin_invalid");
  return JSON.stringify([input.profileId, url.origin]);
}

export class CredentialStore {
  constructor({ directory, storage = safeStorage }) {
    this.directory = directory;
    this.storage = storage;
  }
  filename(binding) {
    return path.join(this.profileDirectory(JSON.parse(binding)[0]), `${createHash("sha256").update(binding).digest("hex")}.enc`);
  }
  profileDirectory(id) {
    return path.join(this.directory, createHash("sha256").update(profileId(id)).digest("hex"));
  }
  async removeProfileCredentials(input) {
    await rm(this.profileDirectory(input.profileId), { recursive: true, force: true });
  }
  requireEncryption() {
    if (!this.storage.isEncryptionAvailable() || (process.platform === "linux" && this.storage.getSelectedStorageBackend?.() === "basic_text")) {
      throw new Error("Secure credential storage is unavailable. Configure an OS keyring before pairing.");
    }
  }
  async getCredential(input) {
    const binding = identity(input);
    let encrypted;
    try { encrypted = await readFile(this.filename(binding)); }
    catch (error) { if (error.code === "ENOENT") return { credential: null }; throw error; }
    this.requireEncryption();
    const record = JSON.parse(this.storage.decryptString(encrypted));
    if (record.binding !== binding || typeof record.credential !== "string") throw new Error("credential_binding_invalid");
    return { credential: record.credential };
  }
  async setCredential(input) {
    const binding = identity(input);
    if (typeof input.credential !== "string" || !/^[A-Za-z0-9._~-]{16,4096}$/u.test(input.credential)) throw new Error("credential_invalid");
    this.requireEncryption();
    const encrypted = this.storage.encryptString(JSON.stringify({ binding, credential: input.credential }));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await mkdir(this.profileDirectory(input.profileId), { recursive: true, mode: 0o700 });
    const filename = this.filename(binding);
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async removeCredential(input) {
    await unlink(this.filename(identity(input))).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}
export function nativeCredentialStore() {
  return new CredentialStore({ directory: path.join(app.getPath("userData"), "credentials") });
}
class ClientCredentialsImpl {
  getCredential(input) { return nativeCredentialStore().getCredential(input); }
  setCredential(input) { return nativeCredentialStore().setCredential(input); }
  removeCredential(input) { return nativeCredentialStore().removeCredential(input); }
  removeProfileCredentials(input) { return nativeCredentialStore().removeProfileCredentials(input); }
}
ClientCredentialsImpl.__capacitorElectronPlugin = {
  name: "ClientCredentials", methods: ["getCredential", "setCredential", "removeCredential", "removeProfileCredentials"],
};
export { ClientCredentialsImpl as ClientCredentials };
