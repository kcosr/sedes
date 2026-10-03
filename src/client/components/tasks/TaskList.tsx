import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  AlignLeft,
  ArrowDownToLine,
  ArrowRightLeft,
  ArrowUpFromLine,
  ChevronRight,
  Circle,
  CircleCheck,
  CornerDownLeft,
  Ellipsis,
  FileText,
  LoaderCircle,
  Pencil,
  Pin,
  PinOff,
  Search,
  Trash2,
} from "lucide-react";
import type { AssociatedTask, TaskScope } from "../../../shared/index.js";
import { relativeTime } from "../../lib/time.js";
import type { TaskDragController } from "../../tasks/task-drag.js";
import { handleTaskDragStart } from "../../tasks/task-drag.js";
import { Button } from "../ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  DropdownMenuValue,
} from "../ui/dropdown-menu.js";
import { ScopeIcon, type TaskDestinations } from "./task-destinations.js";
import {
  sameScope,
  taskFileName,
  taskFileParent,
  type TaskGroup,
} from "./task-view-model.js";

export type TaskAction = "complete" | "pin" | "backlog" | "move" | "delete";

export interface TaskListActions {
  toggleComplete(task: AssociatedTask): void;
  /** Pin and Backlog do nothing for a completed task, which is never either. */
  togglePin(task: AssociatedTask): void;
  toggleBacklog(task: AssociatedTask): void;
  addToPrompt(task: AssociatedTask): void;
  edit(task: AssociatedTask): void;
  requestDelete(task: AssociatedTask): void;
  moveTo(task: AssociatedTask, scope: TaskScope): void;
  chooseMove(task: AssociatedTask): void;
  openFile(path: string, event: ReactMouseEvent): void;
  openThread(threadId: string): void;
}

/** What every row needs from the content, shared rather than passed row by row. */
export interface TaskListEnvironment {
  readonly actions: TaskListActions;
  readonly destinations: TaskDestinations;
  /** The density switch: touch-sized targets, ⋯ always shown, no drag. */
  readonly touch: boolean;
  /** Menus open only while the surface is shown (it can be retained hidden). */
  readonly surfaceActive: boolean;
  readonly filesOpenable: boolean;
  readonly taskDrag?: TaskDragController;
  pending(taskId: string): ReadonlySet<TaskAction>;
}

const TaskListContext = createContext<TaskListEnvironment | null>(null);

export const TaskListProvider = TaskListContext.Provider;

function useTaskList(): TaskListEnvironment {
  const environment = useContext(TaskListContext);
  if (!environment) throw new Error("Task rows render inside TaskListProvider.");
  return environment;
}

/** The key that ties a focusable list item to the roving tab stop. */
export const taskNavKey = (taskId: string) => `task:${taskId}`;

/** The completion circle; its pending state replaces the glyph. */
export function TaskCheck({
  task,
  className,
}: {
  readonly task: AssociatedTask;
  readonly className?: string;
}): React.JSX.Element {
  const { actions, pending } = useTaskList();
  const completed = task.completedAt !== null;
  const busy = pending(task.id).has("complete");
  return (
    <button
      type="button"
      role="checkbox"
      className={className ?? "tasks-check"}
      aria-checked={completed}
      aria-busy={busy || undefined}
      aria-label={
        completed ? `Mark "${task.title}" as open` : `Mark "${task.title}" as done`
      }
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation();
        actions.toggleComplete(task);
      }}
    >
      {busy ? (
        <LoaderCircle className="animate-spin" aria-hidden="true" />
      ) : completed ? (
        <CircleCheck aria-hidden="true" />
      ) : (
        <Circle aria-hidden="true" />
      )}
    </button>
  );
}

