import { useSyncExternalStore } from "react";
import {
  getEnvironmentPalette,
  subscribeEnvironmentPalette,
  type EnvironmentPaletteId,
} from "./environment-palette.js";

function subscribe(onChange: () => void): () => void {
  return subscribeEnvironmentPalette(onChange);
}

/** Reactive client-local palette selection shared by every tinted surface. */
export function useEnvironmentPalette(): EnvironmentPaletteId {
  return useSyncExternalStore(
    subscribe,
    getEnvironmentPalette,
    getEnvironmentPalette,
  );
}
