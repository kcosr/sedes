import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, lstat, mkdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSidecarAbandonmentArchive, sidecarAbandonmentEvidenceCarriesWork } from "../../src/server/sidecar/sidecar-abandonment-archive.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const scope = { installationId: "installation", tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote" };
async function archiveDirectory(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "abandonment-")); directories.push(root);
  return path.join(root, "archive");
}
it("archives scoped abandoned identities privately without changing unknown delivery to success", async () => {
  const directory = await archiveDirectory();
  const onError = vi.fn();
  const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
  await archive({ resourceId: "runtime", kind: "codex_app_server", reason: "operator_stop",
    evidence: { operations: [{ operationId: "operation", delivery: "sent_outcome_unknown" }] } });
  const entries = await readdir(directory);
  expect(entries).toHaveLength(1);
  const filename = path.join(directory, entries[0]!);
  expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({ scope, serviceIncarnation: "service", resourceId: "runtime",
    disposition: "operator_abandoned", evidence: { operations: [{ operationId: "operation", delivery: "sent_outcome_unknown" }] } });
  if (process.platform !== "win32") {
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(filename)).mode & 0o777).toBe(0o600);
  }
  expect(onError).not.toHaveBeenCalled();
});
it("reports archive failure without blocking Stop or changing an unsafe directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abandonment-")); directories.push(root);
  const directory = path.join(root, "absent-parent", "archive");
  const onError = vi.fn();
  const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
  await expect(archive({ resourceId: "runtime", kind: "claude_agent_sdk", reason: "operator_stop", evidence: {} })).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "sidecar_abandonment_archive_failed" }));
});
it("bounds archived evidence without silently dropping the original size and digest", async () => {
  const directory = await archiveDirectory();
  const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError: vi.fn() });
  await archive({ resourceId: "runtime", kind: "workspace_files", reason: "operator_stop", evidence: { data: "x".repeat(1024 * 1024 + 1) } });
  const filename = path.join(directory, (await readdir(directory))[0]!);
  const record = JSON.parse(await readFile(filename, "utf8"));
  expect(record.evidence).toMatchObject({ omitted: "size_limit", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect((await lstat(filename)).size).toBeLessThan(4096);
});

describe("abandoned-work predicate", () => {
  const idleSession = { sessionId: "session", providerState: "idle", liveWork: false,
    background: { state: "known", agents: 0, commands: 0, other: 0 }, activeOperationIds: [], pendingInputIds: [], retainedEventCount: 0, events: [] };
  const idleEvidence = {
    workspaceFiles: { phase: "before_shutdown", revision: "4", state: "idle", blockers: [], operations: [] },
    workspaceShell: { phase: "after_shutdown", revision: "9", state: "idle", blockers: [], operations: [] },
    exitedTerminal: { state: "idle", blockers: [], revision: "incarnation:exit-5:true:false", headSequence: 5, floorSequence: 0,
      finalAcknowledged: true, exit: { exitCode: 0, signal: null } },
    codex: { phase: "before_shutdown", ownership: "owned", state: "idle", blockers: [], revision: "digest", activity: "idle", operations: [], pendingRequests: [] },
    claude: { phase: "before_shutdown", state: "idle", revision: "3", blockers: [], sessionCount: 1, sessions: [idleSession] },
    claudeWithoutSessions: { phase: "before_shutdown", state: "idle", revision: "0", blockers: [], sessionCount: 0, sessions: [] },
  };
  it.each(Object.entries(idleEvidence))("skips an idle %s resource with nothing abandoned", (_name, evidence) => {
    expect(sidecarAbandonmentEvidenceCarriesWork(evidence)).toBe(false);
  });

  const { workspaceFiles, codex, claude, exitedTerminal } = idleEvidence;
  const session = (change: Record<string, unknown>) => ({ ...claude, sessions: [{ ...idleSession, ...change }] });
  it.each([
    ["active state", { ...workspaceFiles, state: "active" }],
    ["unknown state", { ...workspaceFiles, state: "unknown", blockers: ["cleanup_unproven"] }],
    ["a blocker on an idle state", { ...workspaceFiles, blockers: ["unsettled_outcome"] }],
    ["retained operations", { ...workspaceFiles, operations: [{ operationId: "operation", state: "succeeded" }] }],
    ["pending provider requests", { ...codex, pendingRequests: [{ id: 1, generation: 1, method: "item/permissions/requestApproval" }] }],
    ["unknown provider activity", { ...codex, activity: "unknown" }],
    ["work started after the idle confirmation", { ...claude, startedAfterConfirmation: true }],
    ["live session work", session({ liveWork: true })],
    ["a running provider state", session({ providerState: "running" })],
    ["an active operation", session({ activeOperationIds: ["operation"] })],
    ["pending input", session({ pendingInputIds: ["operation"] })],
    ["retained session output", session({ retainedEventCount: 1, events: [{ sequence: 1, kind: "message" }] })],
    ["background agents", session({ background: { state: "known", agents: 1, commands: 0, other: 0 } })],
    ["unknown background inventory", session({ background: { state: "unknown", agents: 0, commands: 0, other: 0 } })],
    ["sessions omitted from the evidence", { ...claude, sessionCount: 300 }],
    ["an unacknowledged terminal exit", { ...exitedTerminal, finalAcknowledged: false }],
    ["an unrecognized field", { ...workspaceFiles, interruptedTurns: 1 }],
    ["an unrecognized session field", session({ queuedTurns: 2 })],
    ["an unknown phase", { ...workspaceFiles, phase: "during_shutdown" }],
    ["no state", { blockers: [], operations: [] }],
    ["no blockers", { state: "idle", operations: [] }],
    ["malformed blockers", { ...workspaceFiles, blockers: "none" }],
    ["empty evidence", {}],
    ["null evidence", null],
    ["array evidence", [workspaceFiles]],
    ["string evidence", "idle"],
  ])("records evidence with %s", (_name, evidence) => {
    expect(sidecarAbandonmentEvidenceCarriesWork(evidence)).toBe(true);
  });
});

