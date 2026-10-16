import "./automations-view.css";
import "./automation-page.css";
import { Trash2 } from "lucide-react";
import { MAXIMUM_AUTOMATION_NAME_LENGTH } from "../../../shared/protocol/automation.js";
import { useEffect, useRef, useState } from "react";
import {
  automationPath,
  automationsPath,
  automationCreatePath,
  navigate,
  navigateBack,
  threadPath,
} from "../../app/router.js";
import { useDirtyNavigationGuard } from "../../app/use-dirty-navigation-guard.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { DangerZone, DangerZoneItem } from "../settings/DangerZone.js";
import { SaveBar } from "../settings/SaveBar.js";
import { isPlainClick } from "../settings/SettingsNav.js";
import { SettingsBackLink } from "../settings/SettingsPage.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import {
  SettingsDetailHeader,
  SettingsEditor,
  type SettingsEditorSection,
} from "../settings/SettingsSplit.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import { DiscardChangesDialog } from "@client/components/ui/discard-changes-dialog";
import { Field } from "@client/components/ui/field";
import { Input } from "@client/components/ui/input";
import { Textarea } from "@client/components/ui/textarea";
import { AutomationPrecheckSection } from "./PrecheckSection.js";
import { AutomationRunModeSection } from "./RunModeSection.js";
import {
  AutomationMisfireSection,
  AutomationScheduleSection,
} from "./ScheduleSection.js";
import {
  BYTE_COUNTER_THRESHOLD,
  MAXIMUM_PROMPT_BYTES,
  isRecurring,
} from "./automation-form.js";
import { useAutomationCapability } from "./use-automation-details.js";
import { useAutomationResource } from "./use-automation-resource.js";
import type { AutomationResourceReads } from "./automation-resource-reads.js";
import { useAutomationEditor } from "./use-automation-editor.js";
import {
  useAutomationAnchor,
  type AutomationThread,
  type AutomationThreadSource,
} from "./use-automation-thread.js";
import {
  AutomationAnchorLoading,
  AutomationAnchorUnavailable,
} from "./AutomationAnchorStates.js";

type EditorStore = Pick<ApplicationClientStore, "api" | "subscribe" | "getSnapshot" | "subscribeAutomationChanges" | "subscribeThreadSummaryChanges">;

const SECTION = {
  prompt: "automation-prompt",
  when: "automation-when",
  runIn: "automation-run-in",
  precheck: "automation-precheck",
  misfire: "automation-misfire",
} as const;

/** Add to an explicit source, or edit an explicitly identified automation. */
export function AutomationEditor({ store, threadRegistry, threadId, automationId }: {
  store: EditorStore;
  threadRegistry: AutomationThreadSource;
  threadId?: string;
  automationId?: string;
}): React.JSX.Element {
  const resource = useAutomationResource(store, automationId);
  const sourceId = resource.definition?.threadId ?? threadId;
  if (resource.error && !resource.definition) return <AutomationAnchorUnavailable message={resource.error} onRetry={resource.reload} />;
  if (!sourceId) return <AutomationAnchorLoading />;
  return <EditorAnchor key={automationId ?? sourceId} store={store} threadRegistry={threadRegistry} threadId={sourceId} automation={resource.definition} refreshError={resource.error} missing={resource.missing} onRetry={resource.reload} reads={resource.reads} />;
}

function EditorAnchor({ store, threadRegistry, threadId, automation, refreshError, missing, onRetry, reads }: {
  store: EditorStore; threadRegistry: AutomationThreadSource; threadId: string;
  automation?: import("../../types.js").ThreadAutomationDefinition;
  refreshError?: string; missing: boolean; onRetry: () => void;
  reads: AutomationResourceReads;
}): React.JSX.Element {
  const anchor = useAutomationAnchor(store, threadRegistry, threadId);
  if (anchor.status === "loading") return <AutomationAnchorLoading />;
  if (anchor.status === "unavailable") return <AutomationAnchorUnavailable message={anchor.message} onRetry={anchor.retry} />;
  return <section className="automations-view" aria-label="Automation editor"><div className="automations-page automation-page">
    {refreshError && <Callout tone="warning" title={missing ? "This automation was deleted" : "The automation could not be refreshed"}
      action={<Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}>{refreshError} Your edits are kept.</Callout>}
    <ThreadAutomationEditor store={store} missing={missing} reads={reads} thread={{ ...anchor.thread, automation: automation ?? null }} />
  </div></section>;
}

