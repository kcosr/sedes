import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { SidecarOperationRegistry } from "../../src/internal/sidecar-protocol/operation-registry.js";
import { workspaceContextReadOperation } from "../../src/internal/sidecar-protocol/workspace-context-v1.js";
import { workspaceToolsWorkspaceOpenOperation } from "../../src/internal/sidecar-protocol/workspace-tools-v2.js";
import { ExecutionPolicyRoutes } from "../../src/server/sidecar/execution-policy-routes.js";
import { registerPersistentExecutionPolicy } from "../../src/server/sidecar/register-persistent-execution-policy.js";
import { PersistentSidecarServiceRegistry } from "../../src/server/sidecar/persistent-sidecar-service-registry.js";
import {
  ExecutionPolicyReadPages,
  policyReadOperation,
  executionPolicyBytes,
  executionPolicyDigest,
  type ExecutionPolicySnapshot,
  POLICY_BLOCK_BYTES,
  MAX_POLICY_BYTES,
} from "../../src/internal/sidecar-protocol/execution-policy.js";
const configuration = { environmentRevision: 4, operationsRevision: 9 };
const scope = {
  tenantId: "tenant",
  principalId: "principal",
  installationId: "install",
  executionEnvironmentId: "host",
};
const empty: ExecutionPolicySnapshot = {
  backends: [],
  capabilities: [],
  roots: [],
};
function fixture() {
  const service = new PersistentSidecarServiceRegistry({
    scope,
    configuration,
    artifactSha256: "a".repeat(64),
    buildId: "test",
    runtimeWireVersion: 18,
  });
  const epoch = service.attach(configuration),
    incarnation = service.serviceIncarnation;
  return {
    service,
    epoch,
    transfer: (
      snapshot: ExecutionPolicySnapshot,
      revision: number,
      controllerEpoch = epoch,
    ) => {
      const bytes = executionPolicyBytes(snapshot),
        digest = executionPolicyDigest(snapshot),
        transferId = randomUUID();
      const fields = {
        incarnation,
        controllerEpoch,
        digest,
        transferId,
        revision,
      };
      const block = (offset: number, end: number) => ({
        ...fields,
        offset,
        length: bytes.length,
        block: bytes.subarray(offset, end).toString("base64"),
      });
      return {
        bytes,
        fields,
        block,
        stage: () => {
          for (
            let offset = 0;
            offset < bytes.length;
            offset += POLICY_BLOCK_BYTES
          )
            service.stagePolicy(
              controllerEpoch,
              block(offset, offset + POLICY_BLOCK_BYTES),
            );
        },
      };
    },
  };
}
describe("live persistent execution policy", () => {
  it("rejects a manufactured second Antigravity instance without replacing installed grants", () => {
    const { service, epoch, transfer } = fixture();
    const original = transfer(empty, 1);
    original.stage();
    service.applyPolicy(epoch, {
      ...original.fields,
      base: null,
      configuration,
    });
    const backends = ["one", "two"].map((id) => ({
      id,
      generation: 1,
      kind: "antigravity",
      launchDigest: "a".repeat(64),
      targets: [],
    }));
    const snapshot = { roots: [], capabilities: [], backends };
    expect(() => executionPolicyBytes(snapshot)).toThrow(
      "duplicate_antigravity",
    );
    const bytes = Buffer.from(JSON.stringify(snapshot));
    const binding = {
      ...original.fields,
      transferId: randomUUID(),
      revision: 2,
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
    service.stagePolicy(epoch, {
      ...binding,
      length: bytes.length,
      offset: 0,
      block: bytes.toString("base64"),
    });
    expect(() =>
      service.applyPolicy(epoch, {
        ...binding,
        configuration,
        base: { revision: 1, digest: original.fields.digest },
      }),
    ).toThrow("sidecar_policy_snapshot_invalid");
    expect(service.executionPolicy(epoch)).toEqual(empty);
    const corrected = transfer(empty, 2);
    corrected.stage();
    service.applyPolicy(epoch, { ...corrected.fields, base: { revision: 1, digest: original.fields.digest }, configuration });
  });
  it("reports a positively empty provider registry separately from an unscanned launch", () => {
    const {service,epoch,transfer} = fixture();
    const installed = transfer({roots:[],capabilities:[],backends:[{id:"provider",kind:"pi_native",generation:1,
      launchDigest:"a".repeat(64),targets:[]}]}, 1);
    installed.stage();
    service.applyPolicy(epoch, {...installed.fields,configuration,base:null});
    const read = (scan?: () => string | null | undefined) => service.readPolicy(epoch, () => "ready", scan).readiness[0];
    expect(read()).not.toHaveProperty("observedLaunchDigest");
    expect(read(() => undefined)).not.toHaveProperty("observedLaunchDigest");
    expect(read(() => null)).toHaveProperty("observedLaunchDigest",null);
    expect(read(() => "a".repeat(64))).toHaveProperty("observedLaunchDigest","a".repeat(64));
  });
  it.each(["normal", "recovery"] as const)("observes installed Pi support before a %s controller acquires admission", async mode => {
    const { service, epoch, transfer } = fixture();
    const installed = transfer({ roots: [], capabilities: ["workspace_context", "workspace_tools"].map(id => ({ id, generation: 1 })),
      backends: [{ id: "pi", kind: "pi", launchDigest: "a".repeat(64), generation: 1, targets: [] }] }, 1);
    installed.stage();
    service.applyPolicy(epoch, { ...installed.fields, configuration, base: null });
    const next = service.attach(configuration, mode);
    expect(() => service.executionPolicy(next)).toThrow();
    const registry = new SidecarOperationRegistry();
    const unused = (): never => { throw new Error("inspection started work"); };
    registry.register(workspaceContextReadOperation, unused);
    registry.register(workspaceToolsWorkspaceOpenOperation, unused);
    const routes = new ExecutionPolicyRoutes({ readPolicy: unused, start: unused, executableDirectory: "/bin",
      inheritedPath: "/bin", endpointKey: "a".repeat(24), executableAvailable: async () => true });
    try {
      registerPersistentExecutionPolicy({ registry, controllerEpoch: next, serviceRegistry: service, policyRoutes: routes,
        peer: { supportsOperation: () => true, supportsIncomingOperation: () => true } });
      const report = await registry.resolve(policyReadOperation)!.handler({}, { requestId: randomUUID(), signal: new AbortController().signal });
      expect(report).toMatchObject({ readiness: expect.arrayContaining([{ id: "backend:pi", state: "ready", generation: 1 }]) });
    } finally {
      await routes.close();
    }
  });

  it("keeps paged evidence coherent, scoped, bounded and invalidated on a new install", () => {
    vi.useFakeTimers();
    try {
      const evidence = (generation: number) => ({
        incarnation: randomUUID(),
        controllerEpoch: 1,
        installed: null,
        configuration,
        readiness: Array.from({ length: 30 }, (_, i) => ({
          id: `backend:${i}`,
          state: "ready" as const,
          generation,
        })),
      });
      const pages = new ExecutionPolicyReadPages();
      const old = pages.begin(evidence(1));
      const newer = pages.begin(evidence(2));
      expect(
        pages.next(old.cursor!).readiness.every((r) => r.generation === 1),
      ).toBe(true);
      expect(
        pages.next(newer.cursor!).readiness.every((r) => r.generation === 2),
      ).toBe(true);
      const another = pages.begin(evidence(3));
      expect(() => pages.next(old.cursor!)).toThrow("cursor_stale");
      expect(() =>
        new ExecutionPolicyReadPages().next(another.cursor!),
      ).toThrow("cursor_stale");
      vi.advanceTimersByTime(60_001);
      expect(() => pages.next(another.cursor!)).toThrow("cursor_stale");
      const final = pages.begin(evidence(4));
      pages.reset();
      expect(() => pages.next(final.cursor!)).toThrow("cursor_stale");
    } finally {
      vi.useRealTimers();
    }
  });
  it("starts control-only, installs atomically, confirms an identical policy after a fresh attach and confines recovery", () => {
    const { service, epoch, transfer } = fixture();
    expect(() => service.assertAdmission(epoch)).toThrow("unsynchronized");
    const first = transfer(empty, 1);
    first.stage();
    expect(() => service.assertAdmission(epoch)).toThrow("unsynchronized");
    service.applyPolicy(epoch, { ...first.fields, base: null, configuration });
    expect(service.executionPolicy(epoch)).toEqual(empty);
    const next = service.attach(configuration);
    expect(() => service.executionPolicy(epoch)).toThrow("stale");
    expect(() => service.executionPolicy(next)).toThrow("unsynchronized");
    service.applyPolicy(next, {
      ...first.fields,
      controllerEpoch: next,
      transferId: randomUUID(),
      base: null,
      configuration,
    });
    const grant = {
      ...empty,
      capabilities: [{ id: "workspace_files", generation: 2 }],
    };
    const update = transfer(grant, 3, next);
    update.stage();
    expect(() =>
      service.applyPolicy(next, {
        ...update.fields,
        base: null,
        configuration,
      }),
    ).toThrow("conflict");
    expect(service.executionPolicy(next)).toEqual(empty);
    service.applyPolicy(next, {
      ...update.fields,
      base: { revision: 1, digest: first.fields.digest },
      configuration,
    });
    expect(service.executionPolicy(next)).toEqual(grant);
    const recovery = service.attach(
      { environmentRevision: 99, operationsRevision: 99 },
      "recovery",
    );
    expect(service.status().desiredConfiguration).toEqual(configuration);
    expect(() =>
      service.stagePolicy(recovery, {
        ...update.block(0, 2),
        controllerEpoch: recovery,
      }),
    ).toThrow("denied");
    expect(() =>
      service.applyPolicy(recovery, {
        ...update.fields,
        controllerEpoch: recovery,
        configuration,
        base: null,
      }),
    ).toThrow("denied");
  });
  it("rejects conflicting chunks, gaps, digest substitution, and idle expired staging", () => {
    vi.useFakeTimers();
    try {
      const { service, epoch, transfer } = fixture();
      const f = transfer(empty, 1),
        block = f.block(0, 8);
      expect(service.stagePolicy(epoch, block)).toEqual({ offset: 8 });
      expect(service.stagePolicy(epoch, block)).toEqual({ offset: 8 });
      expect(() =>
        service.stagePolicy(epoch, {
          ...block,
          block: Buffer.alloc(8).toString("base64"),
        }),
      ).toThrow("conflict");
      expect(() => service.stagePolicy(epoch, f.block(12, 18))).toThrow(
        "conflict",
      );
      expect(() => service.stagePolicy(epoch, f.block(0, 4))).toThrow(
        "conflict",
      );
      expect(() =>
        service.stagePolicy(epoch, {
          ...block,
          transferId: randomUUID(),
          digest: "a".repeat(64),
        }),
      ).toThrow("conflict");
      service.stagePolicy(epoch, f.block(8, 16));
      expect(service.stagePolicy(epoch, block)).toEqual({ offset: 16 });
      expect(() => service.stagePolicy(epoch, f.block(0, 16))).toThrow(
        "conflict",
      );
      vi.advanceTimersByTime(60_001);
      expect(() => service.stagePolicy(epoch, f.block(8, 10))).toThrow(
        "conflict",
      );
      const wrong = "0".repeat(64);
      service.stagePolicy(epoch, {
        ...f.block(0, f.bytes.length),
        digest: wrong,
      });
      expect(() =>
        service.applyPolicy(epoch, {
          ...f.fields,
          digest: wrong,
          base: null,
          configuration,
        }),
      ).toThrow("digest_mismatch");
      expect(() => service.assertAdmission(epoch)).toThrow("unsynchronized");
      f.stage();
      service.applyPolicy(epoch, { ...f.fields, base: null, configuration });
    } finally {
      vi.useRealTimers();
    }
  });
  it("transfers a maximal canonical document and keeps policy order independent", () => {
    const { service, epoch, transfer } = fixture();
    const roots = Array.from({ length: 16 }, (_, i) => ({
      id: String(i),
      generation: 1,
      path: "/" + i.toString(16) + "x".repeat(32_714),
    }));
    const baseline = executionPolicyBytes({ ...empty, roots }).length;
    let remaining = MAX_POLICY_BYTES - baseline;
    for (const root of roots) {
      const n = Math.min(32_768 - root.path.length, remaining);
      root.path += "y".repeat(n);
      remaining -= n;
    }
    const f = transfer({ ...empty, roots }, 1);
    expect(f.bytes.length).toBe(MAX_POLICY_BYTES);
    expect(
      executionPolicyDigest({ ...empty, roots: [...roots].reverse() }),
    ).toBe(f.fields.digest);
    f.stage();
    service.applyPolicy(epoch, { ...f.fields, base: null, configuration });
    expect(service.executionPolicy(epoch).roots).toHaveLength(16);
  });
});
