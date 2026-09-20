/** Settings categories are route state; their controls retain their existing ownership scopes. */
export type SettingsPage =
  | "paired_clients"
  | "notifications"
  | "general"
  | "diagnostics"
  | "appearance"
  | "prompts"
  | "mobile"
  | "terminal"
  | "tool_clients"
  | "connection"
  | "environments"
  | "backends"
  | "projects"
  | "server";

export const settingsPageSlugs = {
  paired_clients: "paired-clients",
  notifications: "notifications",
  general: "general",
  diagnostics: "diagnostics",
  appearance: "appearance",
  prompts: "prompts",
  mobile: "mobile",
  terminal: "terminal",
  tool_clients: "tool-clients",
  connection: "connection",
  environments: "environments",
  backends: "backends",
  projects: "projects",
  server: "server",
} as const satisfies Readonly<Record<SettingsPage, string>>;
