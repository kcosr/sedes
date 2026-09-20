import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { prepareBackendNormalizedDatabase } from "../../src/server/db/backend-normalized-startup.js";
import { ConfigurationRepository } from "../../src/server/configuration-admin/configuration-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { parseBackendConfiguration, parseBootstrapConfiguration } from "../../src/server/config/backend-configuration.js";
import { convertLegacyConfiguration } from "../../src/server/config/legacy-configuration-import.js";
import { loadBootstrapConfigurationFile } from "../../src/server/config/bootstrap-configuration.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function state() { const root = await mkdtemp(path.join(os.tmpdir(), "sedes-config-bootstrap-")); roots.push(root); return root; }
function legacy() {
  return compiledBackendModuleCatalog.resolveConfiguration(parseBackendConfiguration({ schemaVersion: 10,
    executionEnvironments: [{ id: "019196f7-a0a8-7bc4-a89b-8cf013978405", kind: "local", label: "Local" }],
    backends: [{ id: "pi-custom", kind: "pi", label: "My Pi", enabled: true, modelPolicy: { type: "catalog" } }],
    targets: [{ id: "custom-target", kind: "pi_sdk", label: "My target", backendInstanceId: "pi-custom", executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405", enabled: true }],
    defaultTargetId: "custom-target",
  }));
}
describe("database configuration bootstrap", () => {
  it("reports bootstrap filename and issue paths without echoing rejected values", async () => {
    const filename = path.join(await state(), "server.json");
    await writeFile(filename, JSON.stringify({ schemaVersion: 12, listen: { port: "private-value" }, packagedClients: ["private-client"] }));
    await expect(loadBootstrapConfigurationFile(filename)).rejects.toThrow(filename);
    await expect(loadBootstrapConfigurationFile(filename)).rejects.toThrow("listen.port");
    await expect(loadBootstrapConfigurationFile(filename)).rejects.toThrow("packagedClients.0");
    try { await loadBootstrapConfigurationFile(filename); } catch (error) {
      expect(String(error)).not.toContain("private-value");
      expect(String(error)).not.toContain("private-client");
    }
  });
  it("rejects obsolete file authority with explicit import guidance", () => {
    expect(() => parseBootstrapConfiguration(legacy())).toThrow("configuration:import");
    expect(parseBootstrapConfiguration({ schemaVersion: 11 })).toEqual({ schemaVersion: 11, packagedClients: [] });
    expect(() => parseBootstrapConfiguration({ schemaVersion: 11, workspaceRoots: ["/tmp"] })).toThrow();
  });
  it("starts empty, imports explicitly, and never overwrites database edits on restart or repeated import", async () => {
    const stateDirectory = await state();
    const startup = { stateDirectory, locksHeld: true as const, quiescentCutoverConfirmed: false };
    let opened = await prepareBackendNormalizedDatabase(startup);
    let scope = new SingleUserIdentityProvider(opened.database).getScope();
    expect(new ConfigurationRepository(opened.database).get(scope).configuration.targets).toEqual([]);
    expect(opened.database.prepare("SELECT count(*) count FROM agent_backend_instances").get()).toEqual({ count: 0 });
    expect(opened.database.prepare("SELECT count(*) count FROM execution_environments").get()).toEqual({ count: 0 });
    opened.database.close();
    const legacyImport = { configuration: legacy(), localWorkspaceRoots: [stateDirectory], sourceLabel: "test legacy" };
    opened = await prepareBackendNormalizedDatabase({ ...startup, legacyImport });
    scope = new SingleUserIdentityProvider(opened.database).getScope();
    let repo = new ConfigurationRepository(opened.database);
    const imported = repo.get(scope);
    expect(imported.configuration.backends[0]?.id).toBe("pi-custom");
    expect(imported.configuration.defaultTargetId).toBe("custom-target");
    const changed = structuredClone(imported.configuration);
    changed.backends[0]!.label = "Edited in Settings";
    repo.save(scope, { mutationId: randomUUID(), expectedRevision: imported.revision, configuration: changed });
    opened.database.close();
    opened = await prepareBackendNormalizedDatabase(startup);
    repo = new ConfigurationRepository(opened.database);
    expect(repo.get(scope).configuration.backends[0]?.label).toBe("Edited in Settings");
    opened.database.close();
    opened = await prepareBackendNormalizedDatabase({ ...startup, legacyImport });
    expect(new ConfigurationRepository(opened.database).get(scope).configuration.backends[0]?.label).toBe("Edited in Settings");
    opened.database.close();
    await expect(prepareBackendNormalizedDatabase({ ...startup, legacyImport: { ...legacyImport, localWorkspaceRoots: ["/different"] } })).rejects.toThrow("different source");
  });
  it("never derives workspace authority from the importing process environment", () => {
    expect(() => convertLegacyConfiguration({ configuration: legacy(), sourceLabel: "test", localWorkspaceRoots: [] })).toThrow();
    const converted = convertLegacyConfiguration({ configuration: legacy(), sourceLabel: "test", localWorkspaceRoots: ["/explicit"] });
    expect(converted.document.executionEnvironments[0]?.workspaceRoots).toEqual(["/explicit"]);
  });
});
