import { createPortal } from "react-dom";
import { Tooltip } from "radix-ui";
import { StablePaneSlot } from "../../workspace-panels/StablePaneSlot.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@client/components/ui/popover";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AlignLeft,
  ChevronLeft,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownLeft,
  Ellipsis,
  Keyboard,
  ListFilter,
  Pencil,
  Search,
  X,
} from "lucide-react";
import {
  workspaceFileAbsolutePathSchema,
  type AssociatedTask,
  type TaskScope,
} from "../../../shared/index.js";
import {
  TASKS_VIEWS,
  setTasksLastView,
  setTasksViewOptions,
  subscribeReveal,
  useTaskReveal,
  useTasksPanelPreferences,
  useTasksViewOptions,
  type TasksView,
  type TasksViewOptions,
} from "../../app/tasks-panel-store.js";
import {
  TASKS_TOGGLE_COMMAND,
  matchesKeyboardShortcut,
} from "../../app/keyboard-shortcuts.js";
import { navigate, threadPath, useRoute, type Route } from "../../app/router.js";
import { useComposerDraftStaging } from "../../context-excerpts/coordinator.js";
import { useMediaQuery } from "../../app/use-media-query.js";
import { useTouchDensity } from "../../app/use-touch-density.js";
import { CLOSE_TASK_DETAIL_EVENT } from "../../app/android-back.js";
import {
  useApplicationStore,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { ApiError } from "../../api/ApiClient.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import { CountBadge, countBadgeVariants } from "@client/components/ui/count-badge";
import { cn } from "@client/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";
import { EmptyState } from "@client/components/ui/empty-state";
import { KeyValueList } from "@client/components/ui/key-value-list";
import { SearchableSelectList } from "@client/components/ui/searchable-select";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@client/components/ui/segmented-control";
import type { PanelLayoutStore } from "../../workspace-panels/panel-state.js";
import {
  PanelChrome,
  type PanelChromeControls,
} from "../../workspace-panels/PanelChrome.js";
import { resolvePanelPresentation } from "../../workspace-panels/panel-presentation.js";
import { getPanelPresentation } from "../../app/settings.js";
import { createWorkspaceFilesOpenIntent } from "../../workspace-files/open-intent.js";
import {
  useTaskDrag,
  useTaskScopeDropTargets,
  type TaskScopeDropTarget,
} from "../../tasks/task-drag.js";
import { TaskAddRow, EMPTY_TASK_ADD_DRAFT, type TaskAddDraft } from "./TaskAddRow.js";
import { TaskEditDialog } from "./TaskEditDialog.js";
import {
  PendingTaskRow,
  TaskCheck,
  TaskFacts,
  TaskFileChips,
  TaskListHeading,
  TaskListProvider,
  TaskNotes,
  TaskRow,
  TaskRowMenu,
  taskNavKey,
  type TaskAction,
  type TaskListActions,
  type TaskListEnvironment,
} from "./TaskList.js";
import { TaskViewOptionsItems } from "./TaskViewOptions.js";
import { ScopeIcon, useTaskDestinations } from "./task-destinations.js";
import {
  clampView,
  compareCompleted,
  compareOpen,
  destinationScope,
  groupTasks,
  inViewScope,
  matchesOnly,
  matchesQuery,
  normalizeQuery,
  openCount,
  parseScopeKey,
  revealView,
  sameScope,
  scopeKey,
  TASK_PASTE_MAX_TITLES,
  TASKS_VIEW_LABEL,
  viewFilters,
  viewUnavailableReason,
  type TaskGroup,
} from "./task-view-model.js";
import {
  TASKS_SHEET_QUERY,
  TasksHostContext,
  TasksSurface,
  type TasksDock,
  type TasksHost,
  type TasksPresentation,
} from "./tasks-host.js";
import "./tasks-panel.css";

// ───────────────────────────────────────────────────────────────────────────
// Panel content: header and body for one presentation
// ───────────────────────────────────────────────────────────────────────────

export interface TasksPanelContentProps {
  /** Where the content is hosted: a docked workspace panel, a popover, or a phone sheet. */
  readonly presentation: TasksPresentation;
  readonly store: ApplicationClientStore;
  readonly panelLayoutStore: PanelLayoutStore;
  /** The route the panel follows (a retained surface keeps its own). */
  readonly route: Route;
  /**
   * False while the surface is retained but hidden (Settings): its menus
   * and dialogs close and come back, with unsaved edits, when shown again.
   */
  readonly active: boolean;
  /**
   * Closes a popover or sheet: its ×, Escape, and on a phone the actions
   * that continue elsewhere (Add to prompt, opening a file or a thread).
   * An announcement is made by the host, since this content (and its live
   * region) goes with the surface.
   */
  readonly onRequestClose: (announcement?: string) => void;
  /**
   * Docked only: the layout's collapse, dock and close controls. The
   * content then draws its header as the panel's `PanelChrome`, with its
   * own ⋯ items folded into the panel's actions menu.
   */
  readonly panelControls?: PanelChromeControls;
}

type PendingActions = ReadonlyMap<string, ReadonlySet<TaskAction>>;

interface PendingCreate {
  readonly key: string;
  readonly title: string;
  readonly scope: TaskScope;
  readonly createdId?: string;
}

interface PendingMove {
  readonly task: AssociatedTask;
  readonly scope: TaskScope;
}

const NO_PENDING: ReadonlySet<TaskAction> = new Set();

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "That task changed elsewhere. Review it and try again.";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The request failed.";
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.matches(
      'input, textarea, select, [role="combobox"], [role="textbox"]',
    )
  );
}

const ADD_PLACEHOLDER: Record<TasksView, string> = {
  thread: "Add a task to this thread…",
  project: "Add a task to this project…",
  global: "Add a global task…",
  all: "Add a global task…",
};

const EMPTY_TITLE: Record<TasksView, string> = {
  thread: "No tasks for this thread yet.",
  project: "No tasks for this project yet.",
  global: "No global tasks yet.",
  all: "No tasks yet.",
};

const EMPTY_DESCRIPTION: Record<TasksView, string> = {
  thread: "Tasks you add here stay with the conversation.",
  project: "Project tasks are shared by every thread in the project.",
  global: "Global tasks are available from every project and thread.",
  all: "Add a task here, or from a thread or project.",
};

const KEYBOARD_SHORTCUTS: readonly { key: string; action: string }[] = [
  { key: "N", action: "Add a task" },
  { key: "/", action: "Search" },
  { key: "↑ ↓", action: "Move between tasks" },
  { key: "Enter", action: "Show or hide details" },
  { key: "Space", action: "Complete or reopen" },
  { key: "E", action: "Edit" },
  { key: "P", action: "Pin or unpin" },
  { key: "M", action: "Move to…" },
  { key: "Delete", action: "Delete" },
  { key: "Ctrl/⌘ Enter", action: "Add to prompt" },
  { key: "Esc", action: "Close search or details" },
];

/**
 * The Tasks header and body, for a docked panel, a popover or a phone
 * sheet: count and actions, one scope control that follows the current
 * chat, the add row, search, the list (grouped in All) with inline detail,
 * and the Completed section. Pending state is per task and action, so
 * nothing else is ever disabled and focus is never dropped.
 */
