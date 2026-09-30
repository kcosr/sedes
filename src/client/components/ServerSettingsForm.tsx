import { useEffect, useState } from "react";
import type {
  PackagedConnectionPreferences,
  PackagedConnectionProfile,
} from "../app/server-preferences.js";
import { serverFromPairingInput } from "../authentication/pairing-link.js";
import { Button } from "./ui/button.js";
import { Callout } from "./ui/callout.js";
import { ConfirmDialog } from "./ui/confirm-dialog.js";
import { Field } from "./ui/field.js";
import { Input } from "./ui/input.js";
import { Tag } from "./ui/tag.js";
import { SettingsActionRow } from "./settings/SettingsField.js";
import { SettingsSection } from "./settings/SettingsSection.js";

export interface ServerSettingsControls {
  readonly connections: PackagedConnectionPreferences;
  readonly storageError?: string;
  readonly save: (profile: PackagedConnectionProfile) => Promise<void>;
  readonly connect: (profileId: string) => Promise<void>;
  readonly remove: (profileId: string) => Promise<void>;
}

/**
 * The packaged client's saved servers and the form that adds one. Settings
 * frames the two parts as sections; launch screens show them bare.
 */
export function ServerSettingsForm({
  controls,
  sections = false,
}: {
  controls: ServerSettingsControls;
  sections?: boolean;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState(controls.storageError ?? "");
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<PackagedConnectionProfile>();
  useEffect(() => setStatus(controls.storageError ?? ""), [controls.storageError]);

  const perform = async (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setStatus("");
    try {
      await operation();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the connection.");
    } finally {
      setPending(false);
    }
  };

  const profiles = controls.connections.profiles.map((profile) => (
    <SettingsActionRow
      key={profile.id}
      title={
        <>
          {profile.name}
          {profile.id === controls.connections.selectedProfileId ? (
            <Tag>Selected</Tag>
          ) : null}
        </>
      }
      description={profile.baseUrl}
      actions={
        <>
          <Button type="button" variant="ghost" disabled={pending}
            aria-label={`Remove ${profile.name}`}
            onClick={() => setRemoving(profile)}>
            Remove…
          </Button>
          <Button type="button" variant="outline" disabled={pending}
            aria-label={`Connect to ${profile.name}`}
            onClick={() => void perform(() => controls.connect(profile.id))}>
            Connect
          </Button>
        </>
      }
    />
  ));
  const insecure = value.trim().toLowerCase().startsWith("http://");
  const form = (
    <form className="server-settings-add" onSubmit={(event) => {
      event.preventDefault();
      void perform(async () => {
        const normalized = serverFromPairingInput(value);
        const profile: PackagedConnectionProfile = {
          id: crypto.randomUUID(), name: name.trim(), baseUrl: normalized,
        };
        if (!profile.name) throw new Error("Enter a connection name.");
        await controls.save(profile);
        setName("");
        setValue("");
      });
    }}>
      <Field id="setting-sedes-name" label="Connection name">
        <Input value={name} maxLength={100}
          placeholder="Home" disabled={pending}
          onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field
        id="setting-sedes-server"
        label="Sedes server URL"
        description="Add a server, then enter its pairing code to connect. Each connection remembers its own credential securely on this device."
      >
        <Input type="url" inputMode="url"
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          placeholder="https://sedes.example" value={value} disabled={pending}
          onChange={(event) => setValue(event.target.value)} />
      </Field>
      {insecure ? (
        <Callout tone="warning">
          HTTP is unencrypted. Use it only with a Sedes server on a private
          network you trust.
        </Callout>
      ) : null}
      <div className="server-settings-actions">
        <Button type="submit" disabled={pending || !value.trim() || !name.trim()}>
          {pending ? "Saving…" : "Add & connect"}
        </Button>
      </div>
    </form>
  );
  const error = status ? (
    <Callout tone="danger" role="alert">
      {status}
    </Callout>
  ) : null;
  const confirm = (
    <ConfirmDialog
      open={Boolean(removing)}
      onOpenChange={(open) => {
        if (!open) setRemoving(undefined);
      }}
      tone="danger"
      title={`Remove ${removing?.name ?? "connection"}?`}
      description="This device forgets the server and its credential. Pair again to reconnect."
      confirmLabel="Remove connection"
      pendingLabel="Removing…"
      onConfirm={async () => {
        if (removing) await controls.remove(removing.id);
      }}
    />
  );

  if (sections) {
    return (
      <>
        {error}
        {profiles.length > 0 ? (
          <SettingsSection title="Saved connections" card>
            {profiles}
          </SettingsSection>
        ) : null}
        <SettingsSection title="Add a connection" card>
          {form}
        </SettingsSection>
        {confirm}
      </>
    );
  }
  return (
    <div className="server-settings-form">
      {profiles.length > 0 ? <div className="server-settings-profiles">{profiles}</div> : null}
      {form}
      {error}
      {confirm}
    </div>
  );
}
