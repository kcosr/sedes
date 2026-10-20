import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { SEDES_VERSION } from "../../../../shared/version.js";
import {
  clearCopyDiagnostics,
  copyDiagnostics,
  readDiagnostics,
} from "../../../app/diagnostics.js";
import {
  getDiagnosticCategoryEnabled,
  setDiagnosticCategoryEnabled,
  subscribeDiagnosticCategoryEnabled,
} from "../../../app/settings.js";
import { hasNativeVoice } from "../../../voice/native-voice-plugin.js";
import type { ApplicationClientStore } from "../../../stores/ApplicationClientStore.js";
import { Button } from "@client/components/ui/button";
import { KeyValueList } from "@client/components/ui/key-value-list";
import { SettingsActionRow, SwitchField } from "../SettingsField.js";
import { SettingsPage } from "../SettingsPage.js";
import { SettingsSection } from "../SettingsSection.js";

type DiagnosticCategory = Parameters<typeof getDiagnosticCategoryEnabled>[0];

const CATEGORIES: ReadonlyArray<{
  readonly category: DiagnosticCategory;
  readonly id: string;
  readonly label: string;
  readonly description: string;
}> = [
  {
    category: "voice",
    id: "voice-diagnostics",
    label: "Voice diagnostics",
    description: "Trace voice sends, composer availability, task and attachment counts, draft saves, and playback without message content. Copy log includes browser events and up to 512 native entries, including after disconnect.",
  },
  {
    category: "composer_input",
    id: "composer-input-diagnostics",
    label: "Composer input diagnostics",
    description:
      "Record keyboard, dictation, focus, and send timing without message text. Enable it when investigating text reappearing after sending.",
  },
  {
    category: "streaming",
    id: "streaming-diagnostics",
    label: "Streaming diagnostics",
    description:
      "Record content-free SSE arrival gaps, the running-turn batch timer and apply duration, text commits, and delayed animation frames. Enable it only for one reproduction of uneven streaming.",
  },
  {
    category: "thread_load",
    id: "thread-load-diagnostics",
    label: "Thread loading diagnostics",
    description:
      "Time an accepted thread navigation through server runtime acquire, snapshot transfer and parsing, store validation, React commit, and a post-paint frame. The trace contains counts and timings, never conversation content or provider identifiers.",
  },
  {
    category: "seek",
    id: "seek-diagnostics",
    label: "Seek diagnostics",
    description:
      "Record the bounded geometry and lifecycle trace for seek-on-send. This category can stay off while thread loading is measured.",
  },
];

export function DiagnosticsSettingsPage({
  applicationStore,
}: {
  readonly applicationStore?: ApplicationClientStore;
}): React.JSX.Element {
  const [status, setStatus] = useState("");
  const count = readDiagnostics().length;
  const nativeVoice = hasNativeVoice();
  return (
    <SettingsPage
      title="Diagnostics"
      description="Record a bounded trace on this device, reproduce an issue, then copy it into a bug report."
    >
      <SettingsSection title="Recording" card>
        {CATEGORIES.filter((entry) => entry.category !== "voice" || nativeVoice).map((entry) => (
          <DiagnosticCategorySwitch
            key={entry.category}
            {...entry}
            onChange={() => setStatus("")}
          />
        ))}
      </SettingsSection>
      <SettingsSection title="Log" card>
        <SettingsActionRow
          title="Diagnostics buffer"
          description={nativeVoice
            ? "Clear the copy buffers, reproduce the issue, then copy them here. They retain up to 1,200 browser entries and 512 native voice entries."
            : "Clear the shared browser-local buffer, reproduce the issue, then copy it here. It retains at most 1,200 entries."}
          actions={
            <>
              <Button
                type="button"
                variant="outline"
                disabled={count === 0 && !nativeVoice}
                onClick={() => {
                  void clearCopyDiagnostics()
                    .then(() => setStatus("Copy buffer cleared."))
                    .catch(() => setStatus("Native buffer could not be cleared. Try again."));
                }}
              >
                Clear copy buffer
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={count === 0 && !nativeVoice}
                onClick={() => {
                  void copyDiagnostics()
                    .then(() => setStatus("Log copied."))
                    .catch(() => setStatus("Copy failed. Try copying the log again."));
                }}
              >
                {nativeVoice ? "Copy log" : `Copy log (${count})`}
              </Button>
            </>
          }
        >
          {status ? (
            <p data-slot="settings-action-row-description" role="status">
              {status}
            </p>
          ) : null}
        </SettingsActionRow>
      </SettingsSection>
      <VersionSection applicationStore={applicationStore} />
    </SettingsPage>
  );
}

function DiagnosticCategorySwitch({
  category,
  id,
  label,
  description,
  onChange,
}: (typeof CATEGORIES)[number] & { readonly onChange: () => void }): React.JSX.Element {
  const [enabled, setEnabled] = useState(() => getDiagnosticCategoryEnabled(category));
  useEffect(() => subscribeDiagnosticCategoryEnabled(category, setEnabled), [category]);
  return (
    <SwitchField
      id={`setting-${id}`}
      label={label}
      description={description}
      checked={enabled}
      switchProps={{ "data-testid": `${id}-toggle` }}
      onCheckedChange={(next) => {
        onChange();
        setEnabled(next);
        setDiagnosticCategoryEnabled(category, next);
      }}
    />
  );
}

/**
 * The build identity to quote in a bug report. The server version is shown only
 * when it differs from this client's, so a same-build install stays quiet.
 */
function VersionSection({
  applicationStore,
}: {
  readonly applicationStore?: ApplicationClientStore;
}): React.JSX.Element {
  const serverVersion = useSyncExternalStore(
    useCallback(
      (listener: () => void) => applicationStore?.subscribe(listener) ?? noop,
      [applicationStore],
    ),
    () => applicationStore?.getSnapshot().serverVersion,
  );
  const differs = Boolean(serverVersion) && serverVersion !== SEDES_VERSION;
  return (
    <SettingsSection title="Version" description="Quote this in a bug report." card>
      <KeyValueList
        data-testid="sedes-version"
        className="settings-version"
        items={[
          { label: "This client", value: `Sedes ${SEDES_VERSION}`, mono: true },
          ...(differs ? [{ label: "Server", value: `Sedes ${serverVersion}`, mono: true }] : []),
        ]}
      />
    </SettingsSection>
  );
}

function noop(): void {}
