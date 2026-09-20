import path from "node:path";
import { parseArgs } from "node:util";
import { loadBackendConfigurationFile } from "../../src/server/config/backend-configuration.js";
import { convertLegacyConfiguration } from "../../src/server/config/legacy-configuration-import.js";
import { resolveStateDirectory } from "../../src/server/config/config.js";
import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import { prepareBackendNormalizedDatabase } from "../../src/server/db/backend-normalized-startup.js";
import { acquireStateDirectoryLock } from "../../src/server/security/locks.js";

const { values } = parseArgs({ options: {
  file: { type: "string" }, "state-directory": { type: "string" },
  "workspace-roots": { type: "string", multiple: true },
  "quiescent-cutover-confirmed": { type: "boolean", default: false },
  "validate-only": { type: "boolean", default: false },
}, strict: true, allowPositionals: false });
if (!values.file || !path.isAbsolute(values.file) || !values["workspace-roots"]?.length) {
  throw new Error("Usage: npm run configuration:import -- --file /absolute/legacy-server.json --workspace-roots /absolute/root [--workspace-roots /another/root] [--state-directory /absolute/state] [--validate-only]");
}
const stateDirectory = values["state-directory"] ?? resolveStateDirectory();
const legacyImport = {
  configuration: compiledBackendModuleCatalog.resolveConfiguration(await loadBackendConfigurationFile(values.file)),
  localWorkspaceRoots: values["workspace-roots"], sourceLabel: values.file,
};
const converted = convertLegacyConfiguration(legacyImport);
if (values["validate-only"]) {
  console.log(`Valid configuration: ${converted.document.executionEnvironments.length} environments, ${converted.document.backends.length} backends, ${converted.document.targets.length} targets. No state changed.`);
} else {
  const lock = await acquireStateDirectoryLock(stateDirectory);
  try {
    const result = await prepareBackendNormalizedDatabase({ stateDirectory, locksHeld: true, legacyImport,
      quiescentCutoverConfirmed: values["quiescent-cutover-confirmed"],
    });
    result.database.close();
    console.log(`Configuration imported into ${path.join(stateDirectory, "overlay.sqlite")}. Repeating the same import preserves subsequent database edits.`);
    if (result.backupPath) console.log(`Pre-migration backup: ${result.backupPath}`);
  } finally { await lock.release(); }
}
