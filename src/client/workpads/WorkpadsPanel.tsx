import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Bot, Check, Ellipsis, FilePenLine, FolderInput, Highlighter, History, Layers, ListFilter, LoaderCircle, Pencil, Plus, Search, Trash2, X, ArchiveRestore } from "lucide-react";
import type { UpdateWorkpadRequest, Workpad, WorkpadScope, WorkpadSummary, WorkpadRevision, WorkpadRevisionSummary } from "../../shared/protocol/workpads.js";
import { WORKPAD_CONTENT_MAX_CHARACTERS } from "../../shared/protocol/workpads.js";
import { describeProjectLocations } from "../app/project-locations.js";
import { installNavigationBlocker, routePath, useRoute, type NavigationBlocker } from "../app/router.js";
import { useTouchDensity } from "../app/use-touch-density.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import { useApplicationStore } from "../stores/ApplicationClientStore.js";
import { relativeTime, shortRelativeTime } from "../lib/time.js";
import { DiscardChangesDialog } from "../components/ui/discard-changes-dialog.js";
import { ConfirmDialog } from "../components/ui/confirm-dialog.js";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuItemDescription, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, DropdownMenuValue } from "../components/ui/dropdown-menu.js";
import { SearchableSelectList } from "../components/ui/searchable-select.js";
import { Button } from "../components/ui/button.js";
import { Callout } from "../components/ui/callout.js";
import { EmptyState } from "../components/ui/empty-state.js";
import { Field } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { SegmentedControl, SegmentedControlItem } from "../components/ui/segmented-control.js";
import { ScopeIcon, useTaskDestinations } from "../components/tasks/task-destinations.js";
import { parseScopeKey, scopeKey as destinationKey } from "../components/tasks/task-view-model.js";
import { WorkpadDocument } from "./WorkpadDocument.js";
import { useWorkpadDraft } from "./use-workpad-draft.js";
import "./workpads-panel.css";