/** This thread · This project · Global · Choose…, each disabled where it does not apply. */
function MoveToItems({ task }: { readonly task: AssociatedTask }): React.JSX.Element {
  const { actions, destinations } = useTaskList();
  const { context } = destinations;
  const choices: readonly {
    readonly label: string;
    readonly kind: TaskScope["kind"];
    readonly scope?: TaskScope;
    readonly missing: string;
  }[] = [
    {
      label: "This thread",
      kind: "thread",
      missing: "No thread",
      ...(context.thread
        ? { scope: { kind: "thread", threadId: context.thread.id } }
        : {}),
    },
    {
      label: "This project",
      kind: "project",
      missing: "No project",
      ...(context.project
        ? { scope: { kind: "project", projectId: context.project.id } }
        : {}),
    },
    { label: "Global", kind: "global", missing: "", scope: { kind: "global" } },
  ];
  return (
    <>
      {choices.map((choice) => {
        const current =
          choice.scope !== undefined && sameScope(choice.scope, task.scope);
        const reason = current ? "Current" : choice.scope ? undefined : choice.missing;
        return (
          <DropdownMenuItem
            key={choice.label}
            disabled={reason !== undefined}
            onSelect={() => {
              if (choice.scope) actions.moveTo(task, choice.scope);
            }}
          >
            <ScopeIcon kind={choice.kind} />
            <span>{choice.label}</span>
            {reason && <DropdownMenuValue>{reason}</DropdownMenuValue>}
          </DropdownMenuItem>
        );
      })}
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => actions.chooseMove(task)}>
        <Search />
        <span>Choose…</span>
      </DropdownMenuItem>
    </>
  );
}

/**
 * The row's ⋯ menu: Add to prompt · Edit… · Pin · Send to Backlog · Move
 * to › · Delete…. A completed task is never pinned or in the backlog, so it
 * has neither.
 */
