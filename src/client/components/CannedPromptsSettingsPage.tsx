import { useEffect, useMemo, useState } from "react";
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
import { Checkbox } from "@client/components/ui/checkbox";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@client/components/ui/radio-group";
import { Textarea } from "@client/components/ui/textarea";

interface PromptDraft {
  readonly mode: "create" | "edit";
  readonly promptId?: string;
  readonly title: string;
  readonly text: string;
}

export function CannedPromptsSettingsPage({
  store,
}: {
  readonly store: CannedPromptClientStore;
}): React.JSX.Element {
  const state = useCannedPromptStore(store);
  const [draft, setDraft] = useState<PromptDraft>();
  const [deleting, setDeleting] = useState<CannedPrompt>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showTab, setShowTabState] = useState(getShowPromptsTab);
  const [placement, setPlacementState] = useState(getPromptsPlacement);

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
    const validation = validateDraft(draft);
    if (validation) {
      setError(validation);
      return;
    }
    setError("");
    setNotice("");
    const input = {
      title: draft.title.normalize("NFKC").trim(),
      text: draft.text,
    };
    try {
      if (draft.mode === "create") await store.create(input);
      else await store.update(required(draft.promptId), input);
      setDraft(undefined);
      setNotice(draft.mode === "create" ? "Prompt added." : "Prompt saved.");
    } catch (cause) {
      handleMutationError(cause, "Could not save this prompt.");
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting || state.status !== "ready" || pending) return;
    setError("");
    setNotice("");
    try {
      await store.delete(deleting.id);
      if (draft?.promptId === deleting.id) setDraft(undefined);
      setDeleting(undefined);
      setNotice("Prompt deleted.");
    } catch (cause) {
      handleMutationError(cause, "Could not delete this prompt.");
    }
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
    setError("");
    setNotice("");
    try {
      await store.reorder(promptIds);
      setNotice("Prompt order saved.");
    } catch (cause) {
      handleMutationError(cause, "Could not reorder saved prompts.");
    }
  };

  return (
    <div className="canned-prompts-settings-page">
      <header className="canned-prompts-page-header">
        <div>
          <h3 className="settings-page-title">Prompts</h3>
          <p>
            Save and order reusable prompts for your account. The same library
            is available on desktop and mobile.
          </p>
        </div>
        <div className="canned-prompts-page-actions">
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={state.status === "loading" || pending || Boolean(draft)}
            onClick={() => {
              setDeleting(undefined);
              setError("");
              setNotice("");
              void store.refresh().catch(() => undefined);
            }}
          >
            Refresh
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={
              state.status !== "ready" ||
              pending ||
              prompts.length >= CANNED_PROMPT_MAX_ITEMS
            }
            onClick={() => {
              setDraft({ mode: "create", title: "", text: "" });
              setDeleting(undefined);
              setError("");
              setNotice("");
            }}
          >
            Add prompt
          </Button>
        </div>
      </header>

      <div className="settings-row">
        <div className="settings-row-text">
          <Label
            htmlFor="setting-show-prompts-tab"
            className="settings-row-label"
          >
            Show Prompts
          </Label>
          <p
            id="setting-show-prompts-tab-description"
            className="settings-row-description"
          >
            Show prompt-library access in the composer in this client.
          </p>
        </div>
        <Checkbox
          id="setting-show-prompts-tab"
          data-testid="show-prompts-tab-toggle"
          aria-describedby="setting-show-prompts-tab-description"
          checked={showTab}
          onCheckedChange={(checked) => setShowPromptsTab(checked === true)}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Placement</span>
          <p
            id="setting-prompts-placement-description"
            className="settings-row-description"
          >
            Choose whether Prompts appears above the composer or as an icon in
            its toolbar on this client.
          </p>
        </div>
        <RadioGroup
          className="settings-radio-group"
          value={placement}
          aria-label="Prompts placement"
          aria-describedby="setting-prompts-placement-description"
          onValueChange={(next) =>
            setPromptsPlacement(next as PromptsPlacement)
          }
        >
          {(
            [
              ["above_composer", "Above composer"],
              ["toolbar", "Composer toolbar"],
            ] as const
          ).map(([value, label]) => (
            <div className="settings-radio-option" key={value}>
              <RadioGroupItem
                value={value}
                id={`setting-prompts-placement-${value}`}
              />
              <Label htmlFor={`setting-prompts-placement-${value}`}>
                {label}
              </Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      {state.status === "loading" ? (
        <p role="status">Loading saved prompts…</p>
      ) : null}
      {state.status === "error" ? (
        <Button
          type="button"
          variant="outline"
          onClick={() => void store.refresh().catch(() => undefined)}
        >
          Retry
        </Button>
      ) : null}

      {state.status === "ready" ? (
        <div
          className="canned-prompts-layout"
          data-editor-open={Boolean(draft)}
        >
          <section aria-label="Saved prompts" className="canned-prompts-list">
            {prompts.length === 0 ? (
              <p className="canned-prompts-empty">
                No saved prompts yet. Add one to make it available from the
                composer.
              </p>
            ) : (
              prompts.map((prompt, index) => (
                <article className="canned-prompt-list-item" key={prompt.id}>
                  <button
                    type="button"
                    className="canned-prompt-select"
                    aria-current={
                      draft?.promptId === prompt.id ? "page" : undefined
                    }
                    onClick={() => {
                      setDraft({
                        mode: "edit",
                        promptId: prompt.id,
                        title: prompt.title,
                        text: prompt.text,
                      });
                      setDeleting(undefined);
                      setError("");
                      setNotice("");
                    }}
                  >
                    <strong>{prompt.title}</strong>
                    <span>{promptPreview(prompt.text)}</span>
                  </button>
                  <div className="canned-prompt-order-controls">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={`Move ${prompt.title} up`}
                      disabled={pending || index === 0}
                      onClick={() => void move(prompt.id, -1)}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={`Move ${prompt.title} down`}
                      disabled={pending || index === prompts.length - 1}
                      onClick={() => void move(prompt.id, 1)}
                    >
                      Move down
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={`Delete ${prompt.title}`}
                      disabled={pending}
                      onClick={() => {
                        setDeleting(prompt);
                        setError("");
                        setNotice("");
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                  {deleting?.id === prompt.id ? (
                    <div
                      className="canned-prompt-delete-confirmation"
                      role="group"
                      aria-label={`Delete ${prompt.title}?`}
                    >
                      <span>Delete this prompt?</span>
                      <Button
                        type="button"
                        variant="destructive"
                        size="xs"
                        disabled={pending}
                        onClick={() => void confirmDelete()}
                      >
                        Delete
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={pending}
                        onClick={() => setDeleting(undefined)}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                </article>
              ))
            )}
          </section>

          <section className="canned-prompt-editor" aria-label="Prompt editor">
            {draft ? (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void submit();
                }}
              >
                <h4>
                  {draft.mode === "create" ? "New prompt" : "Edit prompt"}
                </h4>
                <Label htmlFor="canned-prompt-title">Title</Label>
                <Input
                  id="canned-prompt-title"
                  value={draft.title}
                  disabled={pending}
                  onChange={(event) =>
                    setDraft({ ...draft, title: event.currentTarget.value })
                  }
                />
                <Label htmlFor="canned-prompt-text">Prompt</Label>
                <Textarea
                  id="canned-prompt-text"
                  value={draft.text}
                  disabled={pending}
                  rows={8}
                  onChange={(event) =>
                    setDraft({ ...draft, text: event.currentTarget.value })
                  }
                />
                <div className="canned-prompt-editor-actions">
                  <Button type="submit" size="sm" disabled={pending}>
                    {draft.mode === "create" ? "Add prompt" : "Save"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => {
                      setDraft(undefined);
                      setError("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <p className="canned-prompt-editor-empty">
                Select a prompt to edit it, or add a new prompt.
              </p>
            )}
          </section>
        </div>
      ) : null}

      {error || state.error ? (
        <p className="canned-prompts-message" role="alert">
          {error || state.error}
        </p>
      ) : null}
      {notice ? (
        <p className="canned-prompts-message" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function validateDraft(draft: PromptDraft): string | undefined {
  const title = draft.title.normalize("NFKC").trim();
  if (!title) return "Enter a prompt title.";
  if ([...title].length > CANNED_PROMPT_TITLE_MAX_CHARACTERS) {
    return `Prompt titles cannot exceed ${CANNED_PROMPT_TITLE_MAX_CHARACTERS} characters.`;
  }
  if (
    new TextEncoder().encode(title).byteLength > CANNED_PROMPT_TITLE_MAX_BYTES
  ) {
    return `Prompt titles cannot exceed ${CANNED_PROMPT_TITLE_MAX_BYTES} UTF-8 bytes.`;
  }
  if (!draft.text.trim()) return "Enter prompt text.";
  if (
    new TextEncoder().encode(draft.text).byteLength >
    CANNED_PROMPT_TEXT_MAX_BYTES
  ) {
    return `Prompt text cannot exceed ${CANNED_PROMPT_TEXT_MAX_BYTES.toLocaleString("en-US")} UTF-8 bytes.`;
  }
  return undefined;
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
