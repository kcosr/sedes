// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CannedPrompt,
  CannedPromptLibrary,
  CannedPromptMutationResult,
} from "../../shared/protocol/canned-prompts.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import { CannedPromptClientStore } from "../stores/CannedPromptClientStore.js";
import { CannedPromptsSettingsPage } from "./CannedPromptsSettingsPage.js";

function prompt(
  id: string,
  title: string,
  text: string,
  position: number,
): CannedPrompt {
  return { id, title, text, position, createdAt: 1, updatedAt: 1 };
}

function library(
  items: readonly CannedPrompt[] = [],
  revision = 1,
): CannedPromptLibrary {
  return { revision, items: [...items] };
}

function result(
  items: readonly CannedPrompt[],
  revision: number,
): CannedPromptMutationResult {
  return { revision, items: [...items], replayed: false };
}

function store(
  overrides: Record<string, unknown> = {},
): CannedPromptClientStore {
  const api = {
    listCannedPrompts: vi.fn().mockResolvedValue(library()),
    createCannedPrompt: vi.fn(),
    updateCannedPrompt: vi.fn(),
    deleteCannedPrompt: vi.fn(),
    reorderCannedPrompts: vi.fn(),
    ...overrides,
  } as unknown as ApiClient;
  return new CannedPromptClientStore(api);
}

describe("Canned prompts settings", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("crypto", { randomUUID: vi.fn(() => "mutation-id") });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("loads, retries failures, and controls local prompt presentation", async () => {
    const listCannedPrompts = vi
      .fn()
      .mockRejectedValueOnce(new Error("Library unavailable"))
      .mockResolvedValue(
        library([prompt("prompt-1", "Review", "Review changes.", 0)]),
      );
    render(<CannedPromptsSettingsPage store={store({ listCannedPrompts })} />);

    expect(screen.getByTestId("show-prompts-tab-toggle")).toBeChecked();
    expect(screen.getByRole("radio", { name: "Above composer" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Composer toolbar" }));
    expect(localStorage.getItem("sedes-prompts-placement")).toBe("toolbar");
    fireEvent.click(screen.getByTestId("show-prompts-tab-toggle"));
    expect(localStorage.getItem("sedes-show-prompts-tab")).toBe("false");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Library unavailable",
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Review")).toBeVisible();
    expect(listCannedPrompts).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(listCannedPrompts).toHaveBeenCalledTimes(3));
  });

  it("does not apply a UTF-16 maxLength that rejects valid Unicode titles", async () => {
    render(<CannedPromptsSettingsPage store={store()} />);
    await screen.findByRole("button", { name: "Add prompt" });
    fireEvent.click(screen.getByRole("button", { name: "Add prompt" }));

    expect(screen.getByLabelText("Title")).not.toHaveAttribute("maxlength");
  });

  it("validates and creates a prompt through the authoritative store", async () => {
    const createCannedPrompt = vi
      .fn()
      .mockResolvedValue(
        result([prompt("prompt-1", "Review", "Review changes.", 0)], 2),
      );
    render(<CannedPromptsSettingsPage store={store({ createCannedPrompt })} />);

    fireEvent.click(await screen.findByRole("button", { name: "Add prompt" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Add prompt" })[1]!);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a prompt title.",
    );
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: " Review " },
    });
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Review changes." },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Add prompt" })[1]!);

    await waitFor(() =>
      expect(createCannedPrompt).toHaveBeenCalledWith(
        {
          expectedRevision: 1,
          mutationId: "mutation-id",
          title: "Review",
          text: "Review changes.",
        },
        expect.any(AbortSignal),
      ),
    );
    expect(await screen.findByText("Prompt added.")).toBeVisible();
  });

  it("edits, reorders, and confirms deletion without icon or visibility fields", async () => {
    const first = prompt("prompt-1", "Review", "Review changes.", 0);
    const second = prompt("prompt-2", "Test", "Run tests.", 1);
    const updateCannedPrompt = vi
      .fn()
      .mockResolvedValue(
        result([{ ...first, title: "Review carefully" }, second], 4),
      );
    const reorderCannedPrompts = vi.fn().mockResolvedValue(
      result(
        [
          { ...second, position: 0 },
          { ...first, title: "Review carefully", position: 1 },
        ],
        5,
      ),
    );
    const deleteCannedPrompt = vi
      .fn()
      .mockResolvedValue(
        result([{ ...first, title: "Review carefully", position: 0 }], 6),
      );
    render(
      <CannedPromptsSettingsPage
        store={store({
          listCannedPrompts: vi
            .fn()
            .mockResolvedValue(library([first, second], 3)),
          updateCannedPrompt,
          reorderCannedPrompts,
          deleteCannedPrompt,
        })}
      />,
    );

    fireEvent.click((await screen.findByText("Review")).closest("button")!);
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "Review carefully" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateCannedPrompt).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Move Test up" }));
    await waitFor(() =>
      expect(reorderCannedPrompts).toHaveBeenCalledWith(
        expect.objectContaining({ promptIds: ["prompt-2", "prompt-1"] }),
        expect.any(AbortSignal),
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Delete Test" }));
    const confirmation = screen.getByRole("group", { name: "Delete Test?" });
    fireEvent.click(
      within(confirmation).getByRole("button", { name: "Delete" }),
    );
    await waitFor(() => expect(deleteCannedPrompt).toHaveBeenCalled());
    expect(await screen.findByText("Prompt deleted.")).toBeVisible();
    expect(screen.queryByLabelText(/icon/u)).toBeNull();
  });

  it("reports conflict reconciliation and closes the stale editor", async () => {
    const initial = prompt("prompt-1", "Review", "Old text", 0);
    const current = { ...initial, text: "Changed elsewhere" };
    const listCannedPrompts = vi
      .fn()
      .mockResolvedValueOnce(library([initial], 1))
      .mockResolvedValueOnce(library([current], 2));
    const updateCannedPrompt = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "conflict", "Conflict", false));
    render(
      <CannedPromptsSettingsPage
        store={store({ listCannedPrompts, updateCannedPrompt })}
      />,
    );

    fireEvent.click((await screen.findByText("Review")).closest("button")!);
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "My stale edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(
      await screen.findByText(/changed in another session/u),
    ).toBeVisible();
    expect(screen.getByText("Changed elsewhere")).toBeVisible();
    expect(screen.queryByLabelText("Prompt")).toBeNull();
    expect(listCannedPrompts).toHaveBeenCalledTimes(2);
  });
});
