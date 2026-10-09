import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, ArchiveRestore, Bot, Check, ChevronLeft, ChevronsDownUp, ChevronsUpDown, Ellipsis, FilePenLine, FolderInput, Highlighter, History, ListFilter, LoaderCircle, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { ListWorkpadsRequest, UpdateWorkpadRequest, Workpad, WorkpadCounts, WorkpadScope, WorkpadSummary, WorkpadRevision, WorkpadRevisionSummary } from "../../shared/protocol/workpads.js";
import { WORKPAD_CONTENT_MAX_CHARACTERS } from "../../shared/protocol/workpads.js";
import { CLOSE_WORKPAD_EVENT } from "../app/android-back.js";
import { installNavigationBlocker, routePath, useRoute, type NavigationBlocker, type Route } from "../app/router.js";
import { useTouchDensity } from "../app/use-touch-density.js";
import {
  getWorkpadsPanelPreferences, setWorkpadsLastView, setWorkpadsViewOptions, useWorkpadsPanelPreferences,
  type WorkpadsView, type WorkpadsViewOptions,
} from "../app/workpads-panel-store.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import { useApplicationStore } from "../stores/ApplicationClientStore.js";
import { relativeTime, shortRelativeTime } from "../lib/time.js";
import { DiscardChangesDialog } from "../components/ui/discard-changes-dialog.js";
import { ConfirmDialog } from "../components/ui/confirm-dialog.js";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuItemDescription, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, DropdownMenuValue } from "../components/ui/dropdown-menu.js";
import { SearchableSelectList } from "../components/ui/searchable-select.js";
import { Button } from "../components/ui/button.js";
import { Callout } from "../components/ui/callout.js";
import { EmptyState } from "../components/ui/empty-state.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { ScopeSegments } from "../components/scope-view/ScopeSegments.js";
import { ListHeading, ListHeadingIcon, ScopeIcon, ScopeLocation, ViewFilterChips, type ScopeLocationLabel, type ViewFilterChip } from "../components/scope-view/scope-list.js";
import { ScopeOptionItem, SortOptionItems } from "../components/scope-view/ViewOptionsItems.js";
import { useTaskDestinations } from "../components/tasks/task-destinations.js";
import { clampView, destinationScope, parseScopeKey, scopeKey as destinationKey, viewUnavailableReason, type TasksContext } from "../components/tasks/task-view-model.js";
import { WorkpadDocument } from "./WorkpadDocument.js";
import { useWorkpadDraft } from "./use-workpad-draft.js";
import { archivedListRequest, groupKeys, groupWorkpads, showsLocation, viewCount, workpadListRequest, type WorkpadGroup, type WorkpadsTarget } from "./workpads-view-model.js";
import { applyMarkdownChecklistToggle, type MarkdownChecklistToggle } from "../components/conversation/markdown-checklists.js";
import "./workpads-panel.css";

