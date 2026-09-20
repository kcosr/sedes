import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ConfigurationOperationRecoveryService } from "../../src/server/configuration-admin/configuration-operation-recovery-service.js";
import { registerConfigurationOperationRecoveryRoutes } from "../../src/server/configuration-admin/configuration-operation-recovery-routes.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { ConfigurationOperationRecoveryDetails, ConfigurationOperationRecoveryKind } from "../../src/shared/protocol/configuration-operation-recovery.js";

function fixture() {
  const scope = { tenantId: randomUUID(), principalId: randomUUID() };
  const environmentId = randomUUID();
  const reference = { kind: "file" as const, receiptId: randomUUID() };
  let now = 1000;
  let incarnation = "service-one";
  let kinds: ConfigurationOperationRecoveryKind[] = ["file"];
  let operation: ConfigurationOperationRecoveryDetails = { ...reference, state: "succeeded", summary: "Completed.", acknowledgeable: true, details: "saved", stdout: "", stderr: "", omittedBytes: 0 };
  const acknowledge = vi.fn(async () => ({ acknowledged: true }));
  const inspect = vi.fn(async () => structuredClone(operation));
  const list = vi.fn(async () => ({ receipts: [{ kind: reference.kind, receiptId: reference.receiptId, state: operation.state, summary: operation.summary, acknowledgeable: operation.acknowledgeable }] }));
  const release = vi.fn();
  const authorize = vi.fn();
  const acquire = vi.fn(async () => ({ client: { inspect, list, acknowledge }, serviceIncarnation: incarnation, release }));
  const grantedKinds = vi.fn(() => kinds);
  const service = new ConfigurationOperationRecoveryService({ authorize, acquire, kinds: grantedKinds, now: () => now });
  return { scope, environmentId, reference, service, acquire, release, authorize, inspect, list, acknowledge, grantedKinds,
    advance: (milliseconds: number) => { now += milliseconds; }, restart: () => { incarnation = "service-two"; },
    setKinds: (value: ConfigurationOperationRecoveryKind[]) => { kinds = value; },
    change: (patch: Partial<ConfigurationOperationRecoveryDetails>) => { operation = { ...operation, ...patch }; },
  };
}

