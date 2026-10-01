import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type ReactNode,
} from "react";
import type {
  AssociatedTask,
  NormalizedApplicationSnapshot,
  TaskScope,
} from "../../shared/index.js";
import { ApiError } from "../api/ApiClient.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { ConfirmDialog } from "../components/ui/confirm-dialog.js";
import { useToast } from "../components/ui/toast.js";

export const TASK_DRAG_MIME = "application/x-sedes-task+json";

type TaskDragPayload = {
  readonly version: 1;
  readonly taskId: string;
  readonly revision: number;
};

export interface TaskThreadDropTarget {
  readonly threadId: string;
  readonly threadTitle: string;
  readonly workspaceId: string;
  readonly workspaceLabel: string;
}

export interface TaskScopeDropTarget {
  readonly scope: TaskScope;
  readonly label: string;
  readonly workspaceId: string | null;
  readonly workspaceLabel: string;
}

type PendingMove = {
  readonly task: AssociatedTask;
  readonly target: TaskScopeDropTarget;
};

export interface TaskDragController {
  readonly activeTaskId?: string;
  isTaskDrag(dataTransfer: DataTransfer): boolean;
  /**
   * Starts dragging a task from `source`; a move it ends in shows its Undo
   * toast on the surface it came from.
   */
  beginTaskDrag(
    task: AssociatedTask,
    dataTransfer: DataTransfer,
    source?: Element,
  ): void;
  endTaskDrag(): void;
  resolveDraggedTask(dataTransfer: DataTransfer): AssociatedTask | undefined;
  requestMove(
    task: AssociatedTask,
    target: TaskThreadDropTarget,
  ): Promise<void>;
  requestScopeMove(
    task: AssociatedTask,
    target: TaskScopeDropTarget,
  ): Promise<void>;
  announce(message: string, error?: boolean): void;
}

const TaskDragContext = createContext<TaskDragController | null>(null);

function parseTaskDragPayload(value: string): TaskDragPayload | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { taskId?: unknown }).taskId !== "string" ||
      !Number.isSafeInteger((parsed as { revision?: unknown }).revision) ||
      Number((parsed as { revision: number }).revision) < 0
    ) {
      return undefined;
    }
    return parsed as TaskDragPayload;
  } catch {
    return undefined;
  }
}

function hasTaskDragType(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(TASK_DRAG_MIME);
}

function moveErrorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 409) {
    return "That task changed before it could be moved. Review it and try again.";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The task could not be moved.";
}

function scopesEqual(left: TaskScope, right: TaskScope): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "global") return true;
  if (left.kind === "workspace" && right.kind === "workspace") {
    return left.workspaceId === right.workspaceId;
  }
  return (
    left.kind === "thread" &&
    right.kind === "thread" &&
    left.threadId === right.threadId
  );
}

