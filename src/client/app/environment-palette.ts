import type { CSSProperties } from "react";

export const ENVIRONMENT_PALETTE_STORAGE_KEY = "sedes-environment-palette";
export const ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY =
  "sedes-environment-colors-enabled";
export const ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY =
  "sedes-environment-tint-settings";

export const ENVIRONMENT_TINT_INTENSITY_RANGE = {
  min: 6,
  max: 30,
  step: 1,
} as const;

export const ENVIRONMENT_TINT_FADE_IN_RANGE = {
  min: 0,
  max: 20,
  step: 1,
} as const;

export const ENVIRONMENT_TINT_COVERAGE_RANGE = {
  min: 20,
  max: 90,
  step: 1,
} as const;

export const ENVIRONMENT_PALETTE_OPTIONS = [
  {
    id: "gem",
    label: "Gem",
    description: "High-chroma distributed hues anchored in magenta.",
    chroma: 0.145,
    rotation: 325,
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Moderate distributed hues anchored in coral.",
    chroma: 0.11,
    rotation: 25,
  },
  {
    id: "cool",
    label: "Cool",
    description: "Quieter distributed hues anchored in cyan.",
    chroma: 0.1,
    rotation: 185,
  },
  {
    id: "mineral",
    label: "Mineral",
    description: "Muted distributed hues anchored in terracotta.",
    chroma: 0.075,
    rotation: 35,
  },
  {
    id: "vivid",
    label: "Vivid",
    description: "Bright distributed hues anchored in cyan.",
    chroma: 0.18,
    rotation: 195,
  },
  {
    id: "spectrum",
    label: "Spectrum",
    description: "Evenly distributed hues for maximum categorical range.",
    chroma: 0.155,
    rotation: 15,
  },
  {
    id: "signal",
    label: "Signal",
    description: "Strong distributed signal hues anchored in red.",
    chroma: 0.175,
    rotation: 350,
  },
] as const;

export type EnvironmentPaletteId =
  (typeof ENVIRONMENT_PALETTE_OPTIONS)[number]["id"];

export interface EnvironmentTintSettings {
  readonly intensity: number;
  readonly fadeIn: number;
  readonly coverage: number;
}

export interface EnvironmentPaletteTone {
  readonly hue: number;
  readonly chroma: number;
}

export type EnvironmentTintStyle = CSSProperties & {
  readonly "--environment-hue": number;
  readonly "--environment-chroma": number;
};

export const DEFAULT_ENVIRONMENT_PALETTE: EnvironmentPaletteId = "gem";
export const DEFAULT_ENVIRONMENT_TINT_SETTINGS: EnvironmentTintSettings = {
  intensity: 15,
  fadeIn: 6,
  coverage: 68,
};

const paletteChangeEvent = "environment-palette-change";
const environmentColorsEnabledChangeEvent = "environment-colors-enabled-change";
const tintSettingsChangeEvent = "environment-tint-settings-change";

export function getEnvironmentColorsEnabled(): boolean {
  return (
    localStorage.getItem(ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY) !== "false"
  );
}

export function setEnvironmentColorsEnabled(enabled: boolean): void {
  localStorage.setItem(
    ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY,
    enabled ? "true" : "false",
  );
  window.dispatchEvent(new CustomEvent(environmentColorsEnabledChangeEvent));
}

