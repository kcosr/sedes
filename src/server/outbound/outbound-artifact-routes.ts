import type { RequestHandler } from "express";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUTBOUND_ARTIFACT_PATH } from "../../internal/outbound-protocol.js";
import {
  readVerifiedSidecarArtifactPayload,
  type SidecarArtifactRegistration,
} from "../sidecar/sidecar-artifact.js";
import { outboundArtifactManifest } from "../sidecar/local-sidecar-artifact-installer.js";

/** Mount after normal Host/identity guards. GET downloads remain HTTP-native;
 * no login or pairing token is conflated with artifact integrity. */
export function registerOutboundArtifactRoutes(
  routes: { get(path: string, handler: RequestHandler): unknown },
  artifactProvider: () => Promise<SidecarArtifactRegistration>,
  options: { connectorDirectory?: string } = {},
): void {
  const connectorDirectory = options.connectorDirectory ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/connector");
  routes.get("/api/outbound/connector/sedes-sidecar.mjs", async (_request, response) => {
    const filename = path.join(connectorDirectory, "sedes-sidecar.mjs");
    try {
      const metadata = await lstat(filename);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32 * 1024 * 1024 || (await realpath(filename)) !== filename) throw new Error("outbound_connector_invalid");
      const bytes = await readFile(filename);
      response.setHeader("Content-Type", "application/javascript; charset=utf-8");
      response.setHeader("Content-Disposition", 'attachment; filename="sedes-sidecar.mjs"');
      response.setHeader("Cache-Control", "no-store");
      response.send(bytes);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      response.status(404).json({ error: { code: "outbound_connector_not_built", message: "The connector download is unavailable. Run npm run build on the Sedes server to build it.", retryable: false } });
    }
  });
  routes.get(`${OUTBOUND_ARTIFACT_PATH}/:digest/manifest`, async (request, response) => {
    const artifact = await artifactProvider();
    if (request.params.digest !== artifact.artifactSha256) { response.status(404).end(); return; }
    // Verify before describing availability, including all declared native bytes.
    await readVerifiedSidecarArtifactPayload(artifact);
    response.setHeader("Cache-Control", "no-store");
    response.json(outboundArtifactManifest(artifact));
  });
  routes.get(`${OUTBOUND_ARTIFACT_PATH}/:digest/payload`, async (request, response) => {
    const artifact = await artifactProvider();
    if (request.params.digest !== artifact.artifactSha256) { response.status(404).end(); return; }
    const payload = await readVerifiedSidecarArtifactPayload(artifact);
    response.setHeader("Content-Type", "application/octet-stream");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", payload.byteLength);
    response.send(Buffer.from(payload));
  });
}
