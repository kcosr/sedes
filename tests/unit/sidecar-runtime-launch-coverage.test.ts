import { describe, expect, it, vi } from "vitest";
import { controlHelloOperation } from "../../src/internal/sidecar-protocol/control-v2.js";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { recordUncoveredRuntimeOperation } from "../../src/server/sidecar/sidecar-runtime-launch-coverage.js";
import { antigravityRuntimeOperations } from "../../src/server/backends/antigravity/sidecar/wire.js";

describe("sidecar runtime launch coverage", () => {
  it("covers audited Antigravity operations while fencing new operations and versions", async () => {
    const recorder = { markUnsupported: vi.fn(async () => {}) };
    for (const operation of antigravityRuntimeOperations) {
      expect(recordUncoveredRuntimeOperation(recorder, operation)).toBeUndefined();
      await recordUncoveredRuntimeOperation(recorder, { ...operation, majorVersion: operation.majorVersion + 1 });
    }
    await recordUncoveredRuntimeOperation(recorder, {
      capabilityId: "antigravity_runtime", majorVersion: 4, operation: "runtime.future",
    });
    expect(recorder.markUnsupported.mock.calls).toEqual([
      ...antigravityRuntimeOperations.map(operation => [`antigravity_runtime:5:${operation.operation}`]),
      ["antigravity_runtime:4:runtime.future"],
    ]);
  });

  it("keeps a connected idle service unused and fences direct Git, search and future launches", async () => {
    const recorder = { markUnsupported: vi.fn(async () => {}) };
    for (const key of [
      controlHelloOperation, { capabilityId: "codex_runtime", majorVersion: 1, operation: "runtime.lookup" },
      { capabilityId: "workspace_files", majorVersion: 8, operation: "files.read" },
    ]) expect(recordUncoveredRuntimeOperation(recorder, key)).toBeUndefined();
    for (const key of [
      { capabilityId: "workspace_files", majorVersion: 8, operation: "files.watch_open" },
      { capabilityId: "workspace_files", majorVersion: 8, operation: "diff.create" },
      { capabilityId: "workspace_tools", majorVersion: 2, operation: "search.grep" },
      { capabilityId: "workspace_tools", majorVersion: 2, operation: "new.command" },
      { ...controlHelloOperation, majorVersion: 3 },
    ]) await recordUncoveredRuntimeOperation(recorder, key);
    expect(recorder.markUnsupported.mock.calls).toEqual([
      ["workspace_files:8:files.watch_open"], ["workspace_files:8:diff.create"], ["workspace_tools:2:search.grep"],
      ["workspace_tools:2:new.command"], ["control:3:hello"],
    ]);
  });

  it("prevents dispatch when coverage cannot be written or the controller changes during publication", async () => {
    let controller = 1;
    let write: () => Promise<void> = async () => { throw new Error("intent_write_failed"); };
    const registry = new SidecarOperationRegistry({
      beforeDispatch: () => { if (controller !== 1) throw new Error("stale_controller"); },
      prepareDispatch: key => recordUncoveredRuntimeOperation({ markUnsupported: () => write() }, key),
    });
    const future = { ...controlHelloOperation, operation: "new.command" };
    const handler = vi.fn(() => { throw new Error("unexpected_launch"); });
    registry.register(future, handler);
    const call = () => registry.resolve(future)!.handler({}, { requestId: "r", signal: new AbortController().signal });
    await expect(call()).rejects.toThrow("intent_write_failed");
    write = async () => { controller++; };
    await expect(call()).rejects.toThrow("stale_controller");
    expect(handler).not.toHaveBeenCalled();
  });
});
