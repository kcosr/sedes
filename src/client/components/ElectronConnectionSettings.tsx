import { useState } from "react";
import type { ElectronConnectionProfile } from "../app/electron-connections.js";
import { Button } from "./ui/button.js";
import { Callout } from "./ui/callout.js";
import { Tag } from "./ui/tag.js";
import { SettingsActionRow } from "./settings/SettingsField.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { SettingsSection } from "./settings/SettingsSection.js";

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
    <SettingsPage
      title="Connection"
      description="The Sedes server this desktop app uses. Switch to another saved connection or manage connection profiles."
    >
      <SettingsSection title="Current connection" card>
        <SettingsActionRow
          title={
            <>
              {profile.name}
              {profile.kind === "local" && controls.authenticationRequired === false ? (
                <Tag>Authentication disabled</Tag>
              ) : null}
            </>
          }
          description={`${kind} · ${detail}`}
          actions={
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              aria-busy={pending || undefined}
              onClick={() => void switchConnection()}
            >
              {pending ? "Opening…" : "Switch connection"}
            </Button>
          }
        />
        {error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
      </SettingsSection>
    </SettingsPage>
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
