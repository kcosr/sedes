// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/ApiClient.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import type { ThreadAutomationDefinition } from "../types.js";
import { ThreadAutomationDialog } from "./ThreadAutomationDialog.js";

const threadId = "10000000-0000-4000-8000-000000000001";
const paused: ThreadAutomationDefinition = {
  status: "paused",
  runMode: "same_thread",
  scheduleKind: "date_time",
  revision: 1,
  createdAt: "2026-08-02T12:00:00.000Z",
  updatedAt: "2026-08-02T12:00:00.000Z",
  hasPrecheck: false,
  prompt: "Review the current work",
  schedule: {
    kind: "date_time",
    runAt: "2026-08-15T12:00:00.000Z",
  },
  misfirePolicy: "coalesce",
  precheck: null,
};
const state: ApplicationClientState = {
  status: "ready",
  connection: "connected",
  authoritative: true,
  providerPulseEnabled: false, experimentalUsageEnabled: false,
  search: "",
  visibleThreads: [],
  descendantPages: {},
  pendingThreadConfigurationCopySourceIds: [],
};

afterEach(() => cleanup());

function renderDialog(
  api: Record<string, unknown>,
  onClose = vi.fn(),
  automation: ThreadAutomationDefinition | null = null,
  strictMode = false,
) {
  const store = {
    subscribe: () => () => undefined,
    getSnapshot: () => state,
    getThreadSummaries: () => [],
    api: {
      previewThreadAutomationSchedule: vi.fn().mockResolvedValue({
        occurrences: ["2026-08-15T12:00:00.000Z"],
      }),
      listThreadAutomationRuns: vi.fn().mockResolvedValue({ items: [] }),
      ...api,
    },
  } as unknown as ApplicationClientStore;
  const renderFor = (summary: ThreadAutomationDefinition | null) => (
    <ThreadAutomationDialog
      store={store}
      threadId={threadId}
      threadTitle="Current work"
      automationSummary={summary}
      snoozed={false}
      canCloneOnRun
      onClose={onClose}
    />
  );
  const wrap = (summary: ThreadAutomationDefinition | null) =>
    strictMode ? (
      <StrictMode>{renderFor(summary)}</StrictMode>
    ) : (
      renderFor(summary)
    );
  const view = render(wrap(automation));
  return {
    store,
    onClose,
    rerenderAutomation: (summary: ThreadAutomationDefinition | null) =>
      view.rerender(wrap(summary)),
  };
}

