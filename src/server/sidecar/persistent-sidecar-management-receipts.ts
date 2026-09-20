import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { windowsSidecarPlatform } from "./sidecar-windows-platform.js";
import { sidecarManagementReceiptSchema, sidecarManagementRequestSchema,
  type SidecarManagementReceipt, type SidecarManagementRequest } from "../../internal/sidecar-protocol/service-management-v1.js";

/** Minimal durable service-control receipts, not application or provider state. */
export class PersistentSidecarManagementReceipts {
  readonly #directory: string;
  readonly #maximumReceipts: number;
  #admissionTail: Promise<unknown> = Promise.resolve();
  constructor(directory: string, maximumReceipts = 512) {
    if (!path.isAbsolute(directory) || !Number.isSafeInteger(maximumReceipts) || maximumReceipts < 1 || maximumReceipts > 4096) throw new Error("sidecar_management_receipts_configuration_invalid");
    this.#directory = directory;
    this.#maximumReceipts = maximumReceipts;
  }

  async read(mutationId: string): Promise<SidecarManagementReceipt | undefined> {
    await this.#prepare();
    const filename = this.#filename(mutationId);
    try {
      await this.#assertFile(filename);
      const value = sidecarManagementReceiptSchema.parse(JSON.parse(await readFile(filename, "utf8")));
      if (value.mutationId !== mutationId) throw new Error("sidecar_management_receipt_identity_invalid");
      return value;
    } catch (error) { if (hasCode(error, "ENOENT")) return undefined; throw error; }
  }

  begin(request: Extract<SidecarManagementRequest, { operation: "stop" | "restart" }>, serviceIncarnation: string): Promise<{ readonly receipt: SidecarManagementReceipt; readonly created: boolean }> {
    const result = this.#admissionTail.then(() => this.#begin(request, serviceIncarnation));
    this.#admissionTail = result.catch(() => undefined);
    return result;
  }

  /**
   * Fences a mutation id that was never admitted. A requester whose
   * acknowledgement was lost calls this before reporting "nothing changed";
   * request bytes that arrive later find the terminal receipt and are refused.
   * An existing receipt of any state is returned unchanged.
   */
  withdraw(mutationId: string, serviceIncarnation: string): Promise<{ readonly receipt: SidecarManagementReceipt; readonly created: boolean }> {
    const result = this.#admissionTail.then(() => this.#withdraw(mutationId, serviceIncarnation));
    this.#admissionTail = result.catch(() => undefined);
    return result;
  }

  async #withdraw(mutationId: string, serviceIncarnation: string): Promise<{ readonly receipt: SidecarManagementReceipt; readonly created: boolean }> {
    const existing = await this.read(mutationId);
    if (existing) return { receipt: existing, created: false };
    const receipt = sidecarManagementReceiptSchema.parse({ mutationId, requestFingerprint: withdrawalFingerprint(mutationId), serviceIncarnation, state: "withdrawn" });
    if (await this.#create(receipt)) return { receipt, created: true };
    const raced = await this.read(mutationId);
    if (!raced) throw new Error("sidecar_management_receipt_invalid");
    return { receipt: raced, created: false };
  }

  async #begin(request: Extract<SidecarManagementRequest, { operation: "stop" | "restart" }>, serviceIncarnation: string): Promise<{ readonly receipt: SidecarManagementReceipt; readonly created: boolean }> {
    const admitted = sidecarManagementRequestSchema.parse(request);
    const requestFingerprint = createHash("sha256").update(JSON.stringify(admitted)).digest("hex");
    const existing = await this.read(request.requestId);
    if (existing) return replay(existing, requestFingerprint);
    const receipt = sidecarManagementReceiptSchema.parse({ mutationId: request.requestId, requestFingerprint, serviceIncarnation, state: "accepted" });
    if (await this.#create(receipt)) return { receipt, created: true };
    const raced = await this.read(request.requestId);
    if (!raced) throw new Error("sidecar_management_mutation_conflict");
    return replay(raced, requestFingerprint);
  }

