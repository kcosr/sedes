import "./automations-view.css";
import "./automation-page.css";
import { Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import {
  automationPath,
  automationsPath,
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
import { EmptyState } from "@client/components/ui/empty-state";
import { Field } from "@client/components/ui/field";
import { Skeleton } from "@client/components/ui/skeleton";
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
import { useAutomationEditor } from "./use-automation-editor.js";
import { useAutomationThread, type AutomationThread } from "./use-automation-thread.js";

type EditorStore = Pick<ApplicationClientStore, "api" | "subscribe" | "getSnapshot">;

const SECTION = {
  prompt: "automation-prompt",
  when: "automation-when",
  runIn: "automation-run-in",
  precheck: "automation-precheck",
  misfire: "automation-misfire",
} as const;

/** Create or edit a thread's automation (`/automations/:threadId/edit`). */
export function AutomationEditor({
  store,
  threadId,
}: {
  store: EditorStore;
  threadId: string;
}): React.JSX.Element {
  const thread = useAutomationThread(store, threadId);
  let content: React.ReactNode;
  if (thread === undefined) {
    content = <EditorLoading />;
  } else if (thread === null) {
    content = (
      <>
        <SettingsDetailHeader headingLevel={1} title="Automation" />
        <EmptyState
          title="Thread not found"
          description="This thread doesn't exist, or it isn't available here."
          action={
            <Button type="button" variant="outline" onClick={() => navigate(automationsPath())}>
              All automations
            </Button>
          }
        />
      </>
    );
  } else {
    // Keyed by thread: another thread's editor starts from its own form,
    // definition and requests, never from this one's.
    content = <ThreadAutomationEditor key={thread.id} store={store} thread={thread} />;
  }
  return (
    <section className="automations-view" aria-label="Automation editor">
      <div className="automations-page automation-page">{content}</div>
    </section>
  );
}

function EditorLoading(): React.JSX.Element {
  return (
    <div className="automation-page-loading" role="status" aria-label="Loading automation">
      <Skeleton className="automation-page-skeleton-title" />
      <Skeleton className="automation-page-skeleton-card" />
    </div>
  );
}

function ThreadAutomationEditor({
  store,
  thread,
}: {
  readonly store: EditorStore;
  readonly thread: AutomationThread;
}): React.JSX.Element {
  const capabilityState = useAutomationCapability(store, thread.id, thread);
  const capability = capabilityState.capability;
  const editor = useAutomationEditor(store, thread.id, {
    canCloneOnRun: capability?.canCloneOnRun ?? false,
  });
  const guard = useDirtyNavigationGuard(editor.dirty && editor.pending === undefined);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const now = new Date();
  const create = editor.mode === "create";
  const form = editor.form;
  const backTo = create ? threadPath(thread.id) : automationPath(thread.id);
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
    return <EditorLoading />;
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
  const blocked = editor.stale || editor.uncertain || attachBlocked;
  const saving = editor.pending === "save" || editor.pending === "save_and_enable";
  const submit = async (enable: boolean) => {
    // Up to the automation page: back when the editor was opened from it.
    if (await editor.save({ enable })) guard.proceed(automationPath(thread.id), { up: true });
  };
  const sections: SettingsEditorSection[] = [
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
                  : "This thread got an automation elsewhere. Reload to edit that one instead."}
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
                    onClick={() => navigate(automationPath(thread.id))}
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
                This automation was deleted elsewhere. Saving creates a new one.
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
            onCancel={create ? () => navigateBack(threadPath(thread.id)) : editor.reset}
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
      </SettingsEditor>

      <DiscardChangesDialog
        open={Boolean(guard.pendingRoute)}
        onOpenChange={(open) => {
          if (!open) guard.cancel();
        }}
        title="Discard automation changes?"
        description={
          create
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
            guard.proceed(automationsPath(), { up: true });
          }}
        />
      ) : null}
    </>
  );
}
