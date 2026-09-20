// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ android: false }));
vi.mock("../app/client-platform.js", () => ({
  isAndroidClient: () => platform.android,
}));
import type { ApiClient } from "../api/ApiClient.js";
import type { EventStreamTransport } from "../api/EventStreamTransport.js";
import {
  INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS,
  MAXIMUM_ANDROID_INACTIVE_THREAD_STORE_BYTES,
  MAXIMUM_INACTIVE_THREAD_STORE_BYTES,
  MAXIMUM_INACTIVE_THREAD_STORES,
  ThreadStoreRegistry,
} from "./ThreadStoreRegistry.js";
import { clearDiagnostics, readDiagnostics } from "../app/diagnostics.js";
import {
  setActivityDetail,
  setDiagnosticCategoryEnabled,
} from "../app/settings.js";
import { resetThreadLoadAttemptsForTests } from "../app/thread-load-diagnostics.js";
import {
  clearPendingActivityDetailExpansion,
  hasPendingActivityDetailExpansion,
  requestActivityDetailExpansion,
} from "../components/thread/activity-detail-intent.js";

afterEach(() => {
  vi.useRealTimers();
  clearDiagnostics();
  resetThreadLoadAttemptsForTests();
  localStorage.clear();
  clearPendingActivityDetailExpansion();
  platform.android = false;
});

function transportFixture(): {
  readonly transport: EventStreamTransport;
  readonly subscribeThread: ReturnType<typeof vi.fn>;
  readonly closes: Map<string, ReturnType<typeof vi.fn>[]>;
} {
  const closes = new Map<string, ReturnType<typeof vi.fn>[]>();
  const subscribeThread = vi.fn(
    (
      threadId: string,
      _input: Parameters<EventStreamTransport["subscribeThread"]>[1],
    ) => {
      const close = vi.fn();
      const threadCloses = closes.get(threadId) ?? [];
      threadCloses.push(close);
      closes.set(threadId, threadCloses);
      return { close };
    },
  );
  return {
    transport: { subscribeThread } as unknown as EventStreamTransport,
    subscribeThread,
    closes,
  };
}

