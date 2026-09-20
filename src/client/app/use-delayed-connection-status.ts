import { useEffect, useState } from "react";
import type { ConnectionState } from "../api/EventStreamTransport.js";

export const CONNECTION_INDICATOR_DELAY_MILLISECONDS = 1_000;

export function useDelayedUnavailableConnection(
  connection: ConnectionState,
): boolean {
  const connected = connection === "connected";
  const [showUnavailable, setShowUnavailable] = useState(false);
  useEffect(() => {
    if (connected) {
      setShowUnavailable(false);
      return;
    }
    const timer = window.setTimeout(
      () => setShowUnavailable(true),
      CONNECTION_INDICATOR_DELAY_MILLISECONDS,
    );
    return () => window.clearTimeout(timer);
  }, [connected]);
  return !connected && showUnavailable;
}
