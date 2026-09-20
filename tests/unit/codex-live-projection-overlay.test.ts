import { describe, expect, it, vi } from "vitest";
import type { CodexThreadItem } from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  CodexLiveProjectionOverlay,
  type CodexLiveProjectionClock,
  type CodexLiveProjectionFlushItem,
  type CodexLiveProjectionScheduledTask,
  type CodexLiveProjectionScheduler,
} from "../../src/server/backends/codex/codex-live-projection-overlay.js";
import type { CodexProjectedItemCoordinate } from "../../src/server/backends/codex/codex-history-projector.js";
import { boundText } from "../../src/server/conversations/payload-policy.js";
import { CODEX_C2_MAX_TEXT_BYTES } from "../../src/server/backends/codex/codex-c2-protocol.js";
import { MAXIMUM_MESSAGE_TEXT_BYTES } from "../../src/shared/protocol/payload.js";

const coordinate: CodexProjectedItemCoordinate = {
  nativeTurnId: "turn-1",
  nativeItemId: "item-1",
  nativeOrdinal: 0,
  itemType: "agentMessage",
  backendTurnId: "backend-turn-1",
  sourceOrder: 0,
  orderedBackendItemIds: ["backend-item-1"],
};

const agentItem = (text = ""): CodexThreadItem => ({
  type: "agentMessage",
  id: "item-1",
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});

class FakeScheduler
  implements CodexLiveProjectionClock, CodexLiveProjectionScheduler
{
  nowValue = 0;
  readonly tasks: Array<{
    readonly dueAt: number;
    readonly callback: () => void;
    cancelled: boolean;
  }> = [];

  now(): number {
    return this.nowValue;
  }

  schedule(
    delayMilliseconds: number,
    callback: () => void,
  ): CodexLiveProjectionScheduledTask {
    const task = {
      dueAt: this.nowValue + delayMilliseconds,
      callback,
      cancelled: false,
    };
    this.tasks.push(task);
    return {
      cancel: () => {
        task.cancelled = true;
      },
    };
  }

  advance(milliseconds: number): void {
    this.nowValue += milliseconds;
    for (;;) {
      const due = this.tasks
        .filter((task) => !task.cancelled && task.dueAt <= this.nowValue)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (!due) return;
      due.cancelled = true;
      due.callback();
    }
  }

  get activeTasks(): number {
    return this.tasks.filter(({ cancelled }) => !cancelled).length;
  }
}

function key(item: CodexLiveProjectionFlushItem): string {
  return `${item.nativeTurnId}\0${item.nativeItemId}`;
}