describe("abandoned-work archive decisions", () => {
  const idle = { state: "idle", revision: "1", blockers: [], operations: [] };
  // A stopped Claude session's own failure marker is residue, not abandoned work.
  const residue = { state: "active", revision: "2", blockers: ["unsettled_outcome"], sessionCount: 1, sessions: [{ sessionId: "session",
    providerState: "idle", liveWork: false, background: { state: "unknown", agents: 0, commands: 0, other: 0 },
    activeOperationIds: [], pendingInputIds: [], retainedEventCount: 1, events: [{ sequence: 1, kind: "failed", code: "stopped" }] }] };

  it("writes nothing, not even the directory, for an idle resource", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "abandonment-")); directories.push(root);
    const directory = path.join(root, "absent-parent", "archive");
    const onError = vi.fn();
    const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
    await archive({ resourceId: "workspace-files", kind: "workspace_files", reason: "operator_stop", evidence: { phase: "before_shutdown", ...idle } });
    await archive({ resourceId: "terminal", kind: "terminal", reason: "operator_stop", evidence: { ...idle, finalAcknowledged: true } });
    expect(onError).not.toHaveBeenCalled();
    await expect(lstat(path.join(root, "absent-parent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("follows the before_shutdown decision for the same resource's after_shutdown record", async () => {
    const directory = await archiveDirectory();
    const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError: vi.fn() });
    // Idle before shutdown: the stop's own residue afterwards is not written.
    await archive({ resourceId: "idle-runtime", kind: "claude_agent_sdk", reason: "operator_stop", evidence: { phase: "before_shutdown", ...idle } });
    await archive({ resourceId: "idle-runtime", kind: "claude_agent_sdk", reason: "operator_stop", evidence: { phase: "after_shutdown", ...residue } });
    expect(await readdir(directory).catch(() => [])).toEqual([]);
    // Abandoned work before shutdown: both halves of the evidence are kept,
    // even though nothing remains after shutdown.
    await archive({ resourceId: "active-files", kind: "workspace_files", reason: "operator_stop",
      evidence: { phase: "before_shutdown", ...idle, state: "active", blockers: ["active_work"], operations: [{ operationId: "operation", state: "pending" }] } });
    await archive({ resourceId: "active-files", kind: "workspace_files", reason: "operator_stop", evidence: { phase: "after_shutdown", ...idle } });
    // Without its own before_shutdown decision, an after_shutdown record is judged on its evidence.
    await archive({ resourceId: "idle-runtime", kind: "claude_agent_sdk", reason: "operator_stop", evidence: { phase: "after_shutdown", ...residue } });
    await archive({ resourceId: "other-runtime", kind: "claude_agent_sdk", reason: "operator_stop", evidence: { phase: "after_shutdown", ...idle } });
    const records = await Promise.all((await readdir(directory)).map(async name => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
    expect(records.map(record => [record.resourceId, record.evidence.phase]).sort()).toEqual([
      ["active-files", "after_shutdown"], ["active-files", "before_shutdown"], ["idle-runtime", "after_shutdown"],
    ]);
  });
});

