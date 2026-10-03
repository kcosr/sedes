import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Plus, Trash2, X } from "lucide-react";
import {
  TASK_DETAILS_MAX_CHARACTERS,
  TASK_FILES_MAX_COUNT,
  TASK_FILE_MAX_PATH_BYTES,
  taskFilePathSchema,
  type AssociatedTask,
} from "../../../shared/index.js";
import { ApiError } from "../../api/ApiClient.js";
import { useTouchDensity } from "../../app/use-touch-density.js";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";
import { Button } from "../ui/button.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog.js";
import { DiscardChangesDialog } from "../ui/discard-changes-dialog.js";
import { Field } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { SearchableSelect } from "../ui/searchable-select.js";
import { Switch } from "../ui/switch.js";
import { Textarea } from "../ui/textarea.js";
import type { TaskDestinations } from "./task-destinations.js";
import {
  parseScopeKey,
  scopeKey,
  TASK_TITLE_MAX_CHARACTERS,
  taskFileName,
  taskFileParent,
} from "./task-view-model.js";

interface Draft {
  readonly title: string;
  readonly details: string;
  readonly scope: string;
  readonly files: readonly string[];
  readonly pinned: boolean;
  readonly backlog: boolean;
}

function draftOf(task: AssociatedTask): Draft {
  return {
    title: task.title,
    details: task.details,
    scope: scopeKey(task.scope),
    files: task.files,
    pinned: task.pinned,
    backlog: task.backlog,
  };
}

