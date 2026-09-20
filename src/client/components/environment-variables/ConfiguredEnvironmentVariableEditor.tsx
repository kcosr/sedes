import { useState } from "react";
import type { ConfiguredEnvironmentVariables } from "../../../shared/protocol/environment-variables.js";
import { EnvironmentVariableEditor } from "./EnvironmentVariableEditor.js";
import { Button } from "../ui/button.js";

export function ConfiguredEnvironmentVariableEditor({ scope, value, inherited, onChange, startupUnavailableReason }: {
  readonly scope: "environment" | "backend";
  readonly value?: ConfiguredEnvironmentVariables;
  readonly inherited?: ConfiguredEnvironmentVariables;
  readonly onChange: (value: ConfiguredEnvironmentVariables) => void;
  readonly startupUnavailableReason?: string;
}) {
  const [selectedTab, setSelectedTab] = useState<"execution" | "startup">("execution");
  const tab = startupUnavailableReason ? "execution" : selectedTab;
  return <section className="environment-variable-settings" aria-label="Environment variable settings">
    <h4>Environment variables</h4>
    <p>{scope === "environment" ? "Defaults for tools and commands on this host, including new ordinary terminals." : "Override environment defaults for this backend’s threads and tools."}</p>
    <div className="environment-variable-tabs" role="tablist" aria-label="Variable usage">
      <button type="button" role="tab" aria-selected={tab === "execution"} onClick={() => setSelectedTab("execution")}>Tools &amp; commands</button>
      <button type="button" role="tab" aria-selected={tab === "startup"} disabled={Boolean(startupUnavailableReason)} onClick={() => setSelectedTab("startup")}>Backend startup</button>
    </div>
    {startupUnavailableReason && <p role="note">{startupUnavailableReason} Inherited startup settings are not applied.</p>}
    {startupUnavailableReason && Object.keys(value?.startup ?? {}).length > 0 && <div>
      <p className="environment-variable-error">Remove this backend’s startup overrides before saving this connection type.</p>
      <Button type="button" size="sm" variant="outline" onClick={() => onChange({ execution: value?.execution ?? {}, startup: {} })}>Remove startup overrides</Button>
    </div>}
    {tab === "startup" && <p>Applied when Sedes starts an owned backend process. Saving does not restart a running backend. Changes remain pending until it restarts. Agents and threads cannot override these settings.</p>}
    <EnvironmentVariableEditor key={tab} scope={scope} inherited={scope === "backend" ? [{ scope: "environment", values: inherited?.[tab] ?? {} }] : []} value={value?.[tab] ?? {}} onChange={next => onChange({ execution: value?.execution ?? {}, startup: value?.startup ?? {}, [tab]: next })} />
    <p>Tools and commands changes become defaults for new threads. Existing threads retain their saved variable snapshots.</p>
  </section>;
}
