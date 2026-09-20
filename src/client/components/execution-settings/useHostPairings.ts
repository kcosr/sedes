import { useCallback, useEffect, useRef, useState } from "react";
import type { HostPairingList } from "../../../shared/protocol/host-pairing.js";
import type { ApiClient } from "../../api/ApiClient.js";
import { errorMessage } from "./fields.js";

export type HostPairingControls = Pick<ApiClient, "outboundConnectorSetup" | "listHostRegistrations" | "acceptHostRegistration" | "denyHostRegistration" | "revokeHostPairing" | "reapproveHostPairing">;

export function useHostPairings(controls: HostPairingControls, onConfigurationChanged: () => Promise<boolean>, visible = true) {
  const [hosts, setHosts] = useState<HostPairingList>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lastMutationSucceeded, setLastMutationSucceeded] = useState<boolean>();
  const [stale, setStale] = useState(false);
  const reader = useRef<AbortController | undefined>(undefined);
  const mutating = useRef(false);
  const mounted = useRef(true);
  const refresh = useCallback(async (background = false) => {
    if (mutating.current || (background && reader.current)) return;
    reader.current?.abort();
    const controller = new AbortController();
    reader.current = controller;
    let timedOut = false;
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort(); }, 15_000);
    controller.signal.addEventListener("abort", () => window.clearTimeout(timeout), { once: true });
    try {
      const next = await controls.listHostRegistrations(controller.signal);
      if (controller.signal.aborted) return;
      setHosts(next); setError(""); setStale(false);
    } catch (cause) {
      if (timedOut || !controller.signal.aborted) { setError(timedOut ? "Host registration refresh timed out. Presence may be out of date." : errorMessage(cause, "Could not refresh host registrations. Presence may be out of date.")); setStale(true); }
    } finally { window.clearTimeout(timeout); if (reader.current === controller) reader.current = undefined; }
  }, [controls]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; reader.current?.abort(); reader.current = undefined; };
  }, []);
  useEffect(() => {
    if (!visible) return;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") void refresh(true); }, 5_000);
    return () => { window.clearInterval(timer); reader.current?.abort(); reader.current = undefined; };
  }, [refresh, visible]);
  const mutate = async (action: () => Promise<unknown>, changesConfiguration: boolean): Promise<boolean> => {
    if (mutating.current || stale) return false;
    mutating.current = true; setBusy(true); setError("");
    setLastMutationSucceeded(undefined);
    reader.current?.abort(); reader.current = undefined;
    let succeeded = false;
    try {
      await action();
      if (changesConfiguration && mounted.current) await onConfigurationChanged();
      succeeded = true;
    } catch (cause) {
      if (mounted.current) { setError(`${errorMessage(cause, "The host change could not be confirmed.")} Refresh before trying again.`); setStale(true); }
    } finally {
      mutating.current = false;
      if (mounted.current && succeeded) await refresh();
      if (mounted.current) { setLastMutationSucceeded(succeeded); setBusy(false); }
    }
    return succeeded;
  };
  return { hosts, error, busy, lastMutationSucceeded, stale, refresh, mutate };
}