describe("configuration operation recovery", () => {
  it("never acknowledges during list or inspect and re-inspects before explicit disposition", async () => {
    const f = fixture();
    await f.service.list(f.scope, f.environmentId);
    const inspection = await f.service.inspect(f.scope, f.environmentId, f.reference);
    expect(inspection.confirmationToken).toBeTypeOf("string");
    expect(f.acknowledge).not.toHaveBeenCalled();
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: inspection.confirmationToken! })).resolves.toEqual({ acknowledged: true });
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.acknowledge).toHaveBeenCalledExactlyOnceWith(f.reference);
    expect(f.release).toHaveBeenCalledTimes(3);
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: inspection.confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    expect(f.acknowledge).toHaveBeenCalledTimes(1);
  });

  it("authorizes every operation before capability lookup or acquisition", async () => {
    const f = fixture();
    f.authorize.mockImplementation(() => { throw new DomainError("not_found", "Not authorized."); });
    await expect(f.service.list(f.scope, f.environmentId)).rejects.toMatchObject({ code: "not_found" });
    await expect(f.service.inspect(f.scope, f.environmentId, f.reference)).rejects.toMatchObject({ code: "not_found" });
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
    expect(f.authorize).toHaveBeenCalledTimes(3);
    expect(f.grantedKinds).not.toHaveBeenCalled();
    expect(f.acquire).not.toHaveBeenCalled();
  });

  it("denies wrong tenant, principal, environment, reference and kind without consuming another scope's token", async () => {
    const f = fixture();
    const { confirmationToken } = await f.service.inspect(f.scope, f.environmentId, f.reference);
    for (const [scope, environmentId, reference] of [
      [{ ...f.scope, tenantId: randomUUID() }, f.environmentId, f.reference],
      [{ ...f.scope, principalId: randomUUID() }, f.environmentId, f.reference],
      [f.scope, randomUUID(), f.reference],
      [f.scope, f.environmentId, { ...f.reference, receiptId: randomUUID() }],
    ] as const) {
      await expect(f.service.acknowledge(scope, environmentId, reference, { confirmationToken: confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    }
    f.setKinds(["file", "shell"]);
    await expect(f.service.acknowledge(f.scope, f.environmentId, { ...f.reference, kind: "shell" }, { confirmationToken: confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    expect(f.acquire).toHaveBeenCalledTimes(1);
    await f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: confirmationToken! });
    expect(f.acknowledge).toHaveBeenCalledTimes(1);
  });

  it.each(["details", "stdout", "stderr", "summary"] as const)("rejects changed inspected %s and consumes the stale token", async field => {
    const f = fixture();
    const { confirmationToken } = await f.service.inspect(f.scope, f.environmentId, f.reference);
    f.change({ [field]: "changed outcome" });
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    expect(f.acquire).toHaveBeenCalledTimes(2);
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("rejects expired tokens, changed service incarnation and revoked grants", async () => {
    for (const invalidate of [(f: ReturnType<typeof fixture>) => f.advance(120_000), (f: ReturnType<typeof fixture>) => f.restart(), (f: ReturnType<typeof fixture>) => f.setKinds([])]) {
      const f = fixture();
      const { confirmationToken } = await f.service.inspect(f.scope, f.environmentId, f.reference);
      invalidate(f);
      await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: confirmationToken! })).rejects.toBeInstanceOf(DomainError);
      expect(f.acknowledge).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledTimes(f.acquire.mock.calls.length);
    }
  });

  it("bounds confirmations to 256 and issues none for unacknowledgeable outcomes", async () => {
    const f = fixture();
    const first = await f.service.inspect(f.scope, f.environmentId, f.reference);
    for (let i = 0; i < 256; i++) await f.service.inspect(f.scope, f.environmentId, f.reference);
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: first.confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    f.change({ state: "pending", acknowledgeable: false });
    expect((await f.service.inspect(f.scope, f.environmentId, f.reference)).confirmationToken).toBeNull();
    expect(f.acknowledge).not.toHaveBeenCalled();
  });

  it("releases failed requests and does not retry uncertain acknowledgments", async () => {
    const f = fixture();
    const { confirmationToken } = await f.service.inspect(f.scope, f.environmentId, f.reference);
    f.acknowledge.mockRejectedValueOnce(new Error("transport lost"));
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: confirmationToken! })).rejects.toThrow("transport lost");
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    expect(f.acknowledge).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("lists only granted receipt kinds and never acquires without grants", async () => {
    const f = fixture();
    f.setKinds([]);
    await expect(f.service.list(f.scope, f.environmentId)).resolves.toEqual({ receipts: [] });
    await expect(f.service.inspect(f.scope, f.environmentId, f.reference)).rejects.toMatchObject({ code: "not_found" });
    expect(f.acquire).not.toHaveBeenCalled();
    f.setKinds(["file"]);
    await f.service.list(f.scope, f.environmentId);
    expect(f.list).toHaveBeenCalledExactlyOnceWith(["file"]);
  });

  it("rejects confirmation expiry during reinspection", async () => {
    const f = fixture();
    const inspected = await f.service.inspect(f.scope, f.environmentId, f.reference);
    f.inspect.mockImplementationOnce(async () => { f.advance(120_000); return inspected.operation; });
    await expect(f.service.acknowledge(f.scope, f.environmentId, f.reference, { confirmationToken: inspected.confirmationToken! })).rejects.toMatchObject({ code: "conflict" });
    expect(f.acknowledge).not.toHaveBeenCalled();
    expect(f.release).toHaveBeenCalledTimes(2);
  });

  it("registers strict authenticated HTTP routes with no caching or implicit ACK", async () => {
    const f = fixture();
    const app = express();
    app.use(express.json());
    registerConfigurationOperationRecoveryRoutes(app, async () => f.scope, f.service);
    app.use((error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => { response.status(400).json({ error: error.message }); });
    const base = `/api/configuration/environments/${f.environmentId}/operations`;
    await request(app).get(base).expect(200).expect("Cache-Control", "no-store");
    const inspected = await request(app).get(`${base}/file/${f.reference.receiptId}`).expect(200);
    expect(f.acknowledge).not.toHaveBeenCalled();
    await request(app).post(`${base}/file/${f.reference.receiptId}/acknowledge`).send({ confirmationToken: inspected.body.confirmationToken, principalId: randomUUID() }).expect(400);
    expect(f.acknowledge).not.toHaveBeenCalled();
    await request(app).post(`${base}/file/${f.reference.receiptId}/acknowledge`).send({ confirmationToken: inspected.body.confirmationToken }).expect(200).expect("Cache-Control", "no-store");
    expect(f.acknowledge).toHaveBeenCalledTimes(1);
  });
});
