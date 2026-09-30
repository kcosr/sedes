import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, MessageSquareText, Plus, RefreshCw, Trash2 } from "lucide-react";
import {
  CANNED_PROMPT_MAX_ITEMS,
  CANNED_PROMPT_TEXT_MAX_BYTES,
  CANNED_PROMPT_TITLE_MAX_BYTES,
  CANNED_PROMPT_TITLE_MAX_CHARACTERS,
  type CannedPrompt,
} from "../../shared/protocol/canned-prompts.js";
import { ApiError } from "../api/ApiClient.js";
import {
  getPromptsPlacement,
  getShowPromptsTab,
  setPromptsPlacement,
  setShowPromptsTab,
  subscribePromptsPlacement,
  subscribeShowPromptsTab,
  type PromptsPlacement,
} from "../app/settings.js";
import {
  type CannedPromptClientStore,
  useCannedPromptStore,
} from "../stores/CannedPromptClientStore.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import { DiscardChangesDialog } from "@client/components/ui/discard-changes-dialog";
import { EmptyState } from "@client/components/ui/empty-state";
import { Field } from "@client/components/ui/field";
import { Input } from "@client/components/ui/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import { Textarea } from "@client/components/ui/textarea";
import { EntityList, EntityRow } from "./settings/EntityList.js";
import { SaveBar } from "./settings/SaveBar.js";
import { SettingsField, SwitchField } from "./settings/SettingsField.js";
import { SettingsBackLink, SettingsPage } from "./settings/SettingsPage.js";
import { SettingsSection } from "./settings/SettingsSection.js";
import { useTransientNotice } from "./settings/use-transient-notice.js";
import { useSettingsEscapeLevel } from "./settings/settings-escape.js";

interface PromptDraft {
  readonly mode: "create" | "edit";
  readonly promptId?: string;
  readonly title: string;
  readonly text: string;
}

interface DraftErrors {
  readonly title?: string;
  readonly text?: string;
}