function ThreadAutomationEditor({
  store,
  thread, missing, reads,
}: {
  readonly store: EditorStore;
  readonly missing: boolean;
  readonly thread: AutomationThread;
  readonly reads: AutomationResourceReads;
}): React.JSX.Element {
  const capabilityState = useAutomationCapability(store, thread.id, thread);
  const capability = capabilityState.capability;
  const editor = useAutomationEditor(store, thread, {
    canCloneOnRun: capability?.canCloneOnRun ?? false,
    automationId: thread.automation?.id,
    missing,
    reads,
  });
  const saving = editor.pending === "save" || editor.pending === "save_and_enable";
  // Leaving is guarded while a save is unresolved too: its outcome is not
  // known yet, and the form's edits are the only copy until it is.
  const guard = useDirtyNavigationGuard(editor.dirty || saving);
  // A request that finishes after the editor has gone must not navigate:
  // the user has moved on (the editor is keyed by thread, so another
  // thread's editor is another mount).
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const now = new Date();
  const create = editor.mode === "create";
  const form = editor.form;
  const backTo = create ? automationsPath(thread.id) : automationPath(thread.automation!.id);
  const back = create ? (
    <SettingsBackLink
      href={backTo}
      label={thread.title}
      onNavigate={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        navigateBack(backTo);
      }}
    />
  ) : (
    <SettingsBackLink href={backTo} label={thread.title} />
  );

  if (
    editor.status === "loading" ||
    (capability === undefined && capabilityState.error === undefined)
  ) {
    return <AutomationAnchorLoading />;
  }
  if (editor.status === "error") {
    return (
      <>
        <SettingsDetailHeader back={back} headingLevel={1} title="Edit automation" />
        <Callout
          tone="danger"
          title="The automation could not be loaded"
          action={
            <Button type="button" variant="outline" size="sm" onClick={editor.reload}>
              Retry
            </Button>
          }
        >
          {editor.loadError}
        </Callout>
      </>
    );
  }

  const attachBlocked =
    create && capability !== undefined && !(capability.available && capability.canAttach);
  const blocked = editor.stale || editor.uncertain || editor.deletedElsewhere || attachBlocked;
  const submit = async (enable: boolean) => {
    const saved = await editor.save({ enable });
    // Up to the automation page: back when the editor was opened from it.
    if (mounted.current) {
      if (saved === null) guard.proceed(automationsPath(thread.id), { up: true });
      else if (saved) guard.proceed(automationPath(saved.id), { up: true });
    }
  };
  const sections: SettingsEditorSection[] = [
    { id: "automation-name", label: "Name" },
    { id: SECTION.prompt, label: "Prompt" },
    { id: SECTION.when, label: "When" },
    { id: SECTION.runIn, label: "Run in" },
    { id: SECTION.precheck, label: "Precheck" },
    ...(isRecurring(form.scheduleKind)
      ? [{ id: SECTION.misfire, label: "If Sedes was down" }]
      : []),
  ];
  const { validation } = editor;

  return (
    <>
      <SettingsEditor
        label={create ? "New automation" : "Automation editor"}
        back={back}
        headingLevel={1}
        title={create ? "New automation" : "Edit automation"}
        description={
          create
            ? "Sends this thread a prompt on a schedule."
            : "Changes apply from the next run. Run now and Pause act on the saved version."
        }
        sections={sections}
        errors={
          <>
            {editor.error ? (
              <Callout tone="danger" role="alert">
                {editor.error}
              </Callout>
            ) : null}
            {editor.notice ? (
              <Callout tone="info" role="status">
                {editor.notice}
              </Callout>
            ) : null}
            {editor.stale ? (
              <Callout
                tone="warning"
                role="status"
                action={
                  <Button type="button" variant="outline" size="sm" onClick={editor.reload}>
                    Reload automation
                  </Button>
                }
              >
                {editor.definition
                  ? "This automation changed elsewhere. Reload before making another change."
                  : "This automation changed elsewhere. Reload its saved settings."}
              </Callout>
            ) : null}
            {editor.uncertain ? (
              <Callout
                tone="warning"
                role="status"
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => navigate(automationPath(thread.automation!.id))}
                  >
                    Open automation
                  </Button>
                }
              >
                Sedes can't tell whether the last run reached the agent. Resolve that run before
                changing this automation.
              </Callout>
            ) : null}
            {editor.deletedElsewhere ? (
              <Callout tone="warning" role="status">
                This automation was deleted elsewhere. Add a new automation from the thread to schedule more work.
              </Callout>
            ) : null}
            {attachBlocked ? (
              <Callout tone="warning" role="status">
                {capability?.unavailableReason?.text ??
                  "This thread can't take an automation right now."}
              </Callout>
            ) : null}
            {capabilityState.error !== undefined ? (
              <Callout
                tone="warning"
                role="status"
                action={
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={capabilityState.retry}
                  >
                    Retry
                  </Button>
                }
              >
                Sedes couldn't check what this thread supports: {capabilityState.error}
              </Callout>
            ) : null}
          </>
        }
        onSubmit={() => void submit(create)}
        saveBar={
          <SaveBar
            creating={create}
            dirty={editor.dirty}
            saving={saving}
            saveLabel={create ? "Save and enable" : "Save"}
            saveDisabled={!validation.valid || blocked}
            onSave={() => void submit(create)}
            // Cancel puts an automation's edits back, or leaves a new one.
            onCancel={create ? () => navigateBack(automationsPath(thread.id)) : editor.reset}
            secondaryAction={
              create
                ? {
                    label: "Save as paused",
                    onSave: () => void submit(false),
                    saving: editor.pending === "save",
                  }
                : undefined
            }
          />
        }
      >
        {/* Locked while a request runs, so no edit is lost to its response. */}
        <fieldset
          className="automation-editor-fields"
          disabled={editor.pending !== undefined}
          aria-busy={editor.pending !== undefined || undefined}
        >
          <SettingsSection id="automation-name" title="Name" card>
            <Field label="Name" id="automation-name-input">
              <Input value={form.name} maxLength={MAXIMUM_AUTOMATION_NAME_LENGTH} required
                onChange={(event) => editor.update({ name: event.target.value })} placeholder="Daily update" />
            </Field>
          </SettingsSection>
          <SettingsSection
            id={SECTION.prompt}
            title="Prompt"
            description="Sent to the agent in this thread on every run, as if you typed it."
            card
          >
            <Field
              className="automation-prompt-field"
              label="Prompt"
              description={
                validation.promptBytes > MAXIMUM_PROMPT_BYTES * BYTE_COUNTER_THRESHOLD
                  ? `${validation.promptBytes.toLocaleString()} / ${MAXIMUM_PROMPT_BYTES.toLocaleString()} UTF-8 bytes`
                  : undefined
              }
              error={validation.promptError}
            >
              <Textarea
                className="automation-prompt-input"
                value={form.prompt}
                placeholder="What should the agent do on each run?"
                onChange={(event) => editor.update({ prompt: event.target.value })}
              />
            </Field>
          </SettingsSection>
          <AutomationScheduleSection
            id={SECTION.when}
            form={form}
            onChange={editor.update}
            schedule={editor.schedule}
            preview={editor.preview}
            now={now}
          />
          <AutomationRunModeSection
            id={SECTION.runIn}
            value={form.runMode}
            onChange={(runMode) => editor.update({ runMode })}
            canCloneOnRun={capability?.canCloneOnRun ?? false}
            savedRunMode={editor.definition?.runMode}
            forkDraftOnly={capability?.forkDraftOnly}
          />
          <AutomationPrecheckSection
            id={SECTION.precheck}
            form={form}
            onChange={editor.update}
            commandBytes={validation.commandBytes}
            commandError={validation.commandError}
            timeoutError={validation.timeoutError}
            test={editor.precheckTest}
          />
          {isRecurring(form.scheduleKind) ? (
            <AutomationMisfireSection
              id={SECTION.misfire}
              value={form.misfirePolicy}
              onChange={(misfirePolicy) => editor.update({ misfirePolicy })}
            />
          ) : null}
          {editor.definition ? (
            <DangerZone>
              <DangerZoneItem
                title="Delete automation"
                description="Stops its runs and removes the schedule. The thread and its messages stay."
                action={
                  <Button
                    ref={deleteTrigger}
                    type="button"
                    variant="destructive-outline"
                    disabled={editor.pending !== undefined || editor.uncertain}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 aria-hidden="true" /> Delete automation…
                  </Button>
                }
              />
            </DangerZone>
          ) : null}
        </fieldset>
      </SettingsEditor>

      <DiscardChangesDialog
        open={Boolean(guard.pendingRoute)}
        onOpenChange={(open) => {
          if (!open) guard.cancel();
        }}
        title="Discard automation changes?"
        description={
          saving
            ? "The save hasn't finished. If you leave now, the changes may or may not be saved."
            : create
              ? "This automation has not been saved."
              : "Your changes to this automation have not been saved."
        }
        discardLabel="Discard and leave"
        onDiscard={guard.discardAndContinue}
      />

      {editor.definition ? (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          tone="danger"
          title="Delete this automation?"
          description="Scheduled and manual runs stop and the schedule is removed. The thread, its messages and any result threads stay. Run history is no longer shown."
          confirmLabel="Delete automation"
          pendingLabel="Deleting…"
          returnFocusRef={deleteTrigger}
          onConfirm={async () => {
            await editor.remove();
            // Up to the list: back when the history came down from it.
            if (mounted.current) guard.proceed(automationsPath(), { up: true });
          }}
        />
      ) : null}
    </>
  );
}