describe("ThreadStoreRegistry retention", () => {
  it("uses the single-user warm navigation budget", () => {
    expect(INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS).toBe(60 * 60_000);
    expect(MAXIMUM_INACTIVE_THREAD_STORES).toBe(32);
    expect(MAXIMUM_INACTIVE_THREAD_STORE_BYTES).toBe(256 * 1_024 * 1_024);
    expect(MAXIMUM_ANDROID_INACTIVE_THREAD_STORE_BYTES).toBe(
      64 * 1_024 * 1_024,
    );
  });

  it("clears inline expansion intent for settings and storage changes only", () => {
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );
    requestActivityDetailExpansion("thread-1", "activity-1");
    setActivityDetail("summary");
    expect(hasPendingActivityDetailExpansion("thread-1", "activity-1")).toBe(
      false,
    );

    requestActivityDetailExpansion("thread-1", "activity-1");
    setActivityDetail("full", "inline_activity");
    expect(hasPendingActivityDetailExpansion("thread-1", "activity-1")).toBe(
      true,
    );

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-activity-detail",
        newValue: "full",
      }),
    );
    expect(hasPendingActivityDetailExpansion("thread-1", "activity-1")).toBe(
      false,
    );
    registry.dispose();
  });

  it("switches every retained store and reconnects only live references", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );
    const active = registry.retain("active");
    const inactive = registry.retain("inactive");
    const inactiveReset = vi.spyOn(inactive.normalized, "resetProjection");
    registry.release("inactive");

    setActivityDetail("summary");

    expect(active.activityDetail).toBe("summary");
    expect(inactive.activityDetail).toBe("summary");
    expect(inactiveReset).toHaveBeenCalledOnce();
    expect(
      fixture.subscribeThread.mock.calls.filter(([id]) => id === "active"),
    ).toHaveLength(2);
    expect(
      fixture.subscribeThread.mock.calls.filter(([id]) => id === "inactive"),
    ).toHaveLength(1);
    expect(fixture.subscribeThread.mock.calls.at(-1)?.[1]).toMatchObject({
      activityDetail: "summary",
    });

    registry.retain("inactive");
    expect(fixture.subscribeThread.mock.calls.at(-1)?.[1]).toMatchObject({
      activityDetail: "summary",
    });
    registry.dispose();
  });

  it("does not treat a background store retention as a visible load", () => {
    setDiagnosticCategoryEnabled("thread_load", true);
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );

    registry.retain("context-menu-preview-thread");

    expect(readDiagnostics()).toEqual([]);
    expect(fixture.subscribeThread.mock.calls[0]?.[1]).not.toHaveProperty(
      "loadDiagnostics",
    );
    registry.dispose();
  });

  it("pauses immediately after the final reference and resumes the same store", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );

    const first = registry.retain("thread-1");
    expect(registry.retain("thread-1")).toBe(first);
    expect(fixture.subscribeThread).toHaveBeenCalledTimes(1);

    registry.release("thread-1");
    expect(fixture.closes.get("thread-1")?.[0]).not.toHaveBeenCalled();
    registry.release("thread-1");
    expect(fixture.closes.get("thread-1")?.[0]).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS - 1);
    expect(registry.retain("thread-1")).toBe(first);
    expect(fixture.subscribeThread).toHaveBeenCalledTimes(2);

    registry.release("thread-1");
    expect(fixture.closes.get("thread-1")?.[1]).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS);
    expect(registry.get("thread-1")).not.toBe(first);
    registry.dispose();
  });

  it("shares one stream across references and protects referenced entries", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );
    const selected = registry.retain("selected");
    registry.retain("selected");

    for (
      let index = 0;
      index < MAXIMUM_INACTIVE_THREAD_STORES + 2;
      index += 1
    ) {
      const id = `inactive-${index}`;
      registry.retain(id);
      registry.release(id);
    }

    expect(registry.get("selected")).toBe(selected);
    expect(fixture.closes.get("selected")?.[0]).not.toHaveBeenCalled();
    expect(
      fixture.subscribeThread.mock.calls.filter(([id]) => id === "selected"),
    ).toHaveLength(1);
    registry.release("selected");
    expect(fixture.closes.get("selected")?.[0]).not.toHaveBeenCalled();
    registry.release("selected");
    expect(fixture.closes.get("selected")?.[0]).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it("keeps pane cache references independent from selected stream ownership", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );

    const paneStore = registry.retainCached("thread-1");
    expect(fixture.subscribeThread).not.toHaveBeenCalled();
    expect(registry.retain("thread-1")).toBe(paneStore);
    expect(fixture.subscribeThread).toHaveBeenCalledOnce();

    registry.release("thread-1");
    expect(fixture.closes.get("thread-1")?.[0]).toHaveBeenCalledOnce();
    expect(registry.get("thread-1")).toBe(paneStore);

    vi.advanceTimersByTime(INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS);
    expect(registry.get("thread-1")).toBe(paneStore);
    registry.releaseCached("thread-1");
    vi.advanceTimersByTime(INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS);
    expect(registry.get("thread-1")).not.toBe(paneStore);
    registry.dispose();
  });

  it("evicts the least-recently-used inactive store over the count limit", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );
    const disposals = new Map<string, ReturnType<typeof vi.spyOn>>();

    for (let index = 0; index <= MAXIMUM_INACTIVE_THREAD_STORES; index += 1) {
      const id = `thread-${index}`;
      const store = registry.retain(id);
      disposals.set(id, vi.spyOn(store, "dispose"));
      registry.release(id);
    }

    expect(disposals.get("thread-0")).toHaveBeenCalledOnce();
    for (let index = 1; index <= MAXIMUM_INACTIVE_THREAD_STORES; index += 1) {
      expect(disposals.get(`thread-${index}`)).not.toHaveBeenCalled();
    }
    registry.dispose();
  });

  it("evicts oldest inactive snapshots over the serialized byte limit", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );
    const first = registry.retain("first");
    Object.defineProperty(first, "snapshotSerializedBytes", {
      configurable: true,
      value: Math.floor(MAXIMUM_INACTIVE_THREAD_STORE_BYTES * 0.6),
    });
    registry.release("first");

    const second = registry.retain("second");
    Object.defineProperty(second, "snapshotSerializedBytes", {
      configurable: true,
      value: Math.floor(MAXIMUM_INACTIVE_THREAD_STORE_BYTES * 0.6),
    });
    registry.release("second");

    expect(registry.get("first")).not.toBe(first);
    expect(registry.get("second")).toBe(second);
    registry.dispose();
  });

  it("uses the smaller serialized byte budget in the Android WebView", () => {
    vi.useFakeTimers();
    platform.android = true;
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );
    const first = registry.retain("android-first");
    Object.defineProperty(first, "snapshotSerializedBytes", {
      configurable: true,
      value: Math.floor(MAXIMUM_ANDROID_INACTIVE_THREAD_STORE_BYTES * 0.6),
    });
    registry.release("android-first");

    const second = registry.retain("android-second");
    Object.defineProperty(second, "snapshotSerializedBytes", {
      configurable: true,
      value: Math.floor(MAXIMUM_ANDROID_INACTIVE_THREAD_STORE_BYTES * 0.6),
    });
    registry.release("android-second");

    expect(registry.get("android-first")).not.toBe(first);
    expect(registry.get("android-second")).toBe(second);
    registry.dispose();
  });

  it("establishes final-release LRU state before pause subscribers enforce limits", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );
    const candidate = registry.get("candidate-created-first");
    const candidateDisposal = vi.spyOn(candidate, "dispose");
    registry.retain("candidate-created-first");
    const inactiveDisposals: ReturnType<typeof vi.spyOn>[] = [];

    for (let index = 0; index < MAXIMUM_INACTIVE_THREAD_STORES; index += 1) {
      const store = registry.retain(`inactive-${index}`);
      inactiveDisposals.push(vi.spyOn(store, "dispose"));
      registry.release(`inactive-${index}`);
    }

    registry.release("candidate-created-first");

    expect(candidateDisposal).not.toHaveBeenCalled();
    expect(inactiveDisposals[0]).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS);
    expect(candidateDisposal).toHaveBeenCalledOnce();
    registry.dispose();
  });

  it("records only bounded content-free cache diagnostics when enabled", () => {
    vi.useFakeTimers();
    setDiagnosticCategoryEnabled("thread_load", true);
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );

    registry.retain("secret-thread-id");
    registry.release("secret-thread-id");
    vi.advanceTimersByTime(INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS);

    const entries = readDiagnostics().filter(({ event }) =>
      event.startsWith("thread_store_"),
    );
    expect(entries).toMatchObject([
      {
        category: "thread_load",
        event: "thread_store_cached",
        details: { bytes: 0, itemCount: 0 },
      },
      {
        category: "thread_load",
        event: "thread_store_evicted",
        details: {
          reason: "idle_timeout",
          bytes: 0,
          itemCount: 0,
          durationMilliseconds: INACTIVE_THREAD_STORE_RETENTION_MILLISECONDS,
        },
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain("secret-thread-id");
    registry.dispose();
  });

  it("does not record cache diagnostics while thread loading diagnostics are off", () => {
    vi.useFakeTimers();
    const fixture = transportFixture();
    const registry = new ThreadStoreRegistry(
      {} as ApiClient,
      fixture.transport,
    );

    registry.retain("thread-1");
    registry.release("thread-1");
    registry.dispose();

    expect(readDiagnostics()).toEqual([]);
  });
});