describe("CodexLiveProjectionOverlay", () => {
  it("uses one leading/trailing task and coalesces chunks per item", () => {
    const scheduler = new FakeScheduler();
    const flushed: string[] = [];
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        flushed.push(
          ...(items.map(({ item }) =>
            item.type === "agentMessage" ? item.text : "unexpected",
          ) as string[]),
        );
        return new Set(items.map(key));
      },
      onInvalid: vi.fn(),
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate, item: agentItem() }],
    });

    expect(overlay.appendText("turn-1", "item-1", "agentMessage", "a")).toBe(
      true,
    );
    expect(flushed).toEqual(["a"]);
    overlay.appendText("turn-1", "item-1", "agentMessage", "b");
    overlay.appendText("turn-1", "item-1", "agentMessage", "c");
    expect(scheduler.activeTasks).toBe(1);
    scheduler.advance(49);
    expect(flushed).toEqual(["a"]);
    scheduler.advance(1);
    expect(flushed).toEqual(["a", "abc"]);
    expect(overlay.pendingCount).toBe(0);
    expect(scheduler.activeTasks).toBe(0);
  });

  it("does not throttle a real replacement after an immediate no-op", () => {
    const scheduler = new FakeScheduler();
    const fileCoordinate = { ...coordinate, itemType: "fileChange" as const };
    const initialChanges = [
      { path: "src/a.ts", kind: { type: "delete" as const }, diff: "" },
    ];
    let installed = JSON.stringify(initialChanges);
    const published: string[] = [];
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        const changed = new Set<string>();
        for (const live of items) {
          if (live.item.type !== "fileChange") continue;
          const value = JSON.stringify(live.item.changes);
          if (value === installed) continue;
          installed = value;
          published.push(value);
          changed.add(key(live));
        }
        return changed;
      },
      onInvalid: vi.fn(),
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [
        {
          coordinate: fileCoordinate,
          item: {
            type: "fileChange",
            id: "item-1",
            changes: initialChanges,
            status: "inProgress",
          },
        },
      ],
    });

    overlay.replaceFileChanges("turn-1", "item-1", initialChanges);
    expect(published).toEqual([]);
    overlay.replaceFileChanges("turn-1", "item-1", [
      { ...initialChanges[0]!, diff: "-old\n" },
    ]);
    expect(published).toHaveLength(1);
    expect(scheduler.activeTasks).toBe(0);
  });

  it("throttles later dirty work after a projected no-op", () => {
    const scheduler = new FakeScheduler();
    const projected: string[] = [];
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        projected.push(
          items[0]?.item.type === "agentMessage"
            ? items[0].item.text
            : "unexpected",
        );
        return new Set();
      },
      onInvalid: vi.fn(),
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate, item: agentItem() }],
    });

    overlay.appendText("turn-1", "item-1", "agentMessage", "a");
    overlay.appendText("turn-1", "item-1", "agentMessage", "b");
    expect(projected).toEqual(["a"]);
    expect(scheduler.activeTasks).toBe(1);
    scheduler.advance(50);
    expect(projected).toEqual(["a", "ab"]);
  });

  it("bounds multibyte saturated plan-preview projection work by cadence", () => {
    const scheduler = new FakeScheduler();
    let installed = boundText("界".repeat(5_461));
    let projections = 0;
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        projections += 1;
        const item = items[0]?.item;
        if (item?.type !== "plan") return false;
        const next = boundText(item.text);
        if (JSON.stringify(next) === JSON.stringify(installed)) {
          return new Set();
        }
        installed = next;
        return new Set(items.map(key));
      },
      onInvalid: vi.fn(),
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [
        {
          coordinate: { ...coordinate, itemType: "plan" },
          item: { type: "plan", id: "item-1", text: "界".repeat(5_461) },
        },
      ],
    });

    overlay.appendText("turn-1", "item-1", "plan", "界");
    for (let index = 0; index < 100; index += 1) {
      overlay.appendText("turn-1", "item-1", "plan", "界");
    }
    expect(projections).toBe(1);
    scheduler.advance(50);
    expect(projections).toBe(2);
    for (let index = 0; index < 100; index += 1) {
      overlay.appendText("turn-1", "item-1", "plan", "界");
    }
    expect(projections).toBe(2);
  });

  it("retains complete long assistant text across seeds, deltas, and reinstalls", () => {
    const scheduler = new FakeScheduler();
    const onInvalid = vi.fn();
    let latest = "";
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        const item = items[0]?.item;
        if (item?.type === "agentMessage") latest = item.text;
        return new Set(items.map(key));
      },
      onInvalid,
    });
    const seed = "Initial paragraph.\n\n".repeat(2_000);
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate, item: agentItem(seed) }],
    });
    const middle = "Unicode 雪🙂 with **Markdown**.\n\n".repeat(3_000);
    expect(overlay.appendText("turn-1", "item-1", "agentMessage", middle)).toBe(
      true,
    );
    expect(latest).toBe(seed + middle);
    overlay.appendText("turn-1", "item-1", "agentMessage", "\ud83d");
    overlay.appendText(
      "turn-1",
      "item-1",
      "agentMessage",
      "\ude00 final paragraph.",
    );
    scheduler.advance(50);
    const expected = `${seed}${middle}😀 final paragraph.`;
    expect(latest).toBe(expected);
    expect(overlay.retainedBytes).toBe(Buffer.byteLength(expected, "utf8"));

    overlay.reset({
      generation: 1,
      installEpoch: 2,
      seeds: [{ coordinate, item: agentItem(latest) }],
    });
    expect(
      overlay.appendText("turn-1", "item-1", "agentMessage", " Final tail."),
    ).toBe(true);
    expect(latest).toBe(`${expected} Final tail.`);
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("preserves null command output until the first output delta", () => {
    const scheduler = new FakeScheduler();
    const outputs: Array<string | null> = [];
    const commandCoordinate = {
      ...coordinate,
      itemType: "commandExecution" as const,
    };
    const command: CodexThreadItem = {
      type: "commandExecution",
      id: "item-1",
      pluginId: null,
      scriptPath: null,
      command: "npm test",
      cwd: "/workspace",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
    };
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        const item = items[0]?.item;
        if (item?.type === "commandExecution") {
          outputs.push(item.aggregatedOutput);
        }
        return new Set(items.map(key));
      },
      onInvalid: vi.fn(),
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate: commandCoordinate, item: command }],
    });

    expect(overlay.materializedItems()[0]?.item).toMatchObject({
      aggregatedOutput: null,
    });
    overlay.appendText("turn-1", "item-1", "commandExecution", "");
    expect(outputs).toEqual([""]);
  });

  it("carries accepted logical byte totals across same-generation installs", () => {
    const scheduler = new FakeScheduler();
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => new Set(items.map(key)),
      onInvalid: vi.fn(),
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate, item: agentItem() }],
    });
    overlay.appendText("turn-1", "item-1", "agentMessage", "first");
    const materialized = overlay.materializedItems()[0]!;
    const beforeReset = overlay.acceptedLogicalBytes;

    overlay.reset({
      generation: 1,
      installEpoch: 2,
      seeds: [{ coordinate, item: materialized.item }],
    });
    expect(overlay.acceptedLogicalBytes).toBe(beforeReset);
    overlay.appendText("turn-1", "item-1", "agentMessage", " second");
    expect(overlay.acceptedLogicalBytes).toBe(
      beforeReset + new TextEncoder().encode(" second").byteLength,
    );
  });

  it("cancels pending work on terminal removal, replacement, and disposal", () => {
    const scheduler = new FakeScheduler();
    const onFlush = vi.fn(
      (items: readonly CodexLiveProjectionFlushItem[]) =>
        new Set(items.map(key)),
    );
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush,
      onInvalid: vi.fn(),
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate, item: agentItem() }],
    });
    overlay.appendText("turn-1", "item-1", "agentMessage", "first");
    overlay.appendText("turn-1", "item-1", "agentMessage", " pending");
    expect(scheduler.activeTasks).toBe(1);
    overlay.remove("turn-1", "item-1");
    expect(scheduler.activeTasks).toBe(0);
    scheduler.advance(100);
    expect(onFlush).toHaveBeenCalledTimes(1);

    overlay.reset({
      generation: 2,
      installEpoch: 2,
      seeds: [{ coordinate, item: agentItem("replacement") }],
    });
    overlay.appendText("turn-1", "item-1", "agentMessage", " live");
    overlay.appendText("turn-1", "item-1", "agentMessage", " pending");
    overlay.dispose();
    scheduler.advance(100);
    expect(onFlush).toHaveBeenCalledTimes(2);
    expect(overlay.retainedBytes).toBe(0);
    expect(overlay.invalidated).toBe(true);
  });

  it("rejects unknown coordinates and preserves split surrogate pairs", () => {
    const scheduler = new FakeScheduler();
    const onInvalid = vi.fn();
    let latest = "";
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        const item = items[0]?.item;
        if (item?.type === "agentMessage") latest = item.text;
        return new Set(items.map(key));
      },
      onInvalid,
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate, item: agentItem() }],
    });

    expect(overlay.appendText("turn-1", "missing", "agentMessage", "no")).toBe(
      false,
    );
    overlay.appendText("turn-1", "item-1", "agentMessage", "\ud83d");
    overlay.appendText("turn-1", "item-1", "agentMessage", "\ude00");
    scheduler.advance(50);
    expect(latest).toBe("😀");
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it("retains supported assistant Unicode beyond the native code-unit limit in bytes", () => {
    const scheduler = new FakeScheduler();
    const onInvalid = vi.fn();
    let latest = "";
    const overlay = new CodexLiveProjectionOverlay({
      intervalMilliseconds: 50,
      clock: scheduler,
      scheduler,
      onFlush: (items) => {
        const item = items[0]?.item;
        if (item?.type === "agentMessage") latest = item.text;
        return new Set(items.map(key));
      },
      onInvalid,
    });
    overlay.reset({
      generation: 1,
      installEpoch: 1,
      seeds: [{ coordinate, item: agentItem() }],
    });
    const text = "😀".repeat(2 * 1024 * 1024);
    expect(overlay.appendText("turn-1", "item-1", "agentMessage", text)).toBe(
      true,
    );
    expect(latest).toBe(text);
    expect(overlay.retainedBytes).toBe(Buffer.byteLength(text, "utf8"));
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it.each([
    ["native code units", () => "x".repeat(CODEX_C2_MAX_TEXT_BYTES + 1)],
    [
      "retained UTF-8 bytes",
      () => "界".repeat(Math.floor(MAXIMUM_MESSAGE_TEXT_BYTES / 3) + 1),
    ],
  ])(
    "invalidates and releases retained state when %s overflow",
    (_name, oversizedText) => {
      const scheduler = new FakeScheduler();
      const onInvalid = vi.fn();
      const overlay = new CodexLiveProjectionOverlay({
        intervalMilliseconds: 50,
        clock: scheduler,
        scheduler,
        onFlush: (items) => new Set(items.map(key)),
        onInvalid,
      });
      overlay.reset({
        generation: 1,
        installEpoch: 1,
        seeds: [{ coordinate, item: agentItem() }],
      });

      expect(
        overlay.appendText("turn-1", "item-1", "agentMessage", oversizedText()),
      ).toBe(false);
      expect(onInvalid).toHaveBeenCalledTimes(1);
      expect(overlay.invalidated).toBe(true);
      expect(overlay.retainedBytes).toBe(0);
      expect(scheduler.activeTasks).toBe(0);
    },
  );
});
