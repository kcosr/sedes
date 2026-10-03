import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeOuterProcessSupervisor } from "../../src/server/backends/claude/worker/claude-outer-process-supervisor.js";
import {
  readProcessEntrySync,
  readProcessTable,
  readProcessTableSync,
  type ProcessTableEntry,
} from "../../src/server/runtime/process-table.js";

vi.mock("../../src/server/runtime/process-table.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/server/runtime/process-table.js")>(),
  readProcessEntrySync: vi.fn(),
  readProcessTable: vi.fn(),
  readProcessTableSync: vi.fn(),
}));

function entry(pid: number, parentPid = 1, processGroupId = pid, exited = false, startTime = `start-${pid}`): ProcessTableEntry {
  return { pid, parentPid, processGroupId, exited, startTime };
}

function table(...entries: ProcessTableEntry[]): Map<number, ProcessTableEntry> {
  return new Map(entries.map((process) => [process.pid, process]));
}

function message(type: "process_group_registered" | "process_group_unregistered", processGroupId = 100) {
  return { type, token: "t".repeat(43), processGroupId } as const;
}

describe("Claude outer process supervisor cleanup proof", () => {
  let current: Map<number, ProcessTableEntry>;
  let supervisor: ClaudeOuterProcessSupervisor;

  beforeEach(() => {
    current = table(entry(100));
    vi.mocked(readProcessEntrySync).mockImplementation((pid) => current.get(pid));
    vi.mocked(readProcessTableSync).mockImplementation(() => current);
    vi.mocked(readProcessTable).mockImplementation(async () => current);
    // kill(0) succeeds for groups containing zombies, just as on POSIX hosts.
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(signal).toBe(0);
      if ([...current.values()].some((process) => process.processGroupId === -pid)) return true;
      throw Object.assign(new Error("absent"), { code: "ESRCH" });
    });
    supervisor = new ClaudeOuterProcessSupervisor();
    supervisor.accept(message("process_group_registered"));
  });

  afterEach(() => vi.restoreAllMocks());

  it("accepts zombie-only cleanup without discarding another retained session's group", async () => {
    current = table(entry(100), entry(101, 100, 100), entry(200));
    supervisor.accept(message("process_group_registered", 200));
    await supervisor.observe();

    current = table(entry(100, 1, 100, true), entry(101, 1, 100, true), entry(200));
    expect(process.kill(-100, 0)).toBe(true);
    expect(() => supervisor.accept(message("process_group_unregistered"))).not.toThrow();
    expect(supervisor.registeredProcessGroupCount).toBe(1);
    expect(() => supervisor.accept(message("process_group_unregistered", 200)))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
    expect(supervisor.registeredProcessGroupCount).toBe(1);
  });

  it("accepts an absent leader whose remaining group members are all zombies", () => {
    current = table(entry(101, 1, 100, true));
    expect(() => supervisor.accept(message("process_group_unregistered"))).not.toThrow();
    expect(supervisor.registeredProcessGroupCount).toBe(0);
  });

  it("rejects a live group member even when the leader is a zombie", () => {
    current = table(entry(100, 1, 100, true), entry(101, 1, 100));
    expect(() => supervisor.accept(message("process_group_unregistered")))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
    expect(supervisor.registeredProcessGroupCount).toBe(1);
  });

  it("retains an observed escaped descendant after its original group disappears", async () => {
    current = table(entry(100), entry(101, 100));
    await supervisor.observe();
    current = table(entry(101));
    expect(() => process.kill(-100, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(() => supervisor.accept(message("process_group_unregistered")))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
    expect(supervisor.registeredProcessGroupCount).toBe(1);

    current = table(entry(101, 1, 101, true));
    expect(() => supervisor.accept(message("process_group_unregistered"))).not.toThrow();
    expect(supervisor.registeredProcessGroupCount).toBe(0);
  });

  it("does not attribute a recycled leader PID to the finished session", () => {
    current = table(entry(100, 1, 100, false, "replacement-start"));
    expect(() => supervisor.accept(message("process_group_unregistered"))).not.toThrow();
    expect(supervisor.registeredProcessGroupCount).toBe(0);
  });

  it.each(["addressable", "permission denied"])("fails closed for an invisible group that is %s", (kind) => {
    current = table();
    vi.mocked(process.kill).mockImplementation(() => {
      if (kind === "permission denied") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    });
    expect(() => supervisor.accept(message("process_group_unregistered")))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
    expect(supervisor.registeredProcessGroupCount).toBe(1);
  });

  it("retains ownership if process-table inspection fails", () => {
    vi.mocked(readProcessTableSync).mockImplementation(() => { throw new Error("process_table_unavailable"); });
    expect(() => supervisor.accept(message("process_group_unregistered"))).toThrow("process_table_unavailable");
    expect(supervisor.registeredProcessGroupCount).toBe(1);
  });

  it("rejects unknown and duplicate unregistration", () => {
    expect(() => supervisor.accept(message("process_group_unregistered", 999)))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
    current = table();
    supervisor.accept(message("process_group_unregistered"));
    expect(() => supervisor.accept(message("process_group_unregistered")))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
  });

  it("accepts a zombie gate that died before its live identity was recorded", () => {
    current = table(entry(100), entry(200, 1, 200, true));
    supervisor.accept(message("process_group_registered", 200));
    expect(() => supervisor.accept(message("process_group_unregistered", 200))).not.toThrow();
    expect(supervisor.registeredProcessGroupCount).toBe(1);
  });

  it("accepts group absence when the gate vanished before its identity was recorded", () => {
    supervisor.accept(message("process_group_registered", 200));
    expect(() => supervisor.accept(message("process_group_unregistered", 200))).not.toThrow();
    expect(supervisor.registeredProcessGroupCount).toBe(1);
  });

  it("rejects live members when the gate died before its identity was recorded", () => {
    current = table(entry(200, 1, 200, true));
    supervisor.accept(message("process_group_registered", 200));
    current = table(entry(200, 1, 200, true), entry(201, 1, 200));
    expect(() => supervisor.accept(message("process_group_unregistered", 200)))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
    expect(supervisor.registeredProcessGroupCount).toBe(2);
  });

  it.each(["addressable", "permission denied"])("retains an unrecorded gate's invisible group that is %s", (kind) => {
    supervisor.accept(message("process_group_registered", 200));
    current = table();
    vi.mocked(process.kill).mockImplementation(() => {
      if (kind === "permission denied") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    });
    expect(() => supervisor.accept(message("process_group_unregistered", 200)))
      .toThrow("claude_runtime_worker_process_group_unregistration_invalid");
    expect(supervisor.registeredProcessGroupCount).toBe(2);
  });

  it("retains an unrecorded gate's group when process-table inspection fails", () => {
    current = table(entry(200, 1, 200, true));
    supervisor.accept(message("process_group_registered", 200));
    vi.mocked(readProcessTableSync).mockImplementation(() => { throw new Error("process_table_unavailable"); });
    expect(() => supervisor.accept(message("process_group_unregistered", 200))).toThrow("process_table_unavailable");
    expect(supervisor.registeredProcessGroupCount).toBe(2);
  });
});
