export interface PaneSizeOptions {
  readonly storageKey: string;
  readonly cssVariable: `--${string}`;
  readonly min: number;
  readonly max: number;
  readonly default: number;
}

export interface PaneSize {
  readonly min: number;
  readonly max: number;
  readonly default: number;
  get(): number;
  clamp(value: number): number;
  /** Apply a drag frame without clamping or persisting it. */
  apply(value: number): void;
  /** Clamp, apply, and persist a committed value. */
  set(value: number): number;
  /** Restore the persisted value before the application paints. */
  install(): void;
}

/**
 * Creates the small localStorage/CSS-variable adapter shared by resizable
 * application panes. Gesture ownership and animation-frame batching remain in
 * the resize handle; this adapter owns only value normalization and storage.
 */
export function createPaneSize(options: PaneSizeOptions): PaneSize {
  if (
    !Number.isFinite(options.min) ||
    !Number.isFinite(options.max) ||
    !Number.isFinite(options.default) ||
    options.min > options.max ||
    options.default < options.min ||
    options.default > options.max
  ) {
    throw new Error("invalid_pane_size_options");
  }

  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return options.default;
    return Math.min(options.max, Math.max(options.min, Math.round(value)));
  };

  const get = (): number => {
    const stored = localStorage.getItem(options.storageKey);
    if (stored === null) return options.default;
    const parsed = Number.parseInt(stored, 10);
    return Number.isNaN(parsed) ? options.default : clamp(parsed);
  };

  const apply = (value: number): void => {
    document.documentElement.style.setProperty(options.cssVariable, `${value}px`);
  };

  const set = (value: number): number => {
    const clamped = clamp(value);
    localStorage.setItem(options.storageKey, String(clamped));
    apply(clamped);
    return clamped;
  };

  return Object.freeze({
    min: options.min,
    max: options.max,
    default: options.default,
    get,
    clamp,
    apply,
    set,
    install: () => apply(get()),
  });
}
