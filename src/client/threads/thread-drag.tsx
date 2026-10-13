import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import type { NormalizedApplicationSnapshot, NormalizedApplicationThreadSummary } from "../../shared/index.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { ApiError } from "../api/ApiClient.js";
import { NewGroupDialog } from "../components/MoveToGroupMenu.js";
import "./thread-drag.css";

export const THREAD_DRAG_MIME = "application/x-sedes-thread+json";

interface ThreadDragPayload {
  readonly version: 1;
  readonly threadId: string;
  readonly token: string;
}

export interface ThreadDragController {
  readonly activeThreadId?: string;
  isThreadDrag(dataTransfer: DataTransfer): boolean;
  beginThreadDrag(threadId: string, dataTransfer: DataTransfer): void;
  endThreadDrag(): void;
  /** Resolve from the current principal-scoped inventory; drag text is never authority. */
  resolveDraggedThread(dataTransfer: DataTransfer): NormalizedApplicationThreadSummary | undefined;
  announce(message: string, error?: boolean): void;
}

const ThreadDragContext = createContext<ThreadDragController | null>(null);

export function useThreadDrag(): ThreadDragController | undefined {
  return useContext(ThreadDragContext) ?? undefined;
}

type PendingGroup = {
  readonly members: readonly NormalizedApplicationThreadSummary[];
  readonly initialName: string;
};

