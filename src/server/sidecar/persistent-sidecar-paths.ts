import { createHash } from "node:crypto";
import path from "node:path";
import { sidecarServiceScopeSchema, type SidecarServiceScope } from "../../internal/sidecar-protocol/service-management-v1.js";

export function sidecarServiceKey(scope: SidecarServiceScope): string {
  const value = sidecarServiceScopeSchema.parse(scope);
  return createHash("sha256").update(JSON.stringify([value.installationId, value.tenantId, value.principalId, value.executionEnvironmentId])).digest("hex");
}

export function persistentSidecarPaths(accountHome: string, uid: number, scope: SidecarServiceScope, platform: NodeJS.Platform = process.platform) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (!paths.isAbsolute(accountHome) || paths.normalize(accountHome) !== accountHome || accountHome === paths.parse(accountHome).root ||
    !Number.isSafeInteger(uid) || uid < 0) throw new Error("sidecar_service_namespace_invalid");
  const key = sidecarServiceKey(scope);
  const stateRoot = paths.join(accountHome, ".local", "state", "sedes", "sidecar");
  const servicesRoot = paths.join(stateRoot, "services");
  const serviceDirectory = paths.join(servicesRoot, key);
  // Unix socket paths have a short kernel limit independent of HOME length.
  // This private, owned directory is validated before every use.
  const socketDirectory = platform === "win32" ? paths.join(stateRoot, "ipc") : `/tmp/sedes-${uid}-${key.slice(0, 24)}`;
  return { key, stateRoot, servicesRoot, serviceDirectory, socketDirectory,
    endpointPath: platform === "win32" ? `\\\\.\\pipe\\sedes-${key}` : paths.join(socketDirectory, "service.sock"),
    descriptorPath: paths.join(serviceDirectory, "service.json"),
    lockDirectory: paths.join(serviceDirectory, "startup.lock") } as const;
}
