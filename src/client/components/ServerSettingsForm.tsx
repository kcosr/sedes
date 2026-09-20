import { useEffect, useState } from "react";
import type {
  PackagedConnectionPreferences,
  PackagedConnectionProfile,
} from "../app/server-preferences.js";
import { serverFromPairingInput } from "../authentication/pairing-link.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";

export interface ServerSettingsControls {
  readonly connections: PackagedConnectionPreferences;
  readonly storageError?: string;
  readonly save: (profile: PackagedConnectionProfile) => Promise<void>;
  readonly connect: (profileId: string) => Promise<void>;
  readonly remove: (profileId: string) => Promise<void>;
}

export function ServerSettingsForm({ controls }: {
  controls: ServerSettingsControls;
}): React.JSX.Element {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState(controls.storageError ?? "");
  const [pending, setPending] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
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

  return (
    <div className="server-settings-form">
      {controls.connections.profiles.map((profile) => (
        <div className="settings-row" key={profile.id}>
          <div className="settings-row-text">
            <span className="settings-row-label">{profile.name}</span>
            <p className="settings-row-description">{profile.baseUrl}</p>
            {profile.id === controls.connections.selectedProfileId && (
              <p className="settings-row-description">Selected connection</p>
            )}
          </div>
          <div className="server-settings-actions">
            <Button type="button" variant="outline" disabled={pending}
              aria-label={`Connect to ${profile.name}`}
              onClick={() => void perform(() => controls.connect(profile.id))}>
              Connect
            </Button>
            {removing === profile.id ? (
              <>
                <Button type="button" variant="destructive" disabled={pending}
                  aria-label={`Confirm remove ${profile.name}`}
                  onClick={() => void perform(async () => {
                    await controls.remove(profile.id);
                    setRemoving(null);
                  })}>Confirm remove</Button>
                <Button type="button" variant="ghost" disabled={pending}
                  onClick={() => setRemoving(null)}>Cancel</Button>
              </>
            ) : (
              <Button type="button" variant="ghost" disabled={pending}
                aria-label={`Remove ${profile.name}`}
                onClick={() => setRemoving(profile.id)}>Remove</Button>
            )}
          </div>
        </div>
      ))}
      <form onSubmit={(event) => {
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
        <div className="server-settings-field">
          <Label htmlFor="setting-sedes-name">Connection name</Label>
          <Input id="setting-sedes-name" value={name} maxLength={100}
            placeholder="Home" disabled={pending}
            onChange={(event) => setName(event.target.value)} />
          <Label htmlFor="setting-sedes-server">Sedes server URL</Label>
          <Input id="setting-sedes-server" type="url" inputMode="url"
            autoCapitalize="none" autoCorrect="off" spellCheck={false}
            placeholder="https://sedes.example" value={value} disabled={pending}
            onChange={(event) => setValue(event.target.value)} />
          <p className="settings-row-description">
            Add a server, then enter its pairing code to connect. Each connection
            remembers its own credential securely on this device.
          </p>
          {value.trim().toLowerCase().startsWith("http://") && (
            <p className="notice warning">HTTP is unencrypted. Use it only with a Sedes
              server on a private network you trust.</p>
          )}
        </div>
        <div className="server-settings-actions">
          <Button type="submit" disabled={pending || !value.trim() || !name.trim()}>
            {pending ? "Saving…" : "Add & connect"}
          </Button>
        </div>
      </form>
      {status && <p className="server-settings-status" role="status">{status}</p>}
    </div>
  );
}
