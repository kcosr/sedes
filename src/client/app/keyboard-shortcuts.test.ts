import { describe, expect, it } from "vitest";
import {
  activePrimaryShortcutModifier,
  keyboardShortcutAriaKey,
  keyboardShortcutLabel,
  matchesKeyboardShortcut,
  SIDEBAR_ADJACENT_THREAD_COMMANDS,
  SIDEBAR_QUICK_SWITCH_COMMANDS,
} from "./keyboard-shortcuts.js";

describe("keyboard shortcut definitions", () => {
  it("recognizes exactly one active primary modifier", () => {
    expect(activePrimaryShortcutModifier({ metaKey: true, ctrlKey: false })).toBe(
      "meta",
    );
    expect(activePrimaryShortcutModifier({ metaKey: false, ctrlKey: true })).toBe(
      "control",
    );
    expect(activePrimaryShortcutModifier({ metaKey: false, ctrlKey: false })).toBe(
      undefined,
    );
    expect(activePrimaryShortcutModifier({ metaKey: true, ctrlKey: true })).toBe(
      undefined,
    );
  });

  it("defines stable primary-modifier commands for sidebar slots 1 through 9", () => {
    expect(SIDEBAR_QUICK_SWITCH_COMMANDS).toHaveLength(9);
    expect(
      SIDEBAR_QUICK_SWITCH_COMMANDS.map((command) => ({
        binding: command.defaultBinding,
        id: command.id,
      })),
    ).toEqual(
      Array.from({ length: 9 }, (_, index) => ({
        binding: { key: String(index + 1), modifiers: ["primary"] },
        id: `sidebar.quick-switch.${index + 1}`,
      })),
    );
  });

  it("defines primary-Shift arrow commands for adjacent sidebar threads", () => {
    expect(SIDEBAR_ADJACENT_THREAD_COMMANDS).toEqual({
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
    });
    const base = {
      altKey: false,
      ctrlKey: false,
      key: "ArrowDown",
      metaKey: false,
      shiftKey: true,
    };
    expect(
      matchesKeyboardShortcut(
        { ...base, metaKey: true },
        SIDEBAR_ADJACENT_THREAD_COMMANDS.next.defaultBinding,
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { ...base, ctrlKey: true },
        SIDEBAR_ADJACENT_THREAD_COMMANDS.next.defaultBinding,
      ),
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(
        { ...base, metaKey: true, shiftKey: false },
        SIDEBAR_ADJACENT_THREAD_COMMANDS.next.defaultBinding,
      ),
    ).toBe(false);
  });

  it("matches either primary modifier without accepting extra modifiers", () => {
    const binding = SIDEBAR_QUICK_SWITCH_COMMANDS[0]!.defaultBinding;
    const event = (overrides: Partial<KeyboardEvent>) => ({
      altKey: false,
      ctrlKey: false,
      key: "1",
      metaKey: false,
      shiftKey: false,
      ...overrides,
    });

    expect(matchesKeyboardShortcut(event({ metaKey: true }), binding)).toBe(
      true,
    );
    expect(matchesKeyboardShortcut(event({ ctrlKey: true }), binding)).toBe(
      true,
    );
    expect(
      matchesKeyboardShortcut(
        event({ metaKey: true, shiftKey: true }),
        binding,
      ),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(event({ ctrlKey: true, metaKey: true }), binding),
    ).toBe(false);
    expect(
      matchesKeyboardShortcut(event({ key: "2", metaKey: true }), binding),
    ).toBe(false);
  });

  it("formats visual and accessibility labels for the active primary modifier", () => {
    const binding = SIDEBAR_QUICK_SWITCH_COMMANDS[2]!.defaultBinding;
    expect(keyboardShortcutLabel(binding, "meta")).toBe("⌘3");
    expect(keyboardShortcutAriaKey(binding, "meta")).toBe("Meta+3");
    expect(keyboardShortcutLabel(binding, "control")).toBe("Ctrl+3");
    expect(keyboardShortcutAriaKey(binding, "control")).toBe("Control+3");
  });
});
