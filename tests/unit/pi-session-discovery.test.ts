import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiSessionStore } from "../../src/server/backends/pi/pi-session-store.js";
import { readPiBranchMarker } from "../../src/server/backends/pi/pi-branch-marker.js";
import { piForkContextBoundaryType } from "../../src/server/backends/pi/pi-fork-context-boundary.js";
import { USER_FORK_CONTEXT_BOUNDARY } from "../../src/server/backends/fork-context-boundary.js";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";

const roots: string[] = [];
const installationKey = new Uint8Array(32).fill(0x42);

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-pi-discovery-"));
  roots.push(root);
  const project = path.join(root, "project");
  const sessions = path.join(root, "sessions");
  await Promise.all([mkdir(project), mkdir(sessions)]);
  const canonicalPath = await realpath(project);
  const workspace: ValidatedWorkspace = {
    canonicalPath,
    authorityRevision: 0,
    summary: {
      id: "workspace",
      environmentId: "environment",
      displayName: "project",
      displayPath: canonicalPath,
      availability: "available",
      trustState: "trusted",
      revision: 0,
    },
  };
  const store = new PiSessionStore({ sessionDirectory: sessions });
  const source = await store.reserve(workspace, "source-session", "Source");
  const turn = appendTurn(source.manager, "Source turn");
  const branch = (id: string) =>
    store.branch(
      workspace,
      "source-session",
      source.opaqueBindingDetail,
      turn.leafId,
      installationKey,
      id,
      `create-${id}`,
      id,
    );
  return { sessions, workspace, store, source, turn, branch };
}

function appendTurn(manager: SessionManager, text: string) {
  const userId = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  });
  const leafId = manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: `${text} complete` }],
    api: "test",
    provider: "test",
    model: "model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  return { userId, leafId };
}

