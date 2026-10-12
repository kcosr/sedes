/**
 * Theme mode (system | light | dark) persisted in localStorage, applied as
 * data-theme + color-scheme on <html>. Call applyStoredTheme() at the top of
 * main.tsx (before render; no inline script needed) and useTheme() in the app.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { readStorage, writeStorage } from "./storage";

export type ThemeMode = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function darkQuery(): MediaQueryList | null {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
    ? window.matchMedia(DARK_QUERY)
    : null;
}

/** The operating system / browser preference right now. */
export function systemTheme(): Theme {
  return darkQuery()?.matches ? "dark" : "light";
}

function parseMode(value: string | null): ThemeMode {
  return value === "light" || value === "dark" ? value : "system";
}

/** The stored mode; "system" when nothing (or garbage) is stored. */
export function readThemeMode(storageKey: string): ThemeMode {
  return parseMode(readStorage(storageKey));
}

export function resolveTheme(mode: ThemeMode): Theme {
  return mode === "system" ? systemTheme() : mode;
}

/** Set data-theme and color-scheme on <html> (CSSOM, so CSP-safe). */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
}

/** Apply the stored theme synchronously; call before the first render. */
export function applyStoredTheme(storageKey: string): Theme {
  const theme = resolveTheme(readThemeMode(storageKey));
  applyTheme(theme);
  return theme;
}

// ---- shared store: every useTheme(key) instance sees the same mode

const modes = new Map<string, ThemeMode>();
const listeners = new Map<string, Set<() => void>>();
let storageListening = false;

function emit(key: string): void {
  for (const listener of listeners.get(key) ?? []) listener();
}

function onStorage(e: StorageEvent): void {
  if (e.key === null) {
    for (const key of listeners.keys()) {
      modes.set(key, readThemeMode(key));
      emit(key);
    }
  } else if (listeners.has(e.key)) {
    modes.set(e.key, parseMode(e.newValue));
    emit(e.key);
  }
}

function getMode(key: string): ThemeMode {
  let mode = modes.get(key);
  if (mode === undefined) {
    mode = readThemeMode(key);
    modes.set(key, mode);
  }
  return mode;
}

/** Persist a mode (system clears the stored override) and notify hooks. */
export function setThemeMode(storageKey: string, mode: ThemeMode): void {
  writeStorage(storageKey, mode === "system" ? null : mode);
  modes.set(storageKey, mode);
  applyTheme(resolveTheme(mode));
  emit(storageKey);
}

function subscribeMode(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  if (!storageListening && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
    storageListening = true;
  }
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
    if (listeners.size === 0 && storageListening) {
      window.removeEventListener("storage", onStorage);
      storageListening = false;
    }
  };
}

function subscribeSystem(listener: () => void): () => void {
  const query = darkQuery();
  if (!query) return () => {};
  query.addEventListener("change", listener);
  return () => query.removeEventListener("change", listener);
}

export interface ThemeState {
  /** What the user chose. */
  mode: ThemeMode;
  /** What is applied (system resolved against prefers-color-scheme). */
  theme: Theme;
  setMode: (mode: ThemeMode) => void;
}

/**
 * Current theme mode for `storageKey`. While the mode is "system" the applied
 * theme follows prefers-color-scheme live. Keeps <html> in sync.
 */
export function useTheme(storageKey: string): ThemeState {
  const subscribe = useCallback(
    (listener: () => void) => subscribeMode(storageKey, listener),
    [storageKey],
  );
  const mode = useSyncExternalStore(
    subscribe,
    () => getMode(storageKey),
    () => "system" as const,
  );
  const system = useSyncExternalStore(
    subscribeSystem,
    systemTheme,
    () => "light" as const,
  );
  const theme: Theme = mode === "system" ? system : mode;
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const setMode = useCallback(
    (next: ThemeMode) => setThemeMode(storageKey, next),
    [storageKey],
  );
  return { mode, theme, setMode };
}
