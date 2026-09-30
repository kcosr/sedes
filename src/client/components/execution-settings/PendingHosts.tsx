import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Check, Copy } from "lucide-react";
import type { AcceptHostRegistrationRequest, HostPairingList, HostRegistration } from "../../../shared/protocol/host-pairing.js";
import { relativeTime } from "../../lib/time.js";
import { SaveBar } from "../settings/SaveBar.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import { KeyValueList } from "../ui/key-value-list.js";
import { StatusPill } from "../ui/status-pill.js";
import { Tag } from "../ui/tag.js";
import { SettingsDetailHeader } from "../settings/SettingsSplit.js";
import { useFocusReturn } from "../settings/use-focus-return.js";
import { GeneralErrors } from "./detail-parts.js";
import { RemoteOperationsFields } from "./EnvironmentEditor.js";
import { hostPlatform, PendingHostList } from "./ExecutionInventory.js";
import { ListField, TextField } from "./fields.js";
import type { HostPairingControls } from "./useHostPairings.js";
import type { MappedErrors } from "./validation.js";

export interface AcceptDraft {
  readonly registrationId: string;
  readonly registrationRevision: number;
  readonly configurationRevision: number;
  readonly label: string;
  readonly workspaceRoots: string[];
  readonly operations: AcceptHostRegistrationRequest["operations"];
}

/** The fields of the acceptance form, relative to the request. */
export const acceptFields = /^(label|workspaceRoots(\.\d+)?|operations(\..+)?)$/u;

export function acceptDraftFor(registration: HostRegistration, configurationRevision: number): AcceptDraft {
  return { registrationId: registration.id, registrationRevision: registration.revision, configurationRevision,
    label: registration.metadata.hostname, workspaceRoots: [], operations: { kind: "sidecar", enabledCapabilities: ["directory_browser", "workspace_files"] } };
}

type PendingRegistration = HostPairingList["registrations"][number];

/**
 * A host awaiting approval: what it reported, and the access that accepting
 * it grants. Accepting creates its environment; denying ends the request.
 */
export function PendingHostDetail({ registration, draft, setDraft, errors, disabled, dirty, saving, saveError, back, headingRef, onAccept, onCancel, onDeny }: {
  readonly registration: PendingRegistration;
  readonly draft: AcceptDraft;
  readonly setDraft: (draft: AcceptDraft) => void;
  readonly errors: MappedErrors;
  readonly disabled: boolean;
  /** The review has edits (the accept form starts complete). */
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly saveError?: ReactNode;
  readonly back: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
  readonly onAccept: () => void;
  readonly onCancel: () => void;
  readonly onDeny: () => Promise<void>;
}): React.JSX.Element {
  const [denying, setDenying] = useState(false);
  const focusReturn = useFocusReturn();
  const metadata = registration.metadata;
  const fields = errors.fields;
  return <section aria-label={`Pending ${metadata.hostname}`} className="execution-detail">
    <SettingsDetailHeader back={back} headingRef={headingRef} title={metadata.hostname}
      tags={<Tag>Pending</Tag>} status={registration.connected ? <StatusPill tone="success">Host online</StatusPill> : <StatusPill tone="warning">Host offline</StatusPill>}
      description="Compare the registration code with the one the connector printed. Accepting creates its environment with only the access below."
      actions={<Button type="button" variant="outline" disabled={disabled} aria-label={`Deny ${metadata.hostname}`} onClick={() => setDenying(true)}>Deny</Button>} />
    <SettingsSection title="Registration" card>
      <KeyValueList className="execution-facts" items={[
        { label: "Registration code", value: <strong className="execution-code">{registration.correlationCode}</strong> },
        { label: "Host", value: `${hostPlatform(metadata.platform)} · ${metadata.architecture} · ${metadata.account}` },
        { label: "Connector", value: metadata.connectorVersion, mono: true },
        { label: "Last seen", value: <time dateTime={registration.lastSeenAt} title={new Date(registration.lastSeenAt).toLocaleString()}>{relativeTime(registration.lastSeenAt)}</time> },
        { label: "Requested", value: <time dateTime={registration.createdAt} title={new Date(registration.createdAt).toLocaleString()}>{relativeTime(registration.createdAt)}</time> },
        { label: "Expires", value: <time dateTime={registration.expiresAt} title={new Date(registration.expiresAt).toLocaleString()}>{relativeTime(registration.expiresAt)}</time> },
      ]} />
    </SettingsSection>
    <GeneralErrors errors={errors.general} />
    <form data-slot="settings-editor-form" noValidate onSubmit={(event) => { event.preventDefault(); onAccept(); }}>
      <SettingsSection title="Access to grant" card>
        <TextField label="Environment name" required disabled={disabled} value={draft.label} error={fields.get("label")}
          onChange={(label) => setDraft({ ...draft, label })} />
        <ListField label="Workspace roots" itemLabel="Workspace root" addLabel="Add root" disabled={disabled}
          placeholder={metadata.platform === "win32" ? "C:\\Projects" : "/Users/you/Projects"}
          description={metadata.platform === "win32" ? "Absolute Windows folders agents may open, for example C:\\Projects." : "Absolute folders on this host that agents may open, for example /Users/you/Projects on macOS."}
          value={draft.workspaceRoots} error={fields.get("workspaceRoots")} itemErrors={draft.workspaceRoots.map((_, index) => fields.get(`workspaceRoots.${index}`))}
          onChange={(workspaceRoots) => setDraft({ ...draft, workspaceRoots })} />
        <RemoteOperationsFields value={draft.operations} disabled={disabled} errors={fields} onChange={(operations) => setDraft({ ...draft, operations })} />
      </SettingsSection>
      <SaveBar creating dirty={dirty} saving={saving} error={saveError} onCancel={onCancel} saveLabel="Accept host" savingLabel="Accepting…" saveDisabled={disabled} />
    </form>
    <ConfirmDialog open={denying} onOpenChange={setDenying} title={`Deny ${metadata.hostname}?`}
      description="The connector's request is rejected and no environment is created. The host can register again later."
      confirmLabel="Deny host" pendingLabel="Denying…" onConfirm={onDeny} {...focusReturn} />
  </section>;
}

