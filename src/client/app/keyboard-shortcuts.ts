export type PrimaryShortcutModifier = "meta" | "control";

export type KeyboardShortcutModifier = "primary" | "shift" | "alt";

/** Holding the primary modifier alone for this long reveals shortcut hints. */
export const SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS = 300;

/** The chosen shortcut badge lingers for confirmation, then fades away. */
export const SIDEBAR_QUICK_SWITCH_CONFIRMATION_MS = 300;

export interface KeyboardShortcutBinding {
  readonly key: string;
  readonly modifiers: readonly KeyboardShortcutModifier[];
}

export interface KeyboardShortcutCommand {
  readonly id: string;
  readonly scope: "sidebar";
  readonly defaultBinding: KeyboardShortcutBinding;
}

/**
 * Stable command identities are deliberately separate from their bindings.
 * A future preference layer can resolve configured bindings by command id
 * without moving navigation behavior into preference storage.
 */
export const SIDEBAR_QUICK_SWITCH_COMMANDS: readonly KeyboardShortcutCommand[] =
  Array.from({ length: 9 }, (_, index) => ({
    id: `sidebar.quick-switch.${index + 1}`,
    scope: "sidebar" as const,
    defaultBinding: {
      key: String(index + 1),
      modifiers: ["primary"] as const,
    },
  }));

export const SIDEBAR_ADJACENT_THREAD_COMMANDS = {
  previous: {
    id: "sidebar.navigate.previous",
    scope: "sidebar",
    defaultBinding: {
      key: "ArrowUp",
      modifiers: ["primary", "shift"],
    },
  },
  next: {
    id: "sidebar.navigate.next",
    scope: "sidebar",
    defaultBinding: {
      key: "ArrowDown",
      modifiers: ["primary", "shift"],
    },
  },
} as const satisfies Record<"previous" | "next", KeyboardShortcutCommand>;

export function activePrimaryShortcutModifier(
  event: Pick<KeyboardEvent, "metaKey" | "ctrlKey">,
): PrimaryShortcutModifier | undefined {
  if (event.metaKey === event.ctrlKey) return undefined;
  if (event.metaKey) return "meta";
  if (event.ctrlKey) return "control";
  return undefined;
}

export function primaryShortcutModifierForKey(
  key: string,
): PrimaryShortcutModifier | undefined {
  if (key === "Meta") return "meta";
  if (key === "Control") return "control";
  return undefined;
}

export function matchesKeyboardShortcut(
  event: Pick<
    KeyboardEvent,
    "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey"
  >,
  binding: KeyboardShortcutBinding,
): boolean {
  const modifiers = new Set(binding.modifiers);
  const primaryCount = Number(event.metaKey) + Number(event.ctrlKey);
  if (modifiers.has("primary") ? primaryCount !== 1 : primaryCount !== 0) {
    return false;
  }
  if (modifiers.has("shift") !== event.shiftKey) return false;
  if (modifiers.has("alt") !== event.altKey) return false;
  return event.key.toLowerCase() === binding.key.toLowerCase();
}

export function keyboardShortcutLabel(
  binding: KeyboardShortcutBinding,
  primary: PrimaryShortcutModifier,
): string {
  const parts = binding.modifiers.map((modifier) => {
    if (modifier === "primary") return primary === "meta" ? "⌘" : "Ctrl";
    if (modifier === "shift") return "Shift";
    return "Alt";
  });
  if (primary === "meta" && parts.length === 1 && parts[0] === "⌘") {
    return `⌘${binding.key}`;
  }
  return [...parts, binding.key].join("+");
}

export function keyboardShortcutAriaKey(
  binding: KeyboardShortcutBinding,
  primary: PrimaryShortcutModifier,
): string {
  const parts = binding.modifiers.map((modifier) => {
    if (modifier === "primary") {
      return primary === "meta" ? "Meta" : "Control";
    }
    return modifier === "shift" ? "Shift" : "Alt";
  });
  return [...parts, binding.key].join("+");
}
