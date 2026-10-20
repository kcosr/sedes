import { App as CapacitorApp } from "@capacitor/app";
import { isAndroidClient } from "./client-platform.js";

/**
 * Calls `listener` whenever the page may stop running script without a
 * React unmount: the document becomes hidden, the page is unloaded or
 * frozen into the back/forward cache, or the Android app leaves the
 * foreground (where timers are throttled and the WebView may be killed).
 * One departure can report more than one of these signals.
 */
export function subscribePageHide(listener: () => void): () => void {
  const hidden = () => {
    if (document.visibilityState === "hidden") listener();
  };
  window.addEventListener("pagehide", listener);
  document.addEventListener("visibilitychange", hidden);
  let removeNativeListener: (() => void) | undefined;
  let disposed = false;
  if (isAndroidClient()) {
    void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (!isActive) listener();
    })
      .then((handle) => {
        removeNativeListener = () => void handle.remove();
        if (disposed) removeNativeListener();
      })
      .catch(() => undefined);
  }
  return () => {
    disposed = true;
    window.removeEventListener("pagehide", listener);
    document.removeEventListener("visibilitychange", hidden);
    removeNativeListener?.();
  };
}
