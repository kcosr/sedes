import { configurationFingerprint } from "../../config/configuration-fingerprint.js";
import type { DatabaseMigration } from "../migrate.js";

/** Retire the auxiliary Grok selection without adopting its credentials or home. */
export const codexWebSearchMigration: DatabaseMigration = {
  version: 158,
  name: "codex_web_search",
  preflight(database) {
    database.function("sedes_configuration_fingerprint_158", { deterministic: true },
      (json: string) => configurationFingerprint(JSON.parse(json)));
  },
  sql: `
UPDATE principal_execution_configuration
SET configuration_json = json_set(configuration_json, '$.webSearch', NULL)
WHERE json_extract(configuration_json, '$.webSearch.provider') = 'grok_cli';

-- Save receipts retain their historical revision and unrelated settings. Their
-- request digest must describe the migrated request that can now be replayed.
UPDATE execution_configuration_receipts
SET request_json = json_set(request_json, '$.configuration.webSearch', NULL),
    request_fingerprint = sedes_configuration_fingerprint_158(
      json_set(request_json, '$.configuration.webSearch', NULL))
WHERE operation = 'save'
  AND json_extract(request_json, '$.configuration.webSearch.provider') = 'grok_cli';

UPDATE execution_configuration_receipts
SET result_json = json_set(result_json, '$.configuration.webSearch', NULL)
WHERE operation = 'save'
  AND json_extract(result_json, '$.configuration.webSearch.provider') = 'grok_cli';

-- Pairing requests contain no search configuration; preserve their digests and
-- update only the nested historical configuration snapshot in each result.
UPDATE host_pairing_receipts
SET result_json = json_set(result_json, '$.configuration.configuration.webSearch', NULL)
WHERE operation IN ('accept', 'revoke', 'reapprove')
  AND json_extract(result_json, '$.configuration.configuration.webSearch.provider') = 'grok_cli';
`,
};
