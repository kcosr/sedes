import { useState } from "react";
import { acceptHostRegistrationRequestSchema, type HostPairingList, type HostRegistration, type AcceptHostRegistrationRequest } from "../../../shared/protocol/host-pairing.js";
import { Button } from "../ui/button.js";
import { TextField, TextListField, Toggle } from "./fields.js";
import { SidecarCapabilitiesField } from "./SidecarCapabilitiesField.js";
import type { HostPairingControls } from "./useHostPairings.js";

export function hostPlatform(platform: string): string {
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : "Linux";
}

export function PendingHosts({ registrations, controls, revision, disabled, mutate, onEditing }: {
  readonly registrations: HostPairingList["registrations"];
  readonly controls: HostPairingControls;
  readonly revision: number;
  readonly disabled: boolean;
  readonly mutate: (action: () => Promise<unknown>, changesConfiguration: boolean) => Promise<boolean>;
  readonly onEditing: (editing: boolean) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<{ registration: HostRegistration; configurationRevision: number; label: string; workspaceRoots: string[]; operations: AcceptHostRegistrationRequest["operations"] }>();
  const [error, setError] = useState("");
  const close = () => { setDraft(undefined); setError(""); onEditing(false); };
  const accept = async () => {
    if (!draft) return;
    const parsed = acceptHostRegistrationRequestSchema.safeParse({ mutationId: crypto.randomUUID(), registrationId: draft.registration.id,
      expectedRegistrationRevision: draft.registration.revision, expectedConfigurationRevision: draft.configurationRevision,
      label: draft.label, workspaceRoots: draft.workspaceRoots, operations: draft.operations });
    if (!parsed.success) { setError(parsed.error.issues.map((issue) => `${issue.path.join(" · ")}: ${issue.message}`).join("\n")); return; }
    if (await mutate(() => controls.acceptHostRegistration(parsed.data), true)) close();
  };
  return <section className="execution-settings-section" aria-label="Pending hosts">
    <h4>Pending hosts</h4>
    {error ? <p role="alert" className="execution-settings-error">{error}</p> : null}
    {draft ? <div className="execution-settings-editor"><form onSubmit={(event) => { event.preventDefault(); void accept(); }}>
      <h4>Accept {draft.registration.metadata.hostname}</h4>
      <p className="execution-settings-muted">Registration code: {draft.registration.correlationCode}. The connector has authenticated to the API. Acceptance creates its environment and grants only the workspace roots and operations selected below.</p>
      <fieldset disabled={disabled}><legend>Environment access</legend>
        <TextField autoFocus required label="Environment name" value={draft.label} onChange={(label) => setDraft({ ...draft, label })} />
        <TextListField label="Workspace roots" value={draft.workspaceRoots} onChange={(workspaceRoots) => setDraft({ ...draft, workspaceRoots })}
          description={draft.registration.metadata.platform === "win32" ? "One allowed absolute Windows directory per line, for example C:\\Projects." : "One allowed absolute directory per line on this host, for example /Users/you/Projects on macOS."} />
        <Toggle label="Enable sidecar operations" checked={draft.operations.kind === "sidecar"} onChange={(enabled) => setDraft({ ...draft, operations: enabled ? { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files"] } : { kind: "none" } })} />
        {draft.operations.kind === "sidecar" ? <SidecarCapabilitiesField value={draft.operations.enabledCapabilities}
          onChange={(enabledCapabilities) => setDraft({ ...draft, operations: { kind: "sidecar", enabledCapabilities } })} /> : null}
      </fieldset>
      <div className="execution-settings-actions execution-settings-save-bar"><Button type="submit" size="sm" disabled={disabled}>Accept host</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={close}>Cancel</Button></div>
    </form></div> : <div className="execution-settings-list">
      {registrations.filter((registration) => registration.state === "pending").map((registration) => <article className="execution-settings-card" key={registration.id} aria-label={`Pending ${registration.metadata.hostname}`}>
        <h4>{registration.metadata.hostname}</h4>
        <p>Registration code: <strong>{registration.correlationCode}</strong></p>
        <p>{hostPlatform(registration.metadata.platform)} · {registration.metadata.architecture} · {registration.metadata.account}</p>
        <p>{registration.connected ? "Host online" : "Host offline"} · Last seen {new Date(registration.lastSeenAt).toLocaleString()}</p>
        <p className="execution-settings-muted">Connector {registration.metadata.connectorVersion} · Requested {new Date(registration.createdAt).toLocaleString()} · Expires {new Date(registration.expiresAt).toLocaleString()}</p>
        <div className="execution-settings-actions"><Button type="button" size="sm" disabled={disabled} aria-label={`Accept ${registration.metadata.hostname}`} onClick={() => {
          setDraft({ registration, configurationRevision: revision, label: registration.metadata.hostname, workspaceRoots: [], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files"] } }); onEditing(true);
        }}>Accept</Button>
          <Button type="button" size="sm" variant="outline" disabled={disabled} aria-label={`Deny ${registration.metadata.hostname}`} onClick={() => void mutate(() => controls.denyHostRegistration({ mutationId: crypto.randomUUID(), registrationId: registration.id, expectedRegistrationRevision: registration.revision }), false)}>Deny</Button></div>
      </article>)}
      {!registrations.some((registration) => registration.state === "pending") ? <p className="execution-settings-muted">No pending host registrations.</p> : null}
    </div>}
  </section>;
}

export function HostConnectorSetup({ controls }: { readonly controls: HostPairingControls }): React.JSX.Element {
  const setup = controls.outboundConnectorSetup();
  return <section className="execution-settings-section" aria-label="Pair a host"><h4>Pair an outbound host</h4>
    <p className="execution-settings-muted">First pair the connector with the Sedes API, then compare its registration code here and approve its environment access. Host details are reported by the connector.</p>
    <div className="execution-settings-card">
      <p>On the Sedes server, create a single-use sidecar pairing code:</p>
      <pre className="execution-settings-connector-command"><code>{`sedes auth pair --server ${JSON.stringify(setup.serverUrl)} --sidecar`}</code></pre>
      <p><a href={setup.downloadUrl} download="sedes-sidecar.mjs" target="_blank" rel="noreferrer">Download connector</a> to the host with Node.js 22.19 or newer. Replace PAIRING_CODE with the code from the server, then run:</p>
      <pre className="execution-settings-connector-command"><code>{`node sedes-sidecar.mjs connect --server ${JSON.stringify(setup.serverUrl)} --pairing-code PAIRING_CODE`}</code></pre>
      <p className="execution-settings-muted">On macOS, install Xcode Command Line Tools before the first start. Keep the connector running to keep the host available. The connector saves its credential for this exact server URL and reuses it on restart; omit --pairing-code on later starts. Pair again if the server URL changes or the credential is revoked.</p>
    </div>
</section>;
}
