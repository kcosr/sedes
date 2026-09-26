import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { SidecarServiceScope } from "../../internal/sidecar-protocol/service-management-v1.js";
import { windowsSidecarPlatform } from "./sidecar-windows-platform.js";

export interface SidecarAbandonmentRecord {
  readonly resourceId: string;
  readonly kind: "codex_app_server" | "claude_agent_sdk" | "workspace_files" | "workspace_tools" | "workspace_shell" | "terminal";
  readonly reason: string;
  /** Provider-owned metadata only: identities and delivery disposition, never
   * credentials, prompts, tool arguments, or a copy of the native transcript.
   * See {@link sidecarAbandonmentEvidenceCarriesWork} for the shape that lets
   * the archive skip an idle resource. */
  readonly evidence: unknown;
}

/** Directory entries, including files the archive did not write. */
export const SIDECAR_ABANDONMENT_RECORD_LIMIT = 128;
const EVIDENCE_LIMIT_BYTES = 1024 * 1024;
/** Only names this archive creates are ever rotated out. */
const RECORD_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;

type IdleCheck = (value: unknown) => boolean;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const empty: IdleCheck = value => Array.isArray(value) && value.length === 0;
const label: IdleCheck = value => typeof value === "string";
const count: IdleCheck = value => Number.isSafeInteger(value) && (value as number) >= 0;
/** Every present field must be recognized and idle; required fields must be present. */
function idle(value: unknown, checks: Readonly<Record<string, IdleCheck>>, required: readonly string[]): value is Record<string, unknown> {
  return isObject(value) && required.every(key => value[key] !== undefined) &&
    Object.entries(value).every(([key, field]) => field === undefined || (Object.hasOwn(checks, key) && checks[key]!(field)));
}
const idleBackground: Readonly<Record<string, IdleCheck>> = {
  state: value => value === "known", agents: value => value === 0, commands: value => value === 0, other: value => value === 0,
};
const idleSession: Readonly<Record<string, IdleCheck>> = {
  sessionId: label, providerState: value => value === "idle", liveWork: value => value === false,
  background: value => idle(value, idleBackground, ["state", "agents", "commands", "other"]),
  activeOperationIds: empty, pendingInputIds: empty, retainedEventCount: value => value === 0, events: empty,
};
const idleEvidence: Readonly<Record<string, IdleCheck>> = {
  phase: value => value === "before_shutdown" || value === "after_shutdown",
  startedAfterConfirmation: value => value === false,
  state: value => value === "idle", blockers: empty, activity: value => value === "idle",
  operations: empty, pendingRequests: empty, finalAcknowledged: value => value === true,
  sessionCount: count,
  sessions: value => Array.isArray(value) && value.every(session =>
    idle(session, idleSession, ["providerState", "liveWork", "background", "activeOperationIds", "pendingInputIds", "retainedEventCount"])),
  // Descriptive identity and position fields carry no work by themselves.
  revision: label, ownership: label, headSequence: count, floorSequence: count, exit: () => true,
};

/** False only when evidence positively reports an idle resource: `state:
 * "idle"`, empty `blockers`, and every other field recognized and idle (no
 * operations, pending requests, active activity, unacknowledged terminal
 * output, `startedAfterConfirmation`, or session with live, pending,
 * retained, or background work, and no omitted sessions). Missing, unknown,
 * malformed, or unrecognized evidence carries work, so a new evidence field
 * is recorded until it is classified here. */
export function sidecarAbandonmentEvidenceCarriesWork(evidence: unknown): boolean {
  if (!idle(evidence, idleEvidence, ["state", "blockers"])) return true;
  const sessions = evidence.sessions as readonly unknown[] | undefined;
  return (evidence.sessionCount ?? 0) !== (sessions?.length ?? 0);
}

/** Evidence retention must not become a new prerequisite for operator Stop.
 * Capacity exhaustion and write failures are reported, never silently promoted
 * into a claim that uncertain provider operations completed successfully.
 *
 * A record whose evidence shows an idle resource is not written. A host's
 * `after_shutdown` record follows the decision for its `before_shutdown`
 * record of the same resource and reason: the stop's own residue (a closed
 * connection's unknown activity, a stopped session's failure marker) is not
 * abandoned work. Hosts fence admission before the first record, and a
 * skipped record returns without yielding to I/O. When full, the oldest
 * records this archive wrote are removed to make room. */
