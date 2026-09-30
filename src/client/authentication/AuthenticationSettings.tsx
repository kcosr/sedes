import { createContext, useContext, useEffect, useState } from "react";
import { MonitorSmartphone } from "lucide-react";
import type { AuthenticationClient } from "../../shared/authentication.js";
import { Button } from "../components/ui/button.js";
import { Callout } from "../components/ui/callout.js";
import { ConfirmDialog } from "../components/ui/confirm-dialog.js";
import { EmptyState } from "../components/ui/empty-state.js";
import { Tag } from "../components/ui/tag.js";
import { SettingsActionRow } from "../components/settings/SettingsField.js";
import { SettingsPage } from "../components/settings/SettingsPage.js";
import { SettingsSection } from "../components/settings/SettingsSection.js";

export interface AuthenticationControls {
  client: AuthenticationClient;
  list(): Promise<AuthenticationClient[]>;
  revoke(id: string): Promise<void>;
  logout(): Promise<void>;
}
export const AuthenticationContext = createContext<AuthenticationControls | null>(null);
export function useAuthenticationControls(): AuthenticationControls | null { return useContext(AuthenticationContext); }

/** Settings › Paired clients: every client paired with this server, and unpairing. */
export function AuthenticationSettings(): React.JSX.Element | null {
  const controls = useAuthenticationControls();
  const [clients, setClients] = useState<AuthenticationClient[]>();
  const [error, setError] = useState("");
  const [unpairing, setUnpairing] = useState<AuthenticationClient>();
  useEffect(() => {
    let alive = true;
    void controls?.list()
      .then((result) => { if (alive) setClients(result); })
      .catch(() => { if (alive) { setClients([]); setError("Could not load paired clients."); } });
    return () => { alive = false; };
  }, [controls]);
  if (!controls) return null;
  const current = (client: AuthenticationClient) => client.id === controls.client.id;
  async function unpair(client: AuthenticationClient): Promise<void> {
    if (!controls) return;
    try {
      if (current(client)) await controls.logout(); else await controls.revoke(client.id);
    } catch {
      throw new Error("Could not unpair this client. Try again.");
    }
    setClients((entries) => entries?.filter((entry) => entry.id !== client.id));
  }
  return (
    <SettingsPage
      title="Paired clients"
      description="Clients paired with this server can reconnect automatically. Unpairing ends their access; sessions and files stay on the server."
    >
      {error ? <Callout tone="danger" role="alert">{error}</Callout> : null}
      {clients === undefined ? (
        <p className="settings-loading" role="status">Loading paired clients…</p>
      ) : clients.length === 0 ? (
        error ? null : (
          <EmptyState
            icon={<MonitorSmartphone />}
            title="No paired clients"
            description="Pair a browser or device to see it here."
          />
        )
      ) : (
        <SettingsSection card>
          {clients.map((client) => (
            <SettingsActionRow
              key={client.id}
              title={<><span>{client.name}</span>{current(client) ? <Tag>This connection</Tag> : null}</>}
              description={`${client.kind === "sidecar" ? "Sidecar" : "Application client"} · Paired ${new Date(client.createdAt).toLocaleDateString()}`}
              actions={
                <Button variant="outline" onClick={() => setUnpairing(client)}>
                  Unpair
                </Button>
              }
            />
          ))}
        </SettingsSection>
      )}
      <ConfirmDialog
        open={Boolean(unpairing)}
        onOpenChange={(open) => { if (!open) setUnpairing(undefined); }}
        tone="danger"
        title={`Unpair ${unpairing?.name ?? "client"}?`}
        description={unpairing && current(unpairing)
          ? "This browser loses access now and must be paired again to reconnect."
          : "It loses access now and must be paired again to reconnect."}
        confirmLabel={unpairing && current(unpairing) ? "Unpair this browser" : "Unpair client"}
        pendingLabel="Unpairing…"
        onConfirm={() => (unpairing ? unpair(unpairing) : undefined)}
      />
    </SettingsPage>
  );
}
