import { configurationSidecarCapabilities } from "../../../shared/protocol/configuration-admin.js";
import { Toggle } from "./fields.js";

const capabilityLabels = {
  directory_browser: "Directory browsing", workspace_files: "Files and comparisons",
  workspace_tools: "Workspace tools and context", workspace_context: "Workspace context",
  workspace_skills: "Workspace skills", composer_attachments: "Attachment staging",
  agent_tools_cli: "Sedes tools for remote agents", interactive_terminal: "Interactive terminals",
} as const;


export function SidecarCapabilitiesField({ value, onChange }: {
  readonly value: Array<typeof configurationSidecarCapabilities[number]>;
  readonly onChange: (value: Array<typeof configurationSidecarCapabilities[number]>) => void;
}): React.JSX.Element {
  return <fieldset><legend>Allowed sidecar operations</legend>
    {configurationSidecarCapabilities.filter((capability) => capability !== "workspace_context").map((capability) => <Toggle key={capability}
      label={capabilityLabels[capability]} checked={value.includes(capability)} onChange={(enabled) => {
        const capabilities = new Set(value);
        if (enabled) capabilities.add(capability); else capabilities.delete(capability);
        if (capability === "workspace_tools") { if (enabled) capabilities.add("workspace_context"); else capabilities.delete("workspace_context"); }
        onChange(configurationSidecarCapabilities.filter((entry) => capabilities.has(entry)));
      }} />)}
  </fieldset>;
}
