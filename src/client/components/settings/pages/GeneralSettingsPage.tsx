import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { ActivityDetailMode } from "../../../../shared/protocol/conversation.js";
import type {
  ApplicationPreferences,
  UpdateApplicationPreferencesRequest,
} from "../../../../shared/protocol/application-preferences.js";
import {
  getActivityDetail,
  getClickNamesToFilter,
  getHistoryPageSize,
  getRightOptionFocusesComposer,
  getSeekOnSubmit,
  HISTORY_PAGE_SIZE_OPTIONS,
  setActivityDetail,
  setClickNamesToFilter,
  setHistoryPageSize,
  setRightOptionFocusesComposer,
  setSeekOnSubmit,
  subscribeActivityDetail,
  subscribeClickNamesToFilter,
  subscribeHistoryPageSize,
  subscribeRightOptionFocusesComposer,
  subscribeSeekOnSubmit,
} from "../../../app/settings.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { NativeSelect } from "@client/components/ui/native-select";
import { SettingsField, SwitchField } from "../SettingsField.js";
import { SettingsPage } from "../SettingsPage.js";
import { SettingsSection } from "../SettingsSection.js";

export interface ApplicationPreferenceControls {
  read(): Promise<ApplicationPreferences>;
  update(
    request: UpdateApplicationPreferencesRequest,
  ): Promise<ApplicationPreferences>;
}

/** Device-local behavior, plus one account-wide composer preference. */
export function GeneralSettingsPage({
  applicationPreferences,
}: {
  readonly applicationPreferences?: ApplicationPreferenceControls;
}): React.JSX.Element {
  const clickNamesToFilter = useSyncExternalStore(
    subscribeClickNamesToFilter,
    getClickNamesToFilter,
  );
  const [activityDetail, setActivityDetailState] =
    useState<ActivityDetailMode>(getActivityDetail);
  const [historyPageSize, setHistoryPageSizeState] = useState(getHistoryPageSize);
  const [seekOnSubmit, setSeekOnSubmitState] = useState(getSeekOnSubmit);
  const [rightOptionFocusesComposer, setRightOptionFocusesComposerState] =
    useState(getRightOptionFocusesComposer);
  useEffect(() => subscribeSeekOnSubmit(setSeekOnSubmitState), []);
  useEffect(
    () => subscribeRightOptionFocusesComposer(setRightOptionFocusesComposerState),
    [],
  );
  useEffect(() => subscribeHistoryPageSize(setHistoryPageSizeState), []);
  useEffect(() => subscribeActivityDetail(setActivityDetailState), []);
  return (
    <SettingsPage
      title="General"
      description="How Sedes behaves in this browser. Changes apply as you make them."
    >
      <SettingsSection title="Workspace" card>
        <SwitchField
          id="setting-click-names-to-filter"
          label="Click project and environment names to filter"
          description="Make project and environment names on sidebar thread cards clickable. Click or tap a name to filter the thread list."
          checked={clickNamesToFilter}
          onCheckedChange={setClickNamesToFilter}
        />
      </SettingsSection>
      <SettingsSection title="Conversation" card>
        <SettingsField
          id="setting-activity-detail"
          label="Activity detail"
          description="Summaries show activity counts, status, elapsed time, and explicit provider reasoning summaries when available. The server omits detailed reasoning, tool inputs, and tool output before sending the conversation to this browser, reducing transfer size."
        >
          <NativeSelect
            data-testid="activity-detail-setting"
            value={activityDetail}
            onChange={(event) => {
              const next = event.target.value as ActivityDetailMode;
              setActivityDetailState(next);
              setActivityDetail(next);
            }}
          >
            <option value="full">Detailed activity</option>
            <option value="summary">Activity summaries</option>
          </NativeSelect>
        </SettingsField>
        <SettingsField
          id="setting-history-page-size"
          label="Earlier messages"
          description="Number of earlier conversation turns loaded at a time on this browser."
        >
          <NativeSelect
            data-testid="history-page-size-setting"
            value={historyPageSize}
            onChange={(event) =>
              setHistoryPageSize(
                Number(event.target.value) as 5 | 10 | 25 | 50 | 100,
              )
            }
          >
            {HISTORY_PAGE_SIZE_OPTIONS.map((turns) => (
              <option value={turns} key={turns}>
                {turns} turns
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
        <SwitchField
          id="setting-seek-on-submit"
          label="Seek on send"
          description="After you send a message, it stays pinned at the top while the reply streams. The reserved space remains until you scroll the last message to the composer or send again."
          checked={seekOnSubmit}
          onCheckedChange={(next) => {
            setSeekOnSubmitState(next);
            setSeekOnSubmit(next);
          }}
          switchProps={{ "data-testid": "seek-on-submit-toggle" }}
        />
      </SettingsSection>
      <SettingsSection title="Composer" card>
        {applicationPreferences ? (
          <OpenAIComposerSkillPreference controls={applicationPreferences} />
        ) : null}
        <SwitchField
          id="setting-right-option-focuses-composer"
          label="Right Option focuses composer"
          description="Press the physical right Option or Alt key to focus the chat composer before dictation. Off by default because right Alt types AltGr characters on some keyboard layouts."
          checked={rightOptionFocusesComposer}
          onCheckedChange={(next) => {
            setRightOptionFocusesComposerState(next);
            setRightOptionFocusesComposer(next);
          }}
          switchProps={{ "data-testid": "right-option-focuses-composer-toggle" }}
        />
      </SettingsSection>
    </SettingsPage>
  );
}

/** An account-wide preference, saved as it changes and restored on failure. */
function OpenAIComposerSkillPreference({
  controls,
}: {
  readonly controls: ApplicationPreferenceControls;
}): React.JSX.Element {
  const [preferences, setPreferences] = useState<ApplicationPreferences>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    setError("");
    try {
      setPreferences(await controls.read());
    } catch {
      setError("Could not load this account preference.");
    }
  }, [controls]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <SwitchField
        id="setting-show-openai-composer-skills"
        label="Show OpenAI skills in composer"
        description="Show OpenAI Templates, Sites, and Visualize skills across every Codex connection for this account."
        checked={preferences?.showOpenAIComposerSkills ?? false}
        disabled={!preferences || saving}
        switchProps={{ "data-testid": "show-openai-composer-skills-toggle" }}
        onCheckedChange={(showOpenAIComposerSkills) => {
          if (!preferences || saving) return;
          const previous = preferences;
          setPreferences({ ...previous, showOpenAIComposerSkills });
          setSaving(true);
          setError("");
          void controls
            .update({
              showOpenAIComposerSkills,
              expectedRevision: previous.revision,
            })
            .then(setPreferences)
            .catch(() => {
              setPreferences(previous);
              setError("Could not save this account preference.");
            })
            .finally(() => setSaving(false));
        }}
      />
      {error ? (
        <Callout
          tone="danger"
          role="alert"
          action={
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
              Retry
            </Button>
          }
        >
          {error}
        </Callout>
      ) : null}
    </>
  );
}
