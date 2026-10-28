import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { bearerToken, normalizeEndpoint, speechError } from "./contracts.mjs";

/** Device-owned secrets. Only the main process and its isolated credential dialog use this class. */
export class SpeechCredentialStore {
  constructor({ directory, storage, platform = process.platform }) {
    this.directory = directory;
    this.storage = storage;
    this.platform = platform;
  }
  filename(endpoint) {
    return path.join(this.directory, `${createHash("sha256").update(normalizeEndpoint(endpoint)).digest("hex")}.enc`);
  }
  requireEncryption() {
    if (!this.storage.isEncryptionAvailable() ||
        (this.platform === "linux" && this.storage.getSelectedStorageBackend?.() === "basic_text")) {
      throw speechError("speech_credential_storage_unavailable", "Secure speech credential storage is unavailable. Configure an OS keyring.");
    }
  }
  async read(endpoint) {
    endpoint = normalizeEndpoint(endpoint);
    let encrypted;
    try { encrypted = await readFile(this.filename(endpoint)); }
    catch (error) { if (error.code === "ENOENT") return null; throw speechError("speech_credential_storage_unavailable", "Speech credential storage could not be read."); }
    this.requireEncryption();
    try {
      if (encrypted.length > 32_768) throw new Error();
      const record = JSON.parse(this.storage.decryptString(encrypted));
      if (record.version !== 1 || record.endpoint !== endpoint) throw new Error();
      return bearerToken(record.token);
    } catch {
      throw speechError("speech_credential_storage_unavailable", "The saved speech credential could not be decrypted for this endpoint.");
    }
  }
  async status(endpoint) { return { credentialConfigured: (await this.read(endpoint)) !== null }; }
  async save(endpoint, token) {
    endpoint = normalizeEndpoint(endpoint);
    token = bearerToken(token);
    this.requireEncryption();
    const destination = this.filename(endpoint);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      const encrypted = this.storage.encryptString(JSON.stringify({ version: 1, endpoint, token }));
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, encrypted, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch {
      throw speechError("speech_credential_storage_unavailable", "The speech credential could not be saved securely.");
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async remove(endpoint) {
    try { await unlink(this.filename(endpoint)); }
    catch (error) { if (error.code !== "ENOENT") throw speechError("speech_credential_storage_unavailable", "The speech credential could not be removed."); }
  }
}
