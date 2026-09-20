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
import { Button } from "../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";

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
  beginTaskDrag(task: AssociatedTask, dataTransfer: DataTransfer): void;
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
  const [pendingMoveError, setPendingMoveError] = useState<string>();
  const [moving, setMoving] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [announcementError, setAnnouncementError] = useState(false);
  const activePayloadRef = useRef<TaskDragPayload | undefined>(undefined);
  const highlightedTargetRef = useRef<HTMLElement | undefined>(undefined);
  const moveMutationIds = useRef(new Map<string, string>());

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
    (task: AssociatedTask, dataTransfer: DataTransfer) => {
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

  const performMove = useCallback(
    async (
      task: AssociatedTask,
      target: TaskScopeDropTarget,
      reportInDialog = false,
    ) => {
      const current = store.getTasks().find(({ id }) => id === task.id);
      if (!current || current.revision !== task.revision) {
        const message =
          "That task changed before it could be moved. Review it and try again.";
        announce(message, true);
        if (reportInDialog) setPendingMoveError(message);
        return;
      }
      if (scopesEqual(current.scope, target.scope)) {
        announce(`“${current.title}” is already assigned to ${target.label}.`);
        return;
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
      setMoving(true);
      try {
        await store.moveTask(
          current,
          target.scope,
          mutationId,
        );
        moveMutationIds.current.delete(fingerprint);
        setPendingMove(undefined);
        setPendingMoveError(undefined);
        announce(`Moved “${current.title}” to ${target.label}.`);
      } catch (error) {
        // An HTTP response is definitive. A transport failure can be
        // ambiguous, so retain the mutation identifier for a safe retry.
        if (error instanceof ApiError) {
          moveMutationIds.current.delete(fingerprint);
        }
        const message = moveErrorMessage(error);
        announce(message, true);
        if (reportInDialog) setPendingMoveError(message);
      } finally {
        setMoving(false);
      }
    },
    [announce, store],
  );

  const requestScopeMove = useCallback(
    async (task: AssociatedTask, target: TaskScopeDropTarget) => {
      const crossesProjects =
        task.associatedWorkspaceId !== null &&
        task.associatedWorkspaceId !== target.workspaceId;
      if (crossesProjects && task.files.length > 0) {
        setPendingMoveError(undefined);
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
      <Dialog
        open={pendingMove !== undefined}
        onOpenChange={(open) => {
          if (!open && !moving) {
            setPendingMove(undefined);
            setPendingMoveError(undefined);
          }
        }}
      >
        <DialogContent
          onEscapeKeyDown={(event) => {
            if (moving) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (moving) event.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>Move task with project files?</DialogTitle>
            <DialogDescription>
              This task links to project files. Moving it to {pendingMove?.target.label} keeps those absolute file paths unchanged.
            </DialogDescription>
          </DialogHeader>
          {pendingMoveError && (
            <p className="text-sm text-destructive" role="alert">
              {pendingMoveError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={moving}
              onClick={() => {
                setPendingMove(undefined);
                setPendingMoveError(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              disabled={moving || !pendingMove}
              onClick={() => {
                if (pendingMove) {
                  setPendingMoveError(undefined);
                  void performMove(
                    pendingMove.task,
                    pendingMove.target,
                    true,
                  );
                }
              }}
            >
              {moving ? "Moving…" : "Move task"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TaskDragContext.Provider>
  );
}

export function useTaskDrag(): TaskDragController | undefined {
  return useContext(TaskDragContext) ?? undefined;
}

export function handleTaskDragStart(
  controller: TaskDragController | undefined,
  task: AssociatedTask,
  event: ReactDragEvent,
): void {
  controller?.beginTaskDrag(task, event.dataTransfer);
}
