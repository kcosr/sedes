import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TerminalResource, TerminalServerFrame } from "../../src/shared/protocol/terminals.js";
import type { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { TerminalJournalStore } from "../../src/server/terminals/terminal-journal.js";
import type { TerminalRepository } from "../../src/server/terminals/terminal-repository.js";
import { TerminalService } from "../../src/server/terminals/terminal-service.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("sealed terminal attachment", () => {
  it.each(["exited", "failed", "interrupted"] as const)(
    "replays a sequenced %s status before caught_up",
    async (lifecycle) => {
      const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-sealed-terminal-"));
      directories.push(directory);
      const scope = { tenantId: "tenant", principalId: "principal" };
      const terminal = resource(lifecycle);
      const journal = new TerminalJournalStore({ stateDirectory: directory });
      journal.append(scope, terminal.terminalId, {
        seq: 1,
        kind: "output",
        bytes: Buffer.from("done"),
      });
      journal.append(scope, terminal.terminalId, {
        seq: 2,
        kind: "final_status",
        lifecycle,
        exitCode: lifecycle === "exited" ? 0 : null,
        exitSignal: null,
        publicReason:
          lifecycle === "failed"
            ? "start_failed"
            : lifecycle === "interrupted"
              ? "ssh_connection_lost"
              : null,
      });
      const service = new TerminalService({
        inventory: {} as InventoryRepository,
        repository: {
          get(_scope: unknown, terminalId: string) {
            return terminalId === terminal.terminalId ? terminal : undefined;
          },
        } as unknown as TerminalRepository,
        journal,
        providers: new Map(),
        onTerminalSummaryChanged: () => undefined,
      });
      const frames: TerminalServerFrame[] = [];
      await service.attach({
        scope,
        terminalId: terminal.terminalId,
        incarnationId: terminal.incarnationId!,
        attachmentId: "66666666-6666-4666-8666-666666666666",
        producerId: "77777777-7777-4777-8777-777777777777",
        requestedRole: "observer",
        restore: { kind: "checkpoint" },
        emit: (frame) => frames.push(frame),
      });
      const statusIndex = frames.findIndex((frame) => frame.type === "terminal_status");
      const caughtIndex = frames.findIndex((frame) => frame.type === "caught_up");
      expect(statusIndex).toBeGreaterThan(-1);
      expect(statusIndex).toBeLessThan(caughtIndex);
      expect(frames[statusIndex]).toMatchObject({
        type: "terminal_status",
        seq: 2,
        lifecycle,
      });
      expect(frames[caughtIndex]).toMatchObject({ type: "caught_up", headSeq: 2 });
    },
  );

  it("synthesizes the sealed lifecycle when retained history has no final status", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-sealed-terminal-"));
    directories.push(directory);
    const scope = { tenantId: "tenant", principalId: "principal" };
    const terminal = { ...resource("interrupted"), headSeq: 1 };
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    journal.append(scope, terminal.terminalId, {
      seq: 1,
      kind: "output",
      bytes: Buffer.from("received before restart"),
    });
    const service = serviceFor(terminal, journal);
    const frames: TerminalServerFrame[] = [];

    await service.attach({
      scope,
      terminalId: terminal.terminalId,
      incarnationId: terminal.incarnationId!,
      attachmentId: "66666666-6666-4666-8666-666666666666",
      producerId: "77777777-7777-4777-8777-777777777777",
      requestedRole: "observer",
      restore: { kind: "checkpoint" },
      emit: (frame) => frames.push(frame),
    });

    expect(frames.find((frame) => frame.type === "terminal_status")).toBeUndefined();
    expect(frames.find((frame) => frame.type === "lifecycle_state")).toMatchObject({
      type: "lifecycle_state",
      lifecycle: "interrupted",
      headSeq: 1,
      publicReason: "ssh_connection_lost",
    });
    expect(frames.at(-1)).toMatchObject({ type: "caught_up", headSeq: 1 });
  });

  it("rejects sealed resources that never acquired a process incarnation", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-sealed-terminal-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const terminal = { ...resource("failed"), incarnationId: null, headSeq: 0 };
    const service = serviceFor(terminal, journal);

    await expect(
      service.attach({
        scope: { tenantId: "tenant", principalId: "principal" },
        terminalId: terminal.terminalId,
        incarnationId: "55555555-5555-4555-8555-555555555555",
        attachmentId: "66666666-6666-4666-8666-666666666666",
        producerId: "77777777-7777-4777-8777-777777777777",
        requestedRole: "observer",
        restore: { kind: "checkpoint" },
        emit: () => undefined,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "invalid_transition",
        message: "No terminal process history is available.",
      }),
    );
  });

  it("rejects an admission for a prior incarnation before reading history", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "sedes-sealed-terminal-"));
    directories.push(directory);
    const journal = new TerminalJournalStore({ stateDirectory: directory });
    const terminal = resource("exited");
    const service = serviceFor(terminal, journal);

    await expect(
      service.attach({
        scope: { tenantId: "tenant", principalId: "principal" },
        terminalId: terminal.terminalId,
        incarnationId: "88888888-8888-4888-8888-888888888888",
        attachmentId: "66666666-6666-4666-8666-666666666666",
        producerId: "77777777-7777-4777-8777-777777777777",
        requestedRole: "observer",
        restore: { kind: "checkpoint" },
        emit: () => undefined,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "invalid_transition",
        message: "The terminal process changed.",
      }),
    );
  });
});

function serviceFor(
  terminal: TerminalResource,
  journal: TerminalJournalStore,
): TerminalService {
  return new TerminalService({
    inventory: {} as InventoryRepository,
    repository: {
      get(_scope: unknown, terminalId: string) {
        return terminalId === terminal.terminalId ? terminal : undefined;
      },
    } as unknown as TerminalRepository,
    journal,
    providers: new Map(),
    onTerminalSummaryChanged: () => undefined,
  });
}

function resource(
  lifecycle: "exited" | "failed" | "interrupted",
): TerminalResource {
  return {
    terminalId: "11111111-1111-4111-8111-111111111111",
    threadId: "22222222-2222-4222-8222-222222222222",
    workspaceId: "33333333-3333-4333-8333-333333333333",
    environmentId: "44444444-4444-4444-8444-444444444444",
    environmentLabel: "Remote",
    terminationEffect: "disconnect_transport",
    incarnationId: "55555555-5555-4555-8555-555555555555",
    displayName: "Shell",
    shellProfile: null,
    initialCwd: "/work",
    lifecycle,
    lifecycleRevision: 4,
    rows: 24,
    columns: 80,
    initialRows: 24,
    initialColumns: 80,
    historyFloorSeq: 0,
    headSeq: 2,
    exitCode: lifecycle === "exited" ? 0 : null,
    exitSignal: null,
    publicReason:
      lifecycle === "failed"
        ? "start_failed"
        : lifecycle === "interrupted"
          ? "ssh_connection_lost"
          : null,
    createdAt: "2026-08-27T00:00:00.000Z",
    startedAt: "2026-08-27T00:00:00.001Z",
    exitedAt: "2026-08-27T00:01:00.000Z",
    updatedAt: "2026-08-27T00:01:00.000Z",
  };
}