export function subscribeEnvironmentColorsEnabled(
  listener: (enabled: boolean) => void,
): () => void {
  const onChange = () => listener(getEnvironmentColorsEnabled());
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === ENVIRONMENT_COLORS_ENABLED_STORAGE_KEY
    ) {
      onChange();
    }
  };
  window.addEventListener(environmentColorsEnabledChangeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(environmentColorsEnabledChangeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getEnvironmentPalette(): EnvironmentPaletteId {
  const value = localStorage.getItem(ENVIRONMENT_PALETTE_STORAGE_KEY);
  return isEnvironmentPaletteId(value) ? value : DEFAULT_ENVIRONMENT_PALETTE;
}

export function setEnvironmentPalette(palette: EnvironmentPaletteId): void {
  localStorage.setItem(ENVIRONMENT_PALETTE_STORAGE_KEY, palette);
  applyEnvironmentPalette(palette);
  window.dispatchEvent(
    new CustomEvent(paletteChangeEvent, { detail: { palette } }),
  );
}

export function subscribeEnvironmentPalette(
  listener: (palette: EnvironmentPaletteId) => void,
): () => void {
  const onChange = () => listener(getEnvironmentPalette());
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ENVIRONMENT_PALETTE_STORAGE_KEY) {
      applyEnvironmentPalette(getEnvironmentPalette());
      onChange();
    }
  };
  window.addEventListener(paletteChangeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(paletteChangeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function getEnvironmentTintSettings(): EnvironmentTintSettings {
  const value = localStorage.getItem(ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY);
  if (value === null) return DEFAULT_ENVIRONMENT_TINT_SETTINGS;
  try {
    const parsed: unknown = JSON.parse(value);
    return isEnvironmentTintSettings(parsed)
      ? parsed
      : DEFAULT_ENVIRONMENT_TINT_SETTINGS;
  } catch {
    return DEFAULT_ENVIRONMENT_TINT_SETTINGS;
  }
}

export function setEnvironmentTintSettings(
  settings: EnvironmentTintSettings,
): void {
  if (!isEnvironmentTintSettings(settings)) {
    throw new RangeError("Invalid environment tint settings.");
  }
  localStorage.setItem(
    ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY,
    JSON.stringify(settings),
  );
  applyEnvironmentTintSettings(settings);
  window.dispatchEvent(
    new CustomEvent(tintSettingsChangeEvent, { detail: { settings } }),
  );
}

export function subscribeEnvironmentTintSettings(
  listener: (settings: EnvironmentTintSettings) => void,
): () => void {
  const onChange = () => listener(getEnvironmentTintSettings());
  const onStorage = (event: StorageEvent) => {
    if (
      event.key === null ||
      event.key === ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY
    ) {
      applyEnvironmentTintSettings(getEnvironmentTintSettings());
      onChange();
    }
  };
  window.addEventListener(tintSettingsChangeEvent, onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(tintSettingsChangeEvent, onChange);
    window.removeEventListener("storage", onStorage);
  };
}

export function installEnvironmentColors(): () => void {
  applyEnvironmentPalette(getEnvironmentPalette());
  applyEnvironmentTintSettings(getEnvironmentTintSettings());
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === ENVIRONMENT_PALETTE_STORAGE_KEY) {
      applyEnvironmentPalette(getEnvironmentPalette());
    }
    if (
      event.key === null ||
      event.key === ENVIRONMENT_TINT_SETTINGS_STORAGE_KEY
    ) {
      applyEnvironmentTintSettings(getEnvironmentTintSettings());
    }
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

export function resolveEnvironmentPaletteTones(
  environmentIds: readonly string[],
  paletteId: EnvironmentPaletteId,
): ReadonlyMap<string, EnvironmentPaletteTone> {
  const palette = environmentPaletteDefinition(paletteId);
  // Use the complete configured set, including unavailable environments, so
  // filtering or availability changes do not recolor the environments shown.
  const orderedEnvironmentIds = [...new Set(environmentIds)].sort(
    compareEnvironmentIds,
  );
  if (orderedEnvironmentIds.length === 0) {
    return new Map();
  }
  const spacing = 360 / orderedEnvironmentIds.length;
  return new Map(
    orderedEnvironmentIds.map((environmentId, index) => [
      environmentId,
      {
        hue: normalizeHue(palette.rotation + index * spacing),
        chroma: palette.chroma,
      },
    ]),
  );
}

export function environmentTintStyle(
  tone: EnvironmentPaletteTone,
): EnvironmentTintStyle {
  return {
    "--environment-hue": tone.hue,
    "--environment-chroma": tone.chroma,
  };
}

function environmentPaletteDefinition(paletteId: EnvironmentPaletteId) {
  return ENVIRONMENT_PALETTE_OPTIONS.find(({ id }) => id === paletteId)!;
}

function isEnvironmentPaletteId(
  value: string | null,
): value is EnvironmentPaletteId {
  return ENVIRONMENT_PALETTE_OPTIONS.some(({ id }) => id === value);
}

function isEnvironmentTintSettings(
  value: unknown,
): value is EnvironmentTintSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    isRangeValue(
      candidate.intensity,
      ENVIRONMENT_TINT_INTENSITY_RANGE.min,
      ENVIRONMENT_TINT_INTENSITY_RANGE.max,
    ) &&
    isRangeValue(
      candidate.fadeIn,
      ENVIRONMENT_TINT_FADE_IN_RANGE.min,
      ENVIRONMENT_TINT_FADE_IN_RANGE.max,
    ) &&
    isRangeValue(
      candidate.coverage,
      ENVIRONMENT_TINT_COVERAGE_RANGE.min,
      ENVIRONMENT_TINT_COVERAGE_RANGE.max,
    )
  );
}

function applyEnvironmentPalette(palette: EnvironmentPaletteId): void {
  document.documentElement.dataset.environmentPalette = palette;
}

function applyEnvironmentTintSettings(settings: EnvironmentTintSettings): void {
  const rowStart = settings.intensity / 100;
  const rowTail = rowStart / 3;
  const sidebarStart = rowStart * 0.9;
  // Coverage is the fully-clear endpoint. Reserve its final third for the
  // tail-to-transparent fade, and never place a row tail before its peak.
  const rowTailStop = Math.max(settings.fadeIn, (settings.coverage * 2) / 3);
  const root = document.documentElement;
  root.dataset.environmentTintIntensity = String(settings.intensity);
  root.dataset.environmentTintFadeIn = String(settings.fadeIn);
  root.dataset.environmentTintCoverage = String(settings.coverage);
  root.style.setProperty(
    "--environment-row-start-opacity",
    formatOpacity(rowStart),
  );
  root.style.setProperty(
    "--environment-row-tail-opacity",
    formatOpacity(rowTail),
  );
  root.style.setProperty(
    "--environment-sidebar-start-opacity",
    formatOpacity(sidebarStart),
  );
  root.style.setProperty(
    "--environment-sidebar-tail-opacity",
    formatOpacity(rowTail),
  );
  root.style.setProperty(
    "--environment-gradient-head-stop",
    `${settings.fadeIn}%`,
  );
  root.style.setProperty(
    "--environment-row-tail-stop",
    formatPercentage(rowTailStop),
  );
  root.style.setProperty(
    "--environment-row-clear-stop",
    formatPercentage(settings.coverage),
  );
}

function isRangeValue(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function formatOpacity(value: number): string {
  return String(Number(value.toFixed(3)));
}

function formatPercentage(value: number): string {
  return `${Number(value.toFixed(3))}%`;
}

function stableEnvironmentHash(value: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function compareEnvironmentIds(left: string, right: string): number {
  const hashDifference =
    stableEnvironmentHash(left) - stableEnvironmentHash(right);
  if (hashDifference !== 0) return hashDifference;
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeHue(hue: number): number {
  return Number((((hue % 360) + 360) % 360).toFixed(6));
}
