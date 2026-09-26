import { describe, expect, it } from "vitest";
import {
  cleanUpOwnedProcessTrees,
  OwnedProcessTree,
  type ProcessSignals,
} from "../../src/server/runtime/owned-process-tree.js";
import {
  collectDescendants,
  parseDarwinProcessTable,
  parseLinuxProcessStat,
  type ProcessTableEntry,
} from "../../src/server/runtime/process-table.js";

function entry(pid: number, parentPid: number, processGroupId = pid, startTime = `t${pid}`, exited = false): ProcessTableEntry {
  return { pid, parentPid, processGroupId, startTime, exited };
}

function table(...entries: ProcessTableEntry[]): Map<number, ProcessTableEntry> {
  return new Map(entries.map((value) => [value.pid, value]));
}

/** Fake kill(2): a group exists while any listed process (live or zombie) is in it. */
function fakeSignals(current: () => Map<number, ProcessTableEntry>) {
  const sent: string[] = [];
  const signals: ProcessSignals = {
    exists: (target) => target < 0
      ? [...current().values()].some((value) => value.processGroupId === -target)
      : current().has(target),
    send: (target, signal) => {
      sent.push(`${signal}:${target}`);
      return signals.exists(target);
    },
  };
  return { signals, sent };
}

describe("process table parsing", () => {
  it("parses Linux stat records whose command names contain spaces and parentheses", () => {
    const fields = Array.from({ length: 50 }, (_, index) => String(index));
    fields[0] = "S"; fields[1] = "41"; fields[2] = "42"; fields[19] = "987654";
    expect(parseLinuxProcessStat(43, `43 (evil) (name) ${fields.join(" ")}`)).toEqual({
      pid: 43, parentPid: 41, processGroupId: 42, startTime: "987654", exited: false,
    });
    fields[0] = "Z";
    expect(parseLinuxProcessStat(43, `43 (x) ${fields.join(" ")}`)?.exited).toBe(true);
    expect(parseLinuxProcessStat(43, "43 (truncated) S 1")).toBeUndefined();
  });

  it("parses macOS ps rows with a normalized start token", () => {
    const parsed = parseDarwinProcessTable([
      "    1     0     1 Ss   Sat Sep 26 02:07:23 2026",
      "  812     1   812 Z+   Sat Sep  5 10:00:01 2026",
      "",
    ].join("\n"));
    expect(parsed.get(1)).toEqual({ pid: 1, parentPid: 0, processGroupId: 1, startTime: "Sat Sep 26 02:07:23 2026", exited: false });
    expect(parsed.get(812)).toMatchObject({ startTime: "Sat Sep 5 10:00:01 2026", exited: true });
    expect(() => parseDarwinProcessTable("garbage\n")).toThrow("process_table_output_invalid");
  });

  it("collects descendants transitively without the roots", () => {
    const processes = table(entry(10, 1), entry(11, 10), entry(12, 11, 12), entry(20, 1), entry(13, 12, 12));
    expect(collectDescendants(processes, [10]).map(({ pid }) => pid).sort()).toEqual([11, 12, 13]);
    expect(collectDescendants(processes, [99])).toEqual([]);
  });
});

