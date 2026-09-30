// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NormalizedThreadSnapshot,
  SettingDescriptor,
} from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import {
  ThreadModelPickerSheet,
  ThreadSettingsControls,
  ThreadSettingsMenuItems,
} from "./ThreadSettingsControls.js";

beforeEach(() => {
  // Radix Select, Popover and the menus need these missing jsdom APIs.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The touch density: narrow layouts and coarse pointers. */
function stubTouchDensity(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

function modelSetting(
  options: readonly [value: string, label: string, available?: boolean][],
): SettingDescriptor {
  return {
    id: "model",
    label: { text: "Model" },
    available: true,
    requiredForFirstSubmission: true,
    options: options.map(([value, label, available = true]) => ({
      value,
      label: { text: label },
      available,
    })),
  } as unknown as SettingDescriptor;
}

function thinkingSetting(
  overrides: Partial<SettingDescriptor> = {},
): SettingDescriptor {
  return {
    id: "thinking_level",
    label: { text: "Thinking" },
    available: true,
    requiredForFirstSubmission: false,
    options: [
      { value: "low", label: { text: "Low" }, available: true },
      { value: "high", label: { text: "High" }, available: true },
      { value: "max", label: { text: "Max" }, available: false },
    ],
    ...overrides,
  } as unknown as SettingDescriptor;
}

function settingsSnapshot(
  settings: readonly SettingDescriptor[],
  desired: Readonly<Record<string, string>> = {},
): NormalizedThreadSnapshot {
  return {
    capabilities: { providerFeatures: [], settings },
    providerFeatures: [],
    settings: {
      revision: 0,
      values: Object.entries(desired).map(([id, value]) => ({
        id,
        desiredValue: value,
        effectiveValue: value,
        applicationState: "effective",
      })),
    },
  } as unknown as NormalizedThreadSnapshot;
}

/** The touch model sheet as ThreadHeader opens it, with a return target. */
function ModelSheetHarness({
  snapshot,
  perform,
  searchFirst = false,
}: {
  readonly snapshot: NormalizedThreadSnapshot;
  readonly perform: ReturnType<typeof vi.fn>;
  readonly searchFirst?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const returnFocusRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={returnFocusRef} onClick={() => setOpen(true)}>
        Thread actions
      </button>
      <ThreadModelPickerSheet
        store={{ perform } as unknown as ThreadClientStore}
        snapshot={snapshot}
        disabled={false}
        open={open}
        searchFirst={searchFirst}
        onOpenChange={setOpen}
        returnFocusRef={returnFocusRef}
      />
    </>
  );
}

// Matches ThreadHeader: the next modal waits out the sheet's exit motion.
const SHEET_HANDOFF_MS = 260;

/**
 * The Thread actions sheet with the settings rows, handing the model row
 * to the model sheet once the actions sheet has closed, as ThreadHeader does.
 */
function ActionsSheetHarness({
  snapshot,
  perform,
}: {
  readonly snapshot: NormalizedThreadSnapshot;
  readonly perform: ReturnType<typeof vi.fn>;
}): React.JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(true);
  const [modelOpen, setModelOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const store = { perform } as unknown as ThreadClientStore;
  return (
    <>
      <DropdownMenu
        presentation="sheet"
        open={actionsOpen}
        onOpenChange={setActionsOpen}
      >
        <DropdownMenuTrigger ref={trigger}>Thread actions</DropdownMenuTrigger>
        <DropdownMenuContent
          aria-label="Thread actions"
          sheetTitle="Review backend contract"
        >
          <ThreadSettingsMenuItems
            store={store}
            snapshot={snapshot}
            disabled={false}
            onChooseModel={() => {
              setActionsOpen(false);
              setTimeout(() => setModelOpen(true), SHEET_HANDOFF_MS);
            }}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      <ThreadModelPickerSheet
        store={store}
        snapshot={snapshot}
        disabled={false}
        open={modelOpen}
        onOpenChange={setModelOpen}
        returnFocusRef={trigger}
      />
    </>
  );
}

describe("ThreadSettingsControls", () => {
  it("focuses the touch model sheet's search when the model row was chosen from the keyboard", () => {
    stubTouchDensity();
    render(
      <ModelSheetHarness
        perform={vi.fn().mockResolvedValue(undefined)}
        searchFirst
        snapshot={settingsSnapshot(
          [modelSetting([["model-a", "Model A"]])],
          { model: "model-a" },
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    expect(
      screen.getByRole("combobox", { name: "Search models" }),
    ).toHaveFocus();
  });

  it.each([false, true])(
    "opens the model pill for browsing on touch, with keyboard search override %s",
    (keyboard) => {
      stubTouchDensity();
      const perform = vi.fn().mockResolvedValue(undefined);
      render(
        <ThreadSettingsControls
          store={{ perform } as unknown as ThreadClientStore}
          snapshot={settingsSnapshot(
            [modelSetting([["model-a", "Model A"], ["model-b", "Model B"]])],
            { model: "model-a" },
          )}
          disabled={false}
        />,
      );
      const trigger = screen.getByRole("combobox", { name: "Model" });
      if (keyboard) {
        fireEvent.keyDown(trigger, { key: "ArrowDown" });
      } else {
        fireEvent.pointerDown(trigger, { pointerType: "touch" });
        fireEvent.click(trigger);
      }
      const search = screen.getByRole("combobox", { name: "Search models" });
      // Touch opens for browsing (no soft keyboard); the keyboard types.
      expect(
        keyboard ? search : screen.getByRole("dialog", { name: "Choose model" }),
      ).toHaveFocus();
      search.focus();
      fireEvent.change(search, { target: { value: "Model B" } });
      fireEvent.keyDown(search, { key: "Enter" });
      expect(perform).toHaveBeenCalledWith({
        action: "set_setting",
        settingId: "model",
        value: "model-b",
      });
    },
  );

  it("opens the touch model sheet for browsing and returns focus when a model is chosen", async () => {
    stubTouchDensity();
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSheetHarness
        perform={perform}
        snapshot={settingsSnapshot(
          [
            modelSetting([
              ["model-a", "Model A"],
              ["model-b", "Model B", false],
              ["model-c", "Model C"],
            ]),
          ],
          { model: "model-a" },
        )}
      />,
    );
    const opener = screen.getByRole("button", { name: "Thread actions" });
    fireEvent.click(opener);

    const sheet = screen.getByRole("dialog", { name: "Choose model" });
    expect(sheet).toHaveAttribute("data-layout", "sheet");
    expect(sheet).toHaveFocus();
    const search = within(sheet).getByRole("combobox", {
      name: "Search models",
    });
    expect(search).not.toHaveFocus();
    expect(
      within(sheet).getByRole("option", { name: "Model A" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(
      within(sheet).getByRole("option", { name: "Model B" }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(sheet).getByRole("option", { name: "Model B" }));
    expect(perform).not.toHaveBeenCalled();

    fireEvent.click(within(sheet).getByRole("option", { name: "Model C" }));
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "model",
      value: "model-c",
    });
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("leaves active models and scroll position alone during touch browsing", () => {
    stubTouchDensity();
    render(
      <ModelSheetHarness
        perform={vi.fn()}
        snapshot={settingsSnapshot(
          [modelSetting([["model-a", "Model A"], ["model-b", "Model B"]])],
          { model: "model-a" },
        )}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Thread actions" }));
    const first = screen.getByRole("option", { name: "Model A" });
    const second = screen.getByRole("option", { name: "Model B" });
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    fireEvent.pointerMove(second, { pointerType: "touch" });
    expect(first).toHaveAttribute("data-active", "true");
    expect(second).not.toHaveAttribute("data-active");
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    fireEvent.pointerMove(second, { pointerType: "mouse" });
    expect(second).toHaveAttribute("data-active", "true");
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledOnce();
  });

  it("keeps provider execution controls out of the primary settings row", () => {
    render(
      <ThreadSettingsControls
        store={{ perform: vi.fn() } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              settings: [],
              providerFeatures: [
                {
                  ref: { featureId: "codex.execution", schemaVersion: 1 },
                  presentationSlots: ["thread_details"],
                },
              ],
            },
            providerFeatures: [],
            settings: { revision: 0, values: [] },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    expect(screen.queryByLabelText("Codex execution settings")).toBeNull();
  });

  it("renders normalized opaque settings and performs the selected update", () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadSettingsControls
        store={{ perform } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              providerFeatures: [],
              settings: [
                {
                  id: "model",
                  label: { text: "Model" },
                  available: true,
                  requiredForFirstSubmission: true,
                  options: [
                    {
                      value: "backend/model-a",
                      label: { text: "Model A" },
                      available: true,
                    },
                    {
                      value: "backend/model-b",
                      label: { text: "Model B" },
                      available: false,
                    },
                    {
                      value: "backend/model-c",
                      label: { text: "Model C" },
                      available: true,
                    },
                  ],
                },
              ],
            },
            providerFeatures: [],
            settings: {
              revision: 2,
              values: [
                {
                  id: "model",
                  desiredValue: "backend/model-a",
                  effectiveValue: "backend/model-a",
                  applicationState: "effective",
                },
              ],
            },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Model" });
    expect(trigger).toHaveTextContent("Model A");
    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: "Model B" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    fireEvent.click(screen.getByRole("option", { name: "Model C" }));
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "model",
      value: "backend/model-c",
    });
  });

  it("filters only advertised labels and never treats the query as a model value", () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadSettingsControls
        store={{ perform } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              providerFeatures: [],
              settings: [
                {
                  id: "model",
                  label: { text: "Model" },
                  available: true,
                  requiredForFirstSubmission: true,
                  options: [
                    {
                      value: "opaque-openai-value",
                      label: { text: "OpenAI / GPT-5.6" },
                      available: true,
                    },
                    {
                      value: "opaque-anthropic-value",
                      label: { text: "Anthropic / Claude Sonnet" },
                      available: true,
                    },
                  ],
                },
              ],
            },
            providerFeatures: [],
            settings: {
              revision: 0,
              values: [
                {
                  id: "model",
                  desiredValue: "opaque-openai-value",
                  effectiveValue: "opaque-openai-value",
                  applicationState: "effective",
                },
              ],
            },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(search).toHaveFocus();
    expect(screen.getAllByRole("option")).toHaveLength(2);

    fireEvent.change(search, { target: { value: "aNtHrOpIc / cLaUdE" } });
    expect(
      screen.getByRole("option", { name: "Anthropic / Claude Sonnet" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "OpenAI / GPT-5.6" }),
    ).toBeNull();

    fireEvent.change(search, { target: { value: "opaque-openai-value" } });
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matching models")).toBeVisible();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(perform).not.toHaveBeenCalled();
  });

  it("navigates available results, skips disabled options, and restores focus", async () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadSettingsControls
        store={{ perform } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              providerFeatures: [],
              settings: [
                {
                  id: "model",
                  label: { text: "Model" },
                  available: true,
                  requiredForFirstSubmission: true,
                  options: [
                    {
                      value: "opaque-openai",
                      label: { text: "OpenAI / GPT-5.6" },
                      available: true,
                    },
                    {
                      value: "opaque-disabled",
                      label: { text: "Anthropic / Disabled" },
                      available: false,
                    },
                    {
                      value: "opaque-xai",
                      label: { text: "xAI / Grok" },
                      available: true,
                    },
                  ],
                },
              ],
            },
            providerFeatures: [],
            settings: {
              revision: 0,
              values: [
                {
                  id: "model",
                  desiredValue: "opaque-openai",
                  effectiveValue: "opaque-openai",
                  applicationState: "effective",
                },
              ],
            },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Model" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(search).toHaveFocus();
    const disabledOption = screen.getByRole("option", {
      name: "Anthropic / Disabled",
    });
    expect(disabledOption).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(disabledOption);
    expect(perform).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(search).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "xAI / Grok" }).id,
    );
    fireEvent.keyDown(search, { key: "Enter" });

    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "model",
      value: "opaque-xai",
    });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("combobox", { name: "Search models" }),
    ).toBeNull();
  });

  it("closes on Escape without mutation, clears search, and restores focus", async () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ThreadSettingsControls
        store={{ perform } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              providerFeatures: [],
              settings: [
                {
                  id: "model",
                  label: { text: "Model" },
                  available: true,
                  requiredForFirstSubmission: true,
                  options: [
                    {
                      value: "opaque-model",
                      label: { text: "OpenAI / GPT-5.6" },
                      available: true,
                    },
                  ],
                },
              ],
            },
            providerFeatures: [],
            settings: { revision: 0, values: [] },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Model" });
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "gpt" } });
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(perform).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("combobox", { name: "Search models" }),
    ).toBeNull();

    fireEvent.click(trigger);
    expect(
      screen.getByRole("combobox", { name: "Search models" }),
    ).toHaveValue("");
  });

  it("hands the Thread actions sheet's model row to the model sheet and back", async () => {
    stubTouchDensity();
    const user = userEvent.setup();
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionsSheetHarness
        perform={perform}
        snapshot={settingsSnapshot(
          [
            modelSetting([
              ["opaque-openai", "OpenAI / GPT-5.6"],
              ["opaque-anthropic", "Anthropic / Claude"],
            ]),
            thinkingSetting(),
          ],
          { model: "opaque-openai", thinking_level: "low" },
        )}
      />,
    );

    const actions = screen.getByRole("dialog", {
      name: "Review backend contract",
    });
    const model = within(actions).getByRole("menuitem", { name: /^Model/ });
    // The row shows the current model and opens a dialog, not a submenu.
    expect(model).toHaveAttribute("aria-haspopup", "dialog");
    expect(model).toHaveTextContent("OpenAI / GPT-5.6");
    await user.click(model);
    expect(actions).not.toBeInTheDocument();

    const sheet = await screen.findByRole("dialog", { name: "Choose model" });
    await user.type(
      within(sheet).getByRole("combobox", { name: "Search models" }),
      "claude",
    );
    await user.click(
      within(sheet).getByRole("option", { name: "Anthropic / Claude" }),
    );
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "model",
      value: "opaque-anthropic",
    });
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    const actionsTrigger = screen.getByRole("button", {
      name: "Thread actions",
    });
    await waitFor(() => expect(actionsTrigger).toHaveFocus());
  });

  it("dismisses the model sheet with Escape without a change and returns focus", async () => {
    stubTouchDensity();
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelSheetHarness
        perform={perform}
        snapshot={settingsSnapshot(
          [modelSetting([["opaque-model", "OpenAI / GPT-5.6"]])],
          { model: "opaque-model" },
        )}
      />,
    );
    const opener = screen.getByRole("button", { name: "Thread actions" });
    fireEvent.click(opener);
    const sheet = screen.getByRole("dialog", { name: "Choose model" });
    fireEvent.change(
      within(sheet).getByRole("combobox", { name: "Search models" }),
      { target: { value: "gpt" } },
    );
    await act(async () => {
      fireEvent.keyDown(sheet, { key: "Escape" });
    });
    await waitFor(() => expect(sheet).not.toBeInTheDocument());
    expect(perform).not.toHaveBeenCalled();
    await waitFor(() => expect(opener).toHaveFocus());

    // Each opening starts a fresh search.
    fireEvent.click(opener);
    expect(
      screen.getByRole("combobox", { name: "Search models" }),
    ).toHaveValue("");
  });

  it("drills into a setting's choices as radio rows on the Thread actions sheet", async () => {
    const user = userEvent.setup();
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionsSheetHarness
        perform={perform}
        snapshot={settingsSnapshot(
          [
            thinkingSetting(),
            thinkingSetting({
              id: "tool_access",
              label: { text: "Tool access" },
              available: false,
              unavailableReason: { text: "Busy" },
            } as Partial<SettingDescriptor>),
          ],
          { thinking_level: "low" },
        )}
      />,
    );
    const actions = screen.getByRole("dialog", {
      name: "Review backend contract",
    });
    // An unavailable setting cannot be opened and says why.
    const toolAccess = within(actions).getByRole("menuitem", {
      name: /^Tool access/,
    });
    expect(toolAccess).toBeDisabled();
    expect(toolAccess).toHaveAttribute("title", "Busy");

    const thinking = within(actions).getByRole("menuitem", {
      name: /^Thinking/,
    });
    expect(thinking).toHaveAttribute("aria-haspopup", "menu");
    expect(thinking).toHaveTextContent("Low");
    await user.click(thinking);
    const radios = within(actions).getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual([
      "Low",
      "High",
      "Max",
    ]);
    expect(
      within(actions).getByRole("menuitemradio", { name: "Low" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(actions).getByRole("menuitemradio", { name: "Max" }),
    ).toBeDisabled();
    await user.click(within(actions).getByRole("menuitemradio", { name: "High" }));
    expect(perform).toHaveBeenCalledExactlyOnceWith({
      action: "set_setting",
      settingId: "thinking_level",
      value: "high",
    });
  });

  it("keeps the effective value visible while a desired change is pending", () => {
    render(
      <ThreadSettingsControls
        store={{ perform: vi.fn() } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              providerFeatures: [],
              settings: [
                {
                  id: "model",
                  label: { text: "Model" },
                  available: true,
                  requiredForFirstSubmission: true,
                  options: [
                    {
                      value: "backend/model-a",
                      label: { text: "Model A" },
                      available: true,
                    },
                    {
                      value: "backend/model-b",
                      label: { text: "Model B" },
                      available: true,
                    },
                  ],
                },
              ],
            },
            providerFeatures: [],
            settings: {
              revision: 3,
              values: [
                {
                  id: "model",
                  desiredValue: "backend/model-b",
                  effectiveValue: "backend/model-a",
                  applicationState: "pending_next_turn",
                },
              ],
            },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Model" }),
    ).toHaveTextContent("Model B");
    expect(screen.queryByText(/Current:|applies next turn/i)).toBeNull();
  });

  it("does not repeat draft application timing beneath the selected value", () => {
    render(
      <ThreadSettingsControls
        store={{ perform: vi.fn() } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              providerFeatures: [],
              settings: [
                {
                  id: "model",
                  label: { text: "Model" },
                  available: true,
                  requiredForFirstSubmission: true,
                  options: [
                    {
                      value: "backend/model-a",
                      label: { text: "Model A" },
                      available: true,
                    },
                  ],
                },
              ],
            },
            providerFeatures: [],
            settings: {
              revision: 0,
              values: [
                {
                  id: "model",
                  desiredValue: "backend/model-a",
                  effectiveValue: null,
                  applicationState: "draft",
                },
              ],
            },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Model" }),
    ).toHaveTextContent("Model A");
    expect(screen.queryByText(/applies when this thread starts/i)).toBeNull();
  });

  it("disables a setting according to normalized availability", () => {
    render(
      <ThreadSettingsControls
        store={{ perform: vi.fn() } as unknown as ThreadClientStore}
        snapshot={
          {
            capabilities: {
              providerFeatures: [],
              settings: [
                {
                  id: "thinking_level",
                  label: { text: "Thinking" },
                  available: false,
                  unavailableReason: { text: "Busy" },
                  requiredForFirstSubmission: false,
                  options: [
                    { value: "low", label: { text: "Low" }, available: true },
                  ],
                },
              ],
            },
            providerFeatures: [],
            settings: { revision: 0, values: [] },
          } as unknown as NormalizedThreadSnapshot
        }
        disabled={false}
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Thinking" }),
    ).toBeDisabled();
  });
});
