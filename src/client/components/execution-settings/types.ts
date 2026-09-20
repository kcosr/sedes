import type {
  ConfigurationDocument,
  ConfigurationSnapshot as AdminSnapshot,
} from "../../../shared/protocol/configuration-admin.js";

export type Configuration = ConfigurationDocument;
export type ConfigurationSnapshot = AdminSnapshot;
export type EnvironmentDefinition = Configuration["executionEnvironments"][number];
export type BackendDefinition = Configuration["backends"][number];
export type TargetDefinition = Configuration["targets"][number];
export type ModelPolicy = BackendDefinition["modelPolicy"];