export function createSidecarAbandonmentArchive(input: {
  directory: string;
  scope: SidecarServiceScope;
  serviceIncarnation(): string;
  /** Receives bounded diagnostic codes, including the first rotation. */
  onError(error: unknown): void;
}): (record: SidecarAbandonmentRecord) => Promise<void> {
  if (!path.isAbsolute(input.directory)) throw new Error("sidecar_abandonment_directory_invalid");
  let tail: Promise<void> = Promise.resolve();
  let rotationReported = false;
  const decisions = new Map<string, boolean>();
  const report = (code: string) => { try { input.onError(new Error(code)); } catch { /* diagnostic observer */ } };
  const carriesWork = (record: SidecarAbandonmentRecord): boolean => {
    const own = sidecarAbandonmentEvidenceCarriesWork(record.evidence);
    const phase = isObject(record.evidence) ? record.evidence.phase : undefined;
    const key = JSON.stringify([record.kind, record.resourceId, record.reason]);
    if (phase === "after_shutdown") {
      const before = decisions.get(key);
      decisions.delete(key);
      return before ?? own;
    }
    if (phase === "before_shutdown") {
      decisions.delete(key);
      decisions.set(key, own);
      // A stop that failed before its after_shutdown record leaves one entry.
      if (decisions.size > 256) decisions.delete(decisions.keys().next().value!);
    }
    return own;
  };
  const makeRoom = async () => {
    const entries = await readdir(input.directory);
    const excess = entries.length - SIDECAR_ABANDONMENT_RECORD_LIMIT + 1;
    if (excess <= 0) return;
    const records: { name: string; modified: number }[] = [];
    for (const name of entries) {
      if (!RECORD_NAME.test(name)) continue;
      const metadata = await lstat(path.join(input.directory, name)).catch(error => {
        if (error?.code === "ENOENT") return undefined;
        throw error;
      });
      if (metadata?.isFile()) records.push({ name, modified: metadata.mtimeMs });
    }
    if (records.length < excess) throw new Error("sidecar_abandonment_capacity_exceeded");
    // Records are written once, so mtime is their recording time.
    records.sort((left, right) => left.modified - right.modified || left.name.localeCompare(right.name));
    for (const { name } of records.slice(0, excess)) {
      await unlink(path.join(input.directory, name)).catch(error => { if (error?.code !== "ENOENT") throw error; });
    }
    if (!rotationReported) { rotationReported = true; report("sidecar_abandonment_archive_rotated"); }
  };
  const write = async (record: SidecarAbandonmentRecord) => {
    await mkdir(input.directory, { mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") throw error; });
    const metadata = await lstat(input.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("sidecar_abandonment_directory_invalid");
    if (process.platform === "win32") await windowsSidecarPlatform.privacy(input.directory, "ensure-directory");
    else if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw new Error("sidecar_abandonment_directory_invalid");
    await makeRoom();
    const evidence = JSON.stringify(record.evidence);
    const evidenceBytes = Buffer.byteLength(evidence, "utf8");
    const document = { version: 1, recordedAt: new Date().toISOString(), scope: input.scope,
      serviceIncarnation: input.serviceIncarnation(), resourceId: record.resourceId, kind: record.kind,
      reason: record.reason, disposition: "operator_abandoned", evidence: evidenceBytes <= EVIDENCE_LIMIT_BYTES ? record.evidence : {
        omitted: "size_limit", bytes: evidenceBytes, sha256: createHash("sha256").update(evidence).digest("hex"),
      } };
    const filename = path.join(input.directory, `${randomUUID()}.json`);
    const handle = await open(filename, "wx", 0o600);
    try {
      if (process.platform === "win32") await windowsSidecarPlatform.privacy(filename, "secure-file");
      await handle.writeFile(JSON.stringify(document));
      await handle.sync();
    } finally { await handle.close(); }
    if (process.platform !== "win32") {
      const directory = await open(input.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  };
  return async record => {
    // Decided synchronously, in call order, before any archive I/O.
    if (!carriesWork(record)) return;
    const writing = tail.then(() => write(record));
    tail = writing.catch(error => { report(error instanceof Error && error.message === "sidecar_abandonment_capacity_exceeded"
      ? error.message : "sidecar_abandonment_archive_failed"); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([tail, new Promise<void>(resolve => {
      timer = setTimeout(() => { report("sidecar_abandonment_archive_timeout"); resolve(); }, 2_000);
    })]);
    if (timer) clearTimeout(timer);
  };
}