function sameFiles(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function saveError(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "This task changed after you opened it. Close the editor and open it again to see the latest version.";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The task could not be saved.";
}

function filePathError(path: string, files: readonly string[]): string | undefined {
  if (!path.startsWith("/")) return "Enter an absolute file path beginning with /.";
  if (!taskFilePathSchema.safeParse(path).success) {
    return `Enter an absolute POSIX path of at most ${TASK_FILE_MAX_PATH_BYTES} bytes.`;
  }
  if (files.includes(path)) return "That file is already attached to this task.";
  if (files.length >= TASK_FILES_MAX_COUNT) {
    return `A task can have up to ${TASK_FILES_MAX_COUNT} files.`;
  }
  return undefined;
}

/** A ref for a dialog's content, and whether that content is mounted: open or still closing. */
function useContentMounted(): [(node: HTMLDivElement | null) => void, boolean] {
  const [mounted, setMounted] = useState(false);
  const ref = useCallback((node: HTMLDivElement | null) => setMounted(node !== null), []);
  return [ref, mounted];
}

/**
 * Edits one task: title, notes, where it belongs, its files, its pin and
 * whether it is in the backlog, with Delete… on the footer's leading edge.
 * A completed task is never pinned or in the backlog, so both switches are
 * off and disabled for one. Its state outlives `open`, so an edit survives
 * the Tasks surface being suspended (Settings) and comes back when it is
 * shown again. Unsaved changes are guarded on every way out.
 *
 * When the surface Tasks is shown on changes under it (crossing the phone
 * breakpoint), the new surface mounts over the dialog and takes focus. The
 * dialog, with a confirmation open over it, then closes until their old
 * content has gone, and opens again on top, with its edits.
 *
 * Each dialog hides the rest of the page from assistive technology, and
 * traps focus, as its content mounts: mounted together, the editor and its
 * confirmation would hide each other. So when they open again after a move
 * or Settings, the editor waits for a confirmation still closing from
 * before, and the confirmation waits for the editor's content to mount.
 */
export function TaskEditDialog({
  task,
  open,
  surface,
  store,
  destinations,
  onClose,
}: {
  /** The live task; undefined once it has been deleted elsewhere. */
  readonly task: AssociatedTask | undefined;
  readonly open: boolean;
  /** The surface Tasks is shown on: the panel or the sheet. */
  readonly surface: string;
  readonly store: ApplicationClientStore;
  readonly destinations: TaskDestinations;
  readonly onClose: () => void;
}): React.JSX.Element {
  const touch = useTouchDensity();
  // The task as it was when editing began: the baseline for "dirty" and the
  // revision the save is checked against.
  const [initial] = useState(() => (task ? draftOf(task) : undefined));
  const [baseRevision] = useState(() => task?.revision ?? 0);
  const [initialScope] = useState(() => task?.scope);
  const [draft, setDraft] = useState<Draft | undefined>(initial);
  const [titleError, setTitleError] = useState<string>();
  const [fileError, setFileError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [newFilePath, setNewFilePath] = useState("");
  const [addingFile, setAddingFile] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [shownSurface, setShownSurface] = useState(surface);
  const [editorRef, editorMounted] = useContentMounted();
  const [discardRef, discardMounted] = useContentMounted();
  const [deleteRef, deleteMounted] = useContentMounted();
  const confirmationMounted = discardMounted || deleteMounted;
  const moving = shownSurface !== surface;
  useEffect(() => {
    if (moving && !editorMounted && !confirmationMounted) setShownSurface(surface);
  }, [moving, editorMounted, confirmationMounted, surface]);
  const shown = open && !moving && (editorMounted || !confirmationMounted);
  const confirmable = shown && editorMounted;

  const dirty =
    draft !== undefined &&
    initial !== undefined &&
    (draft.title !== initial.title ||
      draft.details !== initial.details ||
      draft.scope !== initial.scope ||
      draft.pinned !== initial.pinned ||
      draft.backlog !== initial.backlog ||
      !sameFiles(draft.files, initial.files) ||
      newFilePath.trim().length > 0);

  const requestClose = () => {
    if (saving) return;
    if (dirty && task) setConfirmDiscard(true);
    else onClose();
  };

  const update = (change: Partial<Draft>) =>
    setDraft((current) => (current ? { ...current, ...change } : current));

  const addFile = (): readonly string[] | undefined => {
    if (!draft) return undefined;
    const path = newFilePath.trim();
    if (path.length === 0) return draft.files;
    const problem = filePathError(path, draft.files);
    if (problem) {
      setFileError(problem);
      fileInputRef.current?.focus();
      return undefined;
    }
    const files = [...draft.files, path];
    update({ files });
    setNewFilePath("");
    setFileError(undefined);
    return files;
  };

  const save = async () => {
    if (!draft || !initial || !task || saving) return;
    const title = draft.title.trim();
    if (title.length === 0) {
      setTitleError("A task needs a title.");
      return;
    }
    const files = addFile();
    if (!files) return;
    const scope = parseScopeKey(draft.scope);
    // Completed since the edit began: the server would refuse either switch.
    const placeable = task.completedAt === null;
    const changes = {
      ...(title !== initial.title ? { title } : {}),
      ...(draft.details !== initial.details ? { details: draft.details } : {}),
      ...(scope && draft.scope !== initial.scope ? { scope } : {}),
      ...(placeable && draft.pinned !== initial.pinned
        ? { pinned: draft.pinned }
        : {}),
      ...(placeable && draft.backlog !== initial.backlog
        ? { backlog: draft.backlog }
        : {}),
      ...(!sameFiles(files, initial.files) ? { files } : {}),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setFormError(undefined);
    try {
      await store.updateTask({ ...task, revision: baseRevision }, changes);
      onClose();
    } catch (error) {
      setFormError(saveError(error));
    } finally {
      setSaving(false);
    }
  };

  const completed = task !== undefined && task.completedAt !== null;
  const destination = draft ? parseScopeKey(draft.scope) : undefined;
  const destinationProject =
    destination?.kind === "project"
      ? destination.projectId
      : destination?.kind === "thread"
        ? undefined
        : null;
  // Moving to another project keeps the files' absolute paths, which may not
  // exist there. A thread's project is only known once the move is made, so
  // the warning covers project and global destinations.
  const crossesProjects =
    task !== undefined &&
    draft !== undefined &&
    draft.files.length > 0 &&
    initial !== undefined &&
    draft.scope !== initial.scope &&
    destinationProject !== undefined &&
    destinationProject !== task.associatedProjectId;

  return (
    <>
      <Dialog
        open={shown}
        onOpenChange={(next) => {
          if (!next && shown) requestClose();
        }}
      >
        <DialogContent
          ref={editorRef}
          size="md"
          dismissible={!saving}
          className="tasks-edit-dialog"
          aria-describedby={undefined}
          aria-busy={saving || undefined}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void save();
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Edit task</DialogTitle>
          </DialogHeader>
          {draft ? (
            <DialogBody>
              {!task && (
                <DialogAlert tone="warning">
                  This task was deleted elsewhere. Your changes can no longer
                  be saved.
                </DialogAlert>
              )}
              {formError && <DialogAlert tone="danger">{formError}</DialogAlert>}
              <Field label="Title" error={titleError}>
                <Input
                  value={draft.title}
                  maxLength={TASK_TITLE_MAX_CHARACTERS}
                  onChange={(event) => {
                    update({ title: event.target.value });
                    if (event.target.value.trim().length > 0) {
                      setTitleError(undefined);
                    }
                  }}
                />
              </Field>
              <Field label="Notes">
                <Textarea
                  className="tasks-edit-notes"
                  value={draft.details}
                  placeholder="Add notes, links, or follow-up steps"
                  maxLength={TASK_DETAILS_MAX_CHARACTERS}
                  onChange={(event) => update({ details: event.target.value })}
                />
              </Field>
              <Field label="Belongs to">
                <SearchableSelect
                  presentation={touch ? "dialog" : "popover"}
                  label="Belongs to"
                  searchLabel="Search threads and projects"
                  emptyLabel="No matching threads or projects."
                  value={draft.scope}
                  options={destinations.options(initialScope)}
                  onValueChange={(value) => update({ scope: value })}
                />
              </Field>
              {crossesProjects && (
                <DialogAlert tone="warning">
                  This task links to project files. Moving it keeps their
                  absolute paths unchanged.
                </DialogAlert>
              )}
              <Field label="Files" error={fileError}>
                <div className="tasks-edit-files">
                  {draft.files.length > 0 && (
                    <ul className="tasks-file-chips" aria-label="Linked files">
                      {draft.files.map((path) => (
                        <li key={path} className="tasks-file-chip" title={path}>
                          <FileText aria-hidden="true" />
                          <span className="tasks-file-parent">
                            {taskFileParent(path)}
                          </span>
                          <span className="tasks-file-name">
                            {taskFileName(path)}
                          </span>
                          <button
                            type="button"
                            className="tasks-file-remove"
                            aria-label={`Remove ${path}`}
                            onClick={() =>
                              update({
                                files: draft.files.filter(
                                  (candidate) => candidate !== path,
                                ),
                              })
                            }
                          >
                            <X aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  {addingFile ? (
                    <div className="tasks-edit-file-add">
                      <Input
                        ref={fileInputRef}
                        autoFocus
                        value={newFilePath}
                        aria-label="Absolute file path"
                        placeholder="/absolute/path/to/file"
                        maxLength={TASK_FILE_MAX_PATH_BYTES}
                        onChange={(event) => {
                          setNewFilePath(event.target.value);
                          setFileError(undefined);
                        }}
                        onKeyDown={(event) => {
                          if (
                            event.key === "Enter" &&
                            !event.metaKey &&
                            !event.ctrlKey
                          ) {
                            event.preventDefault();
                            addFile();
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={newFilePath.trim().length === 0}
                        onClick={() => addFile()}
                      >
                        Add
                      </Button>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="tasks-edit-add-file"
                      disabled={draft.files.length >= TASK_FILES_MAX_COUNT}
                      onClick={() => setAddingFile(true)}
                    >
                      <Plus aria-hidden="true" />
                      Add file
                    </Button>
                  )}
                </div>
              </Field>
              <Field
                label="Pinned"
                description={
                  completed
                    ? "Reopen the task to pin it."
                    : "Pinned tasks stay at the top."
                }
                orientation="horizontal"
              >
                <Switch
                  checked={!completed && draft.pinned}
                  disabled={completed}
                  onCheckedChange={(pinned) => update({ pinned })}
                />
              </Field>
              <Field
                label="Backlog"
                description={
                  completed
                    ? "Reopen the task to send it to the Backlog."
                    : "Backlog tasks are open but not current work; they wait in the collapsed Backlog section."
                }
                orientation="horizontal"
              >
                <Switch
                  checked={!completed && draft.backlog}
                  disabled={completed}
                  onCheckedChange={(backlog) => update({ backlog })}
                />
              </Field>
            </DialogBody>
          ) : null}
          <DialogFooter
            start={
              <Button
                type="button"
                variant="destructive-outline"
                disabled={!task || saving}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 aria-hidden="true" />
                Delete…
              </Button>
            }
          >
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={requestClose}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!task || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DiscardChangesDialog
        ref={discardRef}
        open={confirmable && confirmDiscard}
        description="Your changes to this task have not been saved."
        discardLabel="Discard and close"
        onOpenChange={(next) => {
          if (!next) setConfirmDiscard(false);
        }}
        onDiscard={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
      <ConfirmDialog
        ref={deleteRef}
        open={confirmable && confirmDelete && task !== undefined}
        tone="danger"
        title="Delete task?"
        description={`“${task?.title ?? draft?.title ?? ""}” will be deleted permanently. Prompts that already carry it keep their copy.`}
        confirmLabel="Delete task"
        pendingLabel="Deleting…"
        onOpenChange={(next) => {
          if (!next) setConfirmDelete(false);
        }}
        onConfirm={async () => {
          if (!task) return;
          await store.deleteTask(task.id);
          onClose();
        }}
      />
    </>
  );
}
