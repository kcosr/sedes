import type { DatabaseMigration } from "../migrate.js";

export const configurationCommandReceiptsMigration: DatabaseMigration = {
  version: 169,
  name: "configuration_command_receipts",
  sql: `
ALTER TABLE execution_configuration_receipts ADD COLUMN command_metadata_json TEXT
  CHECK (command_metadata_json IS NULL OR (operation = 'save' AND json_valid(command_metadata_json)
    AND length(CAST(command_metadata_json AS BLOB)) <= 4096));
ALTER TABLE execution_configuration_receipts ADD COLUMN command_result_json TEXT
  CHECK ((command_metadata_json IS NULL AND command_result_json IS NULL) OR
    (command_metadata_json IS NOT NULL AND command_result_json IS NOT NULL
      AND json_valid(command_result_json) AND length(CAST(command_result_json AS BLOB)) <= 65536));
`,
};
