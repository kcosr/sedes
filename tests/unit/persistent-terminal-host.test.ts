import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  terminalPrepareOperation, terminalCreateOperation, terminalAttachOperation,
  terminalReadOperation, terminalSnapshotChunkOperation, terminalInputOperation,
  terminalResizeOperation, terminalAcknowledgeOperation,
  terminalProducerOperation,
  terminalForgetOperation,
  TERMINAL_REMOTE_CHUNK_BYTES,
} from "../../src/internal/sidecar-protocol/interactive-terminal-v2.js";
import { terminalHostFixture } from "../helpers/persistent-terminal-fixture.js";

afterEach(() => vi.restoreAllMocks());

describe("PersistentTerminalHost", () => {
  it("force stop proves PTY cleanup and releases unacknowledged history without a viewer", async () => {
    const fixture = terminalHostFixture();
    const { process } = await fixture.create();
    process.output("unacknowledged final output");
    process.terminate.mockImplementation(async () => process.exit({ disposition: "exited", exitCode: null, signal: "SIGKILL", cleanupConfirmed: true }));
    const resource = [...fixture.resources.values()][0]!;
    await resource.stop("operator_stop", { force: true });
    expect(process.terminate).toHaveBeenCalledOnce();
    expect(fixture.resources.size).toBe(0);
    expect(fixture.host.snapshot()).toMatchObject({ state: "idle", blockers: [] });
  });
  it("keeps cleanup uncertainty blocking after final history has been acknowledged", async () => {
    const fixture = terminalHostFixture();
    const { identity, process } = await fixture.create();
    process.exit({ disposition: "exited", exitCode: 0, signal: null });
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: attached.controllerToken };
    await fixture.caller.call(terminalAcknowledgeOperation, { ...control, finalSeq: attached.snapshot.seq });
    expect(fixture.host.snapshot()).toMatchObject({ state: "unknown", blockers: ["cleanup_unproven"] });
    await expect(fixture.caller.call(terminalForgetOperation, identity)).rejects.toThrow("terminal_history_handoff_required");
    await expect([...fixture.resources.values()][0]!.stop("upgrade", { force: false })).rejects.toThrow("terminal_cleanup_unproven");
  });

  it("records an interrupted overflow disposition even when the PTY reports an ordinary exit", async () => {
    const fixture = terminalHostFixture();
    const { identity, process } = await fixture.create();
    process.terminate.mockImplementation(async () => process.exit({ disposition: "exited", exitCode: null, signal: "SIGKILL", cleanupConfirmed: true }));
    process.output(Buffer.alloc(2 * 1024 * 1024 + 1));
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    expect(attached.snapshot.exit).toMatchObject({ disposition: "interrupted", diagnosticCode: "provider_output_overflow", cleanupConfirmed: true });
  });

  it("retains producer input receipts across upstream controller replacement without storing input bytes", async () => {
    const fixture = terminalHostFixture();
    const { identity, process } = await fixture.create();
    const producerId = randomUUID();
    const first = await fixture.caller.call(terminalAttachOperation, identity);
    const input = { ...identity, controllerToken: first.controllerToken, controlSeq: 1,
      producer: { producerId, inputSeq: 1 }, data: Buffer.from("effect once").toString("base64url"),
    };
    await fixture.caller.call(terminalInputOperation, input);
    fixture.disconnect();
    const caller = fixture.connect();
    const attached = await caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: attached.controllerToken };
    expect(await caller.call(terminalProducerOperation, { ...control, producerId })).toEqual({ highWater: 1 });
    expect(await caller.call(terminalInputOperation, { ...input, ...control })).toEqual({ outcome: "sent" });
    expect(process.writes).toHaveLength(1);
    expect(await caller.call(terminalInputOperation, { ...input, ...control, controlSeq: 2, data: "Yg" })).toMatchObject({ outcome: "not_sent", diagnosticCode: "terminal_input_sequence_conflict" });
    expect(await caller.call(terminalInputOperation, { ...input, ...control, controlSeq: 3, producer: { producerId, inputSeq: 2 } })).toEqual({ outcome: "sent" });
    expect(process.writes).toHaveLength(2);
    process.exit();
  });

  it("keeps one PTY through detach, fences old controllers, and restores output before the ordered suffix", async () => {
    const fixture = terminalHostFixture();
    const { identity, ticket, process } = await fixture.create();
    await fixture.caller.call(terminalCreateOperation, ticket);
    expect(fixture.openTerminal).toHaveBeenCalledTimes(1);
    const first = await fixture.caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: first.controllerToken };
    const request = { ...control, controlSeq: 1, data: Buffer.from("secret input").toString("base64url") };
    await fixture.caller.call(terminalInputOperation, request);
    await fixture.caller.call(terminalInputOperation, request);
    expect(process.writes).toHaveLength(1);
    await expect(fixture.caller.call(terminalInputOperation, { ...request, data: Buffer.from("different").toString("base64url") })).rejects.toThrow("terminal_control_sequence_reused");
    process.output("before disconnect\r\n");
    fixture.disconnect();
    process.output("while disconnected\r\n");
    expect(process.terminate).not.toHaveBeenCalled();
    const reconnected = fixture.connect();
    await expect(reconnected.call(terminalInputOperation, { ...request, controlSeq: 2 })).rejects.toThrow("terminal_stale_controller");
    const attached = await reconnected.call(terminalAttachOperation, identity);
    const current = { ...identity, controllerToken: attached.controllerToken };
    const snapshot = await reconnected.call(terminalSnapshotChunkOperation, { ...current, snapshotId: attached.snapshot.snapshotId, offset: 0 });
    const restored = Buffer.from(snapshot.data, "base64url").toString();
    expect(restored).toContain("before disconnect");
    expect(restored).toContain("while disconnected");
    expect(restored).not.toContain("secret input");
    process.output("after snapshot");
    await reconnected.call(terminalResizeOperation, { ...current, controlSeq: 1, rows: 30, columns: 100 });
    process.output("after resize");
    const suffix = await reconnected.call(terminalReadOperation, { ...current, afterSeq: attached.snapshot.seq });
    expect(suffix.kind).toBe("records");
    if (suffix.kind !== "records") throw new Error("expected suffix");
    expect(suffix.records.map((record) => record.kind)).toEqual(["output", "resize", "output"]);
    expect(suffix.records.map((record) => record.seq)).toEqual([attached.snapshot.seq + 1, attached.snapshot.seq + 2, attached.snapshot.seq + 3]);
    expect(fixture.openTerminal).toHaveBeenCalledTimes(1);
    process.exit();
  });

  it("delivers resize redraws with scrollback erasure without resetting the active stream", async () => {
    const fixture = terminalHostFixture();
    const { identity, process } = await fixture.create();
    process.output("private history\r\n" + "safe line\r\n".repeat(50));
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: attached.controllerToken };
    const redraw = "\u001b[H\u001b[2J\u001b[3Jredrawn TUI";
    process.resize.mockImplementation(async () => { process.output(redraw); });
    await fixture.caller.call(terminalResizeOperation, { ...control, controlSeq: 1, rows: 12, columns: 80 });
    const page = await fixture.caller.call(terminalReadOperation, { ...control, afterSeq: attached.snapshot.seq });
    expect(page.kind).toBe("records");
    if (page.kind !== "records") throw new Error("resize forced a snapshot");
    expect(page.records.map(record => record.kind)).toEqual(["resize", "output"]);
    expect(page.records.map(record => record.seq)).toEqual([attached.snapshot.seq + 1, attached.snapshot.seq + 2]);
    expect(page.records[1]).toMatchObject({ data: Buffer.from(redraw).toString("base64url") });
    await expect(fixture.caller.call(terminalSnapshotChunkOperation, {
      ...control, snapshotId: attached.snapshot.snapshotId, offset: 0,
    })).rejects.toThrow("terminal_snapshot_expired");
    const replacement = await fixture.caller.call(terminalAttachOperation, identity);
    const nextControl = { ...identity, controllerToken: replacement.controllerToken };
    const oldCursor = await fixture.caller.call(terminalReadOperation, { ...nextControl, afterSeq: attached.snapshot.seq });
    expect(oldCursor.kind).toBe("snapshot");
    if (oldCursor.kind !== "snapshot") throw new Error("old history was exposed");
    const clean = await fixture.caller.call(terminalSnapshotChunkOperation, {
      ...nextControl, snapshotId: oldCursor.snapshot.snapshotId, offset: 0,
    });
    expect(Buffer.from(clean.data, "base64url").toString()).not.toContain("private history");
    expect(Buffer.from(clean.data, "base64url").toString()).toContain("redrawn TUI");
    process.exit();
  });

  it("keeps split erasures ordered, retires consumed bytes, and bounds unread redraws", async () => {
    const fixture = terminalHostFixture({ maximumSuffixBytes: 300 });
    const { identity, process } = await fixture.create();
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: attached.controllerToken };
    process.output("\u001b[");
    process.output("3Jscreen");
    const page = await fixture.caller.call(terminalReadOperation, { ...control, afterSeq: 0 });
    expect(page).toMatchObject({ kind: "records", headSeq: 2 });
    if (page.kind !== "records") throw new Error("split erase forced a snapshot");
    expect(page.records.map(record => record.kind === "output" ? Buffer.from(record.data, "base64url").toString() : "")).toEqual(["\u001b[", "3Jscreen"]);
    expect(await fixture.caller.call(terminalReadOperation, { ...control, afterSeq: 2 })).toMatchObject({ kind: "records", records: [] });
    expect(await fixture.caller.call(terminalReadOperation, { ...control, afterSeq: 0 })).toMatchObject({ kind: "snapshot" });
    for (let index = 0; index < 20; index++) process.output("\u001b[3Jredraw");
    expect(await fixture.caller.call(terminalReadOperation, { ...control, afterSeq: 2 })).toMatchObject({ kind: "snapshot", snapshot: { seq: 22 } });
    process.exit();
  });

  it("replaces a lost bounded suffix with a snapshot and revokes erased-scrollback snapshots", async () => {
    const fixture = terminalHostFixture({ maximumSuffixBytes: 100 });
    const { identity, process } = await fixture.create();
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: attached.controllerToken };
    process.output("private history\r\n" + "safe line\r\n".repeat(50));
    const page = await fixture.caller.call(terminalReadOperation, { ...control, afterSeq: 0 });
    expect(page.kind).toBe("snapshot");
    if (page.kind !== "snapshot") throw new Error("expected checkpoint");
    process.output("\u001b[3J");
    await expect(fixture.caller.call(terminalSnapshotChunkOperation, { ...control, snapshotId: page.snapshot.snapshotId, offset: 0 })).rejects.toThrow("terminal_snapshot_expired");
    const clean = await fixture.caller.call(terminalReadOperation, { ...control, afterSeq: 0 });
    if (clean.kind !== "snapshot") throw new Error("expected checkpoint");
    const bytes = await fixture.caller.call(terminalSnapshotChunkOperation, { ...control, snapshotId: clean.snapshot.snapshotId, offset: 0 });
    expect(Buffer.from(bytes.data, "base64url").toString()).not.toContain("private history");
    process.exit();
  });

  it("blocks upgrade on live and unacknowledged ended terminals, preserves handoff while admission is fenced, then erases remote history", async () => {
    const fixture = terminalHostFixture();
    const { identity, process } = await fixture.create();
    const resource = [...fixture.resources.values()][0]!;
    const liveRevision = resource.snapshot().revision;
    process.output("retained final output");
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    expect(resource.snapshot().revision).toBe(liveRevision);
    expect(resource.snapshot().blockers).toEqual(["live_terminal"]);
    fixture.drain();
    process.terminate.mockImplementation(async () => process.exit({ disposition: "exited", exitCode: null, signal: "SIGKILL", cleanupConfirmed: true }));
    await expect(resource.stop("upgrade", { force: false })).rejects.toThrow("sidecar_resource_handoff_pending");
    expect(process.terminate).toHaveBeenCalledTimes(1);
    expect(resource.snapshot().blockers).toEqual(["unsettled_outcome"]);
    expect(resource.snapshot().revision).not.toBe(liveRevision);
    const final = await fixture.caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: final.controllerToken };
    expect(final.snapshot.exit).toMatchObject({ disposition: "interrupted", diagnosticCode: "upgrade", cleanupConfirmed: true });
    const bytes = await fixture.caller.call(terminalSnapshotChunkOperation, { ...control, snapshotId: final.snapshot.snapshotId, offset: 0 });
    expect(Buffer.from(bytes.data, "base64url").toString()).toContain("retained final output");
    await expect(fixture.caller.call(terminalInputOperation, { ...control, controlSeq: 1, data: "YQ" })).rejects.toThrow("service_draining");
    await expect(fixture.caller.call(terminalAcknowledgeOperation, { ...control, finalSeq: final.snapshot.seq - 1 })).rejects.toThrow("terminal_final_handoff_mismatch");
    await fixture.caller.call(terminalAcknowledgeOperation, { ...control, finalSeq: final.snapshot.seq });
    expect(resource.snapshot()).toMatchObject({ state: "idle", blockers: [] });
    await resource.stop("upgrade", { force: false });
    await expect(fixture.caller.call(terminalAttachOperation, identity)).rejects.toThrow("terminal_history_transferred");
    await expect(fixture.caller.call(terminalSnapshotChunkOperation, { ...control, snapshotId: final.snapshot.snapshotId, offset: 0 })).rejects.toThrow("terminal_snapshot_expired");
    expect(attached.controllerToken).not.toBe(final.controllerToken);
    fixture.disconnect();
    await fixture.connect().call(terminalForgetOperation, identity);
    expect(fixture.resources.size).toBe(0);
  });

  it("rejects expired creation tickets and bounds live resources without evicting unacknowledged outcomes", async () => {
    const fixture = terminalHostFixture({ maximumTerminals: 1 });
    const identity = { terminalId: randomUUID(), incarnationId: randomUUID() };
    const request = { ...identity, initialCwd: "/workspace", rows: 24, columns: 80 };
    const ticket = await fixture.caller.call(terminalPrepareOperation, request);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    await expect(fixture.caller.call(terminalCreateOperation, ticket)).rejects.toThrow("terminal_creation_ticket_expired");
    expect(fixture.openTerminal).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    const replacement = await fixture.caller.call(terminalPrepareOperation, request);
    await fixture.caller.call(terminalCreateOperation, replacement);
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    fixture.processes[0]!.exit();
    const final = await fixture.caller.call(terminalReadOperation, { ...identity, controllerToken: attached.controllerToken, afterSeq: 0 });
    expect(final.kind).toBe("records");
    // A full retained result is not safe to evict merely to admit another shell.
    vi.spyOn(Date, "now").mockReturnValue(now + 60_001);
    const next = await fixture.caller.call(terminalPrepareOperation, { ...request, terminalId: randomUUID(), incarnationId: randomUUID() });
    await expect(fixture.caller.call(terminalCreateOperation, next)).rejects.toThrow("terminal_capacity");
    expect(fixture.openTerminal).toHaveBeenCalledTimes(1);
  });

  it("pages checkpoint bytes with bounded, validated offsets", async () => {
    const fixture = terminalHostFixture();
    const { identity, process } = await fixture.create();
    process.output("line with retained data\r\n".repeat(4_000));
    const attached = await fixture.caller.call(terminalAttachOperation, identity);
    const control = { ...identity, controllerToken: attached.controllerToken };
    expect(attached.snapshot.byteLength).toBeGreaterThan(TERMINAL_REMOTE_CHUNK_BYTES);
    const first = await fixture.caller.call(terminalSnapshotChunkOperation, { ...control, snapshotId: attached.snapshot.snapshotId, offset: 0 });
    expect(Buffer.from(first.data, "base64url")).toHaveLength(TERMINAL_REMOTE_CHUNK_BYTES);
    await expect(fixture.caller.call(terminalSnapshotChunkOperation, { ...control, snapshotId: attached.snapshot.snapshotId, offset: 1 })).rejects.toThrow("terminal_snapshot_offset_invalid");
    process.exit();
  });
});