describe("ThreadAutomationDialog", () => {
  it("shows the authoritative paused state after creating an automation", async () => {
    const createThreadAutomation = vi.fn().mockResolvedValue(paused);
    renderDialog({ createThreadAutomation });

    await userEvent.type(
      await screen.findByRole("textbox", { name: "Canned prompt" }),
      paused.prompt,
    );
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    await waitFor(() => expect(createThreadAutomation).toHaveBeenCalledOnce());
    expect(screen.getByText("paused")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).toBeNull();
  });

  it("loads an existing automation from the open thread when application summaries omit it", async () => {
    const createThreadAutomation = vi.fn();
    renderDialog(
      {
        getThreadAutomation: vi.fn().mockResolvedValue(paused),
        createThreadAutomation,
      },
      vi.fn(),
      paused,
    );

    expect(await screen.findByText("paused")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Canned prompt" })).toHaveValue(
      paused.prompt,
    );
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(createThreadAutomation).not.toHaveBeenCalled();
  });

  it("loads an existing automation through StrictMode effect replay", async () => {
    const getThreadAutomation = vi.fn().mockResolvedValue(paused);
    renderDialog({ getThreadAutomation }, vi.fn(), paused, true);

    expect(await screen.findByText("paused")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Canned prompt" })).toHaveValue(
      paused.prompt,
    );
    expect(getThreadAutomation).toHaveBeenCalledTimes(2);
  });

  it("shows an adopted definition when its history load is superseded", async () => {
    const updated = {
      ...paused,
      revision: 2,
      updatedAt: "2026-08-02T13:00:00.000Z",
    };
    let releaseRuns!: (value: { items: [] }) => void;
    const runs = new Promise<{ items: [] }>((resolve) => {
      releaseRuns = resolve;
    });
    const listThreadAutomationRuns = vi.fn().mockReturnValue(runs);
    const { rerenderAutomation } = renderDialog(
      {
        getThreadAutomation: vi.fn().mockResolvedValue(paused),
        listThreadAutomationRuns,
      },
      vi.fn(),
      paused,
    );

    await waitFor(() =>
      expect(listThreadAutomationRuns).toHaveBeenCalledOnce(),
    );
    rerenderAutomation(updated);

    expect(
      await screen.findByRole("textbox", { name: "Canned prompt" }),
    ).toHaveValue(paused.prompt);
    expect(
      screen.getByText(/This automation changed elsewhere/),
    ).toBeInTheDocument();
    releaseRuns({ items: [] });
  });

  it("preserves unsaved edits when a newer automation revision is published", async () => {
    const updated = {
      ...paused,
      revision: 2,
      updatedAt: "2026-08-02T13:00:00.000Z",
      prompt: "Remote prompt",
    };
    const getThreadAutomation = vi
      .fn()
      .mockResolvedValueOnce(paused)
      .mockResolvedValueOnce(updated);
    const { rerenderAutomation } = renderDialog(
      { getThreadAutomation },
      vi.fn(),
      paused,
    );

    const prompt = await screen.findByRole("textbox", {
      name: "Canned prompt",
    });
    await userEvent.clear(prompt);
    await userEvent.type(prompt, "Local unsaved prompt");
    rerenderAutomation(updated);

    expect(prompt).toHaveValue("Local unsaved prompt");
    expect(
      screen.getByText(/This automation changed elsewhere/),
    ).toBeInTheDocument();
    expect(getThreadAutomation).toHaveBeenCalledOnce();

    await userEvent.click(
      screen.getByRole("button", { name: "Reload automation" }),
    );
    await waitFor(() => expect(prompt).toHaveValue("Remote prompt"));
    expect(getThreadAutomation).toHaveBeenCalledTimes(2);
  });

  it("closes when an attached automation is deleted elsewhere", async () => {
    const onClose = vi.fn();
    const { rerenderAutomation } = renderDialog(
      { getThreadAutomation: vi.fn().mockResolvedValue(paused) },
      onClose,
      paused,
    );

    expect(await screen.findByText("paused")).toBeInTheDocument();
    rerenderAutomation(null);

    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("recovers a create conflict by loading the existing automation", async () => {
    const getThreadAutomation = vi.fn().mockResolvedValue(paused);
    renderDialog({
      getThreadAutomation,
      createThreadAutomation: vi
        .fn()
        .mockRejectedValue(
          new ApiError(
            409,
            "conflict",
            "This thread already has an automation.",
            false,
          ),
        ),
    });

    await userEvent.type(
      await screen.findByRole("textbox", { name: "Canned prompt" }),
      paused.prompt,
    );
    const save = screen.getByRole("button", { name: "Save" });
    await waitFor(() => expect(save).toBeEnabled());
    await userEvent.click(save);

    expect(await screen.findByText("paused")).toBeInTheDocument();
    expect(getThreadAutomation).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the existing editor open when enabling is rejected", async () => {
    const onClose = vi.fn();
    renderDialog(
      {
        getThreadAutomation: vi.fn().mockResolvedValue(paused),
        setThreadAutomationState: vi
          .fn()
          .mockRejectedValue(
            new ApiError(
              409,
              "invalid_transition",
              "Choose an allowed model and reasoning effort.",
              false,
            ),
          ),
      },
      onClose,
      paused,
    );

    await userEvent.click(
      await screen.findByRole("button", { name: "Enable" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an allowed model and reasoning effort.",
    );
    expect(screen.getByRole("button", { name: "Enable" })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