const message = (error: unknown) => error instanceof Error ? error.message : "Unable to update workpad.";
/** What renaming, moving or archiving needs of a listed or open workpad. */
type WorkpadTarget = Pick<WorkpadSummary, "id" | "revision" | "title" | "scope" | "archivedAt">;
type ListBase = Omit<ListWorkpadsRequest, "query" | "limit" | "cursor">;
/** `listed` then the workpads of `page` it does not hold yet, in order. */
function withoutRepeats(listed: readonly WorkpadSummary[], page: readonly WorkpadSummary[]): WorkpadSummary[] {
  const seen = new Set(listed.map(({ id }) => id));
  return [...listed, ...page.filter(({ id }) => !seen.has(id) && Boolean(seen.add(id)))];
}
/** The guarded identity of what the panel shows: a view and its scope. */
const viewKey = (view: WorkpadsView, scope: WorkpadScope) => JSON.stringify([view, scope]);
const ADD_PLACEHOLDER: Record<WorkpadsView, string> = {
  thread: "New workpad in this thread…",
  project: "New workpad in this project…",
  global: "New global workpad…",
  all: "New global workpad…",
};
const SCOPE_NOUN: Record<WorkpadsView, string> = {
  thread: "workpads in this thread",
  project: "workpads in this project",
  global: "global workpads",
  all: "workpads",
};
export function WorkpadsPanel({ context }: { context: WorkspacePanelContext }) {
  const { applicationStore: store, visible: open, threadId, workspaceId, host } = context;
  const application = useApplicationStore(store);
  const route = useRoute();
  const snapshot = application.snapshot;
  // The panel's project is the project of the thread's location.
  const contextWorkspaceId = workspaceId ?? (threadId ? store.workspaceIdForThread(threadId) : undefined);
  const contextProjectId = snapshot?.workspaces.find(({ id }) => id === contextWorkspaceId)?.projectId;
  const contextKey = JSON.stringify([threadId, contextProjectId]);
  const [leaveRequest, setLeaveRequest] = useState<{ proceed: () => void; contextKey?: string; pendingMutation?: boolean }>();
  // The view Workpads opened on, then the one chosen; it is remembered once the panel shows it.
  const [chosenView, setChosenView] = useState<WorkpadsView>(() => getWorkpadsPanelPreferences().lastView);
  const preferences = useWorkpadsPanelPreferences();
  const [targets, setTargets] = useState({ threadId, contextProjectId, projectId: contextProjectId ?? "", selectedThread: threadId ?? "" });
  // The thread and project in view follow the chat. Only an unsynced editor
  // holds them back (see below), until the user leaves it. Remember every
  // context change so a held target cannot reappear when returning to a
  // previously viewed thread.
  const contextChanged = targets.threadId !== threadId || targets.contextProjectId !== contextProjectId;
  const currentTargets = contextChanged
    ? { threadId, contextProjectId, projectId: contextProjectId ?? "", selectedThread: targets.threadId !== threadId ? threadId ?? "" : targets.selectedThread }
    : targets;
  if (contextChanged) setTargets(currentTargets);
  const { projectId, selectedThread } = currentTargets;
  // The chat the views follow, as Tasks reads it: an archived thread has no Thread view.
  // Only what the views read is kept, so unrelated publications change nothing.
  const shownThreadArchived = Boolean(selectedThread) &&
    snapshot?.threads?.find(({ id }) => id === selectedThread)?.inventoryState === "archived";
  const viewContext = useMemo((): TasksContext => ({
    ...(!selectedThread ? {}
      : shownThreadArchived ? { threadArchived: true as const }
      : { thread: { id: selectedThread, title: "", workspaceId: "" } }),
    ...(projectId ? { project: { id: projectId, label: "" } } : {}),
  }), [selectedThread, shownThreadArchived, projectId]);
  const view = clampView(chosenView, viewContext);
  const options = preferences.views[view];
  const target: WorkpadsTarget = useMemo(() => ({
    ...(viewContext.thread ? { threadId: viewContext.thread.id } : {}),
    ...(viewContext.project ? { projectId: viewContext.project.id } : {}),
  }), [viewContext]);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<WorkpadSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedItems, setArchivedItems] = useState<WorkpadSummary[]>([]);
  const [archivedCursor, setArchivedCursor] = useState<string>();
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [counts, setCounts] = useState<{ key: string; value?: WorkpadCounts; failed?: true }>();
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [selected, setSelected] = useState<Workpad>();
  const [revisions, setRevisions] = useState<WorkpadRevisionSummary[]>([]);
  const [revisionCursor, setRevisionCursor] = useState<string>();
  const [revision, setRevision] = useState<WorkpadRevision>();
  const [attribution, setAttribution] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [documentMenuOpen, setDocumentMenuOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkpadTarget>();
  const [title, setTitle] = useState("");
  const [moveTarget, setMoveTarget] = useState<WorkpadTarget>();
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checklistSaving, setChecklistSaving] = useState(false);
  const [checklistRefreshRequired, setChecklistRefreshRequired] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const draft = useWorkpadDraft(store.api, setError);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const itemsRef = useRef(items); itemsRef.current = items;
  const archivedItemsRef = useRef(archivedItems); archivedItemsRef.current = archivedItems;
  const archivedOpenRef = useRef(archivedOpen); archivedOpenRef.current = archivedOpen;
  const revisionRef = useRef(revision); revisionRef.current = revision;
  const generation = useRef(0);
  const scopeGeneration = useRef(0);
  useEffect(() => () => { ++generation.current; ++scopeGeneration.current; }, []);
  const listGeneration = useRef(0);
  const listCount = useRef(0);
  const archivedGeneration = useRef(0);
  const archivedCount = useRef(0);
  const countsGeneration = useRef(0);
  const loadingId = useRef<string | undefined>(undefined);
  const resumeEvents = useRef<() => void>(() => undefined);
  const listIdentity = useRef("");
  const archivedIdentity = useRef("");
  const operationBusy = useRef(false);
  const operationMutating = useRef(false);
  const activeRequest = useMemo(() => workpadListRequest(view, target, options), [view, target, options]);
  const archivedRequest = useMemo(() => archivedListRequest(view, target, options), [view, target, options]);
  const scope: WorkpadScope = activeRequest?.scope ?? { kind: "global" };
  const scopeKey = viewKey(view, scope);
  const trimmedQuery = query.trim();
  const listKey = JSON.stringify([activeRequest, trimmedQuery]);
  listIdentity.current = listKey;
  const archivedKey = JSON.stringify([archivedRequest, trimmedQuery]);
  archivedIdentity.current = archivedKey;
  const countsKey = JSON.stringify([target.threadId, target.projectId]);
  const scopeValid = activeRequest !== undefined;
  const previousScope = useRef(scopeKey);
  const approvedLeave = useRef<{ scopeKey: string; routeKey?: string; contextKey?: string } | undefined>(undefined);
  const routeKey = routePath(route);
  useLayoutEffect(() => {
    setLeaveRequest(current => current?.contextKey !== undefined && current.contextKey !== contextKey ? undefined : current);
  }, [contextKey]);
  useLayoutEffect(() => {
    if (previousScope.current === scopeKey) return;
    const editor = draft.ref.current;
    const approval = approvedLeave.current;
    const approved = approval?.scopeKey === scopeKey &&
      (approval.routeKey === undefined || approval.routeKey === routeKey) &&
      (approval.contextKey === undefined || approval.contextKey === contextKey);
    const unsynced = draft.saving || Boolean(editor && (editor.remote || editor.text !== editor.draft.content));
    if (!approved && (unsynced || operationMutating.current)) {
      // Choosing another view, or a context change (navigation, or a catalog
      // update such as moving a thread to another project, which never passes
      // through the router guard), would replace the editor. Keep the old
      // view and editor until the user explicitly leaves them.
      const [retainedView, retained] = JSON.parse(previousScope.current) as [WorkpadsView, WorkpadScope];
      const desiredView = chosenView;
      setChosenView(retainedView);
      setTargets({ ...currentTargets,
        ...(retained.kind === "project" ? { projectId: retained.projectId } : {}),
        ...(retained.kind === "thread" ? { selectedThread: retained.threadId } : {}),
      });
      // A router request already owns the user's intended destination. Keep
      // its continuation if the catalog changes while confirmation is open.
      setLeaveRequest(current => current && current.contextKey === undefined ? current : {
        contextKey, pendingMutation: !unsynced,
        proceed: () => { approvedLeave.current = { scopeKey, contextKey }; setTargets(currentTargets); setChosenView(desiredView); },
      });
      return;
    }
    approvedLeave.current = undefined;
    previousScope.current = scopeKey;
    setWorkpadsLastView(chosenView);
    ++scopeGeneration.current; ++generation.current; ++listGeneration.current; ++archivedGeneration.current;
    operationBusy.current = false; operationMutating.current = false; loadingId.current = undefined;
    selectedRef.current = undefined; revisionRef.current = undefined;
    draft.setEditor(undefined);
    setSelected(undefined); setRevision(undefined); setRevisions([]); setRevisionCursor(undefined);
    setItems([]); setCursor(undefined); listCount.current = 0;
    setArchivedItems([]); setArchivedCursor(undefined); archivedCount.current = 0;
    setNewTitle(""); setTitle(""); setRenameTarget(undefined); setMoveTarget(undefined); setDiscarding(false); setReconciling(false);
    setHistoryOpen(false); setViewMenuOpen(false); setDocumentMenuOpen(false);
    setError(""); setRefreshError(""); setBusy(false); setLeaveRequest(undefined);
    setChecklistSaving(false); setChecklistRefreshRequired(false);
  }, [scopeKey, draft.setEditor, draft.saving, routeKey, contextKey, busy]);
  const run = async (action: (isCurrent: () => boolean) => Promise<void>, mutating = false) => {
    if (operationBusy.current) return;
    const token = scopeGeneration.current;
    const isCurrent = () => token === scopeGeneration.current;
    operationBusy.current = true; operationMutating.current = mutating; setBusy(true); setError("");
    try { await action(isCurrent); } catch (failure) { if (isCurrent()) setError(message(failure)); }
    finally { if (isCurrent()) { operationBusy.current = false; operationMutating.current = false; loadingId.current = undefined; setBusy(false); resumeEvents.current(); } }
  };
  /**
   * One list's pages, in the server's order: the next page, or every page
   * already shown again on a refresh. A workpad whose sort key changed
   * between pages can come twice; it is listed once, where it came first.
   */
  const readPages = useCallback(async (request: ListBase & { query?: string }, known: number, nextCursor: string | undefined, isCurrent: () => boolean) => {
    const page = await store.api.listWorkpads({ ...request, ...(nextCursor ? { cursor: nextCursor } : {}) });
    const refreshed = [...page.items];
    let following = page.nextCursor;
    // A change refreshes every page already displayed, preserving pagination.
    while (!nextCursor && following && refreshed.length < known) {
      if (!isCurrent()) return undefined;
      const next = await store.api.listWorkpads({ ...request, cursor: following });
      refreshed.push(...next.items); following = next.nextCursor;
    }
    return isCurrent() ? { items: withoutRepeats([], refreshed), cursor: following } : undefined;
  }, [store]);
  /** The segments' counts, for the thread and project in view. They are secondary: a failure only hides them. */
  const refreshCounts = useCallback(async () => {
    const token = ++countsGeneration.current;
    try {
      const value = await store.api.getWorkpadCounts({
        ...(target.threadId ? { threadId: target.threadId } : {}),
        ...(target.projectId ? { projectId: target.projectId } : {}),
      });
      if (token === countsGeneration.current) setCounts({ key: countsKey, value });
    } catch {
      if (token === countsGeneration.current) setCounts(current => current?.key === countsKey && current.value ? current : { key: countsKey, failed: true });
    }
  }, [store, target, countsKey]);
  /** The Archived section's workpads, while it is expanded. */
  const refreshArchived = useCallback(async (nextCursor?: string) => {
    const token = ++archivedGeneration.current;
    const identity = archivedKey;
    if (!archivedRequest || !archivedOpenRef.current) return;
    const request = { ...archivedRequest, ...(trimmedQuery ? { query: trimmedQuery } : {}) };
    const isCurrent = () => token === archivedGeneration.current && identity === archivedIdentity.current;
    const result = await readPages(request, archivedCount.current, nextCursor, isCurrent);
    if (!result) return;
    const listed = nextCursor ? withoutRepeats(archivedItemsRef.current, result.items) : result.items;
    archivedItemsRef.current = listed;
    setArchivedItems(listed);
    archivedCount.current = listed.length;
    setArchivedCursor(result.cursor);
  }, [archivedRequest, archivedKey, trimmedQuery, readPages]);
  /**
   * The list, and with it (unless asked not to) the counts and an expanded
   * Archived section: whatever refreshes the list refreshes them too. A
   * cursor loads the next page instead.
   */
  const refreshList = useCallback(async (nextCursor?: string, also: { counts?: boolean; archived?: boolean } = {}) => {
    const token = ++listGeneration.current;
    const identity = listKey;
    const alongside = nextCursor ? [] : [
      ...(also.counts !== false ? [refreshCounts()] : []),
      ...(also.archived !== false && archivedOpenRef.current ? [refreshArchived()] : []),
    ];
    if (!activeRequest) { setItems([]); setCursor(undefined); await Promise.all(alongside); return; }
    const request = { ...activeRequest, ...(trimmedQuery ? { query: trimmedQuery } : {}) };
    const isCurrent = () => token === listGeneration.current && identity === listIdentity.current;
    const [result] = await Promise.all([readPages(request, listCount.current, nextCursor, isCurrent), ...alongside]);
    if (!result) return;
    const listed = nextCursor ? withoutRepeats(itemsRef.current, result.items) : result.items;
    itemsRef.current = listed;
    setItems(listed);
    listCount.current = listed.length;
    setCursor(result.cursor);
  }, [activeRequest, listKey, trimmedQuery, readPages, refreshCounts, refreshArchived]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listCount.current = 0;
    setLoading(true);
    const debounce = window.setTimeout(() => {
      void refreshList(undefined, { counts: false, archived: false }).then(() => { if (!cancelled) setRefreshError(""); })
        .catch(failure => { if (!cancelled) setRefreshError(message(failure)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(debounce); ++listGeneration.current; };
  }, [open, refreshList]);
  useEffect(() => {
    if (!open || !archivedOpen) return;
    let cancelled = false;
    archivedCount.current = 0;
    setArchivedLoading(true);
    const debounce = window.setTimeout(() => {
      void refreshArchived().catch(failure => { if (!cancelled) setRefreshError(message(failure)); })
        .finally(() => { if (!cancelled) setArchivedLoading(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(debounce); ++archivedGeneration.current; };
  }, [open, archivedOpen, refreshArchived]);
  // Counts follow the thread and project in view; the list's own refreshes refetch them.
  useEffect(() => {
    if (!open) return;
    void refreshCounts();
    return () => { ++countsGeneration.current; };
  }, [open, refreshCounts]);
  const load = async (id: string) => {
    const token = ++generation.current;
    loadingId.current = id;
    const [workpad, history] = await Promise.all([store.api.getWorkpad(id), store.api.listWorkpadRevisions(id)]);
    const latest = await store.api.getWorkpadRevision(id, workpad.revision);
    if (token !== generation.current) return;
    selectedRef.current = workpad; revisionRef.current = latest; loadingId.current = undefined;
    setSelected(workpad); setRevisions(history.items); setRevisionCursor(history.nextCursor); setRevision(latest);
    setChecklistRefreshRequired(false);
    draft.setEditor(undefined); setReconciling(false); setRenameTarget(undefined); setMoveTarget(undefined); setHistoryOpen(false);
  };
  const refreshDocument = async () => {
    const id = selectedRef.current?.id;
    if (!id) return;
    const token = generation.current;
    const latest = await store.api.getWorkpad(id);
    if (token !== generation.current || selectedRef.current?.id !== id) return;
    const previous = selectedRef.current;
    const viewed = revisionRef.current;
    const [history, updated] = await Promise.all([
      store.api.listWorkpadRevisions(id),
      viewed?.revision === previous.revision ? store.api.getWorkpadRevision(id, latest.revision) : undefined,
    ]);
    if (token !== generation.current || selectedRef.current?.id !== id || operationBusy.current) return;
    selectedRef.current = latest;
    setSelected(latest);
    setChecklistRefreshRequired(false);
    const retained = revisionRef.current;
    setRevisions(retained && !history.items.some(item => item.revision === retained.revision)
      ? [...history.items, retained] : history.items);
    setRevisionCursor(history.nextCursor);
    if (updated && revisionRef.current === viewed) { revisionRef.current = updated; setRevision(updated); }
  };
  const refreshDraft = async () => {
    const id = selectedRef.current?.id;
    if (!id || !draft.ref.current) return;
    const token = generation.current;
    const remote = await store.api.getWorkpadDraft(id);
    if (token !== generation.current || selectedRef.current?.id !== id || operationBusy.current) return;
    await draft.adoptRemote(remote);
    const current = draft.ref.current;
    const latest = selectedRef.current;
    if (latest && current && !current.remote && current.draft.baseRevision !== latest.revision && current.text === current.baseText && current.draft.content === current.baseText) {
      draft.setEditor({ draft: { ...current.draft, baseRevision: latest.revision }, text: latest.content, baseText: latest.content });
    }
  };
  const refreshHandlers = useRef({ refreshList, refreshDocument, refreshDraft });
  refreshHandlers.current = { refreshList, refreshDocument, refreshDraft };
  useEffect(() => {
    if (!open) return;
    let disposed = false;
    let inflight = false;
    let listPending = false;
    let documentPending = false;
    let draftPending = false;
    const drain = async () => {
      if (disposed || inflight || operationBusy.current) return;
      inflight = true;
      try {
        while (!disposed && !operationBusy.current && (listPending || documentPending || draftPending)) {
          const refreshListNow = listPending;
          const refreshDocumentNow = documentPending;
          const refreshDraftNow = draftPending || refreshDocumentNow;
          listPending = false; documentPending = false; draftPending = false;
          try {
            if (refreshListNow) await refreshHandlers.current.refreshList();
            if (disposed) return;
            if (operationBusy.current) {
              documentPending ||= refreshDocumentNow; draftPending ||= refreshDraftNow;
              break;
            }
            if (refreshDocumentNow) await refreshHandlers.current.refreshDocument();
            if (disposed) return;
            if (operationBusy.current) {
              documentPending ||= refreshDocumentNow; draftPending ||= refreshDraftNow;
              break;
            }
            if (refreshDraftNow) await refreshHandlers.current.refreshDraft();
            if (operationBusy.current) draftPending ||= refreshDraftNow;
            if (!disposed) setRefreshError("");
          } catch (failure) { if (!disposed) setRefreshError(message(failure)); }
        }
      } finally { inflight = false; }
    };
    const resync = () => {
      listPending = true; documentPending = true; draftPending = true;
      void drain();
    };
    const unsubscribe = store.normalized.subscribeWorkpadChanges(change => {
      if (!change) { resync(); return; }
      const relevant = change.workpadId === (loadingId.current ?? selectedRef.current?.id);
      if (change.change === "document") { listPending = true; documentPending ||= relevant; }
      else draftPending ||= relevant;
      void drain();
    });
    resumeEvents.current = () => { void drain(); };
    window.addEventListener("focus", resync);
    // Opening a retained detail catches changes received while this panel was closed.
    if (selectedRef.current) { documentPending = true; draftPending = true; void drain(); }
    return () => {
      disposed = true; unsubscribe(); window.removeEventListener("focus", resync);
      resumeEvents.current = () => undefined;
    };
  }, [open, store]);
  const hasUnsynced = Boolean(draft.editor && (draft.editor.remote || draft.editor.text !== draft.editor.draft.content));
  useEffect(() => { host.setDirty(hasUnsynced || draft.saving); }, [host, hasUnsynced, draft.saving]);
  useEffect(() => { host.setBusy(busy || draft.saving); }, [host, busy, draft.saving]);
  // Router approvals are keyed by callback identity. Keep one registration,
  // forwarding to current state so stream updates cannot invalidate a dialog.
  const navigationGuard = useRef<NavigationBlocker>(() => true);
  navigationGuard.current = (current, next, proceed) => {
    // Settings parks the owning thread instead of replacing its workpads.
    if (next.name === "settings") return true;
    const retainedThread = current.name === "thread" ||
      (current.name === "settings" && threadId !== undefined);
    if (retainedThread && next.name === "thread") {
      // Global and All are the same in every thread.
      if (next.threadId === threadId || view === "global" || view === "all") return true;
      if (view === "thread" && next.threadId === selectedThread) return true;
      if (view === "project") {
        const nextWorkspaceId = store.workspaceIdForThread(next.threadId);
        const nextProjectId = store.getSnapshot().snapshot?.workspaces.find(({ id }) => id === nextWorkspaceId)?.projectId;
        if (nextProjectId && nextProjectId === projectId) return true;
      }
    }
    if (!(hasUnsynced || draft.saving || operationMutating.current)) return true;
    setLeaveRequest({ pendingMutation: !(hasUnsynced || draft.saving), proceed: () => {
      // The destination may have moved projects while the dialog was open.
      const nextThreadId = next.name === "thread" ? next.threadId : undefined;
      const nextWorkspaceId = nextThreadId ? store.workspaceIdForThread(nextThreadId) : undefined;
      const nextSnapshot = store.getSnapshot().snapshot;
      const nextProjectId = nextSnapshot?.workspaces.find(({ id }) => id === nextWorkspaceId)?.projectId;
      const nextArchived = nextSnapshot?.threads?.find(({ id }) => id === nextThreadId)?.inventoryState === "archived";
      const nextContext: TasksContext = {
        ...(!nextThreadId ? {} : nextArchived ? { threadArchived: true as const } : { thread: { id: nextThreadId, title: "", workspaceId: "" } }),
        ...(nextProjectId ? { project: { id: nextProjectId, label: "" } } : {}),
      };
      const nextView = clampView(chosenView, nextContext);
      const nextScope: WorkpadScope = nextView === "thread" && nextContext.thread ? { kind: "thread", threadId: nextContext.thread.id }
        : nextView === "project" && nextContext.project ? { kind: "project", projectId: nextContext.project.id }
        : { kind: "global" };
      approvedLeave.current = { scopeKey: viewKey(nextView, nextScope), routeKey: routePath(next) };
      proceed();
    } });
    return false;
  };
  useEffect(() => installNavigationBlocker((...args) => navigationGuard.current(...args)), []);
  const beginEditing = async (isCurrent: () => boolean) => {
    // Read through the ref: creating a workpad opens it and starts editing
    // in one operation, before this render's `selected` catches up.
    const selected = selectedRef.current;
    if (!selected) return;
    let value = await store.api.getWorkpadDraft(selected.id);
    let base = await store.api.getWorkpadRevision(selected.id, value.baseRevision);
    if (!isCurrent()) return;
    if (value.baseRevision !== selected.revision && value.content === base.content) {
      value = await store.api.discardWorkpadDraft(selected.id, value.revision);
      base = await store.api.getWorkpadRevision(selected.id, value.baseRevision);
    }
    if (!isCurrent()) return;
    draft.setEditor({ draft: value, text: value.content, baseText: base.content }); setReconciling(false);
  };
  const saveDocument = async (isCurrent: () => boolean) => {
    if (!selected || !draft.editor) return;
    const value = await draft.save();
    if (!isCurrent()) return;
    const result = await store.api.commitWorkpadDraft(selected.id, { expectedDraftRevision: value.revision, expectedRevision: value.baseRevision });
    if (!isCurrent()) return;
    await load(result.workpad.id);
    if (isCurrent()) await refreshList();
  };
  // Any listed or open workpad; an open one reloads with the result. The
  // revision is the latest this panel knows, not the one a dialog opened
  // with: live refresh keeps both the open document and the list current.
  const mutate = async (target: WorkpadTarget, change: Omit<UpdateWorkpadRequest, "expectedRevision">) => {
    const token = scopeGeneration.current;
    const known = selectedRef.current?.id === target.id ? selectedRef.current
      : itemsRef.current.find(({ id }) => id === target.id) ?? archivedItemsRef.current.find(({ id }) => id === target.id) ?? target;
    const result = await store.api.updateWorkpad(target.id, { expectedRevision: known.revision, ...change });
    if (token !== scopeGeneration.current) return;
    if (selectedRef.current?.id === result.id) await load(result.id);
    if (token === scopeGeneration.current) await refreshList();
  };
  const toggleChecklist = (viewed: WorkpadRevision, change: MarkdownChecklistToggle) => {
    const current = selectedRef.current;
    if (!open || operationBusy.current || checklistRefreshRequired || draft.ref.current || !current || current.archivedAt ||
      current.id !== viewed.workpadId || current.revision !== viewed.revision || revisionRef.current !== viewed || change.source !== viewed.content) return;
    const content = applyMarkdownChecklistToggle(change);
    if (content === undefined) return;
    const documentGeneration = generation.current;
    void run(async isCurrent => {
      const stillViewing = () => isCurrent() && generation.current === documentGeneration && revisionRef.current === viewed;
      setChecklistSaving(true);
      try {
        try {
          // The revision belongs to this exact rendered source. A fresher
          // counter from the selected summary must never authorize old text.
          await store.api.updateWorkpad(current.id, { expectedRevision: viewed.revision, edit: { kind: "replace", content } });
        } catch (failure) {
          if (!stillViewing()) return;
          // A conflict or lost response needs an authoritative read, never an
          // automatic retry with the old source and a newer revision counter.
          try { await load(current.id); } catch {
            if (isCurrent()) setChecklistRefreshRequired(true);
          }
          if (isCurrent()) setError(message(failure));
          return;
        }
        if (!stillViewing()) return;
        try {
          await load(current.id);
        } catch (failure) {
          if (isCurrent()) {
            setChecklistRefreshRequired(true);
            setError(`Checklist change saved, but the updated workpad could not be loaded. ${message(failure)}`);
          }
          return;
        }
        if (isCurrent()) await refreshList();
      } finally {
        if (isCurrent()) setChecklistSaving(false);
      }
    }, true);
  };
  const stale = Boolean(selected && draft.editor && selected.revision !== draft.editor.draft.baseRevision);
  const chooseRevision = async (number: number) => {
    const token = generation.current;
    if (selected) { const next = await store.api.getWorkpadRevision(selected.id, number); if (token !== generation.current) return; revisionRef.current = next; setRevision(next); }
  };
  const touch = useTouchDensity();
  // Names follow the chat the panel serves, also while Settings parks it.
  const followedRoute = useMemo<Route>(() => threadId ? { name: "thread", threadId } : { name: "home" }, [threadId]);
  const destinations = useTaskDestinations(snapshot, followedRoute);
  const editing = Boolean(draft.editor);
  const latestRevision = selected?.revision;
  // An older revision on screen, as opposed to the document's latest.
  const viewedOlder = revision && latestRevision !== undefined && revision.revision !== latestRevision ? revision : undefined;
  // Keep Markdown props stable on unrelated application publications, while
  // invoking the callback belonging to the latest rendered revision/source.
  const checklistToggleHandler = useRef<(change: MarkdownChecklistToggle) => void>(() => undefined);
  checklistToggleHandler.current = change => { if (revision) toggleChecklist(revision, change); };
  const onChecklistToggle = useCallback((change: MarkdownChecklistToggle) => checklistToggleHandler.current(change), []);
  const checklistDisabled = Boolean(selected?.archivedAt || viewedOlder || checklistRefreshRequired || (busy && !checklistSaving));
  const checklistControls = useMemo(() => ({ disabled: checklistDisabled, pending: checklistSaving, onToggle: onChecklistToggle }),
    [checklistDisabled, checklistSaving, onChecklistToggle]);
  const noChanges = Boolean(draft.editor && draft.editor.text === draft.editor.baseText);
  const canSave = Boolean(draft.editor) && !busy && !draft.saving && !stale && !draft.editor?.remote && !noChanges;

  // ‹ Workpads, and everything else that returns to the list: the open
  // editor's text syncs first, and the document closes once it has.
  const closeDocument = (then?: () => void) => {
    void run(async isCurrent => {
      if (draft.editor) await draft.save();
      if (!isCurrent()) return;
      draft.setEditor(undefined); selectedRef.current = undefined; revisionRef.current = undefined;
      setSelected(undefined); setRevision(undefined); setHistoryOpen(false); setDocumentMenuOpen(false); ++generation.current;
      setChecklistRefreshRequired(false);
      then?.();
    });
  };
  /** Search and View options act on the list: with a workpad open, they return to it first. */
  const fromList = (action: () => void) => { if (selectedRef.current) closeDocument(action); else action(); };
  const changeOptions = (patch: Partial<WorkpadsViewOptions>) => fromList(() => setWorkpadsViewOptions(view, patch));
  const openRename = (target: WorkpadTarget) => { setTitle(target.title); setRenameTarget(target); };
  const moveTo = (target: WorkpadTarget, destination: WorkpadScope) => { void run(() => mutate(target, { scope: destination }), true); };
  const archiveWorkpad = (target: WorkpadTarget, value: boolean) => { void run(() => mutate(target, { archived: value }), true); };
  const finishEditing = () => { void run(async isCurrent => { await draft.save(); if (isCurrent()) draft.setEditor(undefined); }); };
  // Choosing a view returns to its list; the scope guard above confirms
  // leaving unsynced text. Choosing the one in view again closes the workpad.
  const changeView = (next: WorkpadsView) => {
    if (viewUnavailableReason(next, viewContext, "workpads") !== undefined) return;
    setChosenView(next);
  };
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const closeSearch = () => { setSearchOpen(false); setQuery(""); requestAnimationFrame(() => searchButtonRef.current?.focus()); };
  const destination = destinationScope(view, viewContext);
  const create = () => {
    const value = newTitle.trim();
    if (!value || !destination) return;
    void run(async isCurrent => {
      const created = await store.api.createWorkpad({ title: value, scope: destination });
      if (!isCurrent()) return;
      setNewTitle("");
      await load(created.id);
      // A new workpad opens ready for its first text.
      if (isCurrent() && selectedRef.current?.id === created.id) await beginEditing(isCurrent);
    }, true);
  };

  // Android Back closes an open workpad, as ‹ Workpads does.
  const closeDocumentRef = useRef(closeDocument); closeDocumentRef.current = closeDocument;
  useEffect(() => {
    if (!open) return;
    const onClose = (event: Event) => {
      if (!selectedRef.current) return;
      event.preventDefault();
      closeDocumentRef.current();
    };
    window.addEventListener(CLOSE_WORKPAD_EVENT, onClose);
    return () => window.removeEventListener(CLOSE_WORKPAD_EVENT, onClose);
  }, [open]);

  // All's groups, named from the snapshot. A thread in a project with
  // several locations says where it runs.
  const groups = useMemo(() => view === "all" && options.groupByProject ? groupWorkpads(items, {
    project: id => destinations.projectLabels.get(id),
    thread: id => {
      const name = destinations.threadTitles.get(id);
      const where = destinations.threadLocation(id);
      return name && where ? `${name} · ${where}` : name;
    },
    threadProject: id => destinations.threadProjectId(id),
  }) : undefined, [view, options.groupByProject, items, destinations]);
  const hasSelection = selected !== undefined;
  const hasGroups = !hasSelection && groups !== undefined && groups.length > 0;
  const anyCollapsed = collapsedGroups.size > 0;
  const groupsRef = useRef(groups); groupsRef.current = groups;
  // The panel's ⋯ collapses or expands All's groups, as Tasks' does.
  const menuItems = useMemo(() => hasGroups ? <DropdownMenuItem onSelect={() =>
    setCollapsedGroups(anyCollapsed ? new Set() : new Set(groupKeys(groupsRef.current ?? [])))}>
    {anyCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}
    <span>{anyCollapsed ? "Expand all groups" : "Collapse all groups"}</span>
  </DropdownMenuItem> : undefined, [hasGroups, anyCollapsed]);
  useEffect(() => { host.setMenuItems(menuItems); }, [host, menuItems]);
  useEffect(() => () => { host.setMenuItems(undefined); }, [host]);

  const errorText = error || refreshError || (checklistRefreshRequired ? "Reload this workpad before changing checklist items." : "");
  const errorCallout = errorText && <div className="workpads-alert">
    <Callout tone="danger" role="alert" action={checklistRefreshRequired && selected && <Button variant="outline" size="sm" disabled={busy || editing || draft.saving}
      onClick={() => {
        // Recovery reloads replace the reading view, never an open draft.
        if (draft.ref.current || draft.saving || selectedRef.current?.id !== selected.id) return;
        void run(() => load(selected.id));
      }}>Reload workpad</Button>}>{errorText}</Callout>
    <Button variant="ghost" size="icon-xs" className="workpads-alert-dismiss" aria-label="Dismiss error" onClick={() => { setError(""); setRefreshError(""); }}><X aria-hidden="true" /></Button>
  </div>;

  const chips: ViewFilterChip[] = view === "project" && options.includeThreadWorkpads ? [{ key: "threads", label: "Thread workpads" }] : [];
  const chromeActions = createPortal(<div className="workpads-chrome-actions">
    <Button ref={searchButtonRef} variant="ghost" size="icon-sm" aria-label="Search workpads" aria-pressed={searchOpen && !selected} title="Search workpads"
      onClick={() => (selected ? fromList(() => setSearchOpen(true)) : searchOpen ? closeSearch() : setSearchOpen(true))}>
      <Search aria-hidden="true" />
    </Button>
    <DropdownMenu presentation={touch ? "sheet" : "menu"} open={open && viewMenuOpen} onOpenChange={setViewMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="view-options-trigger" aria-label="View options" title="View options" data-filtering={chips.length > 0 || undefined}>
          <ListFilter aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="View options" sheetTitle="View options">
        <SortOptionItems value={options.sort} disabled={busy} onChange={sort => changeOptions({ sort })} />
        {(view === "all" || view === "project") && <DropdownMenuSeparator />}
        <ScopeOptionItem view={view} groupByProject={options.groupByProject} includeThreadItems={options.includeThreadWorkpads}
          includeThreadLabel="Include thread workpads" disabled={busy}
          onChange={({ groupByProject, includeThreadItems }) => changeOptions({
            ...(groupByProject !== undefined ? { groupByProject } : {}),
            ...(includeThreadItems !== undefined ? { includeThreadWorkpads: includeThreadItems } : {}),
          })} />
      </DropdownMenuContent>
    </DropdownMenu>
  </div>, context.chromeActionsTarget);

  const activeCounts = counts?.key === countsKey ? counts.value?.active : undefined;
  const archivedCounts = counts?.key === countsKey ? counts.value?.archived : undefined;
  const countsFailed = counts?.key === countsKey && counts.failed === true;
  const archivedTotal = viewCount(archivedCounts, view, options.includeThreadWorkpads);
  // The section shows while the view has archived workpads, and whenever their count cannot be read.
  const archivedShown = (archivedTotal ?? 0) > 0 || countsFailed || archivedItems.length > 0;
  const segments = <ScopeSegments aria-label="Workpad scope" value={view} disabled={busy}
    onValueChange={changeView}
    onReselect={() => { if (selectedRef.current) closeDocument(); }}
    unavailableReason={candidate => viewUnavailableReason(candidate, viewContext, "workpads")}
    count={candidate => viewCount(activeCounts, candidate, candidate === "project" && preferences.views.project.includeThreadWorkpads)}
    describeCount={count => `${count} ${count === 1 ? "workpad" : "workpads"}`} />;

  const rowLocation = (item: WorkpadSummary, section: "active" | "archived") =>
    showsLocation(view, options, section) ? destinations.location(item.scope, { withProject: view === "all" }) : undefined;
  const renderRow = (item: WorkpadSummary, location?: ScopeLocationLabel) => <WorkpadRow key={item.id} item={item} location={location}
    busy={busy} touch={touch} threadId={threadId} projectId={contextProjectId}
    onOpen={() => { void run(() => load(item.id)); }} onRename={() => openRename(item)}
    onMove={destination => moveTo(item, destination)} onChooseMove={() => setMoveTarget(item)}
    onArchive={() => archiveWorkpad(item, !item.archivedAt)} />;
  const toggleGroup = (key: string) => setCollapsedGroups(current => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const renderGroup = (group: WorkpadGroup): React.JSX.Element => {
    const collapsed = collapsedGroups.has(group.key);
    return <li key={group.key} className="list-group" data-kind={group.kind}>
      <ListHeading variant="group" expanded={!collapsed} onToggle={() => toggleGroup(group.key)}
        icon={<ListHeadingIcon kind={group.kind} />} label={group.label} count={group.count} />
      {!collapsed && <ul className="workpads-list" aria-label={group.label}>
        {group.items.map(item => renderRow(item))}
        {group.children.map(renderGroup)}
      </ul>}
    </li>;
  };
  const emptyState = (() => {
    if (loading) return <EmptyState variant="inline" className="workpads-empty" title="Loading…" />;
    if (!scopeValid) return <EmptyState variant="inline" className="workpads-empty" title="Open a thread to see its workpads" />;
    if (trimmedQuery) return <EmptyState variant="inline" className="workpads-empty" title={`No workpads match “${trimmedQuery}”`} />;
    if ((archivedTotal ?? 0) > 0) return <EmptyState variant="inline" className="workpads-empty" title="Nothing active." description="Every workpad here is archived." />;
    return <EmptyState variant="inline" className="workpads-empty" title={`No ${SCOPE_NOUN[view]} yet`} description="Name one above, or ask an agent to start one." />;
  })();
  const archivedSection = archivedShown && <section className="workpads-section" aria-label="Archived workpads">
    <ListHeading variant="section" expanded={archivedOpen} onToggle={() => setArchivedOpen(value => !value)}
      label="Archived" count={trimmedQuery ? undefined : archivedTotal} />
    {archivedOpen && <>
      {archivedItems.length ? <ul className="workpads-list" aria-label="Archived workpads">
        {archivedItems.map(item => renderRow(item, rowLocation(item, "archived")))}
      </ul> : <EmptyState variant="inline" className="workpads-empty"
        title={archivedLoading ? "Loading…" : trimmedQuery ? `No archived workpads match “${trimmedQuery}”` : "No archived workpads"} />}
      {archivedCursor && <Button variant="ghost" size="sm" className="workpads-more" disabled={busy} onClick={() => { void run(() => refreshArchived(archivedCursor)); }}>Load more</Button>}
    </>}
  </section>;

  const listView = <>
    {errorCallout}
    <div className="workpads-scroll" aria-busy={loading}>
      {items.length ? <ul className="workpads-list" aria-label={`${view === "all" ? "All" : view === "global" ? "Global" : view === "project" ? "Project" : "Thread"} workpads`}>
        {groups ? groups.map(renderGroup) : items.map(item => renderRow(item, rowLocation(item, "active")))}
      </ul> : emptyState}
      {cursor && <Button variant="ghost" size="sm" className="workpads-more" disabled={busy} onClick={() => { void run(() => refreshList(cursor)); }}>Load more</Button>}
      {archivedSection}
    </div>
  </>;

  const revisionLabel = (value: { revision: number }) => value.revision === 0 ? "Created" : `Revision ${value.revision}`;
  const syncLabel = draft.saving ? "Syncing draft…" : draft.editor?.remote ? "Draft conflict" : hasUnsynced ? "Draft not synced" : noChanges ? "No changes" : "Draft synced";
  // The workpad's place, named as list rows name it.
  const place = revision && destinations.location(revision.scope, { withProject: true });
  const meta = revision && place && <>
    {(revision.revision === 0
      ? [`Created ${relativeTime(revision.createdAt)} by ${revision.author.name}`]
      : [revisionLabel(revision), relativeTime(revision.createdAt), revision.author.name]).join(" · ")}
    {" · "}
    <span className="workpads-doc-scope"><ScopeIcon kind={place.kind} />{place.label}</span>
  </>;
  const orderedRevisions = useMemo(() => [...revisions].sort((left, right) => right.revision - left.revision), [revisions]);
  // The title of the revision on screen; an open editor edits the latest.
  const documentTitle = selected ? (editing ? selected.title : revision?.title ?? selected.title) : "";
  const selectedArchived = Boolean(selected?.archivedAt);

  const documentView = selected && <>
    <div className="workpads-doc-toolbar">
      <Button variant="ghost" size="sm" className="workpads-doc-back" aria-label="Back to workpads" title="Back to workpads" disabled={busy}
        onClick={() => closeDocument()}>
        <ChevronLeft data-icon="inline-start" aria-hidden="true" />
        <span className="workpads-doc-back-label">Workpads</span>
      </Button>
      <div className="workpads-doc-heading">
        <h3 className="workpads-doc-title" title={documentTitle}>{documentTitle}</h3>
        {editing
          ? <span className="workpads-doc-meta workpads-sync" role="status">{syncLabel}</span>
          : checklistSaving ? <span className="workpads-doc-meta workpads-sync" role="status">Saving checklist item…</span>
          : <span className="workpads-doc-meta" title={revision ? new Date(revision.createdAt).toLocaleString() : undefined}>{meta}</span>}
      </div>
      <div className="workpads-doc-actions">
        {!editing && <Button variant={attribution ? "secondary" : "ghost"} size="icon-sm" aria-label="Show attribution" aria-pressed={attribution}
          title={attribution ? "Hide attribution" : "Show attribution"} onClick={() => setAttribution(!attribution)}>
          <Highlighter aria-hidden="true" />
        </Button>}
        {!editing && <DropdownMenu presentation={touch ? "sheet" : "menu"} open={open && historyOpen} onOpenChange={setHistoryOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant={viewedOlder ? "secondary" : "ghost"} size="icon-sm" aria-label="Revision history" title="Revision history" disabled={!revision}>
              <History aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sheetTitle="Revisions" className="workpads-history-menu">
            {!touch && <DropdownMenuLabel>Revisions</DropdownMenuLabel>}
            <DropdownMenuRadioGroup aria-label="Revision" value={revision ? String(revision.revision) : ""}
              onValueChange={value => { void run(() => chooseRevision(Number(value))); }}>
              {orderedRevisions.map(value => <DropdownMenuRadioItem key={value.revision} value={String(value.revision)}>
                <span className="workpads-history-item">
                  <span>{revisionLabel(value)}{value.revision === latestRevision ? " · latest" : ""}</span>
                  <DropdownMenuItemDescription>{value.author.name} · {relativeTime(value.createdAt)}</DropdownMenuItemDescription>
                </span>
              </DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            {revisionCursor && <>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={busy} onSelect={event => {
                event.preventDefault();
                void run(async isCurrent => { const page = await store.api.listWorkpadRevisions(selected.id, revisionCursor); if (!isCurrent()) return; setRevisions(previous => [...previous, ...page.items]); setRevisionCursor(page.nextCursor); });
              }}>Older revisions</DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>}
        <Button variant="ghost" size="icon-sm"
          aria-label={editing ? "Done editing" : "Edit workpad"} title={editing ? "Done editing" : "Edit workpad"}
          disabled={busy || (editing ? Boolean(draft.editor?.remote) : Boolean(selected.archivedAt) || checklistRefreshRequired)}
          onClick={() => { if (editing) finishEditing(); else if (!checklistRefreshRequired) void run(beginEditing); }}>
          {editing ? <Check aria-hidden="true" /> : <FilePenLine aria-hidden="true" />}
        </Button>
        {editing && <Button size="sm" className="workpads-save" aria-label="Save workpad" title="Save as a new revision (Ctrl+S)" aria-busy={(busy && operationMutating.current) || undefined}
          disabled={!canSave} onClick={() => { void run(saveDocument, true); }}>
          {busy && operationMutating.current && <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden="true" />}
          Save
        </Button>}
        <DropdownMenu presentation={touch ? "sheet" : "menu"} open={open && documentMenuOpen} onOpenChange={setDocumentMenuOpen}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Workpad actions" title="More">
              <Ellipsis aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sheetTitle={documentTitle}>
            {editing ? <DropdownMenuItem variant="destructive" disabled={busy || draft.saving} onSelect={() => setDiscarding(true)}>
              <Trash2 /><span>Discard draft…</span>
            </DropdownMenuItem> : <>
              <DropdownMenuItem disabled={busy} onSelect={() => openRename(selected)}><Pencil /><span>Rename…</span></DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger disabled={busy}><FolderInput /><span>Move to</span></DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <MoveToItems current={destinationKey(selected.scope)} threadId={threadId} projectId={contextProjectId}
                    onMove={value => moveTo(selected, value)} onChoose={() => setMoveTarget(selected)} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem disabled={busy} onSelect={() => archiveWorkpad(selected, !selected.archivedAt)}>
                {selectedArchived ? <><ArchiveRestore /><span>Unarchive</span></> : <><Archive /><span>Archive</span></>}
              </DropdownMenuItem>
            </>}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
    {errorCallout}
    {selected.archivedAt && !editing && <div className="workpads-notice">
      <Callout action={<Button size="sm" variant="outline" disabled={busy} onClick={() => archiveWorkpad(selected, false)}>Unarchive</Button>}>
        This workpad is archived.
      </Callout>
    </div>}
    {viewedOlder && !editing && <div className="workpads-notice">
      <Callout tone="info" action={<Button size="sm" variant="outline" disabled={busy || latestRevision === undefined}
        onClick={() => { if (latestRevision !== undefined) void run(() => chooseRevision(latestRevision)); }}>Back to latest</Button>}>
        Viewing {viewedOlder.revision === 0 ? "the first version" : `revision ${viewedOlder.revision}`}. The latest is revision {latestRevision}.
      </Callout>
    </div>}
    {draft.editor ? <div className="workpads-editor" onKeyDown={event => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        if (canSave) void run(saveDocument, true);
      }
    }}>
      {draft.editor.remote && <Callout tone="warning" role="alert" className="workpads-conflict" title="This draft changed on another device.">
        <details><summary>Other device’s draft</summary><pre>{draft.editor.remote.content}</pre></details>
        <div className="workpads-callout-actions">
          <Button size="sm" variant="outline" onClick={() => { void run(async isCurrent => { const remote = draft.editor!.remote!; const base = await store.api.getWorkpadRevision(selected.id, remote.baseRevision); if (!isCurrent()) return; draft.setEditor({ draft: remote, text: remote.content, baseText: base.content }); }); }}>Use latest draft</Button>
          <Button size="sm" variant="ghost" onClick={() => { const value = draft.editor!; draft.setEditor({ ...value, draft: { ...value.remote!, baseRevision: value.draft.baseRevision }, remote: undefined }); }}>Keep my draft</Button>
        </div>
      </Callout>}
      {stale && <Callout tone="warning" role="alert" className="workpads-conflict" title="The document changed.">
        Review the latest version before saving.
        {reconciling && <>
          <details open><summary>Starting version · revision {draft.editor.draft.baseRevision}</summary><pre>{draft.editor.baseText}</pre></details>
          <details open><summary>Latest version · revision {selected.revision}</summary><pre>{selected.content}</pre></details>
        </>}
        <div className="workpads-callout-actions">
          <Button size="sm" variant="outline" onClick={() => setReconciling(!reconciling)}>{reconciling ? "Hide comparison" : "Review changes"}</Button>
          {reconciling && <Button size="sm" disabled={Boolean(draft.editor.remote) || draft.saving} onClick={() => { void run(async isCurrent => { const synced = await draft.save(); if (!isCurrent()) return; const rebased = await store.api.saveWorkpadDraft(selected.id, { expectedRevision: synced.revision, baseRevision: selected.revision, content: draft.ref.current!.text }); if (!isCurrent()) return; draft.setEditor({ draft: rebased, text: rebased.content, baseText: selected.content }); setReconciling(false); }, true); }}>Use my reconciled text</Button>}
        </div>
      </Callout>}
      <Textarea disabled={busy} aria-label="Workpad content" maxLength={WORKPAD_CONTENT_MAX_CHARACTERS} value={draft.editor.text}
        onChange={event => draft.setEditor({ ...draft.editor!, text: event.target.value })} spellCheck className="workpads-textarea" />
    </div> : <div className="workpads-reading">{revision && <>
      <WorkpadDocument active={open} content={revision.content} attribution={revision.attribution} showAttribution={attribution}
        checklist={checklistControls} />
      <details className="workpads-revision-details">
        <summary>Revision details</summary>
        <p className="workpads-revision-byline">{revisionLabel(revision)} · {revision.author.name} · {new Date(revision.createdAt).toLocaleString()}</p>
        {revision.changes.length ? (["removed", "added"] as const).map(kind => {
          const changes = revision.changes.filter(change => change.kind === kind);
          return changes.length ? <div key={kind} className="workpads-revision-changes">
            <strong>{kind === "removed" ? "Removed" : "Added"} by {revision.author.name}</strong>
            {changes.map((change, index) => <blockquote key={index} data-kind={kind}>{change.text}</blockquote>)}
          </div> : null;
        }) : <p>Document metadata updated.</p>}
      </details>
    </>}</div>}
  </>;

  return <section id="workpads-panel" role="region" aria-label="Workpads" className="workpads-panel" data-touch={touch || undefined}
    data-document-open={selected ? "" : undefined}>
    {chromeActions}
    {searchOpen && !selected && <div className="workpads-search">
      <Search className="workpads-search-icon" aria-hidden="true" />
      <input autoFocus type="text" className="workpads-search-input" aria-label="Search workpads" placeholder="Search titles and text"
        autoComplete="off" maxLength={240} value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); } }} />
      <Button variant="ghost" size="icon-xs" aria-label="Close search" onClick={closeSearch}><X aria-hidden="true" /></Button>
    </div>}
    <div className="workpads-toolbar">
      {segments}
      {!selected && <ViewFilterChips chips={chips} disabled={busy}
        onRemove={() => setWorkpadsViewOptions(view, { includeThreadWorkpads: false })} />}
      {!selected && <form className="workpads-add" onSubmit={event => { event.preventDefault(); create(); }}>
        <Plus className="workpads-add-icon" aria-hidden="true" />
        <input type="text" className="workpads-add-input" aria-label="New workpad title" placeholder={ADD_PLACEHOLDER[view]}
          autoComplete="off" enterKeyHint="done" maxLength={240} disabled={!destination} value={newTitle}
          onChange={event => setNewTitle(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape" && newTitle) { event.preventDefault(); event.stopPropagation(); setNewTitle(""); } }} />
        {newTitle.trim() && <span className="workpads-add-hint" aria-hidden="true">↵ create</span>}
      </form>}
    </div>
    {selected ? documentView : listView}
    <Dialog open={open && renameTarget !== undefined} onOpenChange={value => { if (!value) setRenameTarget(undefined); }}>
      <DialogContent size="sm" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Rename workpad</DialogTitle></DialogHeader>
        <form className="contents" noValidate onSubmit={event => {
          event.preventDefault();
          const target = renameTarget;
          const value = title.trim();
          if (!target || !value) return;
          setRenameTarget(undefined);
          void run(() => mutate(target, { title: value }), true);
        }}>
          <DialogBody>
            <Field label="Title"><Input autoFocus aria-label="Workpad title" maxLength={240} value={title} onChange={event => setTitle(event.target.value)} /></Field>
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setRenameTarget(undefined)}>Cancel</Button>
            <Button type="submit" disabled={busy || !title.trim()}>Rename</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <Dialog open={open && moveTarget !== undefined} onOpenChange={value => { if (!value) setMoveTarget(undefined); }}>
      <DialogContent size="sm" mobile="sheet" className="searchable-select-sheet workpads-destination-dialog" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>Move workpad</DialogTitle></DialogHeader>
        {moveTarget && <SearchableSelectList
          label="Destination"
          searchLabel="Search threads and projects"
          emptyLabel="No matching threads or projects."
          value={destinationKey(moveTarget.scope)}
          options={destinations.options(moveTarget.scope)}
          initialDirection="first"
          onValueChange={value => {
            const destination = parseScopeKey(value);
            const target = moveTarget;
            setMoveTarget(undefined);
            if (destination) moveTo(target, destination);
          }}
        />}
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={open && discarding}
      tone="danger"
      title="Discard draft?"
      description="Your unsaved edits to this workpad will be lost. Saved revisions are kept."
      confirmLabel="Discard draft"
      onOpenChange={value => { if (!value) setDiscarding(false); }}
      onConfirm={async () => {
        // A failure keeps the confirmation open with its message inline.
        let failure: unknown;
        await run(async () => { try { await draft.discard(); } catch (caught) { failure = caught; } }, true);
        if (failure !== undefined) throw failure instanceof Error ? failure : new Error(message(failure));
      }}
    />
    <DiscardChangesDialog
      open={Boolean(leaveRequest)}
      onOpenChange={value => { if (!value) setLeaveRequest(undefined); }}
      title={leaveRequest?.pendingMutation ? "Leave pending workpad changes?" : "Leave unsynced workpad?"}
      description={leaveRequest?.pendingMutation ? "A workpad change is still in progress. Leaving will hide its result. Leave anyway?" : "Your latest workpad draft changes have not synced. Leave anyway?"}
      discardLabel="Leave anyway"
      onDiscard={() => {
        const request = leaveRequest;
        setLeaveRequest(undefined);
        request?.proceed();
      }}
    />
  </section>;
}

/** This thread · This project · Global · Choose…, the current one disabled. */
function MoveToItems({ current, threadId, projectId, onMove, onChoose }: {
  readonly current?: string;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly onMove: (scope: WorkpadScope) => void;
  readonly onChoose: () => void;
}) {
  const choices: readonly { label: string; kind: WorkpadScope["kind"]; scope?: WorkpadScope; missing: string }[] = [
    { label: "This thread", kind: "thread", missing: "No thread", ...(threadId ? { scope: { kind: "thread", threadId } } : {}) },
    { label: "This project", kind: "project", missing: "No project", ...(projectId ? { scope: { kind: "project", projectId } } : {}) },
    { label: "Global", kind: "global", missing: "", scope: { kind: "global" } },
  ];
  return <>
    {choices.map(choice => {
      const reason = choice.scope && destinationKey(choice.scope) === current ? "Current" : choice.scope ? undefined : choice.missing;
      return <DropdownMenuItem key={choice.kind} disabled={reason !== undefined} onSelect={() => { if (choice.scope) onMove(choice.scope); }}>
        <ScopeIcon kind={choice.kind} /><span>{choice.label}</span>{reason && <DropdownMenuValue>{reason}</DropdownMenuValue>}
      </DropdownMenuItem>;
    })}
    <DropdownMenuSeparator />
    <DropdownMenuItem onSelect={onChoose}><Search /><span>Choose…</span></DropdownMenuItem>
  </>;
}

/**
 * One listed workpad: its title (and, in lists that mix scopes, where it
 * belongs on a quiet second line), when it was last edited (and by whom when
 * not you), and ⋯ with Rename…, Move to and Archive or Unarchive.
 */
function WorkpadRow({ item, location, busy, touch, threadId, projectId, onOpen, onRename, onMove, onChooseMove, onArchive }: {
  readonly item: WorkpadSummary;
  readonly location?: ScopeLocationLabel;
  readonly busy: boolean;
  readonly touch: boolean;
  readonly threadId?: string;
  readonly projectId?: string;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onMove: (scope: WorkpadScope) => void;
  readonly onChooseMove: () => void;
  readonly onArchive: () => void;
}): React.JSX.Element {
  const locationId = useId();
  return <li className="workpads-row">
    <button type="button" className="workpads-row-title" data-location={location ? "" : undefined}
      aria-describedby={location ? locationId : undefined} onClick={onOpen}>
      {location ? <>
        <span className="workpads-row-name">{item.title}</span>
        <ScopeLocation location={location} />
      </> : <span className="workpads-row-name">{item.title}</span>}
    </button>
    {location && <span id={locationId} className="sr-only">In {location.label}</span>}
    <span className="workpads-row-meta" title={`Last edited by ${item.author.kind === "user" ? "you" : item.author.name} · ${new Date(item.updatedAt).toLocaleString()}`}>
      {item.author.kind !== "user" && <Bot className="workpads-row-agent" aria-label={`Last edited by ${item.author.name}`} />}
      {shortRelativeTime(item.updatedAt)}
    </span>
    <DropdownMenu presentation={touch ? "sheet" : "menu"}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="workpads-row-more" aria-label={`Actions for “${item.title}”`} disabled={busy}>
          <Ellipsis aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sheetTitle={item.title}>
        <DropdownMenuItem onSelect={onRename}><Pencil /><span>Rename…</span></DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger><FolderInput /><span>Move to</span></DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <MoveToItems current={destinationKey(item.scope)} threadId={threadId} projectId={projectId}
              onMove={onMove} onChoose={onChooseMove} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onSelect={onArchive}>
          {item.archivedAt ? <><ArchiveRestore /><span>Unarchive</span></> : <><Archive /><span>Archive</span></>}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </li>;
}