export function ThreadDragProvider({ store, snapshot, children }: {
  readonly store: ApplicationClientStore;
  readonly snapshot: NormalizedApplicationSnapshot;
  readonly children: ReactNode;
}): React.JSX.Element {
  const [active, setActive] = useState<ThreadDragPayload>();
  const activeRef = useRef<ThreadDragPayload | undefined>(undefined);
  const [pendingGroup, setPendingGroup] = useState<PendingGroup>();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [announcementError, setAnnouncementError] = useState(false);
  const highlightRef = useRef<HTMLElement | undefined>(undefined);
  const mutationIds = useRef(new Map<string, string>());

  const currentThread = useCallback((id: string) => {
    const state = store.getSnapshot();
    return state.snapshot?.threads.find((thread) => thread.id === id) ??
      Object.values(state.descendantPages).flatMap((page) => page.descendants).find(({ thread }) => thread.id === id)?.thread;
  }, [store]);

  const announce = useCallback((message: string, error = false) => {
    setAnnouncement(message);
    setAnnouncementError(error);
  }, []);

  const highlight = useCallback((element?: HTMLElement) => {
    if (highlightRef.current === element) return;
    highlightRef.current?.removeAttribute("data-thread-drop-target");
    highlightRef.current = element;
    element?.setAttribute("data-thread-drop-target", "true");
  }, []);

  const endThreadDrag = useCallback(() => {
    activeRef.current = undefined;
    setActive(undefined);
    highlight();
  }, [highlight]);

  const isThreadDrag = useCallback((transfer: DataTransfer) =>
    activeRef.current !== undefined && Array.from(transfer.types).includes(THREAD_DRAG_MIME), []);

  const beginThreadDrag = useCallback((threadId: string, transfer: DataTransfer) => {
    const thread = currentThread(threadId);
    if (!thread) return;
    const payload = { version: 1, threadId, token: crypto.randomUUID() } as const;
    activeRef.current = payload;
    setActive(payload);
    transfer.effectAllowed = "copyMove";
    transfer.setData(THREAD_DRAG_MIME, JSON.stringify(payload));
    transfer.setData("text/plain", thread.title.text);
  }, [currentThread]);

  const resolveDraggedThread = useCallback((transfer: DataTransfer) => {
    if (!isThreadDrag(transfer)) return undefined;
    try {
      const payload: unknown = JSON.parse(transfer.getData(THREAD_DRAG_MIME));
      if (typeof payload !== "object" || payload === null) return undefined;
      const candidate = payload as Partial<ThreadDragPayload>;
      if (candidate.version !== 1 || typeof candidate.threadId !== "string" || candidate.threadId !== activeRef.current?.threadId || candidate.token !== activeRef.current?.token) return undefined;
      return currentThread(candidate.threadId);
    } catch {
      return undefined;
    }
  }, [currentThread, isThreadDrag]);

  const mutate = useCallback(async (key: string, action: (mutationId: string) => Promise<unknown>) => {
    const mutationId = mutationIds.current.get(key) ?? crypto.randomUUID();
    mutationIds.current.set(key, mutationId);
    try {
      await action(mutationId);
      mutationIds.current.delete(key);
    } catch (error) {
      // Retain a transport-ambiguous request's identity for an idempotent retry.
      if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
        mutationIds.current.delete(key);
      }
      throw error;
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    const findTarget = (target: EventTarget | null) => {
      const row = target instanceof Element ? target.closest<HTMLElement>("[data-thread-drop-kind]") : null;
      if (!row) return undefined;
      if (row.dataset.threadDropKind === "group") {
        const group = store.getSnapshot().snapshot?.groups.find(({ id }) => id === row.dataset.groupId);
        return group ? { row, groupId: group.id } : undefined;
      }
      const thread = currentThread(row.dataset.threadDropId ?? row.dataset.threadId ?? "");
      return thread ? { row, thread, groupId: thread.groupId } : undefined;
    };
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer || !isThreadDrag(event.dataTransfer)) return;
      const target = findTarget(event.target);
      if (!target || target.thread?.id === activeRef.current?.threadId) {
        highlight();
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      highlight(target.row);
    };
    const onDrop = (event: DragEvent) => {
      if (!event.dataTransfer || !isThreadDrag(event.dataTransfer)) return;
      const target = findTarget(event.target);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const source = resolveDraggedThread(event.dataTransfer);
      endThreadDrag();
      if (!source) {
        announce("That thread is no longer available. Refresh the inventory and try again.", true);
        return;
      }
      if (source.id === target.thread?.id || (target.groupId !== null && target.groupId === source.groupId)) return;
      if (target.groupId) {
        const key = JSON.stringify(["assign", source.id, source.groupAssignmentRevision, target.groupId]);
        void mutate(key, (id) => store.assignThreadGroup(source, target.groupId!, id)).then(
          () => announce(`Moved “${source.title.text}” to the group.`),
          (error: unknown) => announce(error instanceof Error ? error.message : "The thread could not be grouped.", true),
        );
      } else if (target.thread) {
        returnFocusRef.current = target.row.querySelector<HTMLElement>("button") ?? target.row;
        setPendingGroup({
          members: [target.thread, source],
          initialName: (target.thread.title.text || "New group").normalize("NFKC").trim().slice(0, 120),
        });
      }
    };
    const onDragLeave = (event: DragEvent) => {
      if (!event.relatedTarget) highlight();
    };
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDrop, true);
    document.addEventListener("dragend", endThreadDrag, true);
    document.addEventListener("dragleave", onDragLeave, true);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") endThreadDrag(); };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("drop", onDrop, true);
      document.removeEventListener("dragend", endThreadDrag, true);
      document.removeEventListener("dragleave", onDragLeave, true);
      document.removeEventListener("keydown", onKeyDown, true);
      highlight();
    };
  }, [active, announce, currentThread, endThreadDrag, highlight, isThreadDrag, mutate, resolveDraggedThread, store]);

  const controller = useMemo<ThreadDragController>(() => ({
    ...(active ? { activeThreadId: active.threadId } : {}),
    isThreadDrag, beginThreadDrag, endThreadDrag, resolveDraggedThread, announce,
  }), [active, isThreadDrag, beginThreadDrag, endThreadDrag, resolveDraggedThread, announce]);

  return <ThreadDragContext.Provider value={controller}>
    {children}
    <p className="sr-only" role={announcementError ? "alert" : "status"} aria-live="polite">{announcement}</p>
    <NewGroupDialog
      open={pendingGroup !== undefined}
      initialName={pendingGroup?.initialName ?? ""}
      memberCount={pendingGroup?.members.length ?? 1}
      groups={snapshot.groups}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => { if (!open) setPendingGroup(undefined); }}
      onCreate={async (name) => {
        if (!pendingGroup) return;
        // Keep the reviewed revisions through the dialog and retry. A concurrent
        // change must fail atomically rather than silently choosing new members.
        const key = JSON.stringify(["create", name, pendingGroup.members.map((thread) => [thread.id, thread.groupAssignmentRevision])]);
        await mutate(key, (id) => store.createThreadGroup(pendingGroup.members, name, id));
        announce(`Created group “${name}”.`);
      }}
    />
  </ThreadDragContext.Provider>;
}
