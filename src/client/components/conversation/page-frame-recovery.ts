import type { PageRevision } from "../../../shared/protocol/pages.js";

const STORAGE_KEY = "sedes-page-preview-pending";
const MAX_ENTRIES = 256;

/** Persist identities only: capability URLs and document content stay in memory. */
export function pageFrameRecoveryKey(
  admissionUrl: string,
  page: Pick<PageRevision, "threadId" | "pageId" | "revision">,
): string {
  return JSON.stringify([
    new URL(admissionUrl, window.location.href).origin,
    page.threadId,
    page.pageId,
    page.revision,
  ]);
}

interface RecoveryEntry {
  readonly key: string;
  readonly owner: string;
}

function readEntries(): RecoveryEntry[] | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    if (raw.length > 262_144) return;
    const entries: unknown = JSON.parse(raw);
    if (
      !Array.isArray(entries) ||
      entries.length > MAX_ENTRIES ||
      !entries.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof entry.key === "string" &&
          typeof entry.owner === "string",
      )
    )
      return;
    return entries as RecoveryEntry[];
  } catch {
    return;
  }
}

export function pageFrameNeedsActivation(key: string): boolean {
  const entries = readEntries();
  // Without durable recovery state, running authored code requires a click.
  return entries === undefined || entries.some((entry) => entry.key === key);
}

function writeEntries(entries: readonly RecoveryEntry[]): boolean {
  try {
    if (entries.length === 0) localStorage.removeItem(STORAGE_KEY);
    else
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(entries.slice(-MAX_ENTRIES)),
      );
    return true;
  } catch {
    return false;
  }
}

/**
 * Record before executing; remove only this attempt on deliberate cancellation.
 * A process death cannot run cancel(), while failure explicitly retains its mark.
 */
export class PageFrameRecoveryAttempt {
  readonly #owner = crypto.randomUUID();
  readonly #previousOwners: Set<string>;
  #state: "pending" | "failed" | "complete" | "cancelled" = "pending";
  readonly recorded: boolean;

  constructor(readonly key: string) {
    const entries = readEntries();
    this.#previousOwners = new Set(
      entries?.filter((entry) => entry.key === key).map((entry) => entry.owner),
    );
    this.recorded =
      entries !== undefined &&
      writeEntries([...entries, { key, owner: this.#owner }]);
  }

  complete(): void {
    if (this.#state !== "pending") return;
    this.#state = "complete";
    const entries = readEntries();
    if (entries)
      writeEntries(
        entries.filter(
          (entry) =>
            entry.key !== this.key ||
            (entry.owner !== this.#owner && !this.#previousOwners.has(entry.owner)),
        ),
      );
  }

  fail(): void {
    if (this.#state === "cancelled" || this.#state === "failed") return;
    this.#state = "failed";
    const entries = readEntries();
    if (entries && !entries.some((entry) => entry.owner === this.#owner))
      writeEntries([...entries, { key: this.key, owner: this.#owner }]);
  }

  cancel(): void {
    if (this.#state !== "pending") return;
    this.#state = "cancelled";
    const entries = readEntries();
    if (entries)
      writeEntries(entries.filter((entry) => entry.owner !== this.#owner));
  }
}
