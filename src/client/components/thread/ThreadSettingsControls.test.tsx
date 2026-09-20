// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import * as Popover from "@radix-ui/react-popover";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedThreadSnapshot } from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { ThreadSettingsControls } from "./ThreadSettingsControls.js";
import { SearchableModelPicker } from "./SearchableModelPicker.js";

beforeEach(() => {
  // Radix Select needs these missing jsdom APIs.
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
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ThreadSettingsControls", () => {
  it.each([false, true])("opens mobile models for browsing, with keyboard search override %s", (keyboard) => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
    const onValueChange = vi.fn();
    render(<SearchableModelPicker
      setting={{ id: "model", label: { text: "Model" }, available: true,
        requiredForFirstSubmission: true,
        options: [{ value: "model-a", label: { text: "Model A" }, available: true }],
      }}
      value="model-a" disabled={false} variant="row" onValueChange={onValueChange}
    />);
    const trigger = screen.getByRole("combobox", { name: "Model" });
    if (keyboard) fireEvent.keyDown(trigger, { key: "ArrowDown" });
    else fireEvent.click(trigger);
    const search = screen.getByRole("searchbox", { name: "Search models" });
    expect(keyboard ? search : screen.getByRole("dialog", { name: "Choose model" })).toHaveFocus();
    search.focus();
    fireEvent.change(search, { target: { value: "Model A" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onValueChange).toHaveBeenCalledWith("model-a");
  });

  it("leaves active models and scroll position alone during touch browsing", () => {
    render(<SearchableModelPicker
      setting={{ id: "model", label: { text: "Model" }, available: true,
        requiredForFirstSubmission: true,
        options: [
          { value: "model-a", label: { text: "Model A" }, available: true },
          { value: "model-b", label: { text: "Model B" }, available: true },
        ],
      }}
      value="model-a" disabled={false} variant="row" onValueChange={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("combobox", { name: "Model" }));
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
        mobile
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
    const search = screen.getByRole("searchbox", { name: "Search models" });
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
    const search = screen.getByRole("searchbox", { name: "Search models" });
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
    expect(screen.queryByRole("searchbox", { name: "Search models" })).toBeNull();
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
    const search = screen.getByRole("searchbox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "gpt" } });
    fireEvent.keyDown(search, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(perform).not.toHaveBeenCalled();
    expect(screen.queryByRole("searchbox", { name: "Search models" })).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("searchbox", { name: "Search models" })).toHaveValue(
      "",
    );
  });

  it("keeps the thread-actions popover open while the portaled picker is used", async () => {
    const user = userEvent.setup();
    const perform = vi.fn().mockResolvedValue(undefined);
    render(
      <Popover.Root>
        <Popover.Trigger>Thread actions</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content aria-label="Thread actions">
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
                            value: "opaque-anthropic",
                            label: { text: "Anthropic / Claude" },
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
              mobile
            />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>,
    );

    const actionsTrigger = screen.getByRole("button", {
      name: "Thread actions",
    });
    await user.click(actionsTrigger);
    const actions = screen.getByRole("dialog", { name: "Thread actions" });
    const modelTrigger = screen.getByRole("combobox", { name: "Model" });
    await user.click(modelTrigger);
    const search = screen.getByRole("searchbox", { name: "Search models" });
    await user.type(search, "claude");
    await user.click(
      screen.getByRole("option", { name: "Anthropic / Claude" }),
    );
    expect(actions).toBeVisible();
    expect(modelTrigger).toHaveFocus();
    expect(perform).toHaveBeenCalledWith({
      action: "set_setting",
      settingId: "model",
      value: "opaque-anthropic",
    });

    await user.click(modelTrigger);
    await user.keyboard("{Escape}");
    expect(actions).toBeVisible();
    expect(modelTrigger).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(actions).not.toBeInTheDocument());
    expect(actionsTrigger).toHaveFocus();
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