export function CannedPromptsSettingsPage({
  store,
}: {
  readonly store: CannedPromptClientStore;
}): React.JSX.Element {
  const state = useCannedPromptStore(store);
  const [draft, setDraft] = useState<PromptDraft>();
  const [draftErrors, setDraftErrors] = useState<DraftErrors>({});
  const [deleting, setDeleting] = useState<CannedPrompt>();
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState("");
  const [notice, showNotice, clearNotice] = useTransientNotice();
  const [showTab, setShowTabState] = useState(getShowPromptsTab);
  const [placement, setPlacementState] = useState(getPromptsPlacement);
  const titleInput = useRef<HTMLInputElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void store.load().catch(() => undefined);
  }, [store]);
  useEffect(() => subscribeShowPromptsTab(setShowTabState), []);
  useEffect(() => subscribePromptsPlacement(setPlacementState), []);

  const prompts = useMemo(
    () =>
      [...state.library.items].sort(
        (left, right) =>
          left.position - right.position || left.id.localeCompare(right.id),
      ),
    [state.library.items],
  );
  const pending = state.pendingMutation;
  const savedPrompt =
    draft?.mode === "edit"
      ? prompts.find(({ id }) => id === draft.promptId)
      : undefined;
  const dirty = draft
    ? draft.mode === "create"
      ? Boolean(draft.title || draft.text)
      : draft.title !== savedPrompt?.title || draft.text !== savedPrompt?.text
    : false;

  const clearMessages = (): void => {
    setError("");
    clearNotice();
  };
  const openDraft = (next: PromptDraft | undefined): void => {
    setDraft(next);
    setDraftErrors({});
    clearMessages();
  };
  // Escape closes an open editor (its "‹ Prompts"), asking first when it has edits.
  // Its "‹ Prompts" and Escape close the editor, asking first when it has edits.
  const closeEditor = (): void => (dirty ? setDiscarding(true) : openDraft(undefined));
  useSettingsEscapeLevel(draft ? closeEditor : undefined);

  const handleMutationError = (cause: unknown, fallback: string): void => {
    if (cause instanceof ApiError && cause.code === "conflict") {
      setDraft(undefined);
      setDeleting(undefined);
      setError(
        store.getSnapshot().status === "ready"
          ? "The prompt library changed in another session. The latest version has been loaded; review it before trying again."
          : "The prompt library changed in another session, but the latest version could not be loaded. Retry before editing it again.",
      );
      return;
    }
    setError(messageFrom(cause, fallback));
  };

  const submit = async (): Promise<void> => {
    if (!draft || state.status !== "ready" || pending) return;
    const errors = validateDraft(draft);
    setDraftErrors(errors);
    if (errors.title || errors.text) {
      (errors.title ? titleInput : textInput).current?.focus();
      return;
    }
    clearMessages();
    const input = {
      title: draft.title.normalize("NFKC").trim(),
      text: draft.text,
    };
    try {
      if (draft.mode === "create") await store.create(input);
      else await store.update(required(draft.promptId), input);
      setDraft(undefined);
      showNotice(draft.mode === "create" ? "Prompt added." : "Prompt saved.");
    } catch (cause) {
      handleMutationError(cause, "Could not save this prompt.");
    }
  };

  const confirmDelete = async (prompt: CannedPrompt): Promise<void> => {
    if (state.status !== "ready") return;
    clearMessages();
    try {
      await store.delete(prompt.id);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === "conflict") {
        handleMutationError(cause, "Could not delete this prompt.");
        return;
      }
      throw new Error(messageFrom(cause, "Could not delete this prompt."));
    }
    if (draft?.promptId === prompt.id) setDraft(undefined);
    showNotice("Prompt deleted.");
  };

  const move = async (promptId: string, offset: -1 | 1): Promise<void> => {
    if (state.status !== "ready" || pending) return;
    const index = prompts.findIndex(({ id }) => id === promptId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= prompts.length) return;
    const promptIds = prompts.map(({ id }) => id);
    [promptIds[index], promptIds[target]] = [
      required(promptIds[target]),
      required(promptIds[index]),
    ];
    clearMessages();
    try {
      await store.reorder(promptIds);
      showNotice("Prompt order saved.");
    } catch (cause) {
      handleMutationError(cause, "Could not reorder saved prompts.");
    }
  };

  const atLimit = prompts.length >= CANNED_PROMPT_MAX_ITEMS;
  const startCreate = (): void =>
    openDraft({ mode: "create", title: "", text: "" });
  // With nothing saved, the empty state carries the one "Add prompt".
  const empty = state.status === "ready" && prompts.length === 0 && !draft;

  return (
    <SettingsPage
      title="Prompts"
      description="Save and order reusable prompts for your account. The same library is available on desktop and mobile."
      width="wide"
      actions={
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Refresh prompts"
            title="Refresh prompts"
            disabled={state.status === "loading" || pending || Boolean(draft)}
            onClick={() => {
              setDeleting(undefined);
              clearMessages();
              void store.refresh().catch(() => undefined);
            }}
          >
            <RefreshCw aria-hidden="true" />
          </Button>
          {empty ? null : (
            <Button
              type="button"
              variant="outline"
              disabled={state.status !== "ready" || pending || atLimit}
              title={atLimit ? `A library holds at most ${CANNED_PROMPT_MAX_ITEMS} prompts.` : undefined}
              onClick={startCreate}
            >
              <Plus aria-hidden="true" />
              Add prompt
            </Button>
          )}
        </>
      }
    >
      <SettingsSection
        title="In the composer"
        description="How this client offers the library."
        card
      >
        <SwitchField
          id="setting-show-prompts-tab"
          label="Show Prompts"
          description="Show prompt-library access in the composer in this client."
          checked={showTab}
          onCheckedChange={setShowPromptsTab}
          switchProps={{ "data-testid": "show-prompts-tab-toggle" }}
        />
        <SettingsField
          label="Placement"
          description="Above the composer, or as an icon in its toolbar."
        >
          <SegmentedControl
            className="w-full"
            value={placement}
            onValueChange={(next) => setPromptsPlacement(next as PromptsPlacement)}
          >
            <SegmentedControlItem value="above_composer">
              Above composer
            </SegmentedControlItem>
            <SegmentedControlItem value="toolbar">
              Composer toolbar
            </SegmentedControlItem>
          </SegmentedControl>
        </SettingsField>
      </SettingsSection>

      <SettingsSection
        title="Library"
        description={
          state.status === "ready"
            ? `${prompts.length} of ${CANNED_PROMPT_MAX_ITEMS} prompts.`
            : undefined
        }
        actions={
          notice ? (
            <span className="settings-inline-status" role="status">
              {notice}
            </span>
          ) : null
        }
      >
        {error || state.error ? (
          <Callout
            tone="danger"
            role="alert"
            action={
              state.status === "error" ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void store.refresh().catch(() => undefined)}
                >
                  Retry
                </Button>
              ) : undefined
            }
          >
            {error || state.error}
          </Callout>
        ) : null}
        {state.status === "loading" ? (
          <p className="settings-loading" role="status">
            Loading saved prompts…
          </p>
        ) : null}
        {empty ? (
          <EmptyState
            icon={<MessageSquareText />}
            title="No saved prompts yet"
            description="Add one to offer it from the composer on every client."
            action={
              <Button type="button" disabled={pending} onClick={startCreate}>
                <Plus aria-hidden="true" />
                Add prompt
              </Button>
            }
          />
        ) : null}
        {state.status === "ready" && (prompts.length > 0 || draft) ? (
          <div
            className="settings-master-detail"
            data-detail-open={Boolean(draft)}
            data-list-empty={prompts.length === 0 || undefined}
          >
            <section
              aria-label="Saved prompts"
              className="settings-master-detail-list"
            >
              {prompts.length === 0 ? null : (
                <EntityList>
                  {prompts.map((prompt, index) => (
                    <EntityRow
                      key={prompt.id}
                      title={prompt.title}
                      subtitle={promptPreview(prompt.text)}
                      selected={draft?.promptId === prompt.id}
                      onSelect={() =>
                        openDraft({
                          mode: "edit",
                          promptId: prompt.id,
                          title: prompt.title,
                          text: prompt.text,
                        })
                      }
                      actions={
                        <>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Move ${prompt.title} up`}
                            title="Move up"
                            disabled={pending || index === 0}
                            onClick={() => void move(prompt.id, -1)}
                          >
                            <ArrowUp aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Move ${prompt.title} down`}
                            title="Move down"
                            disabled={pending || index === prompts.length - 1}
                            onClick={() => void move(prompt.id, 1)}
                          >
                            <ArrowDown aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Delete ${prompt.title}`}
                            title="Delete"
                            disabled={pending}
                            onClick={() => {
                              setDeleting(prompt);
                              clearMessages();
                            }}
                          >
                            <Trash2 aria-hidden="true" />
                          </Button>
                        </>
                      }
                    />
                  ))}
                </EntityList>
              )}
            </section>

            <section
              className="settings-master-detail-pane"
              data-card={draft ? "true" : undefined}
              data-sticky="true"
              aria-label="Prompt editor"
            >
              {draft ? (
                <form
                  className="settings-pane-form"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void submit();
                  }}
                >
                  <header className="settings-pane-header">
                    <SettingsBackLink
                      label="Prompts"
                      className="settings-master-detail-back"
                      onNavigate={closeEditor}
                    />
                    <h3 className="settings-pane-title">
                      {draft.mode === "create" ? "New prompt" : "Edit prompt"}
                    </h3>
                  </header>
                  <Field
                    id="canned-prompt-title"
                    label="Title"
                    error={draftErrors.title}
                  >
                    <Input
                      ref={titleInput}
                      value={draft.title}
                      disabled={pending}
                      onChange={(event) => {
                        const title = event.currentTarget.value;
                        setDraftErrors((errors) => ({ ...errors, title: undefined }));
                        setDraft({ ...draft, title });
                      }}
                    />
                  </Field>
                  <Field
                    id="canned-prompt-text"
                    label="Prompt"
                    error={draftErrors.text}
                  >
                    <Textarea
                      ref={textInput}
                      className="settings-prompt-text"
                      value={draft.text}
                      disabled={pending}
                      rows={8}
                      onChange={(event) => {
                        const text = event.currentTarget.value;
                        setDraftErrors((errors) => ({ ...errors, text: undefined }));
                        setDraft({ ...draft, text });
                      }}
                    />
                  </Field>
                  <SaveBar
                    placement="pane"
                    creating={draft.mode === "create"}
                    dirty={dirty}
                    saving={pending}
                    saveLabel={draft.mode === "create" ? "Add prompt" : "Save"}
                    savingLabel={draft.mode === "create" ? "Adding…" : "Saving…"}
                    onCancel={() => openDraft(undefined)}
                  />
                </form>
              ) : (
                <EmptyState
                  icon={<MessageSquareText />}
                  title="Select a prompt"
                  description="Edit it here, or add a new prompt."
                />
              )}
            </section>
          </div>
        ) : null}
      </SettingsSection>
      <ConfirmDialog
        open={Boolean(deleting)}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        tone="danger"
        title={`Delete ${deleting?.title ?? "prompt"}?`}
        description="It disappears from the composer on every client. This can't be undone."
        confirmLabel="Delete prompt"
        pendingLabel="Deleting…"
        onConfirm={() => (deleting ? confirmDelete(deleting) : undefined)}
      />
      <DiscardChangesDialog
        open={discarding && Boolean(draft)}
        onOpenChange={setDiscarding}
        description="This prompt has edits that have not been saved."
        discardLabel="Discard and close"
        onDiscard={() => {
          setDiscarding(false);
          openDraft(undefined);
        }}
      />
    </SettingsPage>
  );
}

function validateDraft(draft: PromptDraft): DraftErrors {
  const title = draft.title.normalize("NFKC").trim();
  const errors: { title?: string; text?: string } = {};
  if (!title) errors.title = "Enter a prompt title.";
  else if ([...title].length > CANNED_PROMPT_TITLE_MAX_CHARACTERS) {
    errors.title = `Prompt titles cannot exceed ${CANNED_PROMPT_TITLE_MAX_CHARACTERS} characters.`;
  } else if (
    new TextEncoder().encode(title).byteLength > CANNED_PROMPT_TITLE_MAX_BYTES
  ) {
    errors.title = `Prompt titles cannot exceed ${CANNED_PROMPT_TITLE_MAX_BYTES} UTF-8 bytes.`;
  }
  if (!draft.text.trim()) errors.text = "Enter prompt text.";
  else if (
    new TextEncoder().encode(draft.text).byteLength >
    CANNED_PROMPT_TEXT_MAX_BYTES
  ) {
    errors.text = `Prompt text cannot exceed ${CANNED_PROMPT_TEXT_MAX_BYTES.toLocaleString("en-US")} UTF-8 bytes.`;
  }
  return errors;
}

function promptPreview(text: string): string {
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
}

function messageFrom(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message
    : fallback;
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Required prompt value is missing.");
  return value;
}
