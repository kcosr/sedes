import { createHash } from "node:crypto";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { registerOutboundArtifactRoutes } from "../../src/server/outbound/outbound-artifact-routes.js";
import { SIDECAR_ARTIFACT_ID, SIDECAR_ARTIFACT_MODES, SIDECAR_MINIMUM_NODE_VERSION, type SidecarArtifactRegistration } from "../../src/server/sidecar/sidecar-artifact.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-outbound-artifacts-"));
  temporary.push(directory);
  const bytes = Buffer.from("#!/usr/bin/env node\nconsole.log('reviewed runtime');\n");
  const executablePath = path.join(directory, "sedes");
  await writeFile(executablePath, bytes, { mode: 0o500 });
  const artifact: SidecarArtifactRegistration = { artifactId: SIDECAR_ARTIFACT_ID, modes: SIDECAR_ARTIFACT_MODES, executableDirectory: directory, executablePath, artifactSha256: createHash("sha256").update(bytes).digest("hex"), artifactBytes: bytes.length, buildId: "test", minimumNodeVersion: SIDECAR_MINIMUM_NODE_VERSION, nativeAssets: [] };
  const app = express();
  registerOutboundArtifactRoutes(app, async () => artifact, { connectorDirectory: directory });
  app.use((_error: Error, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(500).json({ error: "artifact_unavailable" }));
  return { directory, bytes, artifact, app };
}

describe("server-owned outbound artifact distribution", () => {
  it("serves only the selected verified manifest and exact payload", async () => {
    const f = await fixture();
    const base = `/api/outbound/artifacts/${f.artifact.artifactSha256}`;
    const manifest = await request(f.app).get(`${base}/manifest`).expect(200);
    expect(manifest.body).toMatchObject({ schemaVersion: 6, sha256: f.artifact.artifactSha256, bytes: f.bytes.length, nativeAssets: [] });
    expect(manifest.body).not.toHaveProperty("executablePath");
    const payload = await request(f.app).get(`${base}/payload`).expect(200);
    expect(payload.body.equals(f.bytes)).toBe(true);
    await request(f.app).get(`/api/outbound/artifacts/${"a".repeat(64)}/payload`).expect(404);
    await request(f.app).get("/api/outbound/artifacts/../../package.json").expect(404);
  });

  it("refuses runtime bytes that changed after server registration", async () => {
    const f = await fixture();
    await chmod(f.artifact.executablePath, 0o700);
    await writeFile(f.artifact.executablePath, Buffer.alloc(f.bytes.length, "x"));
    await chmod(f.artifact.executablePath, 0o500);
    await request(f.app).get(`/api/outbound/artifacts/${f.artifact.artifactSha256}/payload`).expect(500);
  });

  it("provides an actionable missing-connector response and downloads its fixed bundle", async () => {
    const f = await fixture();
    const endpoint = "/api/outbound/connector/sedes-sidecar.mjs";
    const missing = await request(f.app).get(endpoint).expect(404);
    expect(missing.body.error.code).toBe("outbound_connector_not_built");
    const content = "console.log('connector');\n";
    await writeFile(path.join(f.directory, "sedes-sidecar.mjs"), content);
    const downloaded = await request(f.app).get(endpoint).expect(200);
    expect(downloaded.text).toBe(content);
    expect(downloaded.headers["content-disposition"]).toBe('attachment; filename="sedes-sidecar.mjs"');
    expect(downloaded.headers["cache-control"]).toBe("no-store");
  });
});