export function TaskRowMenu({
  task,
  focusable,
  trigger,
}: {
  readonly task: AssociatedTask;
  readonly focusable: boolean;
  /** Replaces the row's ⋯ button (the phone detail header). */
  readonly trigger?: ReactNode;
}): React.JSX.Element {
  const { actions, touch, surfaceActive } = useTaskList();
  const [open, setOpen] = useState(false);
  const completed = task.completedAt !== null;
  return (
    <DropdownMenu
      presentation={touch ? "sheet" : "menu"}
      open={surfaceActive && open}
      onOpenChange={setOpen}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <Button
            variant="ghost"
            size="icon-sm"
            className="tasks-row-more"
            aria-label={`Actions for "${task.title}"`}
            tabIndex={focusable ? 0 : -1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") {
                event.preventDefault();
                event.currentTarget
                  .closest(".tasks-row")
                  ?.querySelector<HTMLElement>(".tasks-row-title")
                  ?.focus();
              }
            }}
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sheetTitle={task.title}>
        <DropdownMenuItem onSelect={() => actions.addToPrompt(task)}>
          <CornerDownLeft />
          <span>Add to prompt</span>
        </DropdownMenuItem>
        <DropdownMenuItem aria-keyshortcuts="E" onSelect={() => actions.edit(task)}>
          <Pencil />
          <span>Edit…</span>
          {!touch && <DropdownMenuShortcut aria-hidden="true">E</DropdownMenuShortcut>}
        </DropdownMenuItem>
        {!completed && (
          <>
            <DropdownMenuItem aria-keyshortcuts="P" onSelect={() => actions.togglePin(task)}>
              {task.pinned ? <PinOff /> : <Pin />}
              <span>{task.pinned ? "Unpin" : "Pin"}</span>
              {!touch && <DropdownMenuShortcut aria-hidden="true">P</DropdownMenuShortcut>}
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-keyshortcuts="B"
              onSelect={() => actions.toggleBacklog(task)}
            >
              {task.backlog ? <ArrowUpFromLine /> : <ArrowDownToLine />}
              <span>{task.backlog ? "Take out of Backlog" : "Send to Backlog"}</span>
              {!touch && <DropdownMenuShortcut aria-hidden="true">B</DropdownMenuShortcut>}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ArrowRightLeft />
            <span>Move to</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <MoveToItems task={task} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          aria-keyshortcuts="Delete"
          onSelect={() => actions.requestDelete(task)}
        >
          <Trash2 />
          <span>Delete…</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** "has notes, 2 files, pinned": what the row's indicators show, or "". */
function indicatorsText(task: AssociatedTask): string {
  const files = task.files.length;
  return [
    task.details.trim().length > 0 ? "has notes" : undefined,
    files > 0 ? `${files} file${files === 1 ? "" : "s"}` : undefined,
    task.pinned ? "pinned" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The notes, files and pin indicators. Inside a row's second line (touch
 * density) they are hidden with it, and the row says them separately.
 */
function TaskIndicators({ task }: { readonly task: AssociatedTask }): React.JSX.Element | null {
  const notes = task.details.trim().length > 0;
  const files = task.files.length;
  const described = indicatorsText(task);
  if (described.length === 0) return null;
  return (
    <span className="tasks-row-meta" title={described}>
      <span className="sr-only">{described}</span>
      {notes && <AlignLeft aria-hidden="true" />}
      {files > 0 && (
        <span className="tasks-row-files" aria-hidden="true">
          <FileText />
          {files}
        </span>
      )}
      {task.pinned && <Pin className="tasks-row-pin" aria-hidden="true" />}
    </span>
  );
}

/** File chips: the name always shows whole; the parent folder gives way first. */
export function TaskFileChips({ task }: { readonly task: AssociatedTask }): React.JSX.Element | null {
  const { actions, filesOpenable } = useTaskList();
  if (task.files.length === 0) return null;
  return (
    <ul className="tasks-file-chips" aria-label="Linked files">
      {task.files.map((path) => {
        const content = (
          <>
            <FileText aria-hidden="true" />
            <span className="tasks-file-parent">{taskFileParent(path)}</span>
            <span className="tasks-file-name">{taskFileName(path)}</span>
          </>
        );
        return (
          <li key={path}>
            {filesOpenable ? (
              <button
                type="button"
                className="tasks-file-chip"
                title={path}
                aria-label={`Open ${path} in Files`}
                onClick={(event) => actions.openFile(path, event)}
              >
                {content}
              </button>
            ) : (
              <span className="tasks-file-chip" title={path}>
                {content}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

const EDIT_GRACE_MS = 60_000;

/** "Added 2 hours ago in Checkout flow refactor · edited 20 minutes ago". */
export function TaskFacts({ task }: { readonly task: AssociatedTask }): React.JSX.Element {
  const { actions, destinations } = useTaskList();
  const { scope } = task;
  const edited =
    Date.parse(task.updatedAt) - Date.parse(task.createdAt) > EDIT_GRACE_MS;
  return (
    <p className="tasks-detail-facts">
      Added {relativeTime(task.createdAt)}
      {scope.kind === "global" ? (
        " · Global"
      ) : scope.kind === "project" ? (
        <> to {destinations.label(scope)}</>
      ) : destinations.threadTitles.has(scope.threadId) ? (
        <>
          {" in "}
          <button
            type="button"
            className="tasks-detail-link"
            onClick={() => actions.openThread(scope.threadId)}
          >
            {destinations.label(scope)}
          </button>
        </>
      ) : (
        " in a thread"
      )}
      {task.completedAt !== null
        ? ` · completed ${relativeTime(task.completedAt)}`
        : edited
          ? ` · edited ${relativeTime(task.updatedAt)}`
          : null}
    </p>
  );
}

const NOTES_CLAMP_CHARACTERS = 480;
const NOTES_CLAMP_LINES = 8;

/** Notes as plain text with their line breaks; long notes start clamped. */
export function TaskNotes({ task }: { readonly task: AssociatedTask }): React.JSX.Element | null {
  const [expanded, setExpanded] = useState(false);
  const notes = task.details.trim();
  if (notes.length === 0) return null;
  const long =
    notes.length > NOTES_CLAMP_CHARACTERS ||
    notes.split("\n").length > NOTES_CLAMP_LINES;
  return (
    <div className="tasks-detail-notes-block">
      <p className="tasks-detail-notes" data-clamped={(long && !expanded) || undefined}>
        {notes}
      </p>
      {long && (
        <Button
          variant="link"
          size="xs"
          className="tasks-detail-more"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Show less" : "Show more"}
        </Button>
      )}
    </div>
  );
}

/** The inline detail's Move to… button and menu (also opened by M). */
function MoveToButton({
  task,
  open,
  onOpenChange,
}: {
  readonly task: AssociatedTask;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { touch, surfaceActive } = useTaskList();
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <DropdownMenu
      presentation={touch ? "sheet" : "menu"}
      open={surfaceActive && open}
      onOpenChange={onOpenChange}
    >
      <DropdownMenuTrigger asChild>
        <Button ref={triggerRef} variant="outline" size="sm">
          <ArrowRightLeft aria-hidden="true" />
          Move to…
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sheetTitle={`Move “${task.title}”`}
        onCloseAutoFocus={(event) => {
          // Back to the row, where M opened it, rather than the button.
          const title = triggerRef.current
            ?.closest(".tasks-row")
            ?.querySelector<HTMLElement>(".tasks-row-title");
          if (!title) return;
          event.preventDefault();
          title.focus();
        }}
      >
        <MoveToItems task={task} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function InlineDetail({
  task,
  id,
  moveOpen,
  onMoveOpenChange,
}: {
  readonly task: AssociatedTask;
  readonly id: string;
  readonly moveOpen: boolean;
  readonly onMoveOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const { actions } = useTaskList();
  return (
    <div className="tasks-detail" id={id} role="group" aria-label={`${task.title} details`}>
      <TaskNotes task={task} />
      <TaskFileChips task={task} />
      <TaskFacts task={task} />
      <div className="tasks-detail-actions">
        <Button size="sm" onClick={() => actions.addToPrompt(task)}>
          <CornerDownLeft aria-hidden="true" />
          Add to prompt
        </Button>
        <Button variant="outline" size="sm" onClick={() => actions.edit(task)}>
          <Pencil aria-hidden="true" />
          Edit
        </Button>
        <MoveToButton task={task} open={moveOpen} onOpenChange={onMoveOpenChange} />
      </div>
    </div>
  );
}

/** Where a task belongs, for lists that mix scopes without group headings. */
export interface TaskRowLocation {
  readonly kind: TaskScope["kind"];
  readonly label: string;
}

export interface TaskRowProps {
  readonly task: AssociatedTask;
  readonly expanded: boolean;
  /** A quiet second line under the title; its text is the row's description. */
  readonly location?: TaskRowLocation;
  /** The roving tab stop of the list. */
  readonly focusable: boolean;
  /** Render the detail inline under the row (the docked panel). */
  readonly inlineDetail: boolean;
  readonly moveOpen: boolean;
  readonly onMoveOpenChange: (open: boolean) => void;
  readonly onToggle: (task: AssociatedTask) => void;
  readonly onTitleKeyDown: (
    event: ReactKeyboardEvent<HTMLButtonElement>,
    task: AssociatedTask,
  ) => void;
}

/**
 * One task: the completion circle, a one-line title, quiet indicators and
 * ⋯. The whole row is the drag source on desktop and the click target that
 * expands it; the title button carries its keyboard and AT semantics.
 */
export function TaskRow({
  task,
  expanded,
  location,
  focusable,
  inlineDetail,
  moveOpen,
  onMoveOpenChange,
  onToggle,
  onTitleKeyDown,
}: TaskRowProps): React.JSX.Element {
  const { touch, taskDrag, pending } = useTaskList();
  const detailId = useId();
  const locationId = useId();
  const busy = pending(task.id);
  const draggable = !touch && taskDrag !== undefined;
  // On touch the indicators join the second line, so the title has the
  // row's whole width.
  const indicatorsOnLocation = touch && location !== undefined;
  const indicators = indicatorsText(task);
  return (
    <li
      className="tasks-row"
      data-task-id={task.id}
      data-completed={task.completedAt !== null || undefined}
      data-expanded={expanded || undefined}
      data-busy={busy.size > 0 || undefined}
      aria-busy={busy.size > 0 || undefined}
    >
      <div
        className="tasks-row-main"
        draggable={draggable}
        data-dragging={taskDrag?.activeTaskId === task.id || undefined}
        onClick={(event) => {
          // The row menu portals elsewhere, but its clicks bubble here
          // through React; only clicks on the row itself expand it.
          if (event.currentTarget.contains(event.target as Node)) onToggle(task);
        }}
        onDragStart={
          draggable
            ? (event) => handleTaskDragStart(taskDrag, task, event)
            : undefined
        }
        onDragEnd={draggable ? () => taskDrag?.endTaskDrag() : undefined}
      >
        <TaskCheck task={task} />
        <button
          type="button"
          className="tasks-row-title"
          data-tasks-nav={taskNavKey(task.id)}
          tabIndex={focusable ? 0 : -1}
          aria-expanded={expanded}
          aria-controls={expanded && inlineDetail ? detailId : undefined}
          aria-describedby={location ? locationId : undefined}
          data-location={location ? "" : undefined}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(task);
          }}
          onKeyDown={(event) => onTitleKeyDown(event, task)}
        >
          {location ? (
            <>
              <span className="tasks-row-title-text">{task.title}</span>
              <span className="tasks-row-location" aria-hidden="true">
                <ScopeIcon kind={location.kind} />
                <span className="tasks-row-location-label">{location.label}</span>
                {indicatorsOnLocation && <TaskIndicators task={task} />}
              </span>
            </>
          ) : (
            task.title
          )}
        </button>
        {location && (
          <span id={locationId} className="sr-only">
            In {location.label}
          </span>
        )}
        {!indicatorsOnLocation ? (
          <TaskIndicators task={task} />
        ) : indicators.length > 0 ? (
          <span className="sr-only">{indicators}</span>
        ) : null}
        <TaskRowMenu task={task} focusable={focusable} />
      </div>
      {expanded && inlineDetail && (
        <InlineDetail
          task={task}
          id={detailId}
          moveOpen={moveOpen}
          onMoveOpenChange={onMoveOpenChange}
        />
      )}
    </li>
  );
}

/** A row being created: muted, with a spinner, until the server confirms it. */
export function PendingTaskRow({ title }: { readonly title: string }): React.JSX.Element {
  return (
    <li className="tasks-row" data-creating="true" aria-busy="true">
      <div className="tasks-row-main">
        <span className="tasks-check" aria-hidden="true">
          <LoaderCircle className="animate-spin" />
        </span>
        <span className="tasks-row-title">{title}</span>
        <span className="sr-only">Adding…</span>
      </div>
    </li>
  );
}

/** A collapsible heading (an All group, Backlog or Completed) that takes part in list navigation. */
export function TaskListHeading({
  navKey,
  focusable,
  expanded,
  onToggle,
  icon,
  label,
  count,
  variant,
  onKeyDown,
}: {
  readonly navKey: string;
  readonly focusable: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly icon?: ReactNode;
  readonly label: string;
  readonly count: number;
  readonly variant: "group" | "section";
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={variant === "group" ? "tasks-group-heading" : "tasks-section-heading"}
      data-tasks-nav={navKey}
      tabIndex={focusable ? 0 : -1}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <ChevronRight className="tasks-heading-chevron" aria-hidden="true" />
      {icon}
      <span className="tasks-heading-label">{label}</span>
      <span className="tasks-heading-count">{count}</span>
    </button>
  );
}

export type { TaskGroup };
