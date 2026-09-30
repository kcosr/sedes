import { useEffect, useState } from "react";
import {
  getConfirmTerminalTermination,
  getTerminalPreferences,
  setConfirmTerminalTermination,
  setTerminalPreferences,
  subscribeConfirmTerminalTermination,
  subscribeTerminalPreferences,
  TERMINAL_MAXIMUM_FONT_SIZE,
  TERMINAL_MINIMUM_FONT_SIZE,
} from "../../../app/settings.js";
import { NativeSelect } from "@client/components/ui/native-select";
import { SettingsField, SwitchField } from "../SettingsField.js";
import { SettingsPage } from "../SettingsPage.js";
import { SettingsSection } from "../SettingsSection.js";

const SCROLLBACK_OPTIONS = [1_000, 2_000, 4_000, 8_000, 12_000, 16_000, 20_000];

export function TerminalSettingsPage(): React.JSX.Element {
  const [confirmTermination, setConfirmTerminationState] = useState(
    getConfirmTerminalTermination,
  );
  useEffect(
    () => subscribeConfirmTerminalTermination(setConfirmTerminationState),
    [],
  );
  const [preferences, setPreferencesState] = useState(getTerminalPreferences);
  useEffect(() => subscribeTerminalPreferences(setPreferencesState), []);
  const fontSizes = Array.from(
    { length: TERMINAL_MAXIMUM_FONT_SIZE - TERMINAL_MINIMUM_FONT_SIZE + 1 },
    (_, index) => TERMINAL_MINIMUM_FONT_SIZE + index,
  );
  return (
    <SettingsPage
      title="Terminal"
      description="The Codex TUI and managed terminals in this browser."
    >
      <SettingsSection title="Display" card>
        <SwitchField
          id="setting-terminal-cursor-blink"
          label="Cursor blink"
          description="Blink the cursor in the Codex TUI and regular terminals. Off by default on Windows to reduce idle rendering."
          checked={preferences.cursorBlink}
          onCheckedChange={(cursorBlink) =>
            setTerminalPreferences({ ...preferences, cursorBlink })
          }
          switchProps={{ "data-testid": "terminal-cursor-blink-toggle" }}
        />
        <SettingsField
          id="setting-terminal-font-size"
          label="Font size"
          description="Text size for the TUI and managed terminals."
        >
          <NativeSelect
            data-testid="terminal-font-size-setting"
            value={preferences.fontSize}
            onChange={(event) =>
              setTerminalPreferences({
                ...preferences,
                fontSize: Number(event.target.value),
              })
            }
          >
            {fontSizes.map((fontSize) => (
              <option value={fontSize} key={fontSize}>
                {fontSize} px
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
        <SettingsField
          id="setting-terminal-scrollback"
          label="Scrollback"
          description="Maximum terminal lines retained in this browser’s memory."
        >
          <NativeSelect
            data-testid="terminal-scrollback-setting"
            value={preferences.scrollback}
            onChange={(event) =>
              setTerminalPreferences({
                ...preferences,
                scrollback: Number(event.target.value),
              })
            }
          >
            {SCROLLBACK_OPTIONS.map((lines) => (
              <option value={lines} key={lines}>
                {lines.toLocaleString()} lines
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
      </SettingsSection>
      <SettingsSection title="Ending terminals" card>
        <SwitchField
          id="setting-confirm-terminal-termination"
          label="Confirm before ending active terminals"
          description="Ask whether to close the tab or end an active terminal. When off, the tab’s X ends local terminals or disconnects remote terminals and removes their history immediately. Remote processes may continue running. Ended terminals are always removed without confirmation."
          checked={confirmTermination}
          onCheckedChange={setConfirmTerminalTermination}
          switchProps={{ "data-testid": "confirm-terminal-termination-toggle" }}
        />
      </SettingsSection>
    </SettingsPage>
  );
}
