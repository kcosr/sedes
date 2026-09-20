import { compiledBackendModuleCatalog } from "../../src/server/backends/compiled-module-catalog.js";
import {
  parseBackendConfiguration,
  type BackendConfigurationFile,
} from "../../src/server/config/backend-configuration.js";

export function resolveBackendConfiguration(
  configuration: BackendConfigurationFile,
) {
  return compiledBackendModuleCatalog.resolveConfiguration(configuration);
}

/** Parses the strict operator shape, then adds code-owned backend releases. */
export function parseResolvedBackendConfiguration(value: unknown) {
  return resolveBackendConfiguration(parseBackendConfiguration(value));
}