const message = (error: unknown) => error instanceof Error ? error.message : "Unable to update workpad.";
/** What renaming, moving or archiving needs of a listed or open workpad. */
type WorkpadTarget = Pick<WorkpadSummary, "id" | "revision" | "title" | "scope" | "archivedAt">;
export function WorkpadsPanel({ context }: { context: WorkspacePanelContext }) {
  const { applicationStore: store, visible: open, threadId, workspaceId, host } = context;
  const application = useApplicationStore(store);
  const route = useRoute();
  // The panel's project is the project of the thread's location.
  const contextWorkspaceId = workspaceId ?? (threadId ? store.workspaceIdForThread(threadId) : undefined);
  const contextProjectId = application.snapshot?.workspaces.find(({ id }) => id === contextWorkspaceId)?.projectId;
  const contextKey = JSON.stringify([threadId, contextProjectId]);
  const [leaveRequest, setLeaveRequest] = useState<{ proceed: () => void; contextKey?: string; pendingMutation?: boolean }>();
  const [scopeKind, setScopeKind] = useState<WorkpadScope["kind"]>(threadId ? "thread" : "global");
  const [targets, setTargets] = useState({ threadId, contextProjectId, projectId: contextProjectId ?? "", selectedThread: threadId ?? "" });
  // Manual targets last until navigation. Remember every context change so an
  // old override cannot reappear when returning to a previously viewed thread.
  const contextChanged = targets.threadId !== threadId || targets.contextProjectId !== contextProjectId;
  const currentTargets = contextChanged
    ? { threadId, contextProjectId, projectId: contextProjectId ?? "", selectedThread: targets.threadId !== threadId ? threadId ?? "" : targets.selectedThread }
    : targets;
  if (contextChanged) setTargets(currentTargets);
  const { projectId, selectedThread } = currentTargets;
  const setProjectId = (value: string) => setTargets({ ...currentTargets, projectId: value });
  const setSelectedThread = (value: string) => setTargets({ ...currentTargets, selectedThread: value });
  const [query, setQuery] = useState("");
  const [nested, setNested] = useState(false);
  const [archived, setArchived] = useState(false);
  const [items, setItems] = useState<WorkpadSummary[]>([]);
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
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
  const [browsing, setBrowsing] = useState(false);
  const [renameTarget, setRenameTarget] = useState<WorkpadTarget>();
  const [title, setTitle] = useState("");
  const [moveTarget, setMoveTarget] = useState<WorkpadTarget>();
  const [discarding, setDiscarding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const draft = useWorkpadDraft(store.api, setError);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const revisionRef = useRef(revision); revisionRef.current = revision;
  const generation = useRef(0);
  const scopeGeneration = useRef(0);
  const listGeneration = useRef(0);
  const listCount = useRef(0);
  const loadingId = useRef<string | undefined>(undefined);
  const resumeEvents = useRef<() => void>(() => undefined);
  const listIdentity = useRef("");
  const operationBusy = useRef(false);
  const operationMutating = useRef(false);
  const scope: WorkpadScope = scopeKind === "global" ? { kind: "global" } : scopeKind === "project" ? { kind: "project", projectId } : { kind: "thread", threadId: selectedThread };
  const scopeKey = JSON.stringify(scope);
  const listKey = JSON.stringify([scopeKey, nested, query, archived]);
  listIdentity.current = listKey;
  const scopeValid = scope.kind === "global" || (scope.kind === "project" ? Boolean(scope.projectId) : Boolean(scope.threadId));
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
      // Context can also change through catalog updates (for example moving a
      // thread to another project), without passing through the router guard.
      // Keep the old scope and editor until the user explicitly leaves it.
      const retained = JSON.parse(previousScope.current) as WorkpadScope;
      setTargets({ ...currentTargets,
        ...(retained.kind === "project" ? { projectId: retained.projectId } : {}),
        ...(retained.kind === "thread" ? { selectedThread: retained.threadId } : {}),
      });
      // A router request already owns the user's intended destination. Keep
      // its continuation if the catalog changes while confirmation is open.
      setLeaveRequest(current => current && current.contextKey === undefined ? current : {
        contextKey, pendingMutation: !unsynced,
        proceed: () => { approvedLeave.current = { scopeKey, contextKey }; setTargets(currentTargets); },
      });
      return;
    }
    approvedLeave.current = undefined;
    previousScope.current = scopeKey;
    ++scopeGeneration.current; ++generation.current; ++listGeneration.current;
    operationBusy.current = false; operationMutating.current = false; loadingId.current = undefined;
    selectedRef.current = undefined; revisionRef.current = undefined;
    draft.setEditor(undefined);
    setSelected(undefined); setRevision(undefined); setRevisions([]); setRevisionCursor(undefined);
    setItems([]); setCursor(undefined); listCount.current = 0;
    setNewTitle(""); setTitle(""); setRenameTarget(undefined); setMoveTarget(undefined); setDiscarding(false); setReconciling(false);
    setError(""); setRefreshError(""); setBusy(false); setLeaveRequest(undefined);
  }, [scopeKey, draft.setEditor, draft.saving, routeKey, contextKey, busy]);
  const run = async (action: (isCurrent: () => boolean) => Promise<void>, mutating = false) => {
    if (operationBusy.current) return;
    const token = scopeGeneration.current;
    const isCurrent = () => token === scopeGeneration.current;
    operationBusy.current = true; operationMutating.current = mutating; setBusy(true); setError("");
    try { await action(isCurrent); } catch (failure) { if (isCurrent()) setError(message(failure)); }
    finally { if (isCurrent()) { operationBusy.current = false; operationMutating.current = false; loadingId.current = undefined; setBusy(false); resumeEvents.current(); } }
  };
  const refreshList = useCallback(async (nextCursor?: string) => {
    const token = ++listGeneration.current;
    const identity = JSON.stringify([scopeKey, nested, query, archived]);
    if (!scopeValid) { setItems([]); setCursor(undefined); return; }
    const request = { scope: JSON.parse(scopeKey) as WorkpadScope, scopeMode: nested ? "subtree" as const : "exact" as const, ...(query.trim() ? { query: query.trim() } : {}), archived };
    const page = await store.api.listWorkpads({ ...request, ...(nextCursor ? { cursor: nextCursor } : {}) });
    const refreshed = [...page.items];
    let following = page.nextCursor;
    // A change refreshes every page already displayed, preserving pagination.
    while (!nextCursor && following && refreshed.length < listCount.current) {
      if (token !== listGeneration.current || identity !== listIdentity.current) return;
      const next = await store.api.listWorkpads({ ...request, cursor: following });
      refreshed.push(...next.items); following = next.nextCursor;
    }
    if (token !== listGeneration.current || identity !== listIdentity.current) return;
    setItems(previous => nextCursor ? [...previous, ...refreshed] : refreshed);
    listCount.current = nextCursor ? listCount.current + refreshed.length : refreshed.length;
    setCursor(following);
  }, [store, scopeKey, scopeValid, nested, query, archived]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    listCount.current = 0;
    setLoading(true);
    const debounce = window.setTimeout(() => {
      void refreshList().then(() => { if (!cancelled) setRefreshError(""); })
        .catch(failure => { if (!cancelled) setRefreshError(message(failure)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 180);
    return () => { cancelled = true; clearTimeout(debounce); ++listGeneration.current; };
  }, [open, refreshList]);
  const load = async (id: string) => {
    const token = ++generation.current;
    loadingId.current = id;
    const [workpad, history] = await Promise.all([store.api.getWorkpad(id), store.api.listWorkpadRevisions(id)]);
    const latest = await store.api.getWorkpadRevision(id, workpad.revision);
    if (token !== generation.current) return;
    selectedRef.current = workpad; revisionRef.current = latest; loadingId.current = undefined;
    setSelected(workpad); setRevisions(history.items); setRevisionCursor(history.nextCursor); setRevision(latest);
    draft.setEditor(undefined); setReconciling(false); setRenameTarget(undefined); setMoveTarget(undefined);
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
      if (next.threadId === threadId || scopeKind === "global") return true;
      if (scopeKind === "thread" && next.threadId === selectedThread) return true;
      if (scopeKind === "project") {
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
      const nextProjectId = store.getSnapshot().snapshot?.workspaces.find(({ id }) => id === nextWorkspaceId)?.projectId;
      const nextScope: WorkpadScope = scopeKind === "global" ? { kind: "global" }
        : scopeKind === "thread" ? { kind: "thread", threadId: nextThreadId ?? "" }
        : { kind: "project", projectId: nextProjectId ?? "" };
      approvedLeave.current = { scopeKey: JSON.stringify(nextScope), routeKey: routePath(next) };
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
  // Any listed or open workpad; an open one reloads with the result.
  const mutate = async (target: WorkpadTarget, change: Omit<UpdateWorkpadRequest, "expectedRevision">) => {
    const token = scopeGeneration.current;
    const result = await store.api.updateWorkpad(target.id, { expectedRevision: target.revision, ...change });
    if (token !== scopeGeneration.current) return;
    if (selectedRef.current?.id === result.id) await load(result.id);
    if (token === scopeGeneration.current) await refreshList();
  };
  const stale = Boolean(selected && draft.editor && selected.revision !== draft.editor.draft.baseRevision);
  const chooseRevision = async (number: number) => {
    const token = generation.current;
    if (selected) { const next = await store.api.getWorkpadRevision(selected.id, number); if (token !== generation.current) return; revisionRef.current = next; setRevision(next); }
  };
  const snapshot = application.snapshot;
  // Each project once, named as everywhere else: same-named projects carry a host or path hint.
  const projects = useMemo(() => {
    const list = snapshot?.projects ?? [];
    const locations = describeProjectLocations({ projects: list, workspaces: snapshot?.workspaces ?? [], environments: snapshot?.environments ?? [] });
    return list.map(project => ({ id: project.id, label: locations.projectLabel(project.id) ?? project.name }))
      .sort((left, right) => left.label.localeCompare(right.label, undefined, { numeric: true }) || left.id.localeCompare(right.id));
  }, [snapshot?.projects, snapshot?.workspaces, snapshot?.environments]);
  const scopeLabel = (value: WorkpadScope) => {
    if (value.kind !== "project") return value.kind === "thread" ? "Thread" : "Global";
    const project = projects.find(({ id }) => id === value.projectId);
    return project ? `Project · ${project.label}` : "Project";
  };
  const threads = application.visibleThreads;
  const touch = useTouchDensity();
  const destinations = useTaskDestinations(application.snapshot, route);
  const editing = Boolean(draft.editor);
  const latestRevision = selected?.revision;
  // An older revision on screen, as opposed to the document's latest.
  const viewedOlder = revision && latestRevision !== undefined && revision.revision !== latestRevision ? revision : undefined;
  const noChanges = Boolean(draft.editor && draft.editor.text === draft.editor.baseText);
  const canSave = Boolean(draft.editor) && !busy && !draft.saving && !stale && !draft.editor?.remote && !noChanges;
  const browsedThread = scopeKind === "thread" && selectedThread !== (threadId ?? "") && Boolean(selectedThread);
  const browsedProject = scopeKind === "project" && projectId !== (contextProjectId ?? "") && Boolean(projectId);
  const narrowed = nested || archived || browsedThread || browsedProject;

  const closeDocument = () => {
    void run(async isCurrent => {
      if (draft.editor) await draft.save();
      if (!isCurrent()) return;
      draft.setEditor(undefined); selectedRef.current = undefined; revisionRef.current = undefined;
      setSelected(undefined); setRevision(undefined); ++generation.current;
    });
  };
  const openRename = (target: WorkpadTarget) => { setTitle(target.title); setRenameTarget(target); };
  const moveTo = (target: WorkpadTarget, destination: WorkpadScope) => { void run(() => mutate(target, { scope: destination }), true); };
  const archiveWorkpad = (target: WorkpadTarget, value: boolean) => { void run(() => mutate(target, { archived: value }), true); };
  const finishEditing = () => { void run(async isCurrent => { await draft.save(); if (isCurrent()) draft.setEditor(undefined); }); };
  const browse = (destination: WorkpadScope) => {
    setScopeKind(destination.kind);
    setTargets({ ...currentTargets,
      ...(destination.kind === "project" ? { projectId: destination.projectId } : {}),
      ...(destination.kind === "thread" ? { selectedThread: destination.threadId } : {}),
    });
  };
  const stopBrowsing = () => setTargets({ ...currentTargets, projectId: contextProjectId ?? "", selectedThread: threadId ?? "" });
  const closeSearch = () => { setSearchOpen(false); setQuery(""); };
  const create = () => {
    const value = newTitle.trim();
    if (!value || !scopeValid) return;
    void run(async isCurrent => {
      const created = await store.api.createWorkpad({ title: value, scope });
      if (!isCurrent()) return;
      setNewTitle("");
      await load(created.id);
      // A new workpad opens ready for its first text.
      if (isCurrent() && selectedRef.current?.id === created.id) await beginEditing(isCurrent);
    }, true);
  };

  // The header: a back step while a document is open, and the open
  // document's actions in its ⋯. Handlers run the latest render's.
  const handlers = useRef({ closeDocument, openRename, moveTo, archiveWorkpad, selected });
  handlers.current = { closeDocument, openRename, moveTo, archiveWorkpad, selected };
  const hasSelection = selected !== undefined;
  useEffect(() => {
    host.setBack(hasSelection ? { label: "Back to workpads", disabled: busy, onBack: () => handlers.current.closeDocument() } : undefined);
  }, [host, hasSelection, busy]);
  const selectedScope = selected ? destinationKey(selected.scope) : undefined;
  const selectedArchived = Boolean(selected?.archivedAt);
  const draftSaving = draft.saving;
  const menuItems = useMemo(() => {
    if (!hasSelection) return undefined;
    if (editing) {
      return <DropdownMenuItem variant="destructive" disabled={busy || draftSaving} onSelect={() => setDiscarding(true)}>
        <Trash2 /><span>Discard draft…</span>
      </DropdownMenuItem>;
    }
    const current = () => handlers.current.selected;
    return <>
      <DropdownMenuItem disabled={busy} onSelect={() => { const target = current(); if (target) handlers.current.openRename(target); }}>
        <Pencil /><span>Rename…</span>
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={busy}><FolderInput /><span>Move to</span></DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <MoveToItems current={selectedScope} threadId={threadId} projectId={contextProjectId}
            onMove={destination => { const target = current(); if (target) handlers.current.moveTo(target, destination); }}
            onChoose={() => { const target = current(); if (target) setMoveTarget(target); }} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuItem disabled={busy} onSelect={() => { const target = current(); if (target) handlers.current.archiveWorkpad(target, !target.archivedAt); }}>
        {selectedArchived ? <><ArchiveRestore /><span>Unarchive</span></> : <><Archive /><span>Archive</span></>}
      </DropdownMenuItem>
    </>;
  }, [hasSelection, editing, busy, draftSaving, selectedScope, selectedArchived, threadId, contextProjectId]);
  useEffect(() => { host.setMenuItems(menuItems); }, [host, menuItems]);
  useEffect(() => () => { host.setBack(undefined); host.setMenuItems(undefined); }, [host]);
  // The open document's title, as the revision on screen names it. Only a
  // changed string is published: each publish re-renders the panel layout.
  const subtitle = selected ? (editing ? selected.title : revision?.title ?? selected.title) : undefined;
  useEffect(() => { host.setSubtitle(subtitle); }, [host, subtitle]);

  const errorText = error || refreshError;
  const errorCallout = errorText && <div className="workpads-alert">
    <Callout tone="danger" role="alert">{errorText}</Callout>
    <Button variant="ghost" size="icon-xs" className="workpads-alert-dismiss" aria-label="Dismiss error" onClick={() => { setError(""); setRefreshError(""); }}><X aria-hidden="true" /></Button>
  </div>;

  const chromeActions = !selected && createPortal(<div className="workpads-chrome-actions">
    <Button variant="ghost" size="icon-sm" aria-label="Search workpads" aria-pressed={searchOpen} title="Search workpads"
      onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}>
      <Search aria-hidden="true" />
    </Button>
    <DropdownMenu presentation={touch ? "sheet" : "menu"} open={open && viewMenuOpen} onOpenChange={setViewMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" className="workpads-view-options" aria-label="View options" title="View options" data-filtering={narrowed || undefined}>
          <ListFilter aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label="View options" sheetTitle="View options">
        <DropdownMenuLabel>Show</DropdownMenuLabel>
        <DropdownMenuCheckboxItem disabled={busy} checked={nested} onCheckedChange={value => setNested(value === true)} onSelect={keepOpen}>
          <Layers />Include nested scopes
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem disabled={busy} checked={archived} onCheckedChange={value => setArchived(value === true)} onSelect={keepOpen}>
          <Archive />Archived
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={busy} onSelect={() => setBrowsing(true)}><Search /><span>Browse another thread or project…</span></DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>, context.chromeActionsTarget);

  const chips: { key: string; label: string; clear: () => void }[] = [
    ...(browsedThread || browsedProject ? [{ key: "browse", label: destinations.label(scope), clear: stopBrowsing }] : []),
    ...(nested ? [{ key: "nested", label: "Nested scopes", clear: () => setNested(false) }] : []),
    ...(archived ? [{ key: "archived", label: "Archived", clear: () => setArchived(false) }] : []),
  ];
  const addPlaceholder = scope.kind === "global" ? "New global workpad…"
    : scope.kind === "project" ? (browsedProject ? `New workpad in ${destinations.label(scope)}…` : "New workpad in this project…")
    : browsedThread ? `New workpad in ${destinations.label(scope)}…` : "New workpad in this thread…";
  const scopeNoun = scope.kind === "global" ? "global workpads"
    : browsedThread || browsedProject ? `workpads in ${destinations.label(scope)}`
    : scope.kind === "project" ? "workpads in this project" : "workpads in this thread";
  const emptyTitle = loading ? "Loading…"
    : !scopeValid ? (scope.kind === "thread" ? "Open a thread to see its workpads" : "Choose a project to see its workpads")
    : query.trim() ? `No workpads match “${query.trim()}”`
    : archived ? "No archived workpads"
    : `No ${scopeNoun} yet`;

  const listView = <>
    {searchOpen && <div className="workpads-search">
      <Search className="workpads-search-icon" aria-hidden="true" />
      <input autoFocus type="text" className="workpads-search-input" aria-label="Search workpads" placeholder="Search titles and text"
        autoComplete="off" maxLength={240} value={query} onChange={event => setQuery(event.target.value)}
        onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); } }} />
      <Button variant="ghost" size="icon-xs" aria-label="Close search" onClick={closeSearch}><X aria-hidden="true" /></Button>
    </div>}
    <div className="workpads-toolbar">
      <SegmentedControl disabled={busy} aria-label="Workpad scope" className="w-full" value={scopeKind}
        onValueChange={value => { setScopeKind(value as WorkpadScope["kind"]); setTargets({ ...currentTargets, projectId: projectId || contextProjectId || projects[0]?.id || "", selectedThread: selectedThread || threadId || threads[0]?.id || "" }); }}>
        <SegmentedControlItem value="thread" disabled={!threads.length}>Thread</SegmentedControlItem>
        <SegmentedControlItem value="project" disabled={!projects.length}>Project</SegmentedControlItem>
        <SegmentedControlItem value="global">Global</SegmentedControlItem>
      </SegmentedControl>
      {chips.length > 0 && <div className="workpads-filters" role="group" aria-label="View filters">
        {chips.map(chip => <Button key={chip.key} variant="outline" size="sm" className="workpads-filter-chip" disabled={busy}
          aria-label={`Remove filter: ${chip.label}`} onClick={chip.clear}>
          <span className="workpads-filter-label">{chip.label}</span><X data-icon="inline-end" aria-hidden="true" />
        </Button>)}
      </div>}
      {!archived && <form className="workpads-add" onSubmit={event => { event.preventDefault(); create(); }}>
        <Plus className="workpads-add-icon" aria-hidden="true" />
        <input type="text" className="workpads-add-input" aria-label="New workpad title" placeholder={addPlaceholder}
          autoComplete="off" enterKeyHint="done" maxLength={240} disabled={!scopeValid} value={newTitle}
          onChange={event => setNewTitle(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape" && newTitle) { event.preventDefault(); event.stopPropagation(); setNewTitle(""); } }} />
        {newTitle.trim() && <span className="workpads-add-hint" aria-hidden="true">↵ create</span>}
      </form>}
    </div>
    {errorCallout}
    <div className="workpads-scroll" aria-busy={loading}>
      {items.length ? <ul className="workpads-list">
        {items.map(item => <li key={item.id} className="workpads-row">
          <button type="button" className="workpads-row-title" data-scope={nested || undefined} onClick={() => { void run(() => load(item.id)); }}>
            <span className="workpads-row-name">{item.title}</span>
            {nested && <span className="workpads-row-scope"><ScopeIcon kind={item.scope.kind} />{scopeLabel(item.scope)}</span>}
          </button>
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
              <DropdownMenuItem onSelect={() => openRename(item)}><Pencil /><span>Rename…</span></DropdownMenuItem>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger><FolderInput /><span>Move to</span></DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <MoveToItems current={destinationKey(item.scope)} threadId={threadId} projectId={contextProjectId}
                    onMove={destination => moveTo(item, destination)} onChoose={() => setMoveTarget(item)} />
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem onSelect={() => archiveWorkpad(item, !item.archivedAt)}>
                {item.archivedAt ? <><ArchiveRestore /><span>Unarchive</span></> : <><Archive /><span>Archive</span></>}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </li>)}
      </ul> : <EmptyState variant="inline" className="workpads-empty" title={emptyTitle}
        description={!loading && scopeValid && !query.trim() && !archived ? "Name one above, or ask an agent to start one." : undefined} />}
      {cursor && <Button variant="ghost" size="sm" className="workpads-more" disabled={busy} onClick={() => { void run(() => refreshList(cursor)); }}>Load more</Button>}
    </div>
  </>;

  const revisionLabel = (value: { revision: number }) => value.revision === 0 ? "Created" : `Revision ${value.revision}`;
  const syncLabel = draft.saving ? "Syncing draft…" : draft.editor?.remote ? "Draft conflict" : hasUnsynced ? "Draft not synced" : noChanges ? "No changes" : "Draft synced";
  const meta = revision && (revision.revision === 0
    ? [`Created ${relativeTime(revision.createdAt)} by ${revision.author.name}`, scopeLabel(revision.scope)]
    : [revisionLabel(revision), relativeTime(revision.createdAt), revision.author.name, scopeLabel(revision.scope)]).join(" · ");
  const orderedRevisions = useMemo(() => [...revisions].sort((left, right) => right.revision - left.revision), [revisions]);

  const documentView = selected && <>
    <div className="workpads-doc-toolbar">
      {editing
        ? <span className="workpads-doc-meta workpads-sync" role="status">{syncLabel}</span>
        : <span className="workpads-doc-meta" title={revision ? new Date(revision.createdAt).toLocaleString() : undefined}>{meta}</span>}
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
          disabled={busy || (editing ? Boolean(draft.editor?.remote) : Boolean(selected.archivedAt))}
          onClick={() => { if (editing) finishEditing(); else void run(beginEditing); }}>
          {editing ? <Check aria-hidden="true" /> : <FilePenLine aria-hidden="true" />}
        </Button>
        {editing && <Button size="sm" className="workpads-save" aria-label="Save workpad" title="Save as a new revision (Ctrl+S)" aria-busy={(busy && operationMutating.current) || undefined}
          disabled={!canSave} onClick={() => { void run(saveDocument, true); }}>
          {busy && operationMutating.current && <LoaderCircle className="animate-spin" data-icon="inline-start" aria-hidden="true" />}
          Save
        </Button>}
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
      <WorkpadDocument active={open} content={revision.content} attribution={revision.attribution} showAttribution={attribution} />
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

  return <section id="workpads-panel" role="region" aria-label="Workpads" className="workpads-panel" data-touch={touch || undefined}>
    {chromeActions}
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
    <Dialog open={open && (moveTarget !== undefined || browsing)} onOpenChange={value => { if (!value) { setMoveTarget(undefined); setBrowsing(false); } }}>
      <DialogContent size="sm" mobile="sheet" className="searchable-select-sheet workpads-destination-dialog" aria-describedby={undefined}>
        <DialogHeader><DialogTitle>{moveTarget ? "Move workpad" : "Browse workpads"}</DialogTitle></DialogHeader>
        <SearchableSelectList
          label={moveTarget ? "Destination" : "Thread or project"}
          searchLabel="Search threads and projects"
          emptyLabel="No matching threads or projects."
          value={destinationKey(moveTarget ? moveTarget.scope : scope)}
          options={destinations.options(moveTarget ? moveTarget.scope : scopeValid ? scope : undefined)}
          initialDirection="first"
          onValueChange={value => {
            const destination = parseScopeKey(value);
            const target = moveTarget;
            setMoveTarget(undefined); setBrowsing(false);
            if (!destination) return;
            if (target) moveTo(target, destination);
            else browse(destination);
          }}
        />
      </DialogContent>
    </Dialog>
    <ConfirmDialog
      open={open && discarding}
      tone="danger"
      title="Discard draft?"
      description="Your unsaved edits to this workpad will be lost. Saved revisions are kept."
      confirmLabel="Discard draft"
      onOpenChange={value => { if (!value) setDiscarding(false); }}
      onConfirm={() => run(draft.discard, true)}
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

const keepOpen = (event: Event) => event.preventDefault();

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
