import { useSyncExternalStore } from "react";
import type {
  NotificationSettings,
  UpdateNotificationSettingsRequest,
  TestNotificationRequest,
} from "../../shared/protocol/notification.js";
import type { ApiClient } from "../api/ApiClient.js";

interface State {
  readonly settings?: NotificationSettings;
  readonly error?: string;
  readonly pending: boolean;
}

/** Principal-owned settings, shared by the settings form and persistent bell. */
export class NotificationSettingsStore {
  #state: State = { pending: false };
  #listeners = new Set<() => void>();
  #controller?: AbortController;
  #loading?: Promise<void>;
  #disposed = false;
  #mutationEpoch = 0;
  constructor(readonly api: ApiClient) {}
  getSnapshot = (): State => this.#state;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };
  #publish(state: State): void {
    if (this.#disposed) return;
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
  #accept(settings: NotificationSettings): void {
    if (
      !this.#state.settings ||
      settings.revision >= this.#state.settings.revision
    ) {
      this.#publish({ ...this.#state, settings, error: undefined });
    }
  }
  refresh(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (this.#loading) return this.#loading;
    this.#controller = new AbortController();
    const mutationEpoch = this.#mutationEpoch;
    this.#loading = this.api
      .readNotificationSettings(this.#controller.signal)
      .then((settings) => {
        if (mutationEpoch === this.#mutationEpoch) this.#accept(settings);
      })
      .catch((cause: unknown) => {
        if (!this.#controller?.signal.aborted)
          this.#publish({ ...this.#state, error: message(cause) });
      })
      .finally(() => {
        this.#loading = undefined;
      });
    return this.#loading;
  }
  async #mutate(
    operation: () => Promise<NotificationSettings>,
  ): Promise<NotificationSettings> {
    if (this.#state.pending)
      throw new Error("A notification setting is already being saved.");
    this.#mutationEpoch++;
    this.#publish({ ...this.#state, pending: true, error: undefined });
    try {
      const settings = await operation();
      this.#mutationEpoch++;
      this.#accept(settings);
      return settings;
    } catch (cause) {
      // Finish a pre-mutation read before requesting the latest conflict state.
      if (this.#loading) await this.#loading;
      await this.refresh();
      this.#publish({ ...this.#state, error: message(cause) });
      throw cause;
    } finally {
      this.#publish({ ...this.#state, pending: false });
    }
  }
  save(
    request: UpdateNotificationSettingsRequest,
  ): Promise<NotificationSettings> {
    return this.#mutate(() => this.api.updateNotificationSettings(request));
  }
  silence(silenced: boolean): Promise<NotificationSettings> {
    return this.#mutate(() => this.api.setNotificationSilenced(silenced));
  }
  test(request: TestNotificationRequest) {
    return this.api.testNotification(request);
  }
  dispose(): void {
    this.#disposed = true;
    this.#controller?.abort();
    this.#listeners.clear();
  }
}
export function useNotificationSettings(store: NotificationSettingsStore) {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}
function message(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "Could not update notification settings.";
}
