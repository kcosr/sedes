import { Bell, BellOff } from "lucide-react";
import { Button } from "@client/components/ui/button";
import {
  type NotificationSettingsStore,
  useNotificationSettings,
} from "../stores/NotificationSettingsStore.js";

export function NotificationSilenceButton({
  store,
}: {
  readonly store: NotificationSettingsStore;
}): React.JSX.Element {
  const state = useNotificationSettings(store);
  const settings = state.settings;
  const active = Boolean(settings?.enabled && !settings.silenced);
  const label = settings?.silenced
    ? "Resume external notifications"
    : "Silence external notifications";
  return (
    <span className="notification-silence-control">
      <Button
        variant="ghost"
        size="icon"
        className="notification-silence-button"
        data-active={active}
        aria-label={label}
        title={
          state.error ??
          (settings?.silenced
            ? "Notifications silenced — click to resume"
            : settings?.enabled
              ? label
              : "Notifications disabled in Settings")
        }
        aria-pressed={settings?.silenced ?? false}
        disabled={!settings || state.pending}
        onClick={() => {
          if (settings)
            void store.silence(!settings.silenced).catch(() => undefined);
        }}
      >
        {active ? <Bell size={18} /> : <BellOff size={18} />}
      </Button>
      {state.error ? (
        <span role="alert" className="notification-control-error">
          {state.error}
        </span>
      ) : null}
    </span>
  );
}
