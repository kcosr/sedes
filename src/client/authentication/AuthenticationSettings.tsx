import { createContext, useContext, useEffect, useState } from "react";
import type { AuthenticationClient } from "../../shared/authentication.js";
import { Button } from "../components/ui/button.js";

export interface AuthenticationControls {
  client: AuthenticationClient;
  list(): Promise<AuthenticationClient[]>;
  revoke(id: string): Promise<void>;
  logout(): Promise<void>;
}
export const AuthenticationContext = createContext<AuthenticationControls | null>(null);
export function useAuthenticationControls(): AuthenticationControls | null { return useContext(AuthenticationContext); }
export function AuthenticationSettings(): React.JSX.Element | null {
  const controls = useAuthenticationControls();
  const [clients, setClients] = useState<AuthenticationClient[]>([]);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void controls?.list().then((result) => { if (alive) setClients(result); }).catch(() => { if (alive) setError("Could not load paired clients."); });
    return () => { alive = false; };
  }, [controls]);
  if (!controls) return null;
  async function revoke(id: string): Promise<void> {
    if (!controls) return;
    setPending(true); setError("");
    try {
      if (id === controls.client.id) await controls.logout(); else await controls.revoke(id);
      setClients((current) => current.filter((entry) => entry.id !== id)); setConfirmation(null);
    } catch { setError("Could not unpair this client. Try again."); } finally { setPending(false); }
  }
  return <>
    <h3 className="settings-page-title">Paired clients</h3>
    <p className="settings-row-description">Clients paired with this server can reconnect automatically. Unpairing ends their access; sessions and files stay on the server.</p>
    {clients.map((client) => <div className="settings-row" key={client.id}>
      <div className="settings-row-text"><span className="settings-row-label">{client.name}{client.id === controls.client.id ? " (this connection)" : ""}</span><p className="settings-row-description">{client.kind === "sidecar" ? "Sidecar" : "Application client"} · Paired {new Date(client.createdAt).toLocaleDateString()}</p></div>
      {confirmation === client.id ? <><Button disabled={pending} onClick={() => void revoke(client.id)}>Confirm unpair</Button><Button disabled={pending} variant="outline" onClick={() => setConfirmation(null)}>Cancel</Button></> : <Button variant="outline" disabled={pending} onClick={() => setConfirmation(client.id)}>Unpair</Button>}
    </div>)}
    {error && <p role="alert">{error}</p>}
  </>;
}