export function TaskDragProvider({
  store,
  snapshot,
  children,
}: {
  readonly store: ApplicationClientStore;
  readonly snapshot: NormalizedApplicationSnapshot;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [activePayload, setActivePayload] = useState<TaskDragPayload>();
  const [pendingMove, setPendingMove] = useState<PendingMove>();
  const [announcement, setAnnouncement] = useState("");
  const [announcementError, setAnnouncementError] = useState(false);
  const activePayloadRef = useRef<TaskDragPayload | undefined>(undefined);
  const highlightedTargetRef = useRef<HTMLElement | undefined>(undefined);
  // The toast region of the surface the last drag began in (the dragged row
  // may be gone by the time the move lands).
  const sourceRegionRef = useRef<Element | null>(null);
  const moveMutationIds = useRef(new Map<string, string>());
  const toast = useToast();

  const announce = useCallback((message: string, error = false) => {
    setAnnouncement("");
    setAnnouncementError(error);
    window.setTimeout(() => setAnnouncement(message), 0);
  }, []);

  const endTaskDrag = useCallback(() => {
    activePayloadRef.current = undefined;
    setActivePayload(undefined);
    highlightedTargetRef.current?.removeAttribute("data-task-drop-target");
    highlightedTargetRef.current = undefined;
  }, []);

  const beginTaskDrag = useCallback(
    (task: AssociatedTask, dataTransfer: DataTransfer, source?: Element) => {
      sourceRegionRef.current = source?.closest("[data-toast-region]") ?? null;
      const payload: TaskDragPayload = {
        version: 1,
        taskId: task.id,
        revision: task.revision,
      };
      activePayloadRef.current = payload;
      setActivePayload(payload);
      dataTransfer.effectAllowed = "copyMove";
      dataTransfer.setData(TASK_DRAG_MIME, JSON.stringify(payload));
      dataTransfer.setData("text/plain", task.title);
    },
    [],
  );

  const resolveDraggedTask = useCallback(
    (dataTransfer: DataTransfer): AssociatedTask | undefined => {
      const encoded = dataTransfer.getData(TASK_DRAG_MIME);
      const payload =
        (encoded.length > 0 ? parseTaskDragPayload(encoded) : undefined) ??
        activePayloadRef.current;
      if (!payload) return undefined;
      const task = store.getTasks().find(({ id }) => id === payload.taskId);
      return task?.revision === payload.revision ? task : undefined;
    },
    [store],
  );

  /** Moves a task back to the scope it was moved from. */
  const undoMove = useCallback(
    async (taskId: string, scope: TaskScope) => {
      const current = store.getTasks().find(({ id }) => id === taskId);
      if (!current) {
        announce("That task is gone, so the move can't be undone.", true);
        return;
      }
      try {
        await store.moveTask(current, scope, crypto.randomUUID());
        announce(`Moved “${current.title}” back.`);
      } catch (error) {
        announce(moveErrorMessage(error), true);
      }
    },
    [announce, store],
  );

  const performMove = useCallback(
    /** Resolves with the failure message when the move did not happen. */
    async (
      task: AssociatedTask,
      target: TaskScopeDropTarget,
    ): Promise<string | undefined> => {
      const current = store.getTasks().find(({ id }) => id === task.id);
      if (!current || current.revision !== task.revision) {
        const message =
          "That task changed before it could be moved. Review it and try again.";
        announce(message, true);
        return message;
      }
      if (scopesEqual(current.scope, target.scope)) {
        announce(`“${current.title}” is already assigned to ${target.label}.`);
        return undefined;
      }

      const targetIdentity =
        target.scope.kind === "global"
          ? "global"
          : target.scope.kind === "workspace"
            ? `workspace:${target.scope.workspaceId}`
            : `thread:${target.scope.threadId}`;
      const fingerprint = `${current.id}:${current.revision}:${targetIdentity}`;
      const mutationId =
        moveMutationIds.current.get(fingerprint) ?? crypto.randomUUID();
      moveMutationIds.current.set(fingerprint, mutationId);
      try {
        await store.moveTask(
          current,
          target.scope,
          mutationId,
        );
        moveMutationIds.current.delete(fingerprint);
        setPendingMove(undefined);
        announce(`Moved “${current.title}” to ${target.label}.`);
        // Every move can be undone: Undo moves the task back where it was.
        const previous = current.scope;
        toast.show({
          message: `Moved to ${target.label}`,
          anchor: sourceRegionRef.current,
          action: {
            label: "Undo",
            onAction: () => void undoMove(current.id, previous),
          },
        });
        return undefined;
      } catch (error) {
        // An HTTP response is definitive. A transport failure can be
        // ambiguous, so retain the mutation identifier for a safe retry.
        if (error instanceof ApiError) {
          moveMutationIds.current.delete(fingerprint);
        }
        const message = moveErrorMessage(error);
        announce(message, true);
        return message;
      }
    },
    [announce, store, toast, undoMove],
  );

  const requestScopeMove = useCallback(
    async (task: AssociatedTask, target: TaskScopeDropTarget) => {
      const crossesProjects =
        task.associatedWorkspaceId !== null &&
        task.associatedWorkspaceId !== target.workspaceId;
      if (crossesProjects && task.files.length > 0) {
        setPendingMove({ task, target });
        return;
      }
      await performMove(task, target);
    },
    [performMove],
  );

  const requestMove = useCallback(
    async (task: AssociatedTask, target: TaskThreadDropTarget) => {
      await requestScopeMove(task, {
        scope: { kind: "thread", threadId: target.threadId },
        label: target.threadTitle,
        workspaceId: target.workspaceId,
        workspaceLabel: target.workspaceLabel,
      });
    },
    [requestScopeMove],
  );

  const targetByThreadId = useMemo(() => {
    const workspaceLabels = new Map(
      snapshot.workspaces.map((workspace) => [
        workspace.id,
        workspace.label.text,
      ]),
    );
    return new Map(
      snapshot.threads.map((thread) => [
        thread.id,
        {
          threadId: thread.id,
          threadTitle: thread.title.text,
          workspaceId: thread.workspaceId,
          workspaceLabel:
            workspaceLabels.get(thread.workspaceId) ?? "Unknown project",
        } satisfies TaskThreadDropTarget,
      ]),
    );
  }, [snapshot]);

  useEffect(() => {
    if (!activePayload) return undefined;

    const findSidebarTarget = (eventTarget: EventTarget | null) => {
      const element = eventTarget instanceof Element ? eventTarget : null;
      const row = element?.closest<HTMLElement>(
        "[data-thread-group-roster-member], [data-thread-id]",
      );
      if (!row) return undefined;
      if (
        !row.closest(
          ".sidebar-inner, [data-thread-group-roster], [data-thread-group-roster-member]",
        )
      ) {
        return undefined;
      }
      const threadId = row.dataset.threadId;
      const target = threadId ? targetByThreadId.get(threadId) : undefined;
      return target ? { row, target } : undefined;
    };

    const setHighlighted = (element?: HTMLElement) => {
      if (highlightedTargetRef.current === element) return;
      highlightedTargetRef.current?.removeAttribute("data-task-drop-target");
      highlightedTargetRef.current = element;
      element?.setAttribute("data-task-drop-target", "true");
    };

    const onDragOver = (event: DragEvent) => {
      if (!hasTaskDragType(event.dataTransfer!)) return;
      const match = findSidebarTarget(event.target);
      if (!match) {
        setHighlighted(undefined);
        return;
      }
      event.preventDefault();
      event.dataTransfer!.dropEffect = "move";
      setHighlighted(match.row);
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer || !hasTaskDragType(event.dataTransfer)) return;
      const match = findSidebarTarget(event.target);
      if (!match) return;
      event.preventDefault();
      event.stopPropagation();
      const task = resolveDraggedTask(event.dataTransfer);
      endTaskDrag();
      if (!task) {
        announce(
          "That task changed before it could be moved. Review it and try again.",
          true,
        );
        return;
      }
      void requestMove(task, match.target);
    };
    const onDragEnd = () => endTaskDrag();

    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDrop, true);
    document.addEventListener("dragend", onDragEnd, true);
    return () => {
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("dragend", onDragEnd, true);
      setHighlighted(undefined);
    };
  }, [
    activePayload,
    announce,
    endTaskDrag,
    requestMove,
    resolveDraggedTask,
    targetByThreadId,
  ]);

  const controller = useMemo<TaskDragController>(
    () => ({
      ...(activePayload ? { activeTaskId: activePayload.taskId } : {}),
      isTaskDrag: (dataTransfer) =>
        activePayloadRef.current !== undefined || hasTaskDragType(dataTransfer),
      beginTaskDrag,
      endTaskDrag,
      resolveDraggedTask,
      requestMove,
      requestScopeMove,
      announce,
    }),
    [
      activePayload,
      announce,
      beginTaskDrag,
      endTaskDrag,
      requestMove,
      requestScopeMove,
      resolveDraggedTask,
    ],
  );

  return (
    <TaskDragContext.Provider value={controller}>
      {children}
      <div
        className="sr-only"
        role={
          announcement.length > 0
            ? announcementError
              ? "alert"
              : "status"
            : undefined
        }
        aria-live={announcementError ? "assertive" : "polite"}
      >
        {announcement}
      </div>
      <ConfirmDialog
        open={pendingMove !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingMove(undefined);
        }}
        title="Move task with project files?"
        description={`This task links to project files. Moving it to ${pendingMove?.target.label ?? "another scope"} keeps those absolute file paths unchanged.`}
        confirmLabel="Move task"
        pendingLabel="Moving…"
        onConfirm={async () => {
          if (!pendingMove) return;
          const failure = await performMove(pendingMove.task, pendingMove.target);
          if (failure) throw new Error(failure);
        }}
      />
    </TaskDragContext.Provider>
  );
}

