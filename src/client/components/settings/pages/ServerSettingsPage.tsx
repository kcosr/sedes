import {
  ServerSettingsForm,
  type ServerSettingsControls,
} from "../../ServerSettingsForm.js";
import { SettingsPage } from "../SettingsPage.js";

/** The packaged Android client's saved Sedes servers. */
export function ServerSettingsPage({
  controls,
}: {
  readonly controls: ServerSettingsControls;
}): React.JSX.Element {
  return (
    <SettingsPage
      title="Server"
      description="Sedes servers this device can connect to. Each connection keeps its own credential securely on this device."
    >
      <ServerSettingsForm controls={controls} sections />
    </SettingsPage>
  );
}
