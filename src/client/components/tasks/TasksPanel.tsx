import { createPortal } from "react-dom";
import { StablePaneSlot } from "../../workspace-panels/StablePaneSlot.js";
import { useKeyboardInset } from "../../app/use-keyboard-inset.js";
import * as Dialog from "@radix-ui/react-dialog";
import { DismissableLayer } from "@radix-ui/react-dismissable-layer";
import * as Popover from "@radix-ui/react-popover";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
} from "react";
import {
  AlignLeft,
  Check,
  CheckCircle2,
  Circle,
  File,
  Files,
  GripVertical,
  MoreHorizontal,
  Pin,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  TASK_DETAILS_MAX_CHARACTERS,
  TASK_FILES_MAX_COUNT,
  TASK_FILE_MAX_PATH_BYTES,
  taskFilePathSchema,
  workspaceFileAbsolutePathSchema,
  type AssociatedTask,
  type Task,
  type TaskScope,
} from "../../../shared/index.js";
import {
  setTasksPanelDefaultView,
  setTasksPanelIncludeNestedScopes,
  setTasksPanelOpen,
  setTasksPanelPinned,
  setTasksPanelSearchContent,
  useTasksPanelPreferences,
  type TasksPanelScopePreference,
} from "../../app/tasks-panel-store.js";
import { useRoute, type Route } from "../../app/router.js";
import { useComposerDraftStaging } from "../../context-excerpts/coordinator.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import {
  CLOSE_TASK_DETAIL_EVENT,
  OPEN_OVERLAY_SELECTORS,
} from "../../app/android-back.js";
import {
  useApplicationStore,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import { Textarea } from "@client/components/ui/textarea";
import { SearchableSelect } from "../ui/searchable-select.js";
import { workspaceDisplayLabel } from "../../app/sidebar-scope-presentation.js";
import { SegmentedControl } from "./SegmentedControl.js";
import type { PanelLayoutStore } from "../../workspace-panels/panel-state.js";
import type { PanelPresentation } from "../../workspace-panels/panel-presentation.js";
import { resolvePanelPresentation } from "../../workspace-panels/panel-presentation.js";
import { getPanelPresentation } from "../../app/settings.js";
import { createWorkspaceFilesOpenIntent } from "../../workspace-files/open-intent.js";
import {
  applyTasksPanelWidth,
  clampTasksPanelWidth,
  getTasksPanelWidth,
  setTasksPanelWidth,
  tasksPanelWidthDefault,
  tasksPanelWidthMax,
  tasksPanelWidthMin,
} from "../../app/tasks-panel-width.js";
import { PaneResizeHandle } from "../PaneResizeHandle.js";
import {
  handleTaskDragStart,
  useTaskDrag,
  type TaskScopeDropTarget,
} from "../../tasks/task-drag.js";
import "./tasks-panel.css";

const MOBILE_QUERY = "(max-width: 819px)";

type TasksView = TasksPanelScopePreference;

const VIEW_ORDER: readonly TasksView[] = ["global", "project", "thread"];
const VIEW_LABEL: Record<TasksView, string> = {
  global: "Global",
  project: "Project",
  thread: "Thread",
};
const CURRENT_SCOPE = "current";

type ScopeSelection =
  | { readonly kind: "global" }
  | { readonly kind: "workspace"; readonly workspaceId: string | undefined }
  | { readonly kind: "thread"; readonly threadId: string | undefined };

/** Radix layers above the panel own their own Escape dismissal. */
const OTHER_OVERLAY_SELECTOR = OPEN_OVERLAY_SELECTORS.filter(
  (selector) => !selector.includes("tasks-panel"),
).join(", ");

/**
 * Right offset anchoring the desktop card to the primary chat column rather
 * than the viewport: docked workspace panels own the screen's right edge and
 * the card must float over the chat, not over them.
 */
function usePrimaryRightAnchor(enabled: boolean, routeKey: string): number {
  const [offset, setOffset] = useState(12);
  useEffect(() => {
    if (!enabled) return undefined;
    let frame = 0;
    let observed: Element | null = null;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => schedule());
    // On reload this card can mount before the primary column does; keep
    // watching the DOM so the anchor re-acquires the column when it appears
    // (or reappears after navigation) instead of staying at the viewport edge.
    const mutationObserver =
      typeof MutationObserver === "undefined"
        ? undefined
        : new MutationObserver(() => {
            if (
              document.querySelector('[data-testid="thread-view"]') !== observed
            ) {
              schedule();
            }
          });
    const measure = () => {
      frame = 0;
      const primary = document.querySelector('[data-testid="thread-view"]');
      if (primary !== observed) {
        if (observed) resizeObserver?.unobserve(observed);
        if (primary) resizeObserver?.observe(primary);
        observed = primary;
      }
      if (!primary) {
        setOffset(12);
        return;
      }
      const rect = primary.getBoundingClientRect();
      setOffset(
        rect.width > 0 && rect.height > 0
          ? Math.max(12, Math.round(window.innerWidth - rect.right) + 12)
          : 12,
      );
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    mutationObserver?.observe(document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [enabled, routeKey]);
  return offset;
}


type ViewContext = {
  readonly threadId?: string;
  readonly workspaceId?: string;
  readonly workspaceLabel?: string;
  readonly threadTitle?: string;
};

function viewAvailable(view: TasksView, context: ViewContext): boolean {
  if (view === "thread") {
    return context.threadId !== undefined && context.workspaceId !== undefined;
  }
  if (view === "project") return context.workspaceId !== undefined;
  return true;
}

/** Narrow an unavailable preference along thread → project → global. */
function clampView(view: TasksView, available: Record<TasksView, boolean>): TasksView {
  if (available[view]) return view;
  if (view === "thread" && available.project) return "project";
  return "global";
}

function viewScope(view: TasksView, context: ViewContext): ScopeSelection {
  if (view === "thread") return { kind: "thread", threadId: context.threadId };
  if (view === "project") {
    return { kind: "workspace", workspaceId: context.workspaceId };
  }
  return { kind: "global" };
}

function scopeView(scope: ScopeSelection): TasksView {
  if (scope.kind === "workspace") return "project";
  return scope.kind;
}

function resolvedScope(scope: ScopeSelection): TaskScope | undefined {
  if (scope.kind === "global") return scope;
  if (scope.kind === "workspace" && scope.workspaceId !== undefined) {
    return { kind: "workspace", workspaceId: scope.workspaceId };
  }
  if (scope.kind === "thread" && scope.threadId !== undefined) {
    return { kind: "thread", threadId: scope.threadId };
  }
  return undefined;
}

function matchesView(
  task: AssociatedTask,
  view: TasksView,
  context: ViewContext,
  includeNestedScopes: boolean,
): boolean {
  if (view === "global") {
    return includeNestedScopes || task.scope.kind === "global";
  }
  if (view === "project") {
    if (
      task.scope.kind === "workspace" &&
      task.scope.workspaceId === context.workspaceId
    ) {
      return true;
    }
    return (
      includeNestedScopes &&
      task.scope.kind === "thread" &&
      task.associatedWorkspaceId === context.workspaceId
    );
  }
  return (
    task.scope.kind === "thread" && task.scope.threadId === context.threadId
  );
}

function taskLocationLabel(
  task: AssociatedTask,
  view: TasksView,
  threadTitles: ReadonlyMap<string, string>,
  workspaceLabels: ReadonlyMap<string, string>,
): string | null {
  if (view === "thread" || task.scope.kind === "global") return null;
  if (view === "project") {
    if (task.scope.kind !== "thread") return null;
    return threadTitles.get(task.scope.threadId) ?? "Thread";
  }
  if (task.scope.kind === "workspace") {
    return workspaceLabels.get(task.scope.workspaceId) ?? "Project";
  }
  const workspaceLabel = task.associatedWorkspaceId
    ? workspaceLabels.get(task.associatedWorkspaceId)
    : undefined;
  const threadTitle = threadTitles.get(task.scope.threadId);
  if (workspaceLabel && threadTitle)
    return `${workspaceLabel} / ${threadTitle}`;
  if (workspaceLabel) return `${workspaceLabel} / Thread`;
  return threadTitle ?? "Thread";
}

function TaskLocation({
  task,
  view,
  threadTitles,
  workspaceLabels,
}: {
  readonly task: AssociatedTask;
  readonly view: TasksView;
  readonly threadTitles: ReadonlyMap<string, string>;
  readonly workspaceLabels: ReadonlyMap<string, string>;
}): React.JSX.Element | null {
  const label = taskLocationLabel(task, view, threadTitles, workspaceLabels);
  return label === null ? null : (
    <span className="tasks-row-location" title={label}>
      {label}
    </span>
  );
}

function disabledReason(view: TasksView): string | undefined {
  if (view === "thread") return "No threads available.";
  if (view === "project") return "No projects available.";
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The request failed.";
}

type EditorState = {
  readonly taskId: string;
  readonly baseRevision: number;
  readonly title: string;
  readonly details: string;
  readonly scope: ScopeSelection;
  readonly files: readonly string[];
};

function taskFileName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.split("/").at(-1) || path;
}

function TasksPanelBody({
  route,
  active,
  store,
  panelLayoutStore,
  onClose,
  mobile,
}: {
  store: ApplicationClientStore;
  panelLayoutStore: PanelLayoutStore;
  onClose: () => void;
  mobile: boolean;
  route: Route;
  active: boolean;
}): React.JSX.Element {
  const preferences = useTasksPanelPreferences();
  const application = useApplicationStore(store);
  const composerDraft = useComposerDraftStaging();
  const taskDrag = useTaskDrag();

  const threadId = route.name === "thread" ? route.threadId : undefined;
  const thread = threadId
    ? application.snapshot?.threads.find(({ id }) => id === threadId)
    : undefined;
  const workspace = thread
    ? application.snapshot?.workspaces.find(
        ({ id }) => id === thread.workspaceId,
      )
    : undefined;
  const taskThreads = useMemo(
    () => (application.snapshot?.threads ?? []).filter(({ inventoryState }) => inventoryState !== "archived"),
    [application.snapshot?.threads],
  );
  const currentTaskThread = thread?.inventoryState === "archived" ? undefined : thread;
  const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);
  const [chosenThreadId, setChosenThreadId] = useState<string | null>(null);
  const selectedProject = application.snapshot?.workspaces.find(
    ({ id }) => id === (chosenProjectId ?? thread?.workspaceId),
  );
  const selectedThread = taskThreads.find(
    ({ id }) => id === (chosenThreadId ?? threadId),
  );
  const selectedThreadWorkspace = application.snapshot?.workspaces.find(
    ({ id }) => id === selectedThread?.workspaceId,
  );
  const projectContext: ViewContext = useMemo(
    () => selectedProject
      ? { workspaceId: selectedProject.id, workspaceLabel: selectedProject.label.text }
      : {},
    [selectedProject],
  );
  const threadContext: ViewContext = useMemo(
    () => ({
      ...(selectedThread === undefined ? {} : {
        threadId: selectedThread.id,
        workspaceId: selectedThread.workspaceId,
        threadTitle: selectedThread.title.text,
      }),
      ...(selectedThreadWorkspace === undefined
        ? {}
        : { workspaceLabel: selectedThreadWorkspace.label.text }),
    }),
    [selectedThread, selectedThreadWorkspace],
  );

  const [chosenView, setChosenView] = useState<TasksView | null>(null);
  const availableViews = {
    global: true,
    project: chosenProjectId !== null || (application.snapshot?.workspaces.length ?? 0) > 0,
    thread: chosenThreadId !== null || taskThreads.length > 0,
  };
  const view = clampView(chosenView ?? preferences.defaultView, availableViews);
  const context = view === "thread" ? threadContext : projectContext;
  const currentScope = resolvedScope(viewScope(view, context));
  // Single-select pure-filter views: the composer always adds to the scope
  // in view; there is no separate add-to preference.

  const [optionsOpen, setOptionsOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFilePath, setNewFilePath] = useState("");
  const [scopeDropView, setScopeDropView] = useState<TasksView>();
  useEffect(() => {
    if (taskDrag?.activeTaskId === undefined) setScopeDropView(undefined);
  }, [taskDrag?.activeTaskId]);

  const tasks = application.snapshot?.tasks ?? [];
  const workspaceLabels = useMemo(
    () =>
      new Map(
        (application.snapshot?.workspaces ?? []).map((candidate) => [
          candidate.id,
          candidate.label.text,
        ]),
      ),
    [application.snapshot?.workspaces],
  );
  const threadTitles = useMemo(
    () =>
      new Map(
        (application.snapshot?.threads ?? []).map((candidate) => [
          candidate.id,
          candidate.title.text,
        ]),
      ),
    [application.snapshot?.threads],
  );
  const projectOptions = useMemo(() => {
    const workspaces = application.snapshot?.workspaces ?? [];
    const environments = application.snapshot?.environments ?? [];
    return workspaces.map((candidate) => ({
      value: candidate.id,
      label: workspaceDisplayLabel({
        workspace: candidate,
        workspaces,
        environments,
        includeEnvironment: environments.find(
          ({ id }) => id === candidate.environmentId,
        )?.kind !== "local",
      }),
      description: candidate.displayPath.text,
      searchTerms: [candidate.id, candidate.label.text, candidate.displayPath.text],
    })).sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  }, [application.snapshot?.workspaces, application.snapshot?.environments]);
  const threadOptions = useMemo(() => {
    const projects = new Map(projectOptions.map((option) => [option.value, option]));
    const threads = taskThreads;
    const titleCounts = new Map<string, number>();
    for (const candidate of threads) {
      const key = JSON.stringify([candidate.workspaceId, candidate.title.text]);
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    return threads.map((candidate) => {
      const project = projects.get(candidate.workspaceId);
      const duplicate = (titleCounts.get(JSON.stringify([candidate.workspaceId, candidate.title.text])) ?? 0) > 1;
      return {
        value: candidate.id,
        label: [
          candidate.title.text,
          project?.label ?? candidate.workspaceId,
          duplicate ? candidate.id : undefined,
        ].filter(Boolean).join(" · "),

        searchTerms: [candidate.id, ...(project?.searchTerms ?? [])],
      };
    }).sort((left, right) => left.label.localeCompare(right.label) || left.value.localeCompare(right.value));
  }, [taskThreads, projectOptions]);
  const editorScope = editor ? resolvedScope(editor.scope) : undefined;
  const savedEditorScope = tasks.find(({ id }) => id === editor?.taskId)?.scope;
  const editorScopeAvailable = editorScope !== undefined && (
    editorScope.kind === "global" ||
    (editorScope.kind === "workspace"
      ? (savedEditorScope?.kind === "workspace" && savedEditorScope.workspaceId === editorScope.workspaceId) ||
        projectOptions.some(({ value }) => value === editorScope.workspaceId)
      : (savedEditorScope?.kind === "thread" && savedEditorScope.threadId === editorScope.threadId) ||
        threadOptions.some(({ value }) => value === editorScope.threadId))
  );
  const includeNestedScopes =
    view !== "thread" && preferences.includeNestedScopes;
  const normalizedSearchQuery = newTitle.trim().toLocaleLowerCase();
  const visible = useMemo(
    () =>
      tasks
        .filter((task) => matchesView(task, view, context, includeNestedScopes))
        .filter(
          (task) =>
            normalizedSearchQuery.length === 0 ||
            task.title.toLocaleLowerCase().includes(normalizedSearchQuery) ||
            (preferences.searchContent &&
              task.details.toLocaleLowerCase().includes(normalizedSearchQuery)),
        )
        .sort(
          (left, right) =>
            Number(right.pinned) - Number(left.pinned) ||
            Number(left.completedAt !== null) -
              Number(right.completedAt !== null) ||
            Date.parse(right.createdAt) - Date.parse(left.createdAt) ||
            left.id.localeCompare(right.id),
        ),
    [
      tasks,
      view,
      context,
      includeNestedScopes,
      normalizedSearchQuery,
      preferences.searchContent,
    ],
  );
  const editingTask = editor
    ? visible.find(({ id }) => id === editor.taskId)
    : undefined;
  // Resolve the selection against the visible list so the detail preview
  // never shows a task the active view filtered out (e.g. after switching
  // scope tabs); the selection itself survives for a return to that view.
  const selectedTask = expandedTaskId
    ? visible.find(({ id }) => id === expandedTaskId)
    : undefined;
  useEffect(() => {
    if (editor && !editingTask) {
      // Do not keep editing a task that was deleted or hidden by the active
      // scope/search filters.
      setEditor(null);
      setConfirmingDelete(false);
    }
  }, [editor, editingTask]);

  useEffect(() => {
    if (!active || !mobile) return undefined;
    const closeTaskDetail = () => {
      setEditor(null);
      setConfirmingDelete(false);
      setExpandedTaskId(null);
    };
    window.addEventListener(CLOSE_TASK_DETAIL_EVENT, closeTaskDetail);
    return () =>
      window.removeEventListener(CLOSE_TASK_DETAIL_EVENT, closeTaskDetail);
  }, [active, mobile]);

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await operation();
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const beginNewTask = () => {
    setEditor(null);
    setConfirmingDelete(false);
    setExpandedTaskId(null);
  };

  const submitNewTask = async () => {
    const title = newTitle.trim();
    if (title.length === 0 || busy || !currentScope) return;
    setBusy(true);
    setError(null);
    try {
      const created = await store.createTask(
        title,
        currentScope,
      );
      // Creation can resolve before the application snapshot publishes its
      // task upsert. Keep the authoritative returned ID selected so the
      // ordinary read-only detail appears as soon as that exact task becomes
      // visible in this scope; duplicate titles cannot affect the selection.
      beginNewTask();
      setExpandedTaskId(created.id);
      setNewTitle("");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const openEditor = (task: Task) => {
    setConfirmingDelete(false);
    setExpandedTaskId(task.id);
    setEditor({
      taskId: task.id,
      baseRevision: task.revision,
      title: task.title,
      details: task.details,
      scope: task.scope,
      files: task.files,
    });
    setNewFilePath("");
  };

  const saveEditor = async () => {
    if (!editor || !editingTask || busy || !editorScope || !editorScopeAvailable) return;
    const title = editor.title.trim();
    if (title.length === 0) {
      setError("A task needs a title.");
      return;
    }
    const saved = await run(() =>
      store.updateTask(
        { ...editingTask, revision: editor.baseRevision },
        {
          title,
          details: editor.details,
          scope: editorScope,
          files: editor.files,
        },
      ),
    );
    if (saved) setEditor(null);
  };

  const addTaskToPrompt = (task: Task) => {
    if (threadId === undefined) return;
    const result = composerDraft?.stageTaskReference({
      taskId: task.id,
      titleSnapshot: task.title,
    }) ?? {
      ok: false as const,
      reason: "This thread has no prompt input to receive the task.",
    };
    if (!result.ok) {
      setError(result.reason);
      return;
    }
    setError(null);
  };

  const deleteEditingTask = async () => {
    if (!editor || busy) return;
    const deleted = await run(() => store.deleteTask(editor.taskId));
    if (deleted) {
      setEditor(null);
      setConfirmingDelete(false);
    }
  };

  const togglePinned = (task: Task) =>
    run(() => store.updateTask(task, { pinned: !task.pinned }));

  const openTaskFile = async (
    absolutePath: string,
    presentation: PanelPresentation,
  ) => {
    if (!workspace?.available) return;
    if (!workspaceFileAbsolutePathSchema.safeParse(absolutePath).success) {
      setError("That file isn't available in Files.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const resolved = await store.api.resolveWorkspaceFileLink(workspace.id, {
        kind: "absolute",
        path: absolutePath,
      });
      if (resolved.status === "not_found") {
        setError("That file isn't available in Files.");
        return;
      }
      const opened = panelLayoutStore.openPanel("workspace-files", {
        presentation,
        intent: createWorkspaceFilesOpenIntent({
          workspaceId: workspace.id,
          rootId: resolved.rootId,
          path: resolved.path,
          rootVisibility: resolved.rootVisibility,
          target: { kind: "file" },
        }),
      });
      if (mobile && opened) setTasksPanelOpen(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const addEditorFile = () => {
    if (!editor) return;
    const path = newFilePath.trim();
    if (!path.startsWith("/")) {
      setError("Enter an absolute file path beginning with /.");
      return;
    }
    if (!taskFilePathSchema.safeParse(path).success) {
      setError(
        `Enter an absolute POSIX path of at most ${TASK_FILE_MAX_PATH_BYTES} bytes.`,
      );
      return;
    }
    if (editor.files.includes(path)) {
      setError("That file is already attached to this task.");
      return;
    }
    if (editor.files.length >= TASK_FILES_MAX_COUNT) {
      setError(`A task can have up to ${TASK_FILES_MAX_COUNT} files.`);
      return;
    }
    setEditor({ ...editor, files: [...editor.files, path] });
    setNewFilePath("");
    setError(null);
  };

  const scopeDropTarget = (
    targetView: TasksView,
  ): TaskScopeDropTarget | undefined => {
    const targetContext = targetView === "thread" ? threadContext : projectContext;
    if (!viewAvailable(targetView, targetContext)) return undefined;
    if (targetView === "global") {
      return {
        scope: { kind: "global" },
        label: "Global tasks",
        workspaceId: null,
        workspaceLabel: "Global tasks",
      };
    }
    if (targetView === "project") {
      return {
        scope: { kind: "workspace", workspaceId: targetContext.workspaceId! },
        label: targetContext.workspaceLabel ?? "this project",
        workspaceId: targetContext.workspaceId!,
        workspaceLabel: targetContext.workspaceLabel ?? "this project",
      };
    }
    return {
      scope: { kind: "thread", threadId: targetContext.threadId! },
      label: targetContext.threadTitle ?? "this thread",
      workspaceId: targetContext.workspaceId!,
      workspaceLabel: targetContext.workspaceLabel ?? "this project",
    };
  };

  const dragTargetsScope = (event: ReactDragEvent): boolean =>
    taskDrag?.isTaskDrag(event.dataTransfer) === true;

  const markScopeDrop = (targetView: TasksView, event: ReactDragEvent) => {
    if (!dragTargetsScope(event) || !scopeDropTarget(targetView)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setScopeDropView(targetView);
  };

  const leaveScopeDrop = (targetView: TasksView, event: ReactDragEvent) => {
    if (!dragTargetsScope(event)) return;
    event.stopPropagation();
    if (
      !event.currentTarget.contains(event.relatedTarget as Node | null) &&
      scopeDropView === targetView
    ) {
      setScopeDropView(undefined);
    }
  };

  const dropOnScope = (targetView: TasksView, event: ReactDragEvent) => {
    if (!dragTargetsScope(event)) return;
    const target = scopeDropTarget(targetView);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    const task = taskDrag?.resolveDraggedTask(event.dataTransfer);
    taskDrag?.endTaskDrag();
    setScopeDropView(undefined);
    if (!task) {
      taskDrag?.announce(
        "That task changed before it could be moved. Review it and try again.",
        true,
      );
      return;
    }
    void taskDrag?.requestScopeMove(task, target);
  };

  const viewOptions = VIEW_ORDER.map((candidate) => ({
    value: candidate,
    label: VIEW_LABEL[candidate],
    disabled: !availableViews[candidate],
    ...(availableViews[candidate]
      ? {}
      : { title: disabledReason(candidate) }),
    dropActive: scopeDropView === candidate,
    onDragEnter: (event: ReactDragEvent<HTMLButtonElement>) =>
      markScopeDrop(candidate, event),
    onDragOver: (event: ReactDragEvent<HTMLButtonElement>) =>
      markScopeDrop(candidate, event),
    onDragLeave: (event: ReactDragEvent<HTMLButtonElement>) =>
      leaveScopeDrop(candidate, event),
    onDrop: (event: ReactDragEvent<HTMLButtonElement>) =>
      dropOnScope(candidate, event),
  }));

  return (
    <div
      className="tasks-panel-body"
      data-task-detail-open={
        selectedTask !== undefined || editor !== null || undefined
      }
      data-task-scope-drop-target={scopeDropView === view || undefined}
      onDragEnter={(event) => markScopeDrop(view, event)}
      onDragOver={(event) => markScopeDrop(view, event)}
      onDragLeave={(event) => leaveScopeDrop(view, event)}
      onDrop={(event) => dropOnScope(view, event)}
    >
      <header className="tasks-panel-header">
        <h2 className="tasks-panel-title">Tasks</h2>
        <div className="tasks-panel-header-actions">
          {!mobile && (
            <Button
              variant={preferences.pinned ? "secondary" : "ghost"}
              size="icon-sm"
              aria-label={
                preferences.pinned ? "Unpin Tasks panel" : "Pin Tasks panel"
              }
              aria-pressed={preferences.pinned}
              title={
                preferences.pinned
                  ? "Keep Tasks open when clicking elsewhere"
                  : "Close Tasks when clicking elsewhere"
              }
              onClick={() => setTasksPanelPinned(!preferences.pinned)}
            >
              <Pin
                size={15}
                strokeWidth={1.8}
                fill={preferences.pinned ? "currentColor" : "none"}
                aria-hidden="true"
              />
            </Button>
          )}
          <Popover.Root open={active && optionsOpen} onOpenChange={setOptionsOpen}>
            <Popover.Trigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Tasks panel options"
              >
                <MoreHorizontal size={16} strokeWidth={1.8} />
              </Button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                className="menu-popover tasks-panel-menu"
                align="end"
                sideOffset={6}
              >
                <div className="tasks-panel-menu-group">
                  <span className="tasks-panel-menu-label">Default view</span>
                  <SegmentedControl
                    ariaLabel="Default view"
                    size="small"
                    value={preferences.defaultView}
                    options={VIEW_ORDER.map((candidate) => ({
                      value: candidate,
                      label: VIEW_LABEL[candidate],
                    }))}
                    onChange={(value) =>
                      setTasksPanelDefaultView(value as TasksView)
                    }
                  />
                </div>
                <label className="tasks-panel-menu-toggle">
                  <input
                    type="checkbox"
                    checked={preferences.searchContent}
                    onChange={(event) =>
                      setTasksPanelSearchContent(event.target.checked)
                    }
                  />
                  Search task content
                </label>
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New task"
            onClick={() => {
              beginNewTask();
              document
                .querySelector<HTMLInputElement>(".tasks-new-input input")
                ?.focus();
            }}
          >
            <Plus size={16} strokeWidth={1.8} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="tasks-panel-close"
            aria-label="Close Tasks panel"
            onClick={onClose}
          >
            <X size={16} strokeWidth={1.8} />
          </Button>
        </div>
      </header>

      <SegmentedControl
        ariaLabel="Task scope view"
        value={view}
        options={viewOptions}
        onChange={(value) => setChosenView(value as TasksView)}
      />

      {view === "project" && (
        <SearchableSelect
          presentation={mobile ? "dialog" : "popover"}
          label="Task project"
          searchLabel="Search projects"
          emptyLabel="No matching projects."
          selectedLabel={chosenProjectId === null && workspace
            ? `Current project · ${workspace.label.text}`
            : selectedProject?.label.text}
          value={chosenProjectId ?? (workspace ? CURRENT_SCOPE : "")}
          placeholder="Select…"
          options={[
            ...(workspace ? [{
              value: CURRENT_SCOPE,
              label: `Current project · ${workspace.label.text}`,
              pinned: true,
            }] : []),
            ...projectOptions,
          ]}
          onValueChange={(value) => setChosenProjectId(value === CURRENT_SCOPE ? null : value)}
        />
      )}
      {view === "thread" && (
        <SearchableSelect
          presentation={mobile ? "dialog" : "popover"}
          label="Task thread"
          searchLabel="Search threads"
          emptyLabel="No matching threads."
          selectedLabel={chosenThreadId === null && currentTaskThread
            ? `Current thread · ${currentTaskThread.title.text}`
            : selectedThread?.title.text}
          value={chosenThreadId ?? (currentTaskThread ? CURRENT_SCOPE : "")}
          placeholder="Select…"
          options={[
            ...(currentTaskThread ? [{
              value: CURRENT_SCOPE,
              label: `Current thread · ${currentTaskThread.title.text}`,
              pinned: true,
            }] : []),
            ...threadOptions,
          ]}
          onValueChange={(value) => setChosenThreadId(value === CURRENT_SCOPE ? null : value)}
        />
      )}

      {view !== "thread" && (
        <label className="tasks-nested-scopes-toggle">
          <input
            type="checkbox"
            checked={preferences.includeNestedScopes}
            onChange={(event) =>
              setTasksPanelIncludeNestedScopes(event.target.checked)
            }
          />
          Include nested scopes
        </label>
      )}

      <div className="tasks-new-input">
        <Input
          type="search"
          value={newTitle}
          aria-label="Search or add task"
          placeholder="Search or add task"
          maxLength={240}
          disabled={busy}
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submitNewTask();
            }
          }}
        />
        <Button
          variant="secondary"
          size="icon-sm"
          aria-label="Add task"
          disabled={busy || !currentScope || newTitle.trim().length === 0}
          onClick={() => void submitNewTask()}
        >
          <Check size={16} strokeWidth={1.8} />
        </Button>
      </div>

      {error && (
        <p className="tasks-panel-error" role="alert">
          {error}
        </p>
      )}

      <ul className="tasks-list" aria-label={`${VIEW_LABEL[view]} tasks`}>
        {visible.length === 0 && (
          <li className="tasks-empty">
            {!currentScope
              ? `Choose a ${view} to view or add tasks.`
              : normalizedSearchQuery.length > 0
              ? "No matching tasks."
              : `No ${VIEW_LABEL[view].toLowerCase()} tasks yet.`}
          </li>
        )}
        {visible.map((task) => (
          <li
            key={task.id}
            className="tasks-row"
            data-completed={task.completedAt !== null || undefined}
            data-selected={expandedTaskId === task.id || undefined}
            data-editing={editor?.taskId === task.id || undefined}
            onClick={() => {
              if (busy) return;
              setEditor(null);
              setConfirmingDelete(false);
              setExpandedTaskId((current) =>
                current === task.id ? null : task.id,
              );
            }}
          >
            {!mobile && (
              <button
                type="button"
                className="tasks-row-drag"
                draggable={!busy}
                aria-label={`Drag “${task.title}” to a thread or prompt`}
                title="Drag to a thread to move, or to the prompt to attach"
                disabled={busy}
                onClick={(event) => event.stopPropagation()}
                onDragStart={(event) => {
                  event.stopPropagation();
                  handleTaskDragStart(taskDrag, task, event);
                }}
                onDragEnd={() => taskDrag?.endTaskDrag()}
              >
                <GripVertical size={15} strokeWidth={1.8} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="tasks-row-checkbox"
              role="checkbox"
              aria-checked={task.completedAt !== null}
              aria-label={
                task.completedAt !== null
                  ? `Mark "${task.title}" as open`
                  : `Mark "${task.title}" as done`
              }
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void run(() =>
                  store.updateTask(task, {
                    completed: task.completedAt === null,
                  }),
                );
              }}
            >
              {task.completedAt !== null ? (
                <CheckCircle2 size={18} strokeWidth={1.8} aria-hidden="true" />
              ) : (
                <Circle size={18} strokeWidth={1.8} aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="tasks-row-title"
              aria-label={`View "${task.title}"`}
              aria-expanded={expandedTaskId === task.id}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                setEditor(null);
                setConfirmingDelete(false);
                setExpandedTaskId((current) =>
                  current === task.id ? null : task.id,
                );
              }}
            >
              {task.title}
            </button>
            {includeNestedScopes && (
              <TaskLocation
                task={task}
                view={view}
                threadTitles={threadTitles}
                workspaceLabels={workspaceLabels}
              />
            )}
            {task.details.length > 0 && (
              <span className="tasks-row-notes" title="Has notes">
                <AlignLeft size={13} strokeWidth={1.8} aria-label="Has notes" />
              </span>
            )}
            {task.files.length > 0 && (
              <span
                className="tasks-row-files"
                title={`${task.files.length} linked file${task.files.length === 1 ? "" : "s"}`}
              >
                <Files
                  size={13}
                  strokeWidth={1.8}
                  aria-label={`${task.files.length} linked file${task.files.length === 1 ? "" : "s"}`}
                />
              </span>
            )}
            <button
              type="button"
              className="tasks-row-pin"
              data-pinned={task.pinned || undefined}
              aria-label={
                task.pinned ? `Unpin "${task.title}"` : `Pin "${task.title}"`
              }
              aria-pressed={task.pinned}
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation();
                void togglePinned(task);
              }}
            >
              <Pin size={14} strokeWidth={1.8} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>

      {selectedTask && !editor && (
        <div className="tasks-detail-area">
          <div className="tasks-detail-heading">
            <strong className="tasks-detail-title">{selectedTask.title}</strong>
            <div className="tasks-detail-heading-actions">
              <Button
                variant="ghost"
                size="xs"
                disabled={busy}
                onClick={() => openEditor(selectedTask)}
              >
                Edit
              </Button>
            </div>
          </div>
          <p className="tasks-detail-description">
            {selectedTask.details || "No description."}
          </p>
          {selectedTask.files.length > 0 && (
            <div className="tasks-files" aria-label="Linked files">
              <span className="tasks-files-label">Files</span>
              {selectedTask.files.map((absolutePath) => {
                const fetchable = Boolean(workspace?.available);
                const content = (
                  <>
                    <File size={15} strokeWidth={1.8} aria-hidden="true" />
                    <span className="tasks-file-text">
                      <span className="tasks-file-name">
                        {taskFileName(absolutePath)}
                      </span>
                      <span className="tasks-file-path">{absolutePath}</span>
                    </span>
                  </>
                );
                return fetchable ? (
                  <button
                    type="button"
                    className="tasks-file-row"
                    key={absolutePath}
                    disabled={busy}
                    aria-label={`Open ${absolutePath} in Files`}
                    onClick={(event) => {
                      const presentation = resolvePanelPresentation(
                        getPanelPresentation(),
                        event.shiftKey,
                      );
                      void openTaskFile(absolutePath, presentation);
                    }}
                  >
                    {content}
                  </button>
                ) : (
                  <div className="tasks-file-row" key={absolutePath}>
                    {content}
                  </div>
                );
              })}
            </div>
          )}
          <div className="tasks-detail-actions">
            <Button
              variant="secondary"
              size="xs"
              disabled={threadId === undefined}
              title={
                threadId === undefined
                  ? "Open a thread to add this task to its prompt."
                  : composerDraft?.getSnapshot().available === false
                    ? composerDraft.getSnapshot().reason
                    : undefined
              }
              onClick={() => addTaskToPrompt(selectedTask)}
            >
              <Plus size={14} aria-hidden="true" /> Add to prompt
            </Button>
          </div>
        </div>
      )}

      {editor && editingTask && (
        <div
          className="tasks-editor"
          onKeyDownCapture={(event) => {
            if (
              event.key === "Enter" &&
              (event.metaKey || event.ctrlKey) &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              event.stopPropagation();
              void saveEditor();
            }
          }}
        >
          <div className="tasks-editor-heading">
            {confirmingDelete ? (
              <>
                <span className="tasks-editor-delete-prompt">
                  Delete this task?
                </span>
                <div className="tasks-editor-actions-main">
                  <Button
                    variant="destructive"
                    size="xs"
                    disabled={busy}
                    onClick={() => void deleteEditingTask()}
                  >
                    Delete
                  </Button>
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Keep editing
                  </Button>
                </div>
              </>
            ) : (
              <>
                <span className="tasks-editor-title">Edit task</span>
                <div className="tasks-editor-actions">
                  <Button
                    variant="destructive"
                    size="icon-sm"
                    aria-label="Delete task"
                    disabled={busy}
                    onClick={() => setConfirmingDelete(true)}
                  >
                    <Trash2 size={16} strokeWidth={1.8} />
                  </Button>
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label="Save task"
                    disabled={busy || !editorScopeAvailable}
                    onClick={() => void saveEditor()}
                  >
                    <Check size={16} strokeWidth={1.8} />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Cancel editing"
                    disabled={busy}
                    onClick={() => {
                      setEditor(null);
                      setConfirmingDelete(false);
                    }}
                  >
                    <X size={16} strokeWidth={1.8} />
                  </Button>
                </div>
              </>
            )}
          </div>
          <div className="tasks-editor-scope">
            <span className="tasks-editor-label">Scope</span>
            <SegmentedControl
              ariaLabel="Task scope"
              size="small"
              value={scopeView(editor.scope)}
              options={VIEW_ORDER.map((candidate) => ({
                value: candidate,
                label: VIEW_LABEL[candidate],
                disabled: busy || (!availableViews[candidate] &&
                  (savedEditorScope === undefined || scopeView(savedEditorScope) !== candidate)),
              }))}
              onChange={(value) =>
                setEditor({
                  ...editor,
                  scope: savedEditorScope !== undefined && scopeView(savedEditorScope) === value
                    ? savedEditorScope
                    : viewScope(value as TasksView, value === "thread" ? threadContext : projectContext),
                })
              }
            />
          </div>
          {editor.scope.kind === "workspace" && (
            <SearchableSelect
          presentation={mobile ? "dialog" : "popover"}
              label="Assign task to project"
              searchLabel="Search projects"
              emptyLabel="No matching projects."
              value={editor.scope.workspaceId ?? ""}
              selectedLabel={editor.scope.workspaceId ? workspaceLabels.get(editor.scope.workspaceId) ?? "Unavailable project" : undefined}
              placeholder="Select…"
              options={projectOptions}
              disabled={busy}
              onValueChange={(workspaceId) => setEditor({ ...editor, scope: { kind: "workspace", workspaceId } })}
            />
          )}
          {editor.scope.kind === "thread" && (
            <SearchableSelect
          presentation={mobile ? "dialog" : "popover"}
              label="Assign task to thread"
              searchLabel="Search threads"
              emptyLabel="No matching threads."
              value={editor.scope.threadId ?? ""}
              selectedLabel={editor.scope.threadId ? threadTitles.get(editor.scope.threadId) ?? "Unavailable thread" : undefined}
              placeholder="Select…"
              options={threadOptions}
              disabled={busy}
              onValueChange={(threadId) => setEditor({ ...editor, scope: { kind: "thread", threadId } })}
            />
          )}
          <Input
            value={editor.title}
            aria-label="Task title"
            maxLength={240}
            disabled={busy}
            onChange={(event) =>
              setEditor({ ...editor, title: event.target.value })
            }
          />
          <div className="tasks-editor-files">
            <span className="tasks-editor-label">Files</span>
            {editor.files.map((path) => (
              <div className="tasks-editor-file-row" key={path}>
                <File size={15} strokeWidth={1.8} aria-hidden="true" />
                <span className="tasks-editor-file-path" title={path}>
                  {path}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${path}`}
                  disabled={busy}
                  onClick={() =>
                    setEditor({
                      ...editor,
                      files: editor.files.filter(
                        (candidate) => candidate !== path,
                      ),
                    })
                  }
                >
                  <X size={14} strokeWidth={1.8} />
                </Button>
              </div>
            ))}
            <div className="tasks-editor-file-add">
              <Input
                value={newFilePath}
                aria-label="Absolute file path"
                placeholder="/absolute/path/to/file"
                maxLength={TASK_FILE_MAX_PATH_BYTES}
                disabled={busy || editor.files.length >= TASK_FILES_MAX_COUNT}
                onChange={(event) => setNewFilePath(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addEditorFile();
                  }
                }}
              />
              <Button
                variant="secondary"
                size="icon-sm"
                aria-label="Add file"
                disabled={
                  busy ||
                  newFilePath.trim().length === 0 ||
                  editor.files.length >= TASK_FILES_MAX_COUNT
                }
                onClick={addEditorFile}
              >
                <Plus size={15} strokeWidth={1.8} />
              </Button>
            </div>
          </div>
          <span className="tasks-editor-label">Notes</span>
          <Textarea
            value={editor.details}
            aria-label="Task notes"
            placeholder="Add notes, links, or follow-up steps"
            maxLength={TASK_DETAILS_MAX_CHARACTERS}
            disabled={busy}
            onChange={(event) =>
              setEditor({ ...editor, details: event.target.value })
            }
          />
        </div>
      )}
    </div>
  );
}

export function TasksPanel({
  active = true,
  route: retainedRoute,
  store,
  panelLayoutStore,
}: {
  store: ApplicationClientStore;
  panelLayoutStore: PanelLayoutStore;
  active?: boolean;
  route?: Route;
}): React.JSX.Element | null {
  const preferences = useTasksPanelPreferences();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const close = useCallback(() => setTasksPanelOpen(false), []);
  const activeRef = useRef(active);
  activeRef.current = active;
  const [bodyTarget] = useState(() => {
    const target = document.createElement("div");
    target.style.display = "contents";
    return target;
  });
  const keyboardInset = useKeyboardInset(active && mobile && preferences.open);
  const currentRoute = useRoute();
  const route = retainedRoute ?? currentRoute;
  const rightOffset = usePrimaryRightAnchor(
    active && preferences.open && !mobile,
    route.name === "thread" ? `thread:${route.threadId}` : route.name,
  );
  const widthRef = useRef(0);
  if (widthRef.current === 0) widthRef.current = getTasksPanelWidth();

  useEffect(() => {
    if (!active || !preferences.open || mobile) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector(OTHER_OVERLAY_SELECTOR) !== null) return;
      close();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, preferences.open, mobile, close]);

  if (!preferences.open) return null;

  const surface = mobile ? (
      <Dialog.Root
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content
            className="tasks-sheet"
            onCloseAutoFocus={(event) => {
              if (!activeRef.current) event.preventDefault();
            }}
            onInteractOutside={(event) => {
              // The retained body is portaled into this surface. Its React
              // event ancestry differs from its physical DOM ancestry.
              if (bodyTarget.contains(event.detail.originalEvent.target as Node)) event.preventDefault();
            }}
            aria-describedby={undefined}
            onEscapeKeyDown={(event) => {
              if (
                document.querySelector(
                  '.tasks-sheet [data-task-detail-open="true"]',
                ) !== null
              ) {
                // Android hardware Back dispatches this synthetic Escape.
                // Keep the sheet mounted while its open detail closes; the
                // next Back follows Radix's normal sheet dismissal path.
                event.preventDefault();
                window.dispatchEvent(new Event(CLOSE_TASK_DETAIL_EVENT));
              }
            }}
            style={
              {
                "--tasks-keyboard-inset": `${keyboardInset}px`,
              } as CSSProperties
            }
          >
            <Dialog.Title className="sr-only">Tasks</Dialog.Title>
            <StablePaneSlot target={bodyTarget} style={{ display: "contents" }} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    ) : (
    <DismissableLayer
      asChild
      disableOutsidePointerEvents={false}
      onFocusOutside={(event) => event.preventDefault()}
      onPointerDownOutside={(event) => {
        if (preferences.pinned || bodyTarget.contains(event.detail.originalEvent.target as Node)) event.preventDefault();
      }}
      onEscapeKeyDown={(event) => {
        event.preventDefault();
        close();
      }}
      onDismiss={() => {
        if (!preferences.pinned) close();
      }}
    >
      <section
        id="tasks-panel"
        className="tasks-panel"
        data-slot="tasks-panel"
        data-state="open"
        role="region"
        aria-label="Tasks"
        style={{ right: rightOffset }}
      >
        <PaneResizeHandle
          className="tasks-panel-resize-handle"
          orientation="row"
          reverse
          value={widthRef.current}
          min={tasksPanelWidthMin}
          max={tasksPanelWidthMax}
          resetValue={tasksPanelWidthDefault}
          ariaLabel="Resize Tasks panel"
          normalizeValue={clampTasksPanelWidth}
          onPreview={(width) => {
            widthRef.current = width;
            applyTasksPanelWidth(width);
          }}
          onCommit={(width) => {
            widthRef.current = setTasksPanelWidth(width);
          }}
        />
        <StablePaneSlot target={bodyTarget} style={{ display: "contents" }} />
      </section>
    </DismissableLayer>
  );
  return <>
    {active ? surface : <div hidden aria-hidden="true" inert><StablePaneSlot target={bodyTarget} /></div>}
    {createPortal(<TasksPanelBody store={store} panelLayoutStore={panelLayoutStore}
      route={route} active={active} onClose={close} mobile={mobile} />, bodyTarget)}
  </>;
}
