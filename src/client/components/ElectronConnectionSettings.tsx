import { useState } from "react";
import type { ElectronConnectionProfile } from "../app/electron-connections.js";
import { Button } from "./ui/button.js";

export interface ElectronConnectionSettingsControls {
  readonly activeProfile: ElectronConnectionProfile;
  readonly authenticationRequired?: boolean;
  readonly switchConnection: () => Promise<void>;
}

export function ElectronConnectionSettings({
  controls,
  onSwitched,
}: {
  controls: ElectronConnectionSettingsControls;
  onSwitched?: () => void;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const switchConnection = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await controls.switchConnection();
      onSwitched?.();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open the connection chooser.",
      );
      setPending(false);
    }
  };

  const profile = controls.activeProfile;
  const detail =
    profile.kind === "local"
      ? "Managed by the desktop app"
      : profile.kind === "direct"
      ? profile.baseUrl
      : `${profile.sshHost} · remote port ${profile.remotePort}`;
  const kind =
    profile.kind === "local"
      ? "Local"
      : profile.kind === "direct"
        ? "Direct"
        : "SSH";

  return (
    <>
      <h3 className="settings-page-title">Connection</h3>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">{profile.name}</span>
          <p className="settings-row-description">
            {kind} · {detail}
          </p>
          {profile.kind === "local" && controls.authenticationRequired === false ? <p className="settings-row-description">Authentication disabled</p> : null}
          <p className="settings-row-description">
            Switch to another saved connection or manage connection
            profiles.
          </p>
          {error ? (
            <p className="settings-row-description" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={() => void switchConnection()}
        >
          {pending ? "Opening…" : "Switch connection"}
        </Button>
      </div>
    </>
  );
}

export function ElectronConnectionRecovery({
  controls,
}: {
  controls: ElectronConnectionSettingsControls;
}): React.JSX.Element {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  const chooseAnother = async () => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      await controls.switchConnection();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not open the connection chooser.",
      );
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        disabled={pending}
        aria-busy={pending || undefined}
        onClick={() => void chooseAnother()}
      >
        {pending ? "Opening…" : "Choose another connection"}
      </Button>
      {error ? (
        <p className="supporting" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
