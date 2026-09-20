import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/ApiClient.js";
import type { NotificationSettings } from "../../shared/protocol/notification.js";
import { NotificationSettingsStore } from "./NotificationSettingsStore.js";
const settings: NotificationSettings = {
  enabled: true,
  silenced: false,
  revision: 1,
  scriptPath: "/notify",
  arguments: [],
  timeoutSeconds: 30,
  assistantResultPhases: [],
  events: ["turn.completed"],
};
describe("NotificationSettingsStore", () => {
  it("ignores a stale settings read finishing after silence has been saved", async () => {
    let resolve!: (settings: NotificationSettings) => void;
    const api = {
      readNotificationSettings: vi.fn(
        () =>
          new Promise<NotificationSettings>((done) => {
            resolve = done;
          }),
      ),
      setNotificationSilenced: vi.fn(async () => ({
        ...settings,
        revision: 1,
        silenced: true,
      })),
    };
    const store = new NotificationSettingsStore(api as unknown as ApiClient);
    const read = store.refresh();
    await store.silence(true);
    resolve(settings);
    await read;
    expect(store.getSnapshot().settings).toMatchObject({
      revision: 1,
      silenced: true,
    });
  });
  it("coalesces concurrent reads and aborts the read on disposal", async () => {
    const api = {
      readNotificationSettings: vi.fn(
        (_: AbortSignal) => new Promise<NotificationSettings>(() => {}),
      ),
    };
    const store = new NotificationSettingsStore(api as unknown as ApiClient);
    void store.refresh();
    void store.refresh();
    expect(api.readNotificationSettings).toHaveBeenCalledTimes(1);
    const signal = api.readNotificationSettings.mock.calls[0]![0];
    store.dispose();
    expect(signal.aborted).toBe(true);
  });
});
