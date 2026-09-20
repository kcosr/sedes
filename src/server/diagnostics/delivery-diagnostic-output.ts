import { constants } from "node:fs";
import { lstat, open, rename, type FileHandle } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 8 * 1024;
let fileSink: BoundedDiagnosticFile | undefined;
let operatorEnabled: boolean | undefined;
let owner: object | undefined;

export function deliveryDiagnosticsEnabled(): boolean {
  return operatorEnabled ?? Boolean(process.env.SEDES_DEBUG_DELIVERY);
}

export function droppedDeliveryDiagnosticRecords(): number { return fileSink?.droppedRecords ?? 0; }

/** Only already-sanitized, content-free diagnostic records may enter here.
 * This does not intercept console or copy ordinary provider error logs. */
export function writeDeliveryDiagnostic(line: string): void {
  try {
    if (!deliveryDiagnosticsEnabled() || !/^\[delivery-(?:attachment|event-loop)\] /u.test(line) ||
      line.includes("\n") || line.includes("\r") || Buffer.byteLength(line) > MAX_RECORD_BYTES) return;
    try { console.error(line); } catch { /* File capture remains independently usable. */ }
    fileSink?.write(`${line}\n`);
  } catch { /* Diagnostics cannot affect application lifecycle. */ }
}

/** Optional POSIX-only file output uses an operator-owned absolute path. The
 * literal {pid} expands to this PID so inherited environments do not share a
 * rotating file. At most one in-process sink is active. */
export function configureDeliveryDiagnosticOutput(options: { readonly enabled?: boolean; readonly filePath?: string } = {}): () => Promise<void> {
  if (owner) return async () => {};
  const token = {};
  owner = token;
  try {
    operatorEnabled = options.enabled;
    const requested = options.filePath ?? process.env.SEDES_DEBUG_DELIVERY_FILE;
    const sink = deliveryDiagnosticsEnabled() && requested ? new BoundedDiagnosticFile(requested.replaceAll("{pid}", String(process.pid))) : undefined;
    fileSink = sink;
    return async () => {
      if (owner === token) { owner = undefined; fileSink = undefined; operatorEnabled = undefined; }
      await sink?.close();
    };
  } catch {
    owner = undefined; fileSink = undefined; operatorEnabled = undefined;
    return async () => {};
  }
}

class BoundedDiagnosticFile {
  readonly #path: string;
  readonly #queue: string[] = [];
  #queuedBytes = 0;
  #bytes = 0;
  #file: FileHandle | undefined;
  #draining: Promise<void> | undefined;
  #closed = false;
  #failed = false;
  droppedRecords = 0;

  constructor(filePath: string) {
    this.#path = filePath;
    if (!path.isAbsolute(filePath) || filePath.includes("\0") || process.platform === "win32") this.#failed = true;
  }

  write(line: string): void {
    if (this.#closed || this.#failed) return;
    const bytes = Buffer.byteLength(line);
    if (this.#queuedBytes + bytes > MAX_QUEUED_BYTES) { this.droppedRecords++; return; }
    this.#queue.push(line);
    this.#queuedBytes += bytes;
    this.#kick();
  }

  #kick(): void {
    if (!this.#draining) {
      this.#draining = this.#drain().catch(() => {
        this.#failed = true;
        this.#queue.length = 0;
        this.#queuedBytes = 0;
        try { console.error('[delivery-event-loop] {"event":"diagnostic_file_unavailable"}'); } catch { /* No raw filesystem errors. */ }
      }).finally(() => {
        this.#draining = undefined;
        if (this.#queue.length && !this.#failed) this.#kick();
      });
    }
  }

  async #open(): Promise<void> {
    const parent = await lstat(path.dirname(this.#path));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw new Error("diagnostic_parent_not_private");
    // Refuse special files without first blocking a libuv worker opening a FIFO.
    const file = await open(this.#path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.size > MAX_FILE_BYTES) throw new Error("diagnostic_file_not_private");
      this.#file = file;
      this.#bytes = stat.size;
    } catch (error) { await file.close(); throw error; }
  }

  async #drain(): Promise<void> {
    if (!this.#file) await this.#open();
    for (let line = this.#queue.shift(); line !== undefined; line = this.#queue.shift()) {
      const bytes = Buffer.byteLength(line);
      // Keep the active write included in the bounded queue budget.
      if (this.#bytes + bytes > MAX_FILE_BYTES) {
        await this.#file!.close(); this.#file = undefined;
        // rename replaces a prior archive entry itself; it never follows it.
        await rename(this.#path, `${this.#path}.1`);
        await this.#open();
      }
      await this.#file!.writeFile(line);
      this.#bytes += bytes;
      this.#queuedBytes -= bytes;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const cleanup = (async () => {
      try { while (this.#draining) await this.#draining; await this.#file?.close(); }
      catch { /* Shutdown must not fail because optional logging failed. */ }
      this.#file = undefined;
    })();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([cleanup, new Promise<void>(resolve => { timeout = setTimeout(resolve, 500); timeout.unref(); })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }
}
