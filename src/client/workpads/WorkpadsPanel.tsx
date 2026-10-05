import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import type { Workpad, WorkpadScope, WorkpadSummary, WorkpadRevision, WorkpadRevisionSummary } from "../../shared/protocol/workpads.js";
import { WORKPAD_CONTENT_MAX_CHARACTERS } from "../../shared/protocol/workpads.js";
import { describeProjectLocations } from "../app/project-locations.js";
import { installNavigationBlocker, routePath, useRoute, type NavigationBlocker } from "../app/router.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import { useApplicationStore } from "../stores/ApplicationClientStore.js";
import { DiscardChangesDialog } from "../components/ui/discard-changes-dialog.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { SegmentedControl, SegmentedControlItem } from "../components/ui/segmented-control.js";
import { WorkpadDocument } from "./WorkpadDocument.js";
import { useWorkpadDraft } from "./use-workpad-draft.js";
import "./workpads-panel.css";

const message = (error: unknown) => error instanceof Error ? error.message : "Unable to update workpad.";
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
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [moving, setMoving] = useState(false);
  const [moveScope, setMoveScope] = useState<WorkpadScope>({ kind: "global" });
  const [renaming, setRenaming] = useState(false);
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
    setCreating(false); setTitle(""); setMoving(false); setRenaming(false); setReconciling(false);
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
    draft.setEditor(undefined); setReconciling(false); setMoving(false); setRenaming(false);
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
  useEffect(() => { host.setSubtitle(selected?.title); }, [host, selected?.title]);
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
  const mutate = async (change: Parameters<typeof store.api.updateWorkpad>[1]) => {
    if (!selected) return;
    const token = scopeGeneration.current;
    const result = await store.api.updateWorkpad(selected.id, change);
    if (token !== scopeGeneration.current) return;
    await load(result.id);
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
  const renderScopeTargets = (value: WorkpadScope, onChange: (scope: WorkpadScope) => void) => <>
    <SegmentedControl aria-label="Destination scope" value={value.kind} onValueChange={kind => onChange(kind === "global" ? { kind: "global" } : kind === "project" ? { kind: "project", projectId: contextProjectId ?? projects[0]?.id ?? "" } : { kind: "thread", threadId: threadId ?? threads[0]?.id ?? "" })}><SegmentedControlItem value="global">Global</SegmentedControlItem><SegmentedControlItem value="project" disabled={!projects.length}>Project</SegmentedControlItem><SegmentedControlItem value="thread" disabled={!threads.length}>Thread</SegmentedControlItem></SegmentedControl>
    {value.kind === "project" && <select aria-label="Destination project" value={value.projectId} onChange={event => onChange({ kind: "project", projectId: event.target.value })}>{projects.map(project => <option key={project.id} value={project.id}>{project.label}</option>)}</select>}
    {value.kind === "thread" && <select aria-label="Destination thread" value={value.threadId} onChange={event => onChange({ kind: "thread", threadId: event.target.value })}>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title.text}</option>)}</select>}
  </>;
  return <section id="workpads-panel" role="region" aria-label="Workpads" className="workpads-panel">
    {(error || refreshError) && <div className="workpads-error" role="alert">{error || refreshError}<Button variant="ghost" size="icon-sm" aria-label="Dismiss error" onClick={() => { setError(""); setRefreshError(""); }}><X size={14} /></Button></div>}
    {!selected ? <>
      <div className="workpads-filters">
        <SegmentedControl disabled={busy} aria-label="Workpad scope" className="w-full" value={scopeKind} onValueChange={value => { setScopeKind(value as WorkpadScope["kind"]); setTargets({ ...currentTargets, projectId: projectId || contextProjectId || projects[0]?.id || "", selectedThread: selectedThread || threadId || threads[0]?.id || "" }); }}><SegmentedControlItem value="global">Global</SegmentedControlItem><SegmentedControlItem value="project" disabled={!projects.length}>Project</SegmentedControlItem><SegmentedControlItem value="thread" disabled={!threads.length}>Thread</SegmentedControlItem></SegmentedControl>
        {scopeKind === "project" && <select disabled={busy} aria-label="Workpad project" value={projectId} onChange={event => setProjectId(event.target.value)}>{projects.map(project => <option key={project.id} value={project.id}>{project.label}</option>)}</select>}
        {scopeKind === "thread" && <select disabled={busy} aria-label="Workpad thread" value={selectedThread} onChange={event => setSelectedThread(event.target.value)}>{threads.map(thread => <option key={thread.id} value={thread.id}>{thread.title.text}</option>)}</select>}
        <div className="workpads-toolbar"><Input aria-label="Search workpads" placeholder="Search workpads" value={query} maxLength={240} onChange={event => setQuery(event.target.value)} /><Button variant="secondary" size="sm" disabled={!scopeValid} onClick={() => { setCreating(true); setTitle(""); }}><Plus size={15} />New workpad</Button></div>
        <div className="workpads-options"><label><input type="checkbox" checked={nested} onChange={event => setNested(event.target.checked)} />Include nested scopes</label><label><input type="checkbox" checked={archived} onChange={event => setArchived(event.target.checked)} />Archived</label></div>
      </div>
      {creating && <form className="workpads-inline-form" onSubmit={event => { event.preventDefault(); void run(async isCurrent => { const created = await store.api.createWorkpad({ title: title.trim(), scope }); if (!isCurrent()) return; setCreating(false); await load(created.id); }, true); }}><Input autoFocus aria-label="Title" value={title} maxLength={240} onChange={event => setTitle(event.target.value)} /><Button size="sm" disabled={busy || !title.trim()} type="submit">Create workpad</Button><Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>Cancel</Button></form>}
      <div className="workpads-list" aria-busy={loading}>{items.map(item => <button className="workpads-row" key={item.id} onClick={() => { void run(() => load(item.id)); }}><strong>{item.title}</strong><span>{scopeLabel(item.scope)} · {item.author.name} · {new Date(item.updatedAt).toLocaleDateString()}</span></button>)}{!items.length && <p className="workpads-empty">{loading ? "Loading…" : "No workpads"}</p>}{cursor && <Button variant="ghost" onClick={() => { void run(() => refreshList(cursor)); }}>Load more</Button>}</div>
    </> : <>
      <div className="workpads-title"><Button variant="ghost" size="icon-sm" aria-label="Back to workpads" disabled={busy} onClick={() => { void run(async isCurrent => { if (draft.editor) await draft.save(); if (!isCurrent()) return; draft.setEditor(undefined); selectedRef.current = undefined; revisionRef.current = undefined; setSelected(undefined); setRevision(undefined); ++generation.current; }); }}><ArrowLeft size={16} /></Button><h3>{draft.editor ? selected.title : revision?.title ?? selected.title}</h3><span>{scopeLabel(draft.editor ? selected.scope : revision?.scope ?? selected.scope)}</span></div>
      <div className="workpads-toolbar workpads-document-actions">
        {!draft.editor && <><Button size="sm" variant="secondary" disabled={busy || Boolean(selected.archivedAt)} onClick={() => { void run(beginEditing); }}>Edit workpad</Button><Button size="sm" variant="ghost" aria-pressed={attribution} onClick={() => setAttribution(!attribution)}>Show attribution</Button><Button size="sm" variant="ghost" onClick={() => { setMoving(!moving); setMoveScope(selected.scope); }}>Move workpad</Button><Button size="sm" variant="ghost" onClick={() => { setRenaming(!renaming); setTitle(selected.title); }}>Rename</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => mutate({ expectedRevision: selected.revision, archived: !selected.archivedAt }), true); }}>{selected.archivedAt ? "Restore workpad" : "Archive workpad"}</Button></>}
        {draft.editor && <><Button size="sm" disabled={busy || draft.saving || stale || Boolean(draft.editor.remote)} onClick={() => { void run(saveDocument, true); }}>Save workpad</Button><Button size="sm" variant="ghost" disabled={busy || Boolean(draft.editor.remote)} onClick={() => { void run(async isCurrent => { await draft.save(); if (isCurrent()) draft.setEditor(undefined); }); }}>Done editing</Button><Button size="sm" variant="ghost" disabled={busy || draft.saving} onClick={() => { void run(draft.discard, true); }}>Discard draft</Button><span className="workpads-sync" role="status">{draft.saving ? "Syncing draft…" : draft.editor.remote ? "Draft conflict" : hasUnsynced ? "Draft not synced" : "Draft synced"}</span></>}
      </div>
      {moving && !draft.editor && <div className="workpads-inline-form">{renderScopeTargets(moveScope, setMoveScope)}<Button size="sm" disabled={busy} onClick={() => { void run(() => mutate({ expectedRevision: selected.revision, scope: moveScope }), true); }}>Move</Button><Button size="sm" variant="ghost" onClick={() => setMoving(false)}>Cancel</Button></div>}
      {renaming && !draft.editor && <form className="workpads-inline-form" onSubmit={event => { event.preventDefault(); void run(() => mutate({ expectedRevision: selected.revision, title: title.trim() }), true); }}><Input aria-label="Workpad title" maxLength={240} value={title} onChange={event => setTitle(event.target.value)} /><Button size="sm" disabled={busy || !title.trim()}>Rename workpad</Button></form>}
      {draft.editor ? <div className="workpads-editor">
        {draft.editor.remote && <div className="workpads-conflict" role="alert"><p>This draft changed on another device.</p><details><summary>Other device’s draft</summary><pre>{draft.editor.remote.content}</pre></details><Button size="sm" variant="secondary" onClick={() => { void run(async isCurrent => { const remote = draft.editor!.remote!; const base = await store.api.getWorkpadRevision(selected.id, remote.baseRevision); if (!isCurrent()) return; draft.setEditor({ draft: remote, text: remote.content, baseText: base.content }); }); }}>Use latest draft</Button><Button size="sm" variant="ghost" onClick={() => { const value = draft.editor!; draft.setEditor({ ...value, draft: { ...value.remote!, baseRevision: value.draft.baseRevision }, remote: undefined }); }}>Keep my draft</Button></div>}
        {stale && <div className="workpads-conflict" role="alert"><p>The document changed. Review the latest version before saving.</p><Button size="sm" variant="secondary" onClick={() => setReconciling(!reconciling)}>{reconciling ? "Hide comparison" : "Review changes"}</Button>{reconciling && <><details open><summary>Starting version · revision {draft.editor.draft.baseRevision}</summary><pre>{draft.editor.baseText}</pre></details><details open><summary>Latest version · revision {selected.revision}</summary><pre>{selected.content}</pre></details><Button size="sm" disabled={Boolean(draft.editor.remote) || draft.saving} onClick={() => { void run(async isCurrent => { const synced = await draft.save(); if (!isCurrent()) return; const rebased = await store.api.saveWorkpadDraft(selected.id, { expectedRevision: synced.revision, baseRevision: selected.revision, content: draft.ref.current!.text }); if (!isCurrent()) return; draft.setEditor({ draft: rebased, text: rebased.content, baseText: selected.content }); setReconciling(false); }, true); }}>Use my reconciled text</Button></>}</div>}
        <Textarea disabled={busy} aria-label="Workpad content" maxLength={WORKPAD_CONTENT_MAX_CHARACTERS} value={draft.editor.text} onChange={event => draft.setEditor({ ...draft.editor!, text: event.target.value })} spellCheck className="workpads-textarea" />
      </div> : <>
        <div className="workpads-history"><Button variant="ghost" size="icon-sm" aria-label="Previous revision" disabled={busy || !revision || !revisions.some(value => value.revision < revision.revision)} onClick={() => { const number = revisions.filter(value => value.revision < revision!.revision).sort((a,b) => b.revision-a.revision)[0]?.revision; if (number !== undefined) void run(() => chooseRevision(number)); }}><ChevronLeft size={16} /></Button><select aria-label="Revision" value={revision?.revision ?? ""} onChange={event => { void run(() => chooseRevision(Number(event.target.value))); }}>{revisions.map(value => <option key={value.revision} value={value.revision}>Revision {value.revision}{value.revision === selected.revision ? " · latest" : ""}</option>)}</select><Button variant="ghost" size="icon-sm" aria-label="Next revision" disabled={busy || !revision || revision.revision === selected.revision} onClick={() => { const number = revisions.filter(value => value.revision > revision!.revision).sort((a,b) => a.revision-b.revision)[0]?.revision; if (number !== undefined) void run(() => chooseRevision(number)); }}><ChevronRight size={16} /></Button>{revision && <span>{revision.author.name} · {new Date(revision.createdAt).toLocaleString()}</span>}{revisionCursor && <Button size="sm" variant="ghost" onClick={() => { void run(async isCurrent => { const page = await store.api.listWorkpadRevisions(selected.id, revisionCursor); if (!isCurrent()) return; setRevisions(previous => [...previous, ...page.items]); setRevisionCursor(page.nextCursor); }); }}>Older revisions</Button>}</div>
        <div className="workpads-reading">{revision && <><WorkpadDocument active={open} content={revision.content} attribution={revision.attribution} showAttribution={attribution} /><details className="workpads-revision-details"><summary>Revision details</summary><p>{revision.author.name} · {new Date(revision.createdAt).toLocaleString()}</p>{revision.changes.length ? (["removed", "added"] as const).map(kind => { const changes = revision.changes.filter(change => change.kind === kind); return changes.length ? <div key={kind}><strong>{kind === "removed" ? "Removed" : "Added"} by {revision.author.name}</strong>{changes.map((change,index) => <blockquote key={index}>{change.text}</blockquote>)}</div> : null; }) : <p>Document metadata updated.</p>}</details></>}</div>
      </>}
    </>}
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