export function useTaskDrag(): TaskDragController | undefined {
  return useContext(TaskDragContext) ?? undefined;
}

/** Spread on an element to make it a scope drop target. */
export interface TaskScopeDropProps {
  readonly onDragEnter: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  /** While a task drag is in progress: this target accepts it. */
  readonly "data-task-drop-armed"?: "true";
  /** While the dragged task is over this target. */
  readonly "data-task-drop-target"?: "true";
}

export interface TaskScopeDropTargets<Key extends string> {
  /** The target the dragged task is over, if any. */
  readonly over: Key | undefined;
  /**
   * Props for one keyed target that moves a dropped task to `target`; an
   * undefined target (a scope that does not apply) accepts nothing. Targets
   * may nest: the innermost one under the pointer takes the drop.
   */
  props(key: Key, target: TaskScopeDropTarget | undefined): TaskScopeDropProps;
}

/**
 * Drop targets that move a dragged task to a scope, for the Tasks scope
 * segments and the Tasks body wherever Tasks is presented (docked, popover
 * or sheet). Feedback uses the shared `data-task-drop-*` styles.
 */
export function useTaskScopeDropTargets<
  Key extends string,
>(): TaskScopeDropTargets<Key> {
  const taskDrag = useTaskDrag();
  const [over, setOver] = useState<Key>();
  const dragging = taskDrag?.activeTaskId !== undefined;
  useEffect(() => {
    if (!dragging) setOver(undefined);
  }, [dragging]);

  const props = (
    key: Key,
    target: TaskScopeDropTarget | undefined,
  ): TaskScopeDropProps => {
    const accepts = (event: ReactDragEvent<HTMLElement>) =>
      target !== undefined && taskDrag?.isTaskDrag(event.dataTransfer) === true;
    const mark = (event: ReactDragEvent<HTMLElement>) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setOver(key);
    };
    return {
      onDragEnter: mark,
      onDragOver: mark,
      onDragLeave: (event) => {
        if (!accepts(event)) return;
        event.stopPropagation();
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setOver((current) => (current === key ? undefined : current));
      },
      onDrop: (event) => {
        if (!accepts(event) || !taskDrag || !target) return;
        event.preventDefault();
        event.stopPropagation();
        const task = taskDrag.resolveDraggedTask(event.dataTransfer);
        taskDrag.endTaskDrag();
        setOver(undefined);
        if (!task) {
          taskDrag.announce(
            "That task changed before it could be moved. Review it and try again.",
            true,
          );
          return;
        }
        void taskDrag.requestScopeMove(task, target);
      },
      ...(dragging && target ? { "data-task-drop-armed": "true" as const } : {}),
      ...(over === key && target ? { "data-task-drop-target": "true" as const } : {}),
    };
  };
  return { over, props };
}

export function handleTaskDragStart(
  controller: TaskDragController | undefined,
  task: AssociatedTask,
  event: ReactDragEvent,
): void {
  controller?.beginTaskDrag(task, event.dataTransfer, event.currentTarget);
}
