import type { ConfigurationDocument } from "../../shared/protocol/configuration-admin.js";
import type { BackendModuleCatalog } from "../backends/module-catalog.js";
import { validateConfigurationDocument } from "../configuration-admin/configuration-validation.js";

/** Runtime view of the database document. No file parser or topology translation. */
export function resolveDatabaseBackendConfiguration(document: ConfigurationDocument, catalog: BackendModuleCatalog) {
  const validated = validateConfigurationDocument(document);
  return {
    ...validated,
    backends: validated.backends.map(backend => ({
      ...backend,
      protocolRelease: catalog.protocolReleaseForBackendKind(backend.kind),
    })),
  };
}