describe("owned process tree", () => {
  it("keeps orphaned session descendants and their children after the leader exits", () => {
    let current = table(entry(100, 1), entry(101, 100), entry(102, 101, 102));
    const { signals, sent } = fakeSignals(() => current);
    const tree = new OwnedProcessTree(current.get(100)!, signals);
    tree.observe(current);
    expect(tree.observedDescendantCount).toBe(2);

    // The leader and the intermediate shell exit; the setsid child is reparented.
    current = table(entry(102, 1, 102), entry(103, 102, 102), entry(500, 1));
    tree.observe(current);
    expect(tree.remaining(current)).toEqual({ processes: [102, 103], groups: [102] });
    tree.signal(current, "SIGTERM");
    expect(sent).toEqual(["SIGTERM:-102", "SIGTERM:102", "SIGTERM:103"]);
    current = table(entry(500, 1));
    expect(tree.remains(current)).toBe(false);
  });

  it("drops a group whose creating PID now names a different process", () => {
    let current = table(entry(100, 1), entry(101, 100, 101));
    const { signals, sent } = fakeSignals(() => current);
    const tree = new OwnedProcessTree(current.get(100)!, signals);
    tree.observe(current);
    // PID 101 was reused by an unrelated group leader after the owned group ended.
    current = table(entry(101, 1, 101, "reused"), entry(102, 101, 101, "unrelated"));
    expect(tree.remaining(current)).toEqual({ processes: [], groups: [] });
    expect(tree.signal(current, "SIGKILL")).toBe(false);
    expect(sent).toEqual([]);
  });

  it("does not count zombie-only groups but keeps groups with invisible members", () => {
    let current = table(entry(100, 1), entry(101, 100, 101), entry(102, 101, 101));
    const { signals } = fakeSignals(() => current);
    const tree = new OwnedProcessTree(current.get(100)!, signals);
    tree.observe(current);
    current = table(entry(102, 1, 101, "t102", true));
    expect(tree.remaining(current)).toEqual({ processes: [], groups: [] });

    const hidden = new OwnedProcessTree(entry(200, 1), {
      exists: (target) => target === -200,
      send: () => true,
    });
    expect(hidden.remaining(table())).toEqual({ processes: [], groups: [200] });
  });

  it("forgets ended descendant groups while observing a long-lived leader", () => {
    let current = table(entry(100, 1), entry(101, 100, 101), entry(102, 100, 102));
    const { signals } = fakeSignals(() => current);
    const tree = new OwnedProcessTree(current.get(100)!, signals);
    tree.observe(current);
    current = table(entry(100, 1), entry(102, 100, 102));
    tree.observe(current);
    // Group 101 ended. A later unrelated group reusing that number whose
    // leader already exited has no creator entry left to compare.
    current = table(entry(100, 1), entry(102, 100, 102), entry(103, 1, 101, "unrelated"));
    expect(tree.remaining(current)).toEqual({ processes: [102], groups: [100, 102] });
  });

  it("rejects a leader that is not its own live group leader", () => {
    expect(() => new OwnedProcessTree(entry(100, 1, 99))).toThrow("owned_process_tree_leader_invalid");
    expect(() => new OwnedProcessTree(entry(100, 1, 100, "t", true))).toThrow("owned_process_tree_leader_invalid");
  });

  it("escalates to SIGKILL and proves cleanup only when every owned process is gone", async () => {
    let current = table(entry(100, 1), entry(101, 100, 101));
    const { signals, sent } = fakeSignals(() => current);
    const stubborn = { ...signals, send: (target: number, signal: NodeJS.Signals) => {
      const delivered = signals.send(target, signal);
      if (signal === "SIGTERM") current = table(entry(101, 1, 101));
      if (signal === "SIGKILL") current = table();
      return delivered;
    } };
    const tree = new OwnedProcessTree(current.get(100)!, stubborn);
    await expect(cleanUpOwnedProcessTrees([tree], {
      gracefulMilliseconds: 10, terminateMilliseconds: 10, killMilliseconds: 50, pollMilliseconds: 5,
      readTable: async () => current,
    })).resolves.toBe(true);
    expect(sent).toEqual(["SIGTERM:-100", "SIGTERM:-101", "SIGTERM:101", "SIGKILL:-101", "SIGKILL:101"]);
  });

  it("reports unproven cleanup when an owned descendant survives SIGKILL", async () => {
    const current = table(entry(100, 1), entry(101, 100, 101));
    const { signals } = fakeSignals(() => current);
    const tree = new OwnedProcessTree(current.get(100)!, signals);
    await expect(cleanUpOwnedProcessTrees([tree], {
      gracefulMilliseconds: 5, terminateMilliseconds: 5, killMilliseconds: 5, pollMilliseconds: 1,
      readTable: async () => current,
    })).resolves.toBe(false);
  });
});
