import { describe, expect, it, vi } from "vitest";
import { admitGrokRuntimeVersion } from "../../src/server/backends/grok/grok-release-guard.js";
import { GrokRuntimeAdvisorySource } from "../../src/server/backends/grok/grok-runtime-advisories.js";

describe("Grok runtime advisories", () => {
  it("publishes one advisory only while newer than tested", () => {
    const source = new GrokRuntimeAdvisorySource();
    const listener = vi.fn();
    const unsubscribe = source.subscribe(listener);

    source
      .beginObservation()
      .admitted(admitGrokRuntimeVersion("1.0.4", "d846eb93d9").assessment);
    expect(source.active()).toEqual([]);
    expect(listener).not.toHaveBeenCalled();

    source
      .beginObservation()
      .admitted(admitGrokRuntimeVersion("1.2.0", "abcdef1").assessment);
    expect(source.active()).toEqual([
      {
        id: "runtime-newer-than-tested",
        tone: "warning",
        title: { text: "Grok is newer than tested" },
        message: {
          text: "Running 1.2.0; Sedes is tested through 1.0.4.",
        },
      },
    ]);
    expect(listener).toHaveBeenCalledTimes(1);

    const failingListener = vi.fn(() => {
      throw new Error("subscriber_failed");
    });
    source.subscribe(failingListener);

    source
      .beginObservation()
      .admitted(admitGrokRuntimeVersion("1.2.0", "abcdef2").assessment);
    expect(listener).toHaveBeenCalledTimes(1);

    source
      .beginObservation()
      .admitted(admitGrokRuntimeVersion("1.0.4", "d846eb93d9").assessment);
    expect(source.active()).toEqual([]);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(failingListener).toHaveBeenCalledTimes(1);

    unsubscribe();
    source
      .beginObservation()
      .admitted(admitGrokRuntimeVersion("1.2.0", "abcdef3").assessment);
    source.close();
    expect(failingListener).toHaveBeenCalledTimes(3);
    expect(source.active()).toEqual([]);
  });

  it("clears a newer-runtime advisory on a later failed admission", () => {
    const source = new GrokRuntimeAdvisorySource();
    source
      .beginObservation()
      .admitted(admitGrokRuntimeVersion("1.2.0", "abcdef1").assessment);
    expect(source.active()).toHaveLength(1);

    source.beginObservation().failed();

    expect(source.active()).toEqual([]);
  });

  it("ignores a stale failure after a newer successful observation", () => {
    const source = new GrokRuntimeAdvisorySource();
    source
      .beginObservation()
      .admitted(admitGrokRuntimeVersion("1.2.0", "abcdef0").assessment);
    const stale = source.beginObservation();
    const current = source.beginObservation();

    stale.failed();
    expect(source.active()).toMatchObject([
      {
        message: {
          text: "Running 1.2.0; Sedes is tested through 1.0.4.",
        },
      },
    ]);

    current.admitted(admitGrokRuntimeVersion("1.3.0", "abcdef1").assessment);

    expect(source.active()).toMatchObject([
      {
        message: {
          text: "Running 1.3.0; Sedes is tested through 1.0.4.",
        },
      },
    ]);
  });
});
