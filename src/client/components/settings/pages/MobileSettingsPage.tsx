import { useEffect, useState } from "react";
import {
  getMobileComposerRefocusAfterSend,
  getMobileHistorySeekControl,
  setMobileComposerRefocusAfterSend,
  setMobileHistorySeekControl,
  subscribeMobileComposerRefocusAfterSend,
  subscribeMobileHistorySeekControl,
} from "../../../app/settings.js";
import { SwitchField } from "../SettingsField.js";
import { SettingsPage } from "../SettingsPage.js";
import { SettingsSection } from "../SettingsSection.js";

export function MobileSettingsPage(): React.JSX.Element {
  const [refocusAfterSend, setRefocusAfterSendState] = useState(
    getMobileComposerRefocusAfterSend,
  );
  useEffect(
    () => subscribeMobileComposerRefocusAfterSend(setRefocusAfterSendState),
    [],
  );
  const [historySeekControl, setHistorySeekControlState] = useState(
    getMobileHistorySeekControl,
  );
  useEffect(
    () => subscribeMobileHistorySeekControl(setHistorySeekControlState),
    [],
  );
  return (
    <SettingsPage
      title="Mobile"
      description="Behavior on phone-sized layouts of this browser."
    >
      <SettingsSection card>
        <SwitchField
          id="setting-mobile-composer-refocus-after-send"
          label="Refocus composer after sending"
          description="After Send, Queue, or Steer on a mobile layout, return focus to the message field so the on-screen keyboard remains available."
          checked={refocusAfterSend}
          onCheckedChange={(next) => {
            setRefocusAfterSendState(next);
            setMobileComposerRefocusAfterSend(next);
          }}
          switchProps={{ "data-testid": "mobile-composer-refocus-after-send-toggle" }}
        />
        <SwitchField
          id="setting-mobile-history-seek-control"
          label="Show history seek control"
          description="Show the draggable history control beside the conversation on mobile layouts."
          checked={historySeekControl}
          onCheckedChange={(next) => {
            setHistorySeekControlState(next);
            setMobileHistorySeekControl(next);
          }}
          switchProps={{ "data-testid": "mobile-history-seek-control-toggle" }}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
