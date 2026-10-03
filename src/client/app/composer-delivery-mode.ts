import { useSyncExternalStore } from "react";

const key = "sedes-composer-delivery-mode";
const changed = "sedes-composer-delivery-mode-changed";
let sessionMode: "steer" | "queue" = "steer";
export function getComposerDeliveryMode(): "steer" | "queue" {
  try { sessionMode = localStorage.getItem(key) === "queue" ? "queue" : "steer"; } catch { /* Retain the explicit session preference. */ }
  return sessionMode;
}
export function setComposerDeliveryMode(mode: "steer" | "queue"): void {
  sessionMode = mode;
  try { localStorage.setItem(key, mode); } catch { /* The active session still observes the change. */ }
  window.dispatchEvent(new Event(changed));
}
function subscribe(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === key || event.key === null) listener(); };
  window.addEventListener(changed, listener);
  window.addEventListener("storage", storage);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener("storage", storage); };
}
export const useComposerDeliveryMode = () => useSyncExternalStore(subscribe, getComposerDeliveryMode, () => "steer" as const);
