import { useSyncExternalStore } from "react";
import {
  getEnvironmentColorsEnabled,
  subscribeEnvironmentColorsEnabled,
} from "./environment-palette.js";

function subscribe(onChange: () => void): () => void {
  return subscribeEnvironmentColorsEnabled(onChange);
}

/** Reactive device-local switch shared by every environment-tinted surface. */
export function useEnvironmentColorsEnabled(): boolean {
  return useSyncExternalStore(
    subscribe,
    getEnvironmentColorsEnabled,
    getEnvironmentColorsEnabled,
  );
}
