import { describe, expect, it } from "vitest";
import type { DiscoveredConversation } from "../../src/server/backends/contracts.js";
import {
  PiDiscoverySnapshotStore,
  type PiDiscoverySnapshotBinding,
} from "../../src/server/backends/pi/pi-discovery-snapshot-store.js";
import { serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";

const binding: PiDiscoverySnapshotBinding = Object.freeze({
  tenantId: "tenant",
  principalId: "principal",
  backendInstanceId: "pi-instance",
  executionEnvironmentId: "environment",
  canonicalWorkspacePath: "/workspace",
  nativeNamespaceKey: "pi-native-store",
});

function conversations(count: number): readonly DiscoveredConversation[] {
  return Array.from({ length: count }, (_, index) => ({
    backendConversationId: `conversation-${index}`,
    canonicalWorkspacePath: binding.canonicalWorkspacePath,
    title: `Conversation ${index}`,
    updatedAt: new Date(10_000 - index).toISOString(),
    opaqueBindingDetail: `binding-${index}`,
  }));
}

function ids(): () => string {
  let next = 0;
  return () => String.fromCharCode(65 + next++).repeat(32);
}

function expectBackendCode(action: () => unknown, backendCode: string): void {
  expect(action).toThrowError(
    expect.objectContaining({ name: "BackendError", backendCode }),
  );
}

describe("Pi discovery snapshot store", () => {
  it.each([0, 1, 100])(
    "returns a terminal first page for %i projected conversations",
    (count) => {
      const store = new PiDiscoverySnapshotStore({ createScanId: ids() });
      expect(
        store.createFirstPage({
          binding,
          conversations: conversations(count),
          pageSize: 100,
        }),
      ).toMatchObject({ conversations: conversations(count) });
    },
  );

  it("serves a stable multi-page snapshot with sequential single-use cursors", () => {
    const store = new PiDiscoverySnapshotStore({ createScanId: ids() });
    const projected = conversations(250);
    const first = store.createFirstPage({
      binding,
      conversations: projected,
      pageSize: 100,
    });
    expect(first.conversations).toEqual(projected.slice(0, 100));
    expect(first.nextCursor).toMatch(/^pi-discovery:v1:A{32}:100$/);

    const firstCursor = first.nextCursor!;
    expectBackendCode(
      () =>
        store.continuePage({
          binding,
          cursor: firstCursor.replace(/:100$/, ":200"),
          pageSize: 100,
        }),
      "pi_discovery_cursor_invalid",
    );
    const second = store.continuePage({
      binding,
      cursor: firstCursor,
      pageSize: 100,
    });
    expect(second.conversations).toEqual(projected.slice(100, 200));
    expectBackendCode(
      () =>
        store.continuePage({
          binding,
          cursor: firstCursor,
          pageSize: 100,
        }),
      "pi_discovery_cursor_invalid",
    );

    const terminal = store.continuePage({
      binding,
      cursor: second.nextCursor!,
      pageSize: 100,
    });
    expect(terminal).toEqual({ conversations: projected.slice(200) });
    expectBackendCode(
      () =>
        store.continuePage({
          binding,
          cursor: second.nextCursor!,
          pageSize: 100,
        }),
      "pi_discovery_cursor_invalid",
    );
  });

  it.each([
    ["tenantId", "other-tenant"],
    ["principalId", "other-principal"],
    ["backendInstanceId", "other-instance"],
    ["executionEnvironmentId", "other-environment"],
    ["canonicalWorkspacePath", "/other-workspace"],
    ["nativeNamespaceKey", "other-native-store"],
  ] as const)("rejects a cursor with a different %s binding", (key, value) => {
    const store = new PiDiscoverySnapshotStore({ createScanId: ids() });
    const first = store.createFirstPage({
      binding,
      conversations: conversations(101),
      pageSize: 100,
    });
    expectBackendCode(
      () =>
        store.continuePage({
          binding: { ...binding, [key]: value },
          cursor: first.nextCursor!,
          pageSize: 100,
        }),
      "pi_discovery_cursor_invalid",
    );
    expect(
      store.continuePage({
        binding,
        cursor: first.nextCursor!,
        pageSize: 100,
      }).conversations,
    ).toHaveLength(1);
  });

  it.each([
    "",
    "pi-offset:100",
    "pi-discovery:v1:short:100",
    `pi-discovery:v1:${"A".repeat(32)}:0`,
    `pi-discovery:v1:${"A".repeat(32)}:100000`,
    `pi-discovery:v1:${"A".repeat(32)}:${Number.MAX_SAFE_INTEGER + 1}`,
    "x".repeat(81),
  ])("rejects invalid or stale cursor %j", (cursor) => {
    const store = new PiDiscoverySnapshotStore({ createScanId: ids() });
    expectBackendCode(
      () => store.continuePage({ binding, cursor, pageSize: 100 }),
      "pi_discovery_cursor_invalid",
    );
  });

  it("expires abandoned snapshots lazily and frees their capacity", () => {
    let now = 10;
    const store = new PiDiscoverySnapshotStore({
      createScanId: ids(),
      nowMilliseconds: () => now,
      expiryMilliseconds: 50,
      maximumConcurrentSnapshots: 1,
    });
    const abandoned = store.createFirstPage({
      binding,
      conversations: conversations(101),
      pageSize: 100,
    });
    now = 60;
    const replacement = store.createFirstPage({
      binding,
      conversations: conversations(102),
      pageSize: 100,
    });
    expect(replacement.nextCursor).toMatch(/^pi-discovery:v1:B{32}:100$/);
    expectBackendCode(
      () =>
        store.continuePage({
          binding,
          cursor: abandoned.nextCursor!,
          pageSize: 100,
        }),
      "pi_discovery_cursor_invalid",
    );
  });

  it("enforces capacity until a terminal page removes its snapshot", () => {
    const store = new PiDiscoverySnapshotStore({
      createScanId: ids(),
      maximumConcurrentSnapshots: 1,
    });
    const first = store.createFirstPage({
      binding,
      conversations: conversations(101),
      pageSize: 100,
    });
    expectBackendCode(
      () =>
        store.createFirstPage({
          binding,
          conversations: conversations(101),
          pageSize: 100,
        }),
      "pi_discovery_snapshot_capacity_exceeded",
    );
    store.continuePage({
      binding,
      cursor: first.nextCursor!,
      pageSize: 100,
    });
    expect(
      store.createFirstPage({
        binding,
        conversations: conversations(101),
        pageSize: 100,
      }).nextCursor,
    ).toBeDefined();
  });

  it("rejects projected conversation and byte bounds deterministically", () => {
    const countBounded = new PiDiscoverySnapshotStore({
      maximumConversations: 1,
    });
    expectBackendCode(
      () => countBounded.assertConversationCount(2),
      "pi_discovery_snapshot_conversation_limit_exceeded",
    );

    const projected = conversations(1);
    const byteBounded = new PiDiscoverySnapshotStore({
      maximumProjectedBytes: serializedUtf8Bytes(projected) - 1,
    });
    expectBackendCode(
      () =>
        byteBounded.createFirstPage({
          binding,
          conversations: projected,
          pageSize: 100,
        }),
      "pi_discovery_snapshot_byte_limit_exceeded",
    );
  });

  it("clears every snapshot on idempotent runtime disposal", () => {
    const store = new PiDiscoverySnapshotStore({ createScanId: ids() });
    const first = store.createFirstPage({
      binding,
      conversations: conversations(101),
      pageSize: 100,
    });
    store.close();
    store.close();
    expectBackendCode(
      () =>
        store.continuePage({
          binding,
          cursor: first.nextCursor!,
          pageSize: 100,
        }),
      "pi_discovery_snapshot_store_closed",
    );
  });
});
