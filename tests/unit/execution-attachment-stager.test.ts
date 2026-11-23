import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompositeExecutionAttachmentStager } from "../../src/server/composer-attachments/composite-execution-attachment-stager.js";
import {
  ExecutionAttachmentStagingUnavailableError,
  type ExecutionAttachmentStager,
  UnsupportedExecutionAttachmentStager,
} from "../../src/server/composer-attachments/execution-attachment-stager.js";
import { ExecutionAttachmentStagingEngine } from "../../src/server/composer-attachments/execution-attachment-staging-engine.js";
import { LocalExecutionAttachmentStager } from "../../src/server/composer-attachments/local-execution-attachment-stager.js";
import { SidecarExecutionAttachmentStager } from "../../src/server/composer-attachments/sidecar-execution-attachment-stager.js";
import type { ExecutionEnvironmentLease } from "../../src/server/execution/contracts.js";

const roots: string[] = [];
const scope = { tenantId: "tenant", principalId: "principal" };
const environmentId = randomUUID();

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const stateDirectory = await mkdtemp(
    path.join(tmpdir(), "sedes-local-attachment-stager-"),
  );
  roots.push(stateDirectory);
  await chmod(stateDirectory, 0o700);
  const stager = new LocalExecutionAttachmentStager({
    scope,
    environmentId,
    stateDirectory,
    installationKey: randomBytes(32),
  });
  const lease: ExecutionEnvironmentLease = {
    scope,
    environment: {
      id: environmentId,
      label: "Local",
      availability: "available",
      diagnosticCode: null,
      revision: 0,
    },
    workspace: {
      canonicalPath: "/workspace",
      authorityRevision: 2,
      summary: {
        id: randomUUID(),
        environmentId,
        displayName: "workspace",
        displayPath: "/workspace",
        availability: "available",
        trustState: "trusted",
        revision: 0,
      },
    },
    release: vi.fn(async () => undefined),
  };
  return { stager, lease };
}

describe("ExecutionAttachmentStager", () => {
  it("materializes exact local bytes using an actor-owned lease", async () => {
    const { stager, lease } = await fixture();
    const bytes = Buffer.from([0, 255, 4, 5]);
    const attachmentId = randomUUID();
    const threadId = randomUUID();
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const materialized = await stager.materialize(scope, {
      lease,
      applicationThreadId: threadId,
      attachmentId,
      sha256,
      sizeBytes: bytes.byteLength,
      safeExtension: ".bin",
      content: async function* () {
        yield bytes.subarray(0, 2);
        yield bytes.subarray(2);
      },
    });
    await expect(readFile(materialized.agentPath)).resolves.toEqual(bytes);
    expect(materialized.agentPath).toContain(`/threads/${threadId}/`);
    await stager.release(scope, {
      lease,
      applicationThreadId: threadId,
      attachmentId,
      expectedSha256: sha256,
    });
    await expect(readFile(materialized.agentPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await stager.close();
  });

  it("returns the committed file when its workspace grant is withdrawn after publication", async () => {
    const { stager, lease } = await fixture();
    let authorized = true;
    const original = ExecutionAttachmentStagingEngine.prototype.commit;
    const commit = vi.spyOn(ExecutionAttachmentStagingEngine.prototype, "commit").mockImplementationOnce(async function (this: ExecutionAttachmentStagingEngine, handle) {
      const result = await original.call(this, handle);
      authorized = false;
      return result;
    });
    try {
      const bytes = Buffer.from("committed");
      const result = await stager.materialize(scope, {
        lease: {...lease, assertCurrent() { if (!authorized) throw new Error("grant withdrawn"); }},
        applicationThreadId: randomUUID(), attachmentId: randomUUID(),
        sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
        safeExtension: "", content: async function* () { yield bytes; },
      });
      expect(await readFile(result.agentPath)).toEqual(bytes);
    } finally {
      commit.mockRestore();
      await stager.close();
    }
  });

  it("keeps a host commit or replay acknowledged while its reply was travelling", async () => {
    const {stager: local, lease} = await fixture();
    const sha256 = createHash("sha256").digest("hex");
    const result = {agentPath: "/stage/a", sha256, sizeBytes: 0};
    const uploadHandle = randomUUID();
    let authorized = true;
    let committed = false;
    const call = vi.fn(async (definition: {operation: string}) => {
      if (definition.operation === "materialization.open" && !committed) return {state: "upload", uploadHandle, nextOffset: 0};
      if (definition.operation === "materialization.commit") {
        committed = true;
        authorized = false;
        return result;
      }
      if (definition.operation === "materialization.open" && committed) {
        authorized = false;
        return {state: "ready", ...result};
      }
      throw new Error(`Unexpected ${definition.operation}`);
    });
    const runtime = {acquireOperation: async () => ({session: {call}, release() {}})} as unknown as
      ConstructorParameters<typeof SidecarExecutionAttachmentStager>[0]["runtime"];
    const remote = new SidecarExecutionAttachmentStager({scope, environmentId, installationKey: randomBytes(32), runtime});
    try {
      const request = {
        lease: {...lease, assertCurrent() { if (!authorized) throw new Error("grant withdrawn"); }},
        applicationThreadId: randomUUID(), attachmentId: randomUUID(),
        sha256, sizeBytes: 0, safeExtension: "", content: async function* () {},
      };
      await expect(remote.materialize(scope, request)).resolves.toEqual(result);
      authorized = true;
      await expect(remote.materialize(scope, request)).resolves.toEqual(result);
      expect(call.mock.calls.map(([op]) => op.operation)).toEqual(["materialization.open", "materialization.commit", "materialization.open"]);
    } finally {
      await local.close();
      await remote.close();
    }
  });

  it("denies wrong scope and never falls back through the composite", async () => {
    const { stager, lease } = await fixture();
    const composite = new CompositeExecutionAttachmentStager({
      scope,
      providers: new Map<string, ExecutionAttachmentStager>([
        [environmentId, stager],
        [randomUUID(), new UnsupportedExecutionAttachmentStager()],
      ]),
    });
    const wrongScope = { tenantId: "tenant", principalId: "other" };
    expect(composite.supports(wrongScope, environmentId)).toBe(false);
    await expect(
      composite.materialize(wrongScope, {
        lease,
        applicationThreadId: randomUUID(),
        attachmentId: randomUUID(),
        sha256: createHash("sha256").digest("hex"),
        sizeBytes: 0,
        safeExtension: "",
        content: async function* () {},
      }),
    ).rejects.toBeInstanceOf(ExecutionAttachmentStagingUnavailableError);
    await composite.close();
  });
});