function CommandBlock({ command, label }: { readonly command: string; readonly label: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return <div className="execution-command">
    <pre><code>{command}</code></pre>
    <Button type="button" variant="ghost" size="icon-sm" aria-label={copied ? `${label} copied` : `Copy ${label}`}
      onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true), () => undefined)}>{copied ? <Check /> : <Copy />}</Button>
  </div>;
}

/** How to pair an outbound host, and the hosts already waiting for approval. */
export function PairHostSetup({ controls, registrations, back, headingRef }: {
  readonly controls: HostPairingControls;
  readonly registrations: HostPairingList["registrations"];
  readonly back: ReactNode;
  readonly headingRef?: Ref<HTMLHeadingElement>;
}): React.JSX.Element {
  const setup = controls.outboundConnectorSetup();
  return <section aria-label="Pair a host" className="execution-detail">
    <SettingsDetailHeader back={back} headingRef={headingRef} title="Pair a host"
      description="Pair a connector with the Sedes API, compare its registration code here, then approve its access." />
    <SettingsSection title="1. Create a pairing code" description="On the Sedes server, create a single-use sidecar pairing code." card>
      <CommandBlock label="pairing command" command={`sedes auth pair --server ${JSON.stringify(setup.serverUrl)} --sidecar`} />
    </SettingsSection>
    <SettingsSection title="2. Run the connector" card
      description={<><a href={setup.downloadUrl} download="sedes-sidecar.mjs" target="_blank" rel="noreferrer">Download connector</a> to the host (Node.js 22.19 or newer), replace PAIRING_CODE with the code, and run:</>}>
      <CommandBlock label="connector command" command={`node sedes-sidecar.mjs connect --server ${JSON.stringify(setup.serverUrl)} --pairing-code PAIRING_CODE`} />
      <p className="execution-muted">On macOS, install Xcode Command Line Tools before the first start. Keep the connector running to keep the host available. It saves its credential for this server URL and reuses it on restart, so omit --pairing-code later. Pair again if the server URL changes or the credential is revoked.</p>
    </SettingsSection>
    <SettingsSection title="3. Approve the host" description="Its request appears here and in the environment list.">
      <PendingHostList registrations={registrations} />
    </SettingsSection>
  </section>;
}