export function TasksPanelContent({
  presentation,
  store,
  panelLayoutStore,
  route,
  active,
  onRequestClose,
  panelControls,
}: TasksPanelContentProps): React.JSX.Element {
  const sheet = presentation === "sheet";
  const application = useApplicationStore(store);
  const snapshot = application.snapshot;
  const tasks = useMemo(() => snapshot?.tasks ?? [], [snapshot?.tasks]);
  const composerDraft = useComposerDraftStaging();
  const taskDrag = useTaskDrag();
  const touch = useTouchDensity();
  const destinations = useTaskDestinations(snapshot, route);
  const { context } = destinations;
  const threadId = route.name === "thread" ? route.threadId : undefined;
  const routeThread = threadId
    ? snapshot?.threads.find(({ id }) => id === threadId)
    : undefined;
  const workspace = routeThread
    ? snapshot?.workspaces.find(({ id }) => id === routeThread.workspaceId)
    : undefined;

  const view = clampView(useTasksPanelPreferences().lastView, context);
  const options = useTasksViewOptions(view);
  const setOptions = useCallback(
    (patch: Partial<TasksViewOptions>) => setTasksViewOptions(view, patch),
    [view],
  );
  const projectOptions = useTasksViewOptions("project");

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");
  const [addDraft, setAddDraft] = useState<TaskAddDraft>(EMPTY_TASK_ADD_DRAFT);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [moveMenuId, setMoveMenuId] = useState<string | null>(null);
  const [activeNavKey, setActiveNavKey] = useState<string | null>(null);
  const [completedOpen, setCompletedOpen] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [choosingMoveId, setChoosingMoveId] = useState<string | null>(null);
  const [pendingMove, setPendingMove] = useState<PendingMove>();
  const [pasteTitles, setPasteTitles] = useState<readonly string[] | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [creating, setCreating] = useState<readonly PendingCreate[]>([]);
  const [pending, setPending] = useState<PendingActions>(() => new Map());
  const [revealId, setRevealId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const pendingRef = useRef<PendingActions>(pending);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const addInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocused = useRef<{ key: string; element: HTMLElement } | null>(null);
  const lastNavOrder = useRef<readonly string[]>([]);
  const scopeHintId = useId();

  const announce = useCallback((message: string) => {
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 0);
  }, []);

  // ── Per-task, per-action pending state ──────────────────────────────────
  const markPending = useCallback(
    (taskId: string, action: TaskAction, on: boolean) => {
      const next = new Map(pendingRef.current);
      const actions = new Set(next.get(taskId) ?? []);
      if (on) actions.add(action);
      else actions.delete(action);
      if (actions.size > 0) next.set(taskId, actions);
      else next.delete(taskId);
      pendingRef.current = next;
      setPending(next);
    },
    [],
  );
  /** Runs one action on one task; a repeat while it runs is ignored. */
  const runTask = useCallback(
    async <T,>(
      task: AssociatedTask,
      action: TaskAction,
      operation: () => Promise<T>,
      failure: string,
    ): Promise<{ ok: true; value: T } | { ok: false }> => {
      if (pendingRef.current.get(task.id)?.has(action)) return { ok: false };
      markPending(task.id, action, true);
      try {
        const value = await operation();
        setError(null);
        return { ok: true, value };
      } catch (cause) {
        setError(`${failure} “${task.title}”: ${errorMessage(cause)}`);
        return { ok: false };
      } finally {
        markPending(task.id, action, false);
      }
    },
    [markPending],
  );

  // ── What the view shows ──────────────────────────────────────────────────
  const query = normalizeQuery(searchOpen ? searchText : "");
  const filtered = useMemo(
    () =>
      tasks.filter(
        (task) =>
          inViewScope(task, view, context, options.includeThreadTasks) &&
          matchesQuery(task, query, options.searchNotes) &&
          matchesOnly(task, options),
      ),
    [tasks, view, context, options, query],
  );
  const openTasks = useMemo(
    () =>
      filtered
        .filter(({ completedAt }) => completedAt === null)
        .sort(compareOpen(options.sort)),
    [filtered, options.sort],
  );
  const doneTasks = useMemo(
    () =>
      filtered
        .filter(({ completedAt }) => completedAt !== null)
        .sort(compareCompleted(options.sort)),
    [filtered, options.sort],
  );
  const mainTasks = options.show === "completed" ? doneTasks : openTasks;
  const completedSection = options.show === "open" ? doneTasks : [];
  const groups = useMemo(
    () =>
      view === "all" && options.groupByProject
        ? groupTasks(
            mainTasks,
            {
              workspaces: destinations.workspaceLabels,
              threads: destinations.threadTitles,
            },
            context,
          )
        : undefined,
    [view, options.groupByProject, mainTasks, destinations, context],
  );
  const viewCount = (candidate: TasksView) =>
    openCount(
      tasks,
      candidate,
      context,
      candidate === "project" ? projectOptions.includeThreadTasks : false,
    );
  const destination = destinationScope(view, context);
  const visibleCreating = creating.filter(
    (entry) =>
      (entry.createdId === undefined ||
        !tasks.some(({ id }) => id === entry.createdId)) &&
      destination !== undefined &&
      (view === "all" || sameScope(entry.scope, destination)),
  );

  // The focusable items of the list, in order: the roving tab stop is one of them.
  const navKeys = useMemo(() => {
    const keys: string[] = [];
    const pushGroup = (group: TaskGroup) => {
      keys.push(`group:${group.key}`);
      if (collapsedGroups.has(group.key)) return;
      for (const task of group.tasks) keys.push(taskNavKey(task.id));
      for (const child of group.children) pushGroup(child);
    };
    if (groups) groups.forEach(pushGroup);
    else for (const task of mainTasks) keys.push(taskNavKey(task.id));
    if (completedSection.length > 0) {
      keys.push("completed");
      if (completedOpen) {
        for (const task of completedSection) keys.push(taskNavKey(task.id));
      }
    }
    return keys;
  }, [groups, mainTasks, completedSection, completedOpen, collapsedGroups]);
  const rovingKey =
    activeNavKey !== null && navKeys.includes(activeNavKey)
      ? activeNavKey
      : navKeys[0];

  const expandedTask = expandedId
    ? tasks.find(({ id }) => id === expandedId)
    : undefined;
  const sheetDetail = sheet && expandedTask !== undefined;

  // ── Effects ──────────────────────────────────────────────────────────────
  // Forget optimistic rows once their task has been published.
  useEffect(() => {
    if (
      creating.some(
        (entry) =>
          entry.createdId !== undefined &&
          tasks.some(({ id }) => id === entry.createdId),
      )
    ) {
      setCreating((current) =>
        current.filter(
          (entry) =>
            entry.createdId === undefined ||
            !tasks.some(({ id }) => id === entry.createdId),
        ),
      );
    }
  }, [creating, tasks]);

  // A row the user was on can leave the list (completed into a collapsed
  // section, moved, deleted). Keep keyboard focus in the list: the same
  // task where it went, else its neighbour.
  useLayoutEffect(() => {
    const focused = lastFocused.current;
    const region = listRef.current;
    if (focused && region && !focused.element.isConnected) {
      lastFocused.current = null;
      const activeElement = document.activeElement;
      if (activeElement === null || activeElement === document.body) {
        const find = (key: string) =>
          region.querySelector<HTMLElement>(
            `[data-tasks-nav="${CSS.escape(key)}"]`,
          );
        const index = lastNavOrder.current.indexOf(focused.key);
        const neighbour =
          navKeys[Math.min(Math.max(index, 0), navKeys.length - 1)];
        const target =
          find(focused.key) ?? (neighbour ? find(neighbour) : null);
        (target ?? addInputRef.current)?.focus();
      }
    }
    lastNavOrder.current = navKeys;
  });

  // Reveal requests (transcript "Open task"): switch to a view that holds
  // the task, make it visible, expand it and move focus to it.
  useTaskReveal(({ taskId }) => {
    const task = store.getTasks().find(({ id }) => id === taskId);
    if (!task) return;
    setTasksLastView(revealView(task, context));
    setSearchOpen(false);
    setSearchText("");
    setRevealId(taskId);
  });
  useEffect(() => {
    if (revealId === null) return;
    const task = tasks.find(({ id }) => id === revealId);
    if (!task) {
      setRevealId(null);
      return;
    }
    if (
      !matchesOnly(task, options) ||
      (options.show === "completed" && task.completedAt === null)
    ) {
      setOptions({
        show: "open",
        onlyPinned: false,
        onlyWithNotes: false,
        onlyWithFiles: false,
      });
      return;
    }
    if (task.completedAt !== null && options.show === "open") {
      setCompletedOpen(true);
    }
    const scope = scopeKey(task.scope);
    const parent =
      task.scope.kind === "thread" && task.associatedWorkspaceId
        ? `workspace:${task.associatedWorkspaceId}`
        : undefined;
    setCollapsedGroups((current) => {
      if (!current.has(scope) && (!parent || !current.has(parent))) {
        return current;
      }
      const next = new Set(current);
      next.delete(scope);
      if (parent) next.delete(parent);
      return next;
    });
    setExpandedId(task.id);
    setActiveNavKey(taskNavKey(task.id));
    setRevealId(null);
    setFocusRequest(task.id);
  }, [revealId, tasks, options, setOptions]);

  // Focus a row once it has rendered (reveal, leaving the phone detail).
  useLayoutEffect(() => {
    if (focusRequest === null) return;
    const element = listRef.current?.querySelector<HTMLElement>(
      `[data-tasks-nav="${CSS.escape(taskNavKey(focusRequest))}"]`,
    );
    if (!element) return;
    element.focus({ preventScroll: true });
    element.closest(".tasks-row")?.scrollIntoView({ block: "nearest" });
    setFocusRequest(null);
  });

  // Android Back and Escape close the phone detail before the sheet.
  useEffect(() => {
    if (!active || !sheet) return undefined;
    const closeDetail = () => {
      setExpandedId((current) => {
        if (current !== null) setFocusRequest(current);
        return null;
      });
    };
    window.addEventListener(CLOSE_TASK_DETAIL_EVENT, closeDetail);
    return () => window.removeEventListener(CLOSE_TASK_DETAIL_EVENT, closeDetail);
  }, [active, sheet]);

  // The phone detail replaces the list: focus starts on its back button.
  useEffect(() => {
    if (!sheetDetail) return;
    lastFocused.current = null;
    rootRef.current
      ?.querySelector<HTMLElement>(".tasks-header[data-detail] .tasks-back")
      ?.focus();
  }, [sheetDetail]);

  // An expanded row scrolls into view so its detail is never off-screen.
  useEffect(() => {
    if (sheet || expandedId === null) return;
    listRef.current
      ?.querySelector(`.tasks-row[data-task-id="${CSS.escape(expandedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [expandedId, sheet]);

  // ── Actions ──────────────────────────────────────────────────────────────
  const setCompleted = useCallback(
    async (task: AssociatedTask, completed: boolean) => {
      const result = await runTask(
        task,
        "complete",
        () => store.updateTask(task, { completed }),
        completed ? "Couldn't complete" : "Couldn't reopen",
      );
      if (!result.ok) return;
      announce(completed ? `Completed “${task.title}”.` : `Reopened “${task.title}”.`);
    },
    [announce, runTask, store],
  );

  const moveNow = useCallback(
    async (task: AssociatedTask, scope: TaskScope) => {
      markPending(task.id, "move", true);
      try {
        await store.moveTask(task, scope);
      } finally {
        markPending(task.id, "move", false);
      }
      setError(null);
      announce(`Moved “${task.title}” to ${destinations.label(scope)}.`);
    },
    [announce, destinations, markPending, store],
  );

  const moveTo = useCallback(
    (task: AssociatedTask, scope: TaskScope) => {
      if (sameScope(task.scope, scope)) return;
      if (pendingRef.current.get(task.id)?.has("move")) return;
      const targetProject =
        scope.kind === "global"
          ? null
          : scope.kind === "workspace"
            ? scope.workspaceId
            : (snapshot?.threads.find(({ id }) => id === scope.threadId)
                ?.workspaceId ?? null);
      if (
        task.files.length > 0 &&
        task.associatedWorkspaceId !== null &&
        task.associatedWorkspaceId !== targetProject
      ) {
        setPendingMove({ task, scope });
        return;
      }
      void moveNow(task, scope).catch((cause: unknown) =>
        setError(`Couldn't move “${task.title}”: ${errorMessage(cause)}`),
      );
    },
    [moveNow, snapshot?.threads],
  );

  const addToPrompt = useCallback(
    (task: AssociatedTask) => {
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
      const message = `Added “${task.title}” to the prompt.`;
      // On a phone the sheet closes, so the chip arriving is visible.
      if (sheet) onRequestClose(message);
      else announce(message);
    },
    [announce, composerDraft, onRequestClose, sheet, threadId],
  );

  const openFile = useCallback(
    async (absolutePath: string, event: ReactMouseEvent) => {
      if (!workspace?.available) return;
      const presentationMode = resolvePanelPresentation(
        getPanelPresentation(),
        event.shiftKey,
      );
      if (!workspaceFileAbsolutePathSchema.safeParse(absolutePath).success) {
        setError("That file isn't available in Files.");
        return;
      }
      try {
        const resolved = await store.api.resolveWorkspaceFileLink(workspace.id, {
          kind: "absolute",
          path: absolutePath,
        });
        if (resolved.status === "not_found") {
          setError("That file isn't available in Files.");
          return;
        }
        setError(null);
        const opened = panelLayoutStore.openPanel("workspace-files", {
          presentation: presentationMode,
          intent: createWorkspaceFilesOpenIntent({
            workspaceId: workspace.id,
            rootId: resolved.rootId,
            path: resolved.path,
            rootVisibility: resolved.rootVisibility,
            target: { kind: "file" },
          }),
        });
        if (sheet && opened) onRequestClose();
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [onRequestClose, panelLayoutStore, sheet, store, workspace],
  );

  const actions: TaskListActions = useMemo(
    () => ({
      toggleComplete: (task) =>
        void setCompleted(task, task.completedAt === null),
      togglePin: (task) =>
        void runTask(
          task,
          "pin",
          () => store.updateTask(task, { pinned: !task.pinned }),
          task.pinned ? "Couldn't unpin" : "Couldn't pin",
        ),
      addToPrompt,
      edit: (task) => setEditingId(task.id),
      requestDelete: (task) => setDeletingId(task.id),
      moveTo,
      chooseMove: (task) => setChoosingMoveId(task.id),
      openFile: (path, event) => void openFile(path, event),
      openThread: (id) => {
        navigate(threadPath(id));
        if (sheet) onRequestClose();
      },
    }),
    [addToPrompt, moveTo, onRequestClose, openFile, runTask, setCompleted, sheet, store],
  );

  const environment: TaskListEnvironment = useMemo(
    () => ({
      actions,
      destinations,
      touch,
      surfaceActive: active,
      ...(threadId === undefined
        ? { promptUnavailable: "Open a thread to add this task to its prompt." }
        : {}),
      filesOpenable: Boolean(workspace?.available),
      ...(taskDrag ? { taskDrag } : {}),
      pending: (taskId: string) => pending.get(taskId) ?? NO_PENDING,
    }),
    [actions, active, destinations, pending, taskDrag, threadId, touch, workspace?.available],
  );

  const addTask = (title: string, notes: string) => {
    if (!destination) return;
    const key = crypto.randomUUID();
    setCreating((current) => [...current, { key, title, scope: destination }]);
    void store.createTask(title, destination, notes || undefined).then(
      (created) => {
        setError(null);
        setCreating((current) =>
          current.map((entry) =>
            entry.key === key ? { ...entry, createdId: created.id } : entry,
          ),
        );
        announce(`Added “${title}”.`);
      },
      (cause: unknown) => {
        setCreating((current) => current.filter((entry) => entry.key !== key));
        setError(`Couldn't add “${title}”: ${errorMessage(cause)}`);
        // Give the text back unless the next task is already being typed.
        setAddDraft((draft) =>
          draft.title.length === 0 && !draft.notesOpen
            ? { title, notes, notesOpen: notes.length > 0 }
            : draft,
        );
      },
    );
  };

  const toggleExpanded = (task: AssociatedTask) => {
    setActiveNavKey(taskNavKey(task.id));
    setMoveMenuId(null);
    setExpandedId((current) => (current === task.id ? null : task.id));
  };

  const changeView = (next: TasksView) => {
    if (viewUnavailableReason(next, context) !== undefined) return;
    setTasksLastView(next);
    setError(null);
  };

  // The search input focuses itself as it mounts.
  const openSearch = () => {
    if (searchInputRef.current) searchInputRef.current.focus();
    else setSearchOpen(true);
  };
  const closeSearch = () => {
    setSearchOpen(false);
    setSearchText("");
    searchButtonRef.current?.focus();
  };

  const focusAdd = (withNotes = false) => {
    if (withNotes) setAddDraft((draft) => ({ ...draft, notesOpen: true }));
    if (addInputRef.current) {
      addInputRef.current.focus();
      return;
    }
    // The phone detail hides the add bar until the list is back.
    setExpandedId(null);
    requestAnimationFrame(() => addInputRef.current?.focus());
  };

  // ── Keyboard ─────────────────────────────────────────────────────────────
  const onTitleKeyDown = (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    task: AssociatedTask,
  ) => {
    if (event.nativeEvent.isComposing) return;
    const primary = event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && primary) {
      event.preventDefault();
      actions.addToPrompt(task);
      return;
    }
    if (primary || event.altKey) return;
    switch (event.key) {
      case " ":
        event.preventDefault();
        actions.toggleComplete(task);
        return;
      case "e":
      case "E":
        event.preventDefault();
        actions.edit(task);
        return;
      case "p":
      case "P":
        event.preventDefault();
        actions.togglePin(task);
        return;
      case "m":
      case "M":
        event.preventDefault();
        if (sheet) {
          actions.chooseMove(task);
        } else {
          setExpandedId(task.id);
          setMoveMenuId(task.id);
        }
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        actions.requestDelete(task);
        return;
      case "ArrowRight":
        event.preventDefault();
        event.currentTarget
          .closest(".tasks-row-main")
          ?.querySelector<HTMLElement>(".tasks-row-more")
          ?.focus();
        return;
    }
  };

  const onHeadingKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
      if ((event.key === "ArrowRight") !== expanded) {
        event.preventDefault();
        event.currentTarget.click();
      }
    }
  };

  /** ↑/↓/Home/End between the list's focusable items. */
  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (!event.currentTarget.contains(target) || !target.dataset.tasksNav) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const items = [
      ...event.currentTarget.querySelectorAll<HTMLElement>("[data-tasks-nav]"),
    ];
    const index = items.indexOf(target);
    const next =
      event.key === "ArrowDown"
        ? items[Math.min(index + 1, items.length - 1)]
        : event.key === "ArrowUp"
          ? items[Math.max(index - 1, 0)]
          : event.key === "Home"
            ? items[0]
            : event.key === "End"
              ? items.at(-1)
              : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const onListFocus = (event: React.FocusEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    const key = target.dataset.tasksNav;
    if (key) {
      lastFocused.current = { key, element: target };
      setActiveNavKey(key);
    }
  };
  // Focus that leaves on its own (to another control, or a click elsewhere)
  // is not restored; only a row removed from under it is.
  const onListBlur = (event: React.FocusEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement;
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    requestAnimationFrame(() => {
      if (element.isConnected && lastFocused.current?.element === element) {
        lastFocused.current = null;
      }
    });
  };

  /**
   * Escape inside the content closes one layer at a time: the expanded row
   * (or the phone detail), then search, then a popover or sheet. Fields
   * that use Escape themselves (search, the add row) stop it first. The
   * host leaves Escape from inside the content to this handler.
   */
  const onRootKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    // Menus and dialogs portal elsewhere but bubble here through React.
    if (!event.currentTarget.contains(event.target as Node)) return;
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (expandedId !== null) {
        setFocusRequest(expandedId);
        setExpandedId(null);
        setMoveMenuId(null);
      } else if (searchOpen) {
        closeSearch();
      } else if (presentation !== "panel") {
        onRequestClose();
      }
      return;
    }
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "n" || event.key === "N") {
      event.preventDefault();
      focusAdd();
    } else if (event.key === "/") {
      event.preventDefault();
      openSearch();
    }
  };

  // ── Drag onto a scope segment, or the list, moves the task there ────────
  // The drag controller confirms a move across projects for a task with
  // files, as for every other drop.
  const draggedTask = taskDrag?.activeTaskId
    ? tasks.find(({ id }) => id === taskDrag.activeTaskId)
    : undefined;
  const scopeDrop = useTaskScopeDropTargets<TasksView>();
  /** Where a drop on a view's segment moves the dragged task; All has no one place. */
  const scopeDropTarget = (
    candidate: TasksView,
  ): TaskScopeDropTarget | undefined => {
    if (candidate === "all" || !draggedTask) return undefined;
    const scope = destinationScope(candidate, context);
    if (!scope || sameScope(draggedTask.scope, scope)) return undefined;
    const workspaceId =
      scope.kind === "global"
        ? null
        : scope.kind === "workspace"
          ? scope.workspaceId
          : (context.thread?.workspaceId ?? null);
    return {
      scope,
      label: destinations.label(scope),
      workspaceId,
      workspaceLabel:
        workspaceId === null
          ? destinations.label({ kind: "global" })
          : destinations.label({ kind: "workspace", workspaceId }),
    };
  };

  // ── Rendering ────────────────────────────────────────────────────────────
  const searchFiltering = query.length > 0;
  // Lists that mix scopes without group headings say where each task
  // belongs: All ungrouped, and Project with its threads' tasks.
  const showLocation =
    (view === "all" && !options.groupByProject) ||
    (view === "project" && options.includeThreadTasks);
  const locationOf = (task: AssociatedTask) => {
    const label = destinations.label(task.scope);
    const project =
      view === "all" &&
      task.scope.kind === "thread" &&
      task.associatedWorkspaceId !== null
        ? destinations.workspaceLabels.get(task.associatedWorkspaceId)
        : undefined;
    return {
      kind: task.scope.kind,
      label: project ? `${label} · ${project}` : label,
    };
  };
  const filters = viewFilters(options);
  const filtering = filters.length > 0;
  const renderRow = (task: AssociatedTask) => (
    <TaskRow
      key={task.id}
      task={task}
      expanded={expandedId === task.id}
      {...(showLocation ? { location: locationOf(task) } : {})}
      focusable={rovingKey === taskNavKey(task.id)}
      inlineDetail={!sheet}
      moveOpen={moveMenuId === task.id}
      onMoveOpenChange={(open) => setMoveMenuId(open ? task.id : null)}
      onToggle={toggleExpanded}
      onTitleKeyDown={onTitleKeyDown}
    />
  );
  const toggleGroup = (key: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const renderGroup = (group: TaskGroup): React.JSX.Element => {
    const collapsed = collapsedGroups.has(group.key);
    const navKey = `group:${group.key}`;
    return (
      <li key={group.key} className="tasks-group" data-kind={group.kind}>
        <TaskListHeading
          variant="group"
          navKey={navKey}
          focusable={rovingKey === navKey}
          expanded={!collapsed}
          onToggle={() => toggleGroup(group.key)}
          onKeyDown={onHeadingKeyDown}
          icon={<ScopeIcon kind={group.kind} className="tasks-heading-icon" />}
          label={group.label}
          count={group.count}
        />
        {!collapsed && (
          <ul className="tasks-list" aria-label={group.label}>
            {group.tasks.map(renderRow)}
            {group.children.map(renderGroup)}
          </ul>
        )}
      </li>
    );
  };

  const emptyState = (() => {
    if (mainTasks.length > 0 || visibleCreating.length > 0) return null;
    if (searchFiltering) {
      return (
        <EmptyState
          variant="inline"
          className="tasks-empty"
          title={`No tasks match “${searchText.trim()}”.`}
          action={
            <Button variant="ghost" size="sm" onClick={closeSearch}>
              Clear search
            </Button>
          }
        />
      );
    }
    if (filtering) {
      const nothing = options.show === "completed" && !options.onlyPinned && !options.onlyWithNotes && !options.onlyWithFiles;
      return (
        <EmptyState
          variant="inline"
          className="tasks-empty"
          title={nothing ? "No completed tasks." : "No tasks match the view options."}
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setOptions({
                  show: "open",
                  onlyPinned: false,
                  onlyWithNotes: false,
                  onlyWithFiles: false,
                })
              }
            >
              {nothing ? "Show open tasks" : "Reset view options"}
            </Button>
          }
        />
      );
    }
    if (completedSection.length > 0) {
      return (
        <EmptyState
          variant="inline"
          className="tasks-empty"
          title="All done."
          description="Every task here is completed."
        />
      );
    }
    return (
      <EmptyState
        variant="inline"
        className="tasks-empty"
        title={EMPTY_TITLE[view]}
        description={EMPTY_DESCRIPTION[view]}
      />
    );
  })();

  const scopeControl = (
    <SegmentedControl
      aria-label="Task scope view"
      aria-describedby={scopeHintId}
      className="tasks-scope"
      value={view}
      onValueChange={(value) => {
        const next = TASKS_VIEWS.find((candidate) => candidate === value);
        if (next) changeView(next);
      }}
    >
      {TASKS_VIEWS.map((candidate) => {
        const reason = viewUnavailableReason(candidate, context);
        const segment = (
          <SegmentedControlItem
            value={candidate}
            disabled={reason !== undefined}
            className="tasks-scope-item"
            // A phone sheet opens on the view, not the add bar, so the
            // soft keyboard does not cover the list on every open.
            data-autofocus={sheet && candidate === view ? "" : undefined}
            aria-describedby={`${scopeHintId}-${candidate}`}
            {...scopeDrop.props(candidate, scopeDropTarget(candidate))}
          >
            {TASKS_VIEW_LABEL[candidate]}
            {reason === undefined && (
              <span className="tasks-scope-count" aria-hidden="true">
                {viewCount(candidate)}
              </span>
            )}
          </SegmentedControlItem>
        );
        const description = (
          <span id={`${scopeHintId}-${candidate}`} className="sr-only">
            {reason ?? `${viewCount(candidate)} open`}
          </span>
        );
        return reason === undefined ? (
          <span key={candidate} className="tasks-scope-slot">
            {segment}
            {description}
          </span>
        ) : (
          <UnavailableScopeSlot key={candidate} reason={reason}>
            {segment}
            {description}
          </UnavailableScopeSlot>
        );
      })}
    </SegmentedControl>
  );
  const scopeHint = TASKS_VIEWS.map((candidate) => {
    const reason = viewUnavailableReason(candidate, context);
    return reason ? `${TASKS_VIEW_LABEL[candidate]}: ${reason}` : undefined;
  })
    .filter(Boolean)
    .join(" ");

  // ⋯: the docked panel folds these into its actions menu instead.
  const moreItems = (
    <>
      <DropdownMenuItem onSelect={() => focusAdd(true)}>
        <AlignLeft />
        <span>Add a task with notes</span>
      </DropdownMenuItem>
      {groups && groups.length > 0 && (
        <DropdownMenuItem
          onSelect={() =>
            setCollapsedGroups(
              collapsedGroups.size > 0
                ? new Set()
                : new Set(
                    groups.flatMap((group) => [
                      group.key,
                      ...group.children.map(({ key }) => key),
                    ]),
                  ),
            )
          }
        >
          {collapsedGroups.size > 0 ? <ChevronsUpDown /> : <ChevronsDownUp />}
          <span>
            {collapsedGroups.size > 0 ? "Expand all groups" : "Collapse all groups"}
          </span>
        </DropdownMenuItem>
      )}
      {!touch && (
        <DropdownMenuItem onSelect={() => setShortcutsOpen(true)}>
          <Keyboard />
          <span>Keyboard shortcuts</span>
        </DropdownMenuItem>
      )}
    </>
  );

  const searchButton = (
    <Button
      ref={searchButtonRef}
      variant="ghost"
      size="icon-sm"
      className="tasks-header-button"
      aria-label="Search tasks"
      aria-pressed={searchOpen}
      title="Search (/)"
      onClick={() => (searchOpen ? closeSearch() : openSearch())}
    >
      <Search aria-hidden="true" />
    </Button>
  );

  // Phones have no room for it: the sheet's ⋯ carries the View options.
  const viewOptionsMenu = !sheet && (
    <DropdownMenu open={active && viewMenuOpen} onOpenChange={setViewMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="tasks-header-button"
          aria-label="View options"
          title="View options"
          data-filtering={filtering || undefined}
        >
          <ListFilter aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="View options">
        <TaskViewOptionsItems view={view} options={options} onChange={setOptions} />
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const closeButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      className="tasks-header-button"
      aria-label="Close Tasks panel"
      title="Close"
      onClick={() => onRequestClose()}
    >
      <X aria-hidden="true" />
    </Button>
  );

  // The header counts what the list shows, like the segments when nothing
  // narrows it; search or an Only option makes it "1 of 3", out of the
  // segment's count. Show › Completed counts completed tasks.
  const listedKind = options.show === "completed" ? "completed" : "open";
  const listedTotal =
    options.show === "completed"
      ? tasks.filter(
          (task) =>
            task.completedAt !== null &&
            inViewScope(task, view, context, options.includeThreadTasks),
        ).length
      : viewCount(view);
  const countBadge =
    mainTasks.length === listedTotal ? (
      <CountBadge
        count={listedTotal}
        className="tasks-title-count"
        aria-label={`${listedTotal} ${listedKind}`}
      />
    ) : (
      <span
        data-slot="count-badge"
        data-tone="neutral"
        className={cn(countBadgeVariants(), "tasks-title-count")}
        aria-label={`${mainTasks.length} of ${listedTotal} ${listedKind} shown`}
      >
        {mainTasks.length} of {listedTotal}
      </span>
    );

  // Removing a chip moves focus to its neighbour, else to the scope.
  const filtersRef = useRef<HTMLDivElement>(null);
  const removeFilter = (index: number) => {
    const filter = filters[index];
    if (!filter) return;
    setOptions(filter.clear);
    const keys = filters.map(({ key }) => key);
    const next = keys[index + 1] ?? keys[index - 1];
    requestAnimationFrame(() => {
      const target = next
        ? filtersRef.current?.querySelector<HTMLElement>(`[data-filter="${next}"]`)
        : rootRef.current?.querySelector<HTMLElement>(
            '.tasks-scope-item[data-state="on"]',
          );
      target?.focus();
    });
  };
  const filterChips = filtering && (
    <div
      ref={filtersRef}
      className="tasks-filters"
      role="group"
      aria-label="View filters"
    >
      {filters.map((filter, index) => (
        <Button
          key={filter.key}
          variant="outline"
          size="sm"
          className="tasks-filter-chip"
          data-filter={filter.key}
          aria-label={`Remove filter: ${filter.label}`}
          onClick={() => removeFilter(index)}
        >
          {filter.label}
          <X data-icon="inline-end" aria-hidden="true" />
        </Button>
      ))}
    </div>
  );

  const header = sheetDetail ? (
    <header className="tasks-header" data-detail="true">
      <Button
        variant="ghost"
        size="icon-sm"
        className="tasks-header-button tasks-back"
        aria-label="Back to tasks"
        onClick={() => {
          setFocusRequest(expandedTask.id);
          setExpandedId(null);
        }}
      >
        <ChevronLeft aria-hidden="true" />
      </Button>
      <h2 className="tasks-title">Task</h2>
      <div className="tasks-header-actions">
        <TaskRowMenu
          task={expandedTask}
          focusable
          trigger={
            <Button
              variant="ghost"
              size="icon-sm"
              className="tasks-header-button"
              aria-label={`Actions for "${expandedTask.title}"`}
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          }
        />
        {closeButton}
      </div>
    </header>
  ) : presentation === "panel" && panelControls ? (
    // Docked: the panel family's header, with the layout's collapse, dock
    // and close controls and one actions menu.
    <PanelChrome
      className="tasks-header-chrome"
      panelTitle="Tasks"
      leading={
        <div className="workspace-panel-title">
          <span>Tasks</span>
          {countBadge}
        </div>
      }
      panelActions={
        <>
          {searchButton}
          {viewOptionsMenu}
        </>
      }
      controls={{ ...panelControls, renderMenuItems: moreItems }}
    />
  ) : (
    <header className="tasks-header">
      <h2 className="tasks-title">
        Tasks
        {countBadge}
      </h2>
      <div className="tasks-header-actions">
        {searchButton}
        {viewOptionsMenu}
        <DropdownMenu
          presentation={touch ? "sheet" : "menu"}
          open={active && headerMenuOpen}
          onOpenChange={setHeaderMenuOpen}
        >
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="tasks-header-button"
              aria-label="Tasks panel options"
              title="More"
            >
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sheetTitle="Tasks">
            {sheet && (
              <>
                <TaskViewOptionsItems view={view} options={options} onChange={setOptions} />
                <DropdownMenuSeparator />
              </>
            )}
            {moreItems}
          </DropdownMenuContent>
        </DropdownMenu>
        {closeButton}
      </div>
    </header>
  );

  const addRow = (
    <TaskAddRow
      variant={sheet ? "bar" : "row"}
      placeholder={ADD_PLACEHOLDER[view]}
      draft={addDraft}
      inputRef={addInputRef}
      onDraftChange={setAddDraft}
      onAdd={addTask}
      onPasteMany={setPasteTitles}
    />
  );

  const list = (
    <div
      ref={listRef}
      className="tasks-scroll"
      {...scopeDrop.props(view, scopeDropTarget(view))}
      onKeyDown={onListKeyDown}
      onFocus={onListFocus}
      onBlur={onListBlur}
    >
      {groups ? (
        <ul className="tasks-list" aria-label={`${TASKS_VIEW_LABEL[view]} tasks`}>
          {visibleCreating.map((entry) => (
            <PendingTaskRow key={entry.key} title={entry.title} />
          ))}
          {groups.map(renderGroup)}
        </ul>
      ) : (
        <ul className="tasks-list" aria-label={`${TASKS_VIEW_LABEL[view]} tasks`}>
          {visibleCreating.map((entry) => (
            <PendingTaskRow key={entry.key} title={entry.title} />
          ))}
          {mainTasks.map(renderRow)}
        </ul>
      )}
      {emptyState}
      {completedSection.length > 0 && (
        <section className="tasks-section" aria-label="Completed tasks">
          <TaskListHeading
            variant="section"
            navKey="completed"
            focusable={rovingKey === "completed"}
            expanded={completedOpen}
            onToggle={() => setCompletedOpen((open) => !open)}
            onKeyDown={onHeadingKeyDown}
            label="Completed"
            count={completedSection.length}
          />
          {completedOpen && (
            <ul className="tasks-list" aria-label="Completed tasks">
              {completedSection.map(renderRow)}
            </ul>
          )}
        </section>
      )}
    </div>
  );

  const errorCallout = error && (
    <div className="tasks-alert">
      <Callout tone="danger" role="alert">
        {error}
      </Callout>
      <Button
        variant="ghost"
        size="icon-xs"
        className="tasks-alert-dismiss"
        aria-label="Dismiss error"
        onClick={() => setError(null)}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );

  const searchRow = searchOpen && !sheetDetail && (
    <div className="tasks-search">
      <Search className="tasks-search-icon" aria-hidden="true" />
      <input
        ref={searchInputRef}
        autoFocus
        type="text"
        className="tasks-search-input"
        aria-label="Search tasks"
        placeholder={options.searchNotes ? "Search titles and notes" : "Search titles"}
        autoComplete="off"
        maxLength={240}
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            closeSearch();
          }
        }}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close search"
        onClick={closeSearch}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
  );

  const deletingTask = deletingId ? tasks.find(({ id }) => id === deletingId) : undefined;
  const editingTask = editingId ? tasks.find(({ id }) => id === editingId) : undefined;
  const choosingTask = choosingMoveId
    ? tasks.find(({ id }) => id === choosingMoveId)
    : undefined;
  const neighbourFocus = (taskId: string) => () => {
    const index = navKeys.indexOf(taskNavKey(taskId));
    const key = navKeys[index + 1] ?? navKeys[index - 1];
    return key
      ? listRef.current?.querySelector<HTMLElement>(
          `[data-tasks-nav="${CSS.escape(key)}"]`,
        )
      : addInputRef.current;
  };

  return (
    <TaskListProvider value={environment}>
      <div
        ref={rootRef}
        className="tasks-content"
        data-presentation={presentation}
        data-touch={touch || undefined}
        data-task-detail-open={sheetDetail || undefined}
        onKeyDown={onRootKeyDown}
      >
        {header}
        {sheetDetail ? (
          <>
            <div className="tasks-sheet-detail">
              <div className="tasks-sheet-detail-title">
                <TaskCheck task={expandedTask} className="tasks-check" />
                <h3>{expandedTask.title}</h3>
              </div>
              <TaskNotes task={expandedTask} />
              <TaskFileChips task={expandedTask} />
              <TaskFacts task={expandedTask} />
            </div>
            {errorCallout}
            <div className="tasks-sheet-actions">
              <Button
                variant="outline"
                size="lg"
                onClick={() => actions.edit(expandedTask)}
              >
                <Pencil aria-hidden="true" />
                Edit
              </Button>
              <Button
                size="lg"
                disabled={threadId === undefined}
                onClick={() => actions.addToPrompt(expandedTask)}
              >
                <CornerDownLeft aria-hidden="true" />
                Add to prompt
              </Button>
            </div>
          </>
        ) : (
          <>
            {searchRow}
            <div className="tasks-toolbar">
              {scopeControl}
              <span id={scopeHintId} className="sr-only">
                {scopeHint}
              </span>
              {filterChips}
              {!sheet && addRow}
            </div>
            {errorCallout}
            {list}
            {sheet && addRow}
          </>
        )}
        <div className="sr-only" role="status" aria-live="polite">
          {announcement}
        </div>
      </div>

      {editingId !== null && (
        <TaskEditDialog
          key={editingId}
          task={editingTask}
          open={active}
            store={store}
          destinations={destinations}
          onClose={() => setEditingId(null)}
        />
      )}
      <ConfirmDialog
        open={active && deletingTask !== undefined}
        tone="danger"
        title="Delete task?"
        description={`“${deletingTask?.title ?? ""}” will be deleted permanently. Prompts that already carry it keep their copy.`}
        confirmLabel="Delete task"
        pendingLabel="Deleting…"
        fallbackFocus={deletingTask ? neighbourFocus(deletingTask.id) : undefined}
        onOpenChange={(open) => {
          if (!open) setDeletingId(null);
        }}
        onConfirm={async () => {
          if (!deletingTask) return;
          markPending(deletingTask.id, "delete", true);
          try {
            await store.deleteTask(deletingTask.id);
          } finally {
            markPending(deletingTask.id, "delete", false);
          }
          if (expandedId === deletingTask.id) setExpandedId(null);
          announce(`Deleted “${deletingTask.title}”.`);
        }}
      />
      <ConfirmDialog
        open={active && pendingMove !== undefined}
        title="Move task with project files?"
        description={`This task links to project files. Moving it to ${pendingMove ? destinations.label(pendingMove.scope) : "another place"} keeps those absolute file paths unchanged.`}
        confirmLabel="Move task"
        pendingLabel="Moving…"
        onOpenChange={(open) => {
          if (!open) setPendingMove(undefined);
        }}
        onConfirm={async () => {
          if (!pendingMove) return;
          await moveNow(pendingMove.task, pendingMove.scope);
        }}
      />
      <ConfirmDialog
        open={active && pasteTitles !== null}
        title={`Create ${pasteTitles?.length ?? 0} tasks?`}
        description={`Each pasted line becomes a task${destination ? ` in ${destinations.label(destination)}` : ""}.`}
        confirmLabel={`Create ${pasteTitles?.length ?? 0} tasks`}
        pendingLabel="Creating…"
        blockers={
          (pasteTitles?.length ?? 0) > TASK_PASTE_MAX_TITLES
            ? [`Paste at most ${TASK_PASTE_MAX_TITLES} lines at a time.`]
            : []
        }
        onOpenChange={(open) => {
          if (!open) setPasteTitles(null);
        }}
        onConfirm={async () => {
          if (!pasteTitles || !destination) return;
          // Created last-first, so the newest-first list reads in pasted order.
          const remaining = [...pasteTitles];
          while (remaining.length > 0) {
            const title = remaining.at(-1)!;
            try {
              await store.createTask(title, destination);
            } catch (cause) {
              setPasteTitles([...remaining]);
              throw cause;
            }
            remaining.pop();
          }
          announce(`Added ${pasteTitles.length} tasks.`);
          setError(null);
        }}
      >
        <ul className="tasks-paste-preview">
          {(pasteTitles ?? []).slice(0, 6).map((title, index) => (
            <li key={index}>{title}</li>
          ))}
          {(pasteTitles?.length ?? 0) > 6 && (
            <li className="tasks-paste-more">
              and {(pasteTitles?.length ?? 0) - 6} more
            </li>
          )}
        </ul>
      </ConfirmDialog>
      <Dialog
        open={active && choosingTask !== undefined}
        onOpenChange={(open) => {
          if (!open) setChoosingMoveId(null);
        }}
      >
        <DialogContent
          size="sm"
            mobile="sheet"
          className="searchable-select-sheet tasks-move-dialog"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>Move task</DialogTitle>
          </DialogHeader>
          {choosingTask && (
            <SearchableSelectList
              label="Destination"
              searchLabel="Search threads and projects"
              emptyLabel="No matching threads or projects."
              value={scopeKey(choosingTask.scope)}
              options={destinations.options(choosingTask.scope)}
              initialDirection="first"
              onValueChange={(value) => {
                const scope = parseScopeKey(value);
                setChoosingMoveId(null);
                if (scope) moveTo(choosingTask, scope);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={active && shortcutsOpen} onOpenChange={setShortcutsOpen}>
        <DialogContent size="sm" aria-describedby={undefined}>
          <DialogHeader>
            <DialogTitle>Tasks keyboard shortcuts</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="tasks-shortcuts-note">
              They work while focus is in Tasks and not in a text field.
            </p>
            <KeyValueList
              items={KEYBOARD_SHORTCUTS.map(({ key, action }) => ({
                key,
                label: <kbd className="tasks-kbd">{key}</kbd>,
                value: action,
              }))}
            />
          </DialogBody>
        </DialogContent>
      </Dialog>
    </TaskListProvider>
  );
}

/**
 * The slot of a scope segment that does not apply. A disabled segment takes
 * neither focus nor pointer events, so its slot shows the reason: a tooltip
 * on hover, and on a tap or click, which is all touch has. Keyboard and
 * screen-reader users have it in the control's description.
 */
function UnavailableScopeSlot({
  reason,
  children,
}: {
  readonly reason: string;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={300}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <span
            className="tasks-scope-slot"
            data-unavailable=""
            onClick={(event) => {
              // The trigger would close the tooltip on a click.
              event.preventDefault();
              setOpen(true);
            }}
          >
            {children}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            className="lineage-tooltip"
            side="bottom"
            sideOffset={6}
            collisionPadding={8}
          >
            {reason}
            <Tooltip.Arrow className="lineage-tooltip-arrow" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

function createBodyTarget(): HTMLElement {
  const target = document.createElement("div");
  target.style.display = "contents";
  return target;
}

/** Interaction inside a menu, picker or dialog layered above the popover. */
function insideOtherLayer(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      '[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"], [data-slot="popover-content"], [data-slot="dropdown-menu-content"]',
    ) !== null
  );
}

/**
 * The Tasks host: one retained body, shown docked beside Chat in a thread
 * workspace, as a popover on pages without panels, and as a sheet on phones.
 * It wraps the workbench so its toggles and the `tasks` panel tenant reach
 * it through context.
 */
export function TasksPanel({
  active = true,
  route: retainedRoute,
  store,
  panelLayoutStore,
  children,
}: {
  store: ApplicationClientStore;
  panelLayoutStore: PanelLayoutStore;
  active?: boolean;
  route?: Route;
  children?: ReactNode;
}): React.JSX.Element {
  const mobile = useMediaQuery(TASKS_SHEET_QUERY);
  const currentRoute = useRoute();
  const route = retainedRoute ?? currentRoute;
  const threadWorkspace = route.name === "thread";
  const routeKey = threadWorkspace ? `thread:${route.threadId}` : route.name;
  const [overlayOpen, setOverlayOpen] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [dock, publishDock] = useState<TasksDock>();
  const [bodyTarget] = useState(createBodyTarget);
  const popoverAnchor = useRef<HTMLElement | null>(null);
  const dismissedOutside = useRef(false);
  // Settings unmounts the popover and the sheet; their focus restoration
  // must not pull focus back into the hidden workspace.
  const activeRef = useRef(active);
  activeRef.current = active;

  // The popover and the sheet are transient: navigating or crossing the
  // phone breakpoint closes them. The docked panel's open state is the
  // panel layout's.
  useEffect(() => setOverlayOpen(false), [routeKey, mobile]);

  const placement: TasksPresentation | undefined = mobile
    ? overlayOpen
      ? "sheet"
      : undefined
    : threadWorkspace
      ? dock?.present
        ? "panel"
        : undefined
      : overlayOpen
        ? "popover"
        : undefined;

  const latest = useRef({ mobile, threadWorkspace, dock, placement });
  latest.current = { mobile, threadWorkspace, dock, placement };

  const toggleOverlay = useCallback(
    () => setOverlayOpen((open) => !open),
    [],
  );
  const requestClose = useCallback((message?: string) => {
    if (latest.current.placement === "panel") latest.current.dock?.close();
    else setOverlayOpen(false);
    if (message === undefined) return;
    setAnnouncement("");
    window.setTimeout(() => setAnnouncement(message), 0);
  }, []);
  const toggle = useCallback(() => {
    const { mobile, threadWorkspace, dock } = latest.current;
    if (!mobile && threadWorkspace) dock?.toggle();
    else toggleOverlay();
  }, [toggleOverlay]);

  useEffect(
    () =>
      subscribeReveal(() => {
        const { mobile, threadWorkspace, dock } = latest.current;
        // The content switches view and expands the task itself.
        if (!mobile && threadWorkspace) dock?.open({ focus: false });
        else setOverlayOpen(true);
      }),
    [],
  );

  useEffect(() => {
    if (!active) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.repeat) return;
      if (!matchesKeyboardShortcut(event, TASKS_TOGGLE_COMMAND.defaultBinding))
        return;
      // A dialog above the workbench keeps its keys, unless it is Tasks.
      const dialog =
        event.target instanceof Element
          ? event.target.closest('[role="dialog"], [role="alertdialog"]')
          : null;
      if (dialog && !dialog.querySelector('[data-slot="tasks-panel"]')) return;
      event.preventDefault();
      toggle();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, toggle]);

  const host = useMemo<TasksHost>(
    () => ({
      bodyTarget,
      placement,
      overlayOpen,
      toggleOverlay,
      setPopoverAnchor: (element) => {
        popoverAnchor.current = element;
      },
      publishDock,
    }),
    [bodyTarget, placement, overlayOpen, toggleOverlay],
  );

  // The anchor is the corner controls; its button is the toggle.
  const focusToggle = () =>
    popoverAnchor.current?.querySelector("button")?.focus();

  const surface =
    placement === "popover" ? (
      <Popover
        open
        onOpenChange={(open) => {
          if (!open) setOverlayOpen(false);
        }}
      >
        <PopoverAnchor virtualRef={popoverAnchor as RefObject<HTMLElement>} />
        <PopoverContent
          side="bottom"
          align="end"
          aria-label="Tasks"
          className="max-h-[min(var(--radix-popover-content-available-height),680px)] w-[min(400px,calc(100vw-16px))] gap-0 overflow-hidden p-0"
          onEscapeKeyDown={(event) => {
            // Escape from inside the content closes one of its own layers
            // first (an expanded row, search), then asks to close.
            if (bodyTarget.contains(event.target as Node)) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            dismissedOutside.current = false;
            // The content marks its add row as the docked panel's focus
            // target; the popover honours the same marker.
            const preferred = (
              event.currentTarget as HTMLElement
            ).querySelector<HTMLElement>("[data-panel-autofocus]");
            if (!preferred) return;
            event.preventDefault();
            preferred.focus();
          }}
          onInteractOutside={(event) => {
            const target = event.detail.originalEvent.target;
            // The toggle closes the popover itself, and menus or pickers
            // opened from the retained body live outside this layer.
            if (
              (target instanceof Node &&
                popoverAnchor.current?.contains(target)) ||
              insideOtherLayer(target)
            ) {
              event.preventDefault();
              return;
            }
            dismissedOutside.current = true;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (activeRef.current && !dismissedOutside.current) focusToggle();
          }}
        >
          <TasksSurface presentation="popover" target={bodyTarget} />
        </PopoverContent>
      </Popover>
    ) : placement === "sheet" ? (
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setOverlayOpen(false);
        }}
      >
        <DialogContent
          layout="sheet"
          showClose={false}
          className="tasks-sheet"
          onCloseAutoFocus={(event) => {
            if (!activeRef.current) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            // The retained body is portaled into this surface. Its React
            // event ancestry differs from its physical DOM ancestry.
            if (bodyTarget.contains(event.detail.originalEvent.target as Node))
              event.preventDefault();
          }}
          aria-describedby={undefined}
          onEscapeKeyDown={(event) => {
            // Escape from inside the content closes one of its own layers
            // first (the detail, search), then asks to close.
            if (bodyTarget.contains(event.target as Node)) {
              event.preventDefault();
              return;
            }
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
        >
          <DialogTitle className="sr-only">Tasks</DialogTitle>
          <TasksSurface presentation="sheet" target={bodyTarget} />
        </DialogContent>
      </Dialog>
    ) : null;

  return (
    <TasksHostContext.Provider value={host}>
      {children}
      {/* Settings suspends the popover and the sheet but keeps the body
          (and any unsaved edit in it) mounted; the docked panel stays in
          the retained workbench. */}
      {active ? (
        surface
      ) : surface ? (
        <div hidden aria-hidden="true" inert>
          <StablePaneSlot target={bodyTarget} />
        </div>
      ) : null}
      {/* Outlives the popover and the sheet, for what is announced as
          they close. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {placement
        ? createPortal(
            <TasksPanelContent
              store={store}
              panelLayoutStore={panelLayoutStore}
              route={route}
              active={active && (placement !== "panel" || dock?.visible === true)}
              presentation={placement}
              onRequestClose={requestClose}
              panelControls={placement === "panel" ? dock?.controls : undefined}
            />,
            bodyTarget,
          )
        : null}
    </TasksHostContext.Provider>
  );
}
