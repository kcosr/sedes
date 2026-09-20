import type { Appearance } from "../types";

const storageKey = "sedes-appearance";

export function getAppearance(): Appearance {
  const value = localStorage.getItem(storageKey);
  return value === "light" || value === "dark" ? value : "system";
}

export function getResolvedAppearance(): "light" | "dark" {
  const appearance = getAppearance();
  return appearance === "dark" ||
    (appearance === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches)
    ? "dark"
    : "light";
}

export function subscribeResolvedAppearance(
  listener: (appearance: "light" | "dark") => void,
): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => listener(getResolvedAppearance());
  window.addEventListener("appearance-change", onChange);
  media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener("appearance-change", onChange);
    media.removeEventListener("change", onChange);
  };
}

function apply(appearance: Appearance): void {
  const dark =
    appearance === "dark" ||
    (appearance === "system" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
}

export function setAppearance(appearance: Appearance): void {
  localStorage.setItem(storageKey, appearance);
  apply(appearance);
  window.dispatchEvent(
    new CustomEvent("appearance-change", { detail: appearance }),
  );
}

export function installAppearance(): () => void {
  apply(getAppearance());
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onSystemChange = () => {
    if (getAppearance() === "system") apply("system");
  };
  media.addEventListener("change", onSystemChange);
  return () => media.removeEventListener("change", onSystemChange);
}
