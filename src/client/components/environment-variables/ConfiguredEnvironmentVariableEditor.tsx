import { useState } from "react";
import type { ConfiguredEnvironmentVariables } from "../../../shared/protocol/environment-variables.js";
import { EnvironmentVariableEditor } from "./EnvironmentVariableEditor.js";
import { Button } from "../ui/button.js";
import { Callout } from "../ui/callout.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs.js";

type Usage = "execution" | "startup";

/**
 * Configured variables for an environment or backend, in two uses: tools
 * and commands (thread defaults) and backend startup. The enclosing section
 * supplies the heading.
 */
export function ConfiguredEnvironmentVariableEditor({ scope, value, inherited, onChange, startupUnavailableReason, error, disabled = false }: {
  readonly scope: "environment" | "backend";
  readonly value?: ConfiguredEnvironmentVariables;
  readonly inherited?: ConfiguredEnvironmentVariables;
  readonly onChange: (value: ConfiguredEnvironmentVariables) => void;
  readonly startupUnavailableReason?: string;
  /** A saved-document error about these variables. */
  readonly error?: string;
  readonly disabled?: boolean;
}) {
  const [selectedTab, setSelectedTab] = useState<Usage>("execution");
  const tab = startupUnavailableReason ? "execution" : selectedTab;
  const strandedStartup = Boolean(startupUnavailableReason) && Object.keys(value?.startup ?? {}).length > 0;
  const editor = (usage: Usage) => <EnvironmentVariableEditor scope={scope} disabled={disabled}
    inherited={scope === "backend" ? [{ scope: "environment", values: inherited?.[usage] ?? {} }] : []}
    value={value?.[usage] ?? {}} onChange={next => onChange({ execution: value?.execution ?? {}, startup: value?.startup ?? {}, [usage]: next })} />;
  return <div className="environment-variable-settings" role="group" aria-label="Environment variable settings">
    {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
    <Tabs value={tab} onValueChange={next => setSelectedTab(next as Usage)}>
      <TabsList aria-label="Variable usage">
        <TabsTrigger value="execution">Tools &amp; commands</TabsTrigger>
        <TabsTrigger value="startup" disabled={Boolean(startupUnavailableReason)}>Backend startup</TabsTrigger>
      </TabsList>
      {startupUnavailableReason ? <Callout role="note">{startupUnavailableReason} Inherited startup settings are not applied.</Callout> : null}
      {strandedStartup ? <Callout tone="warning" role="alert"
        action={<Button type="button" size="sm" variant="outline" onClick={() => onChange({ execution: value?.execution ?? {}, startup: {} })}>Remove startup overrides</Button>}>
        Remove this backend’s startup overrides before saving this connection type.
      </Callout> : null}
      <TabsContent value="execution">
        <p className="environment-variable-usage">{scope === "environment" ? "Defaults for tools and commands on this host, including new terminals." : "Overrides of the environment's defaults for this backend’s threads and tools."} New threads start with these values; existing threads keep their saved variables.</p>
        {editor("execution")}
      </TabsContent>
      <TabsContent value="startup">
        <p className="environment-variable-usage">Applied when Sedes starts an owned backend process. Saving does not restart a running backend. Changes remain pending until it restarts. Agents and threads cannot override these settings.</p>
        {editor("startup")}
      </TabsContent>
    </Tabs>
  </div>;
}
