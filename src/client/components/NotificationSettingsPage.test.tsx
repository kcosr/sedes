// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationSettings } from "../../shared/protocol/notification.js";
import type { ApiClient } from "../api/ApiClient.js";
import { NotificationSettingsStore } from "../stores/NotificationSettingsStore.js";
import { NotificationSettingsPage } from "./NotificationSettingsPage.js";
import { NotificationSilenceButton } from "./NotificationSilenceButton.js";

const initial: NotificationSettings = {
  enabled: false,
  silenced: true,
  scriptPath: "",
  arguments: [],
  timeoutSeconds: 30,
  assistantResultPhases: [],
  events: ["turn.completed"],
  revision: 0,
};
function fixture() {
  let saved = { ...initial };
  const api = {
    readNotificationSettings: vi.fn(async () => saved),
    updateNotificationSettings: vi.fn(
      async ({ expectedRevision: _, ...request }) => {
        saved = { ...saved, ...request, revision: saved.revision + 1 };
        return saved;
      },
    ),
    setNotificationSilenced: vi.fn(async (silenced: boolean) => {
      saved = { ...saved, silenced };
      return saved;
    }),
    testNotification: vi.fn(async () => ({
      success: true,
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: null,
    })),
  };
  const store = new NotificationSettingsStore(api as unknown as ApiClient);
  return {
    api,
    store,
    changeElsewhere: () => {
      saved = {
        ...saved,
        scriptPath: "/server/new",
        revision: saved.revision + 1,
      };
    },
  };
}
afterEach(cleanup);
describe("notification settings", () => {
  it("saves literal arguments and selected events, and tests unsaved values while silenced", async () => {
    const { api, store } = fixture();
    render(<NotificationSettingsPage store={store} />);
    const path = await screen.findByLabelText("Server script path");
    fireEvent.change(path, { target: { value: "/usr/local/bin/notify" } });
    fireEvent.change(screen.getByLabelText("Arguments (one per line)"), {
      target: { value: "--channel\nmy alerts\n$(literal)" },
    });
    fireEvent.click(screen.getByLabelText("Enable notifications"));
    fireEvent.click(screen.getByLabelText("Automation started"));
    fireEvent.click(screen.getByText("Send test notification"));
    await screen.findByText("Test notification script completed successfully.");
    expect(api.testNotification).toHaveBeenCalledWith({
      scriptPath: "/usr/local/bin/notify",
      arguments: ["--channel", "my alerts", "$(literal)"],
      timeoutSeconds: 30,
    });
    expect(api.updateNotificationSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Save notifications"));
    await screen.findByText("Notification settings saved.");
    expect(api.updateNotificationSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 0,
        enabled: true,
        events: ["turn.completed", "automation.started"],
      }),
    );
    expect(store.getSnapshot().settings?.silenced).toBe(true);
  });
  it("defaults response text off and preserves phase choices when completion events are deselected", async () => {
    const { api, store } = fixture();
    render(<NotificationSettingsPage store={store} />);
    await screen.findByRole("group", { name: "Response text" });
    expect(screen.queryByLabelText("Include assistant response text")).toBeNull();
    const phases = ["Provisional", "Unclassified", "Final"].map(label =>
      screen.getByRole("checkbox", { name: label }) as HTMLButtonElement);
    expect(phases.every(phase => phase.getAttribute("aria-checked") === "false")).toBe(true);
    expect(phases.every(phase => !phase.disabled)).toBe(true);
    fireEvent.click(screen.getByText("Save notifications"));
    await screen.findByText("Notification settings saved.");
    expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ assistantResultPhases: [] }),
    );
    expect(api.updateNotificationSettings.mock.calls.at(-1)?.[0])
      .not.toHaveProperty("includeAssistantResult");
    for (const phase of phases) fireEvent.click(phase);
    fireEvent.click(screen.getByLabelText("Turn completed"));
    expect(phases.every(phase => phase.disabled)).toBe(true);
    expect(phases.every(phase => phase.getAttribute("aria-checked") === "true")).toBe(true);
    fireEvent.click(screen.getByText("Save notifications"));
    await screen.findByText("Notification settings saved.");
    expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ events: [],
        assistantResultPhases: ["provisional", "unclassified", "final"] }),
    );
    fireEvent.click(screen.getByLabelText("Turn completed"));
    expect(phases.every(phase => !phase.disabled)).toBe(true);
    fireEvent.click(phases[0]!);
    fireEvent.click(screen.getByText("Reload saved settings"));
    await waitFor(() => expect(phases.every(phase => phase.getAttribute("aria-checked") === "true")).toBe(true));
  });
  it("saves selected response phases and disables them while saving", async () => {
    const { api, store } = fixture();
    let finishSave!: (settings: NotificationSettings) => void;
    api.updateNotificationSettings.mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
    render(<NotificationSettingsPage store={store} />);
    await screen.findByRole("group", { name: "Response text" });
    const final = screen.getByRole("checkbox", { name: "Final" }) as HTMLButtonElement;
    const provisional = screen.getByRole("checkbox", { name: "Provisional" }) as HTMLButtonElement;
    fireEvent.click(provisional);
    fireEvent.click(screen.getByText("Save notifications"));
    expect(api.updateNotificationSettings).toHaveBeenCalledWith(expect.objectContaining({ assistantResultPhases: ["provisional"] }));
    expect(final.disabled).toBe(true);
    expect(provisional.disabled).toBe(true);
    finishSave({ ...initial, assistantResultPhases: ["provisional"], revision: 1 });
    await screen.findByText("Notification settings saved.");
    expect(provisional.disabled).toBe(false);
    expect(provisional.getAttribute("aria-checked")).toBe("true");
    expect(final.getAttribute("aria-checked")).toBe("false");
  });
  it("keeps interaction and nonblocking question events opt-in and saves their selections", async () => {
    const { api, store } = fixture();
    render(<NotificationSettingsPage store={store} />);
    await screen.findByLabelText("Server script path");
    const approval = screen.getByLabelText("Approval requested");
    const input = screen.getByLabelText("Input requested");
    const questions = screen.getByLabelText("Nonblocking questions");
    expect(approval.getAttribute("aria-checked")).toBe("false");
    expect(input.getAttribute("aria-checked")).toBe("false");
    expect(questions.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByText("Save notifications"));
    await screen.findByText("Notification settings saved.");
    expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ events: ["turn.completed"] }),
    );
    fireEvent.click(approval);
    fireEvent.click(input);
    fireEvent.click(questions);
    fireEvent.click(screen.getByText("Save notifications"));
    await waitFor(() =>
      expect(api.updateNotificationSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          events: [
            "turn.completed",
            "approval.requested",
            "input.requested",
            "question.requested",
          ],
        }),
      ),
    );
  });
  it("preserves a dirty draft on remote changes and requires explicit reload", async () => {
    const { store, api, changeElsewhere } = fixture();
    render(<NotificationSettingsPage store={store} />);
    fireEvent.change(await screen.findByLabelText("Server script path"), {
      target: { value: "/my/draft" },
    });
    changeElsewhere();
    await store.refresh();
    await screen.findByText(
      "Saved settings changed. Reload them before saving to avoid overwriting another change.",
    );
    expect(
      (screen.getByLabelText("Server script path") as HTMLInputElement).value,
    ).toBe("/my/draft");
    expect(
      (screen.getByText("Save notifications") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(api.updateNotificationSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("Reload saved settings"));
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Server script path") as HTMLInputElement).value,
      ).toBe("/server/new"),
    );
  });
  it("shares the persisted silence state between the bell and settings", async () => {
    const { api, store } = fixture();
    render(
      <>
        <NotificationSilenceButton store={store} />
        <NotificationSettingsPage store={store} />
      </>,
    );
    await screen.findByLabelText("Server script path");
    fireEvent.click(
      screen.getByRole("button", { name: "Resume external notifications" }),
    );
    await waitFor(() =>
      expect(api.setNotificationSilenced).toHaveBeenCalledWith(false),
    );
    await screen.findByRole("button", {
      name: "Silence external notifications",
    });
    expect(screen.queryByText(/Notifications silenced\./)).toBeNull();
  });
});