describe("abandoned-work capacity", () => {
  const work = { phase: "before_shutdown", state: "active", revision: "1", blockers: ["active_work"], operations: [{ operationId: "operation", state: "pending" }] };
  async function seed(directory: string, names: readonly string[]): Promise<void> {
    await mkdir(directory, { mode: 0o700 });
    // Distinct, increasing modification times: names[0] is the oldest.
    const start = Date.now() / 1000 - 10_000;
    for (const [index, name] of names.entries()) {
      await writeFile(path.join(directory, name), "{}", { mode: 0o600 });
      await utimes(path.join(directory, name), start + index, start + index);
    }
  }

  it("rotates out the oldest records to keep the newest 128, logging the first rotation once", async () => {
    const directory = await archiveDirectory();
    const existing = Array.from({ length: 128 }, () => `${randomUUID()}.json`);
    await seed(directory, existing);
    const onError = vi.fn();
    const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
    for (let index = 0; index < 3; index++) await archive({ resourceId: `runtime-${index}`, kind: "terminal", reason: "operator_stop", evidence: work });
    const entries = await readdir(directory);
    expect(entries).toHaveLength(128);
    expect(entries.filter(name => existing.includes(name)).sort()).toEqual(existing.slice(3).sort());
    const written = await Promise.all(entries.filter(name => !existing.includes(name)).map(async name => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
    expect(written.map(record => record.resourceId).sort()).toEqual(["runtime-0", "runtime-1", "runtime-2"]);
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ message: "sidecar_abandonment_archive_rotated" })]]);
  });

  it("never rotates out files the archive did not write", async () => {
    const directory = await archiveDirectory();
    const foreign = ["notes.txt", "0.json", `${randomUUID().toUpperCase()}.json`, `${randomUUID()}.json.bak`, "service.json"];
    const records = Array.from({ length: 128 - foreign.length - 2 }, () => `${randomUUID()}.json`);
    // Foreign files are the oldest, so age alone would select them first.
    await seed(directory, [...foreign, ...records]);
    const linked = `${randomUUID()}.json`;
    const nested = `${randomUUID()}.json`;
    await symlink(path.join(directory, "notes.txt"), path.join(directory, linked));
    await mkdir(path.join(directory, nested), { mode: 0o700 });
    await utimes(path.join(directory, nested), 1, 1);
    const onError = vi.fn();
    const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
    for (let index = 0; index < 2; index++) await archive({ resourceId: `runtime-${index}`, kind: "terminal", reason: "operator_stop", evidence: work });
    const entries = await readdir(directory);
    expect(entries).toHaveLength(128);
    expect(entries).toEqual(expect.arrayContaining([...foreign, linked, nested, ...records.slice(2)]));
    expect(entries).not.toEqual(expect.arrayContaining([records[0]]));
    expect(entries).not.toEqual(expect.arrayContaining([records[1]]));
    expect(onError).toHaveBeenCalledOnce();
  });

  it("reports capacity exhaustion without deleting foreign files or blocking Stop", async () => {
    const directory = await archiveDirectory();
    await seed(directory, Array.from({ length: 128 }, (_, index) => `${index}.json`));
    const onError = vi.fn();
    const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
    await expect(archive({ resourceId: "runtime", kind: "codex_app_server", reason: "operator_stop", evidence: {} })).resolves.toBeUndefined();
    expect(onError.mock.calls).toEqual([[expect.objectContaining({ message: "sidecar_abandonment_capacity_exceeded" })]]);
    expect(await readdir(directory)).toHaveLength(128);
  });
});