describe("Pi session discovery", () => {
  it("rejects an excessive conversation count before opening any transcripts", async () => {
    const f = await fixture();
    await f.branch("child-session");
    const list = vi.spyOn(SessionManager, "list");
    const open = vi.spyOn(SessionManager, "open");
    const rejection = new Error("discovery count exceeded");
    const assertConversationCount = vi.fn(() => {
      throw rejection;
    });

    await expect(
      f.store.listWithAncestry(f.workspace, installationKey, {
        assertConversationCount,
      }),
    ).rejects.toBe(rejection);

    expect(list).toHaveBeenCalledOnce();
    expect(assertConversationCount).toHaveBeenCalledExactlyOnceWith(2);
    expect(open).not.toHaveBeenCalled();
  });

  it("stops ancestry work when cancellation arrives during a session load", async () => {
    const f = await fixture();
    await f.branch("child-session");
    const controller = new AbortController();
    const cancellation = new Error("cancel ancestry discovery");
    const nativeOpen = SessionManager.open;
    const open = vi.spyOn(SessionManager, "open").mockImplementation((...args) => {
      const manager = nativeOpen(...args);
      setImmediate(() => controller.abort(cancellation));
      return manager;
    });

    await expect(
      f.store.listWithAncestry(f.workspace, installationKey, {
        signal: controller.signal,
      }),
    ).rejects.toBe(cancellation);

    expect(open).toHaveBeenCalledOnce();
  });

  it("lists once and loads a shared parent only once more for many sibling forks", async () => {
    const f = await fixture();
    const childIds = Array.from({ length: 12 }, (_, index) => `child-${index}`);
    for (const id of childIds) await f.branch(id);
    const list = vi.spyOn(SessionManager, "list");
    const open = vi.spyOn(SessionManager, "open");

    const sessions = await f.store.listWithAncestry(f.workspace, installationKey);

    expect(list).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledTimes(childIds.length + 2);
    expect(open.mock.calls.map(([file]) => file).sort()).toEqual(
      [
        ...sessions.map(({ sessionFile }) => sessionFile),
        f.source.manager.getSessionFile()!,
      ].sort(),
    );
    expect(sessions).toHaveLength(childIds.length + 1);
    for (const id of childIds) {
      expect(
        sessions.find(({ backendConversationId }) => backendConversationId === id)
          ?.nativeAncestry,
      ).toEqual({
        parentBackendConversationId: "source-session",
        sourceLeafEntryId: f.turn.leafId,
        sourceBackendTurnId: f.turn.userId,
        applicationOperationId: `create-${id}`,
      });
    }
  });

  it("rejects ambiguous parent IDs before granting exact fork evidence", async () => {
    const f = await fixture();
    await f.branch("child-session");
    await copyFile(
      f.source.manager.getSessionFile()!,
      path.join(f.sessions, "duplicate-source.jsonl"),
    );

    await expect(
      f.store.listWithAncestry(f.workspace, installationKey),
    ).rejects.toMatchObject({ backendCode: "pi_session_id_ambiguous" });
  });

  it("does not advertise an exact source turn from an abandoned parent branch", async () => {
    const f = await fixture();
    await f.branch("child-session");
    f.source.manager.resetLeaf();
    appendTurn(f.source.manager, "Replacement branch");

    const sessions = await f.store.listWithAncestry(f.workspace, installationKey);
    const child = sessions.find(
      ({ backendConversationId }) => backendConversationId === "child-session",
    );

    expect(child?.nativeAncestry).toEqual({
      parentBackendConversationId: "source-session",
      sourceLeafEntryId: f.turn.leafId,
      applicationOperationId: "create-child-session",
    });
    expect(child?.nativeAncestry).not.toHaveProperty("sourceBackendTurnId");
  });

  it("preserves native parent ancestry without authenticated application evidence", async () => {
    const f = await fixture();
    const child = SessionManager.create(f.workspace.canonicalPath, f.sessions, {
      id: "native-child",
      parentSession: f.source.manager.getSessionFile(),
    });
    appendTurn(child, "Native child");

    const sessions = await f.store.listWithAncestry(f.workspace, installationKey);

    expect(
      sessions.find(
        ({ backendConversationId }) => backendConversationId === "native-child",
      )?.nativeAncestry,
    ).toEqual({ parentBackendConversationId: "source-session" });
  });

  it("keeps only parent ancestry for a tampered marker even when the parent ID is ambiguous", async () => {
    const f = await fixture();
    const child = await f.branch("child-session");
    let tampered = 0;
    const entries = child.manager.getEntries().map((entry) => {
      const result = readPiBranchMarker(entry, installationKey);
      if (result.status !== "authenticated") return entry;
      tampered += 1;
      return {
        ...entry,
        data: { ...result.marker, applicationOperationId: "forged-operation" },
      };
    });
    expect(tampered).toBe(1);
    await writeFile(
      child.manager.getSessionFile()!,
      `${[child.manager.getHeader(), ...entries]
        .map((entry) => JSON.stringify(entry)).join("\n")}\n`,
    );
    await copyFile(
      f.source.manager.getSessionFile()!,
      path.join(f.sessions, "duplicate-source.jsonl"),
    );

    const sessions = await f.store.listWithAncestry(f.workspace, installationKey);

    expect(
      sessions.find(
        ({ backendConversationId }) => backendConversationId === "child-session",
      )?.nativeAncestry,
    ).toEqual({ parentBackendConversationId: "source-session" });
  });

  it.each(["exact", "tampered", "displaced", "duplicate"] as const)(
    "validates %s historical fork context boundary evidence",
    async (variant) => {
      const f = await fixture();
      // Omitting a title leaves the historical boundary immediately after the marker.
      const child = await f.store.branch(
        f.workspace,
        "source-session",
        f.source.opaqueBindingDetail,
        f.turn.leafId,
        installationKey,
        "historical-child",
        "historical-create",
      );
      if (variant === "displaced") {
        child.manager.appendCustomEntry("unrelated-metadata", {});
      }
      const appendBoundary = () =>
        child.manager.appendCustomMessageEntry(
          piForkContextBoundaryType,
          variant === "tampered"
            ? "forged boundary"
            : USER_FORK_CONTEXT_BOUNDARY.content,
          false,
          { version: 1, applicationOperationId: "historical-create" },
        );
      appendBoundary();
      if (variant === "duplicate") appendBoundary();

      const sessions = await f.store.listWithAncestry(f.workspace, installationKey);
      const ancestry = sessions.find(
        ({ backendConversationId }) => backendConversationId === "historical-child",
      )?.nativeAncestry;

      expect(ancestry).toEqual(
        variant === "exact"
          ? {
              parentBackendConversationId: "source-session",
              sourceLeafEntryId: f.turn.leafId,
              sourceBackendTurnId: f.turn.userId,
              applicationOperationId: "historical-create",
            }
          : { parentBackendConversationId: "source-session" },
      );
    },
  );

  it("observes metadata changes, new sessions, and removed parents on the next scan", async () => {
    const f = await fixture();
    const child = await f.branch("child-session");
    const initial = await f.store.listWithAncestry(f.workspace, installationKey);
    const initialChild = initial.find(
      ({ backendConversationId }) => backendConversationId === "child-session",
    );
    expect(
      initialChild?.nativeAncestry?.sourceBackendTurnId,
    ).toBe(f.turn.userId);

    child.manager.appendSessionInfo("Renamed child");
    await f.store.reserve(f.workspace, "new-session", "New session");
    await rm(f.source.manager.getSessionFile()!);
    const refreshed = await f.store.listWithAncestry(f.workspace, installationKey);

    expect(
      refreshed.map(({ backendConversationId }) => backendConversationId).sort(),
    ).toEqual(["child-session", "new-session"]);
    const refreshedChild = refreshed.find(
      ({ backendConversationId }) => backendConversationId === "child-session",
    );
    expect(refreshedChild).toMatchObject({ title: "Renamed child" });
    expect(refreshedChild).not.toHaveProperty("nativeAncestry");
    expect(initialChild?.nativeAncestry?.sourceBackendTurnId).toBe(f.turn.userId);
  });
});