  /** Reclaims capacity, then creates the receipt; false means it already exists. */
  async #create(receipt: SidecarManagementReceipt): Promise<boolean> {
    const entries = await readdir(this.#directory);
    if (entries.length >= this.#maximumReceipts) {
      // A settled control from an older incarnation cannot execute again:
      // every effect also compares the expected live incarnation. Keep current
      // and unresolved receipts; reclaim only terminal old-service metadata.
      let removed = 0;
      for (const entry of entries) {
        if (!/^[0-9a-f]{64}\.json$/u.test(entry)) continue;
        const filename = path.join(this.#directory, entry);
        await this.#assertFile(filename);
        const previous = sidecarManagementReceiptSchema.parse(JSON.parse(await readFile(filename, "utf8")));
        if (filename !== this.#filename(previous.mutationId)) throw new Error("sidecar_management_receipt_identity_invalid");
        // This one refusal is permanently fenced by the confirmed resource
        // fingerprint: replay sees either the same blockers or a stale snapshot.
        // It is safe to reclaim even on a live service whose old probes filled
        // the ledger. Other failures may include partial resource shutdown.
        const blockedBeforeEffect = previous.state === "failed" && previous.code === "sidecar_service_upgrade_blocked";
        // A withdrawn id never executed; once its service is gone, its stale
        // request is refused by the incarnation check anyway.
        const retiredAndSettled = (previous.state === "completed" || previous.state === "failed" || previous.state === "withdrawn") && previous.serviceIncarnation !== receipt.serviceIncarnation;
        if (!blockedBeforeEffect && !retiredAndSettled) continue;
        await unlink(filename);
        removed += 1;
        if (entries.length - removed < this.#maximumReceipts) break;
      }
      if (removed > 0) await this.#syncDirectory();
      if (entries.length - removed >= this.#maximumReceipts) throw new Error("sidecar_management_receipt_capacity_exceeded");
    }
    try {
      const filename = this.#filename(receipt.mutationId);
      const handle = await open(filename, "wx", 0o600);
      try {
        if (process.platform === "win32") await windowsSidecarPlatform.privacy(filename, "secure-file");
        await handle.writeFile(JSON.stringify(receipt)); await handle.sync();
      }
      finally { await handle.close(); }
      await this.#syncDirectory();
      return true;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      return false;
    }
  }

  async finish(mutationId: string, state: "completed" | "failed" | "handoff_pending", code?: string): Promise<SidecarManagementReceipt> {
    const current = await this.read(mutationId);
    if (!current) throw new Error("sidecar_management_receipt_missing");
    const receipt = sidecarManagementReceiptSchema.parse({ ...current, state, ...(code ? { code } : {}) });
    const temporary = `${this.#filename(mutationId)}.${randomUUID()}`;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        if (process.platform === "win32") await windowsSidecarPlatform.privacy(temporary, "secure-file");
        await handle.writeFile(JSON.stringify(receipt)); await handle.sync();
      } finally { await handle.close(); }
      await rename(temporary, this.#filename(mutationId));
      await this.#syncDirectory();
    }
    finally { await unlink(temporary).catch(() => undefined); }
    return receipt;
  }

  #filename(mutationId: string): string {
    if (!/^[A-Za-z0-9_.:-]{1,160}$/u.test(mutationId)) throw new Error("sidecar_management_mutation_id_invalid");
    return path.join(this.#directory, `${createHash("sha256").update(mutationId).digest("hex")}.json`);
  }
  async #prepare(): Promise<void> {
    if (process.platform === "win32") {
      try { await lstat(this.#directory); }
      catch (error) {
        if (!hasCode(error, "ENOENT")) throw error;
        await windowsSidecarPlatform.privacy(this.#directory, "ensure-directory");
      }
      await windowsSidecarPlatform.privacy(this.#directory, "assert-directory");
      return;
    }
    try { await mkdir(this.#directory, { mode: 0o700 }); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    const metadata = await lstat(this.#directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw new Error("sidecar_management_receipts_namespace_invalid");
  }
  async #assertFile(filename: string): Promise<void> {
    const metadata = await lstat(filename);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error("sidecar_management_receipt_invalid");
    if (process.platform === "win32") {
      await windowsSidecarPlatform.privacy(filename, "assert-file");
    } else if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("sidecar_management_receipt_invalid");
    }
  }
  async #syncDirectory(): Promise<void> {
    // Node cannot open and fsync directory handles on Windows. Receipt file
    // contents are still flushed before publication; POSIX also flushes names.
    if (process.platform === "win32") return;
    const handle = await open(this.#directory, "r"); try { await handle.sync(); } finally { await handle.close(); }
  }
}
/** A withdrawn receipt matches no request fingerprint, so every replay of the id is refused. */
function withdrawalFingerprint(mutationId: string): string { return createHash("sha256").update(JSON.stringify({ withdrawn: mutationId })).digest("hex"); }
function replay(existing: SidecarManagementReceipt, requestFingerprint: string): { readonly receipt: SidecarManagementReceipt; readonly created: false } {
  if (existing.state === "withdrawn") throw new Error("sidecar_management_mutation_withdrawn");
  if (existing.requestFingerprint !== requestFingerprint) throw new Error("sidecar_management_mutation_conflict");
  return { receipt: existing, created: false };
}
function hasCode(error: unknown, code: string): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === code; }
