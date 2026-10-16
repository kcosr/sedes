import "./automations-view.css";
import "./automation-page.css";
import { Trash2 } from "lucide-react";
import { MAXIMUM_AUTOMATION_NAME_LENGTH } from "../../../shared/protocol/automation.js";
import { useEffect, useRef, useState } from "react";
import {
  automationPath,
  automationsPath,
  navigate,
  navigateBack,
} from "../../app/router.js";
import { useDirtyNavigationGuard } from "../../app/use-dirty-navigation-guard.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { DangerZone, DangerZoneItem } from "../settings/DangerZone.js";
import { SaveBar } from "../settings/SaveBar.js";
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
  loadedThreadTitle,
  useAutomationAnchor,
  type AutomationThread,
  type AutomationThreadSource,
} from "./use-automation-thread.js";
import {
  AutomationAnchorLoading,
  AutomationAnchorUnavailable,
  AutomationBackLink,
  AutomationFrame,
  AutomationUnavailable,
} from "./AutomationAnchorStates.js";
import {
  automationEditorUp,
  automationPageUp,
  leaveDeletedAutomation,
} from "./automation-navigation.js";
import { usePublishAutomationThread } from "./automation-route-thread.js";

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
  const definition = resource.definition;
  const sourceId = definition?.threadId ?? threadId;
  usePublishAutomationThread(automationId, definition?.threadId);
  // Up to the automation's page, or a new one's list; out to the Automations
  // list when the automation is unknown or gone.
  const up = sourceId === undefined || resource.missing
    ? automationPageUp(automationId!, definition && {
      id: definition.threadId, title: definition.source.title || "Untitled thread",
    }, (id) => loadedThreadTitle(store.getSnapshot(), id))
    : automationEditorUp(sourceId, definition);
  const back = <AutomationBackLink up={up} />;
  // The editor region inside names itself; the frame does not repeat it.
  return <AutomationFrame up={up}>
    {resource.error && !definition ? <AutomationUnavailable back={back} up={up} message={resource.error} missing={resource.missing} onRetry={resource.reload} />
      : sourceId ? <EditorAnchor key={automationId ?? sourceId} store={store} threadRegistry={threadRegistry} threadId={sourceId}
        automation={definition} refreshError={resource.error} missing={resource.missing} onRetry={resource.reload}
        reads={resource.reads} back={back} />
      : <AutomationAnchorLoading back={back} />}
  </AutomationFrame>;
}

function EditorAnchor({ store, threadRegistry, threadId, automation, refreshError, missing, onRetry, reads, back }: {
  store: EditorStore; threadRegistry: AutomationThreadSource; threadId: string;
  automation?: import("../../types.js").ThreadAutomationDefinition;
  refreshError?: string; missing: boolean; onRetry: () => void;
  reads: AutomationResourceReads; back: React.ReactNode;
}): React.JSX.Element {
  const anchor = useAutomationAnchor(store, threadRegistry, threadId);
  if (anchor.status === "loading") return <AutomationAnchorLoading back={back} />;
  if (anchor.status === "unavailable") return <AutomationAnchorUnavailable back={back} message={anchor.message} onRetry={anchor.retry} />;
  return <>
    {refreshError && <Callout tone="warning" title={missing ? "This automation was removed" : "The automation could not be refreshed"}
      action={<Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}>{refreshError} Your edits are kept.</Callout>}
    <ThreadAutomationEditor store={store} missing={missing} reads={reads} thread={{ ...anchor.thread, automation: automation ?? null }} back={back} />
  </>;
}

function ThreadAutomationEditor({
  store,
  thread, missing, reads, back,
}: {
  readonly store: EditorStore;
  readonly missing: boolean;
  readonly thread: AutomationThread;
  readonly reads: AutomationResourceReads;
  readonly back: React.ReactNode;
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
  const [deleted, setDeleted] = useState(false);
  // Leaving is guarded while a save is unresolved too: its outcome is not
  // known yet, and the form's edits are the only copy until it is. A
  // deleted automation's edits have nowhere to go.
  const guard = useDirtyNavigationGuard(!deleted && (editor.dirty || saving));
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
  const automationId = thread.automation?.id;
  useEffect(() => {
    // After the guard has let go: back to the list the automation was
    // opened from, past its page.
    if (deleted && automationId) leaveDeletedAutomation(automationId, thread.id);
  }, [automationId, deleted, thread.id]);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const now = new Date();
  const create = editor.mode === "create";
  const form = editor.form;

  if (
    editor.status === "loading" ||
    (capability === undefined && capabilityState.error === undefined)
  ) {
    return <AutomationAnchorLoading back={back} />;
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
          create ? (
            <>
              Sends <strong>{thread.title}</strong> a prompt on a schedule.
            </>
          ) : (
            "Changes apply from the next run. Run now and Pause act on the saved version."
          )
        }
        sections={sections}
        sectionEdgeFade
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
                This automation was removed elsewhere. To schedule more work, add a new automation from
                the thread's Automations.
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
            <Field className="automation-name-field" label="Name" id="automation-name-input">
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
            setDeleted(true);
          }}
        />
      ) : null}
    </>
  );
}
