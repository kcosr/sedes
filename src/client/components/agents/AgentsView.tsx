import { type EnvironmentVariableOverrides } from "../../../shared/protocol/environment-variables.js";
import { EnvironmentVariableEditor } from "../environment-variables/EnvironmentVariableEditor.js";
import { useEnvironmentVariablePreview } from "../environment-variables/use-environment-variable-preview.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentToolBootstrapPolicy,
  NormalizedAgentConfigurationOverrides,
  NormalizedWorkspaceSummary,
  SavedAgent,
  SavedAgentOptionsResult,
  SavedAgentTargetDescriptor,
} from "../../../shared/index.js";
import type { Route } from "../../app/router.js";
import {
  agentPath,
  agentsPath,
  navigate,
  newAgentPath,
} from "../../app/router.js";
import { useDirtyNavigationGuard } from "../../app/use-dirty-navigation-guard.js";
import {
  type AgentClientStore,
  useAgentStore,
} from "../../agents/AgentClientStore.js";
import { ApiError } from "../../api/ApiClient.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { ArrowLeft, Bot, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import { Textarea } from "@client/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { AgentConfigurationEditor } from "./AgentConfigurationEditor.js";
import { AgentToolPolicyEditor } from "./AgentToolPolicyEditor.js";

type AgentsRoute = Extract<Route, { name: "agents" }>;

export function AgentsView({
  route,
  store,
  workspaces,
}: {
  readonly route: AgentsRoute;
  readonly store: AgentClientStore;
  readonly workspaces: readonly NormalizedWorkspaceSummary[];
}): React.JSX.Element {
  const state = useAgentStore(store);
  const [search, setSearch] = useState("");
  const editorOpen = route.create || route.agentId !== undefined;

  useEffect(() => {
    const timer = window.setTimeout(() => void store.refresh(search), 250);
    return () => window.clearTimeout(timer);
  }, [search, store]);

  useEffect(() => {
    if (route.agentId) void store.loadAgent(route.agentId);
    else store.clearSelection();
  }, [route.agentId, route.create, store]);

  return (
    <section className="agents-view">
      <header className="agents-header">
        <div>
          <p className="eyebrow">Reusable configuration</p>
          <h1>Agents</h1>
          <p>
            Save model, execution, and Sedes tool choices for new threads.
          </p>
        </div>
        {!route.create && (
          <Button onClick={() => navigate(newAgentPath())}>
            <Plus size={16} aria-hidden="true" /> Create Agent
          </Button>
        )}
      </header>
      <div className="agents-layout" data-editor-open={editorOpen || undefined}>
        <aside className="agents-list-pane" aria-label="Saved Agents">
          <label className="agents-list-controls">
            <span className="sr-only">Search Agents</span>
            <span className="search-box">
              <Search size={14} aria-hidden="true" />
              <Input
                type="search"
                value={search}
                maxLength={160}
                placeholder="Search Agents"
                aria-label="Search Agents"
                onChange={(event) => setSearch(event.target.value)}
              />
            </span>
          </label>
          <div className="agents-list">
            {state.items.map((agent) => (
              <button
                type="button"
                className="agents-list-item"
                key={agent.id}
                aria-current={route.agentId === agent.id ? "page" : undefined}
                onClick={() => navigate(agentPath(agent.id))}
              >
                <strong>{agent.name}</strong>
                <small>
                  {agent.backend.label.text} · {agent.overrideCount} override
                  {agent.overrideCount === 1 ? "" : "s"}
                </small>
                <small>{toolSummary(agent.sedesTools)}</small>
                {agent.descriptionExcerpt && (
                  <small>{agent.descriptionExcerpt}</small>
                )}
              </button>
            ))}
            {(state.status === "idle" || state.status === "loading") &&
              state.items.length === 0 && (
                <p className="agents-list-status" role="status">
                  Loading Agents…
                </p>
              )}
            {state.status !== "idle" &&
              state.status !== "loading" &&
              state.items.length === 0 && (
                <div className="agents-list-status">
                  <Bot size={22} aria-hidden="true" />
                  <p>
                    {search ? "No Agents match this search." : "No Agents yet."}
                  </p>
                </div>
              )}
            {state.nextCursor && (
              <Button
                variant="ghost"
                disabled={state.loadingMore}
                onClick={() => void store.loadMore()}
              >
                {state.loadingMore ? "Loading…" : "Load more"}
              </Button>
            )}
          </div>
        </aside>
        <main className="agents-editor">
          {route.create ? (
            <AgentEditor store={store} workspaces={workspaces} />
          ) : route.agentId ? (
            state.detailLoading ? (
              <p role="status">Loading Agent…</p>
            ) : state.selected?.id === route.agentId ? (
              <AgentEditor
                key={state.selected.id}
                store={store}
                workspaces={workspaces}
                agent={state.selected}
              />
            ) : (
              <p role="alert">{state.error ?? "This Agent is unavailable."}</p>
            )
          ) : (
            <div className="large-empty">
              <Bot size={22} aria-hidden="true" />
              <h2>Select an Agent</h2>
              <p>Choose an Agent to inspect or edit its saved configuration.</p>
            </div>
          )}
        </main>
      </div>
      {state.error && !route.agentId && <p role="alert">{state.error}</p>}
    </section>
  );
}

function AgentEditor({
  store,
  workspaces,
  agent,
}: {
  readonly store: AgentClientStore;
  readonly workspaces: readonly NormalizedWorkspaceSummary[];
  readonly agent?: SavedAgent;
}): React.JSX.Element {
  const availableWorkspaces = useMemo(
    () => workspaces.filter(({ available }) => available),
    [workspaces],
  );
  const [name, setName] = useState(agent?.name ?? "");
  const [description, setDescription] = useState(agent?.description ?? "");
  const [workspaceId, setWorkspaceId] = useState(
    availableWorkspaces.length === 1 ? availableWorkspaces[0]!.id : "",
  );
  const [targetId, setTargetId] = useState("");
  const [environmentVariables, setEnvironmentVariables] = useState<EnvironmentVariableOverrides>(agent?.environmentVariables ?? {});
  const variablesPreview = useEnvironmentVariablePreview(store.api, targetId || undefined);
  const variablesDirty = JSON.stringify(environmentVariables) !== JSON.stringify(agent?.environmentVariables ?? {});
  const [overrides, setOverrides] =
    useState<NormalizedAgentConfigurationOverrides>(
      agent?.backendOverrides ?? [],
    );
  const [sedesTools, setSedesTools] = useState<
    AgentToolBootstrapPolicy | undefined
  >(agent?.sedesTools);
  const [options, setOptions] = useState<SavedAgentOptionsResult>();
  const [authoringTargets, setAuthoringTargets] = useState<
    readonly SavedAgentTargetDescriptor[]
  >([]);
  const [configuredBackendTypeId, setConfiguredBackendTypeId] = useState(
    agent?.backendTypeId,
  );
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const optionsAbort = useRef<AbortController | undefined>(undefined);
  const optionsGeneration = useRef(0);
  const deleteTrigger = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const projectRef = useRef<HTMLButtonElement>(null);
  const targetRef = useRef<HTMLButtonElement>(null);

  const metadataDirty =
    name.trim() !== (agent?.name ?? "") ||
    description !== (agent?.description ?? "");
  const configurationDirty =
    JSON.stringify(overrides) !==
      JSON.stringify(agent?.backendOverrides ?? []) ||
    JSON.stringify(sedesTools) !== JSON.stringify(agent?.sedesTools);
  const dirty = metadataDirty || configurationDirty || variablesDirty;
  const guard = useDirtyNavigationGuard(dirty && !pending);

  const recoverConflict = async (cause: unknown): Promise<boolean> => {
    if (!(cause instanceof ApiError) || cause.code !== "conflict" || !agent) {
      return false;
    }
    try {
      await store.refreshAgent(agent.id);
      setError(
        "This Agent changed in another client. Your local edits are preserved; review them and try again.",
      );
    } catch (refreshCause) {
      setError(messageFrom(refreshCause));
    }
    return true;
  };

  useEffect(
    () => () => {
      optionsAbort.current?.abort();
    },
    [],
  );

  const loadOptions = (
    nextWorkspaceId: string,
    nextTargetId: string,
    nextOverrides = overrides,
    nextSedesTools = sedesTools,
  ): void => {
    optionsAbort.current?.abort();
    if (!nextWorkspaceId) {
      setOptions(undefined);
      return;
    }
    const abort = new AbortController();
    optionsAbort.current = abort;
    const generation = ++optionsGeneration.current;
    setOptionsLoading(true);
    setError("");
    void store
      .options(
        {
          workspaceId: nextWorkspaceId,
          ...(nextTargetId
            ? {
                targetId: nextTargetId,
                overrides: nextOverrides,
                ...(nextSedesTools ? { sedesTools: nextSedesTools } : {}),
              }
            : {}),
        },
        abort.signal,
      )
      .then(
        (result) => {
          if (abort.signal.aborted || generation !== optionsGeneration.current)
            return;
          setOptions(result);
          setOptionsLoading(false);
          if (result.kind === "targets") {
            setAuthoringTargets(result.targets);
          } else {
            setConfiguredBackendTypeId(result.configuration.backendTypeId);
            setOverrides(result.configuration.canonicalOverrides);
          }
        },
        (cause: unknown) => {
          if (abort.signal.aborted || generation !== optionsGeneration.current)
            return;
          setOptionsLoading(false);
          setError(messageFrom(cause));
        },
      );
  };

  useEffect(() => {
    if (workspaceId) loadOptions(workspaceId, "");
    // The initial fetch is intentionally tied only to this editor instance.
    // Subsequent context/override changes invoke loadOptions explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const targetOptions = authoringTargets.filter(
    (target) => !agent || target.backend.typeId === agent.backendTypeId,
  );
  const configuration =
    options?.kind === "configuration" ? options.configuration : undefined;
  const toolCatalog =
    options?.kind === "configuration" ? options.sedesTools : undefined;

  const save = async (): Promise<void> => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError("Enter an Agent name.");
      nameRef.current?.focus();
      return;
    }
    if (!agent || configurationDirty || variablesDirty) {
      if (!workspaceId || !targetId || !configuration) {
        setError("Choose a Project and Configure using target first.");
        if (!workspaceId) projectRef.current?.focus();
        else targetRef.current?.focus();
        return;
      }
    }
    setPending(true);
    setError("");
    try {
      const saved = agent
        ? await store.update(agent.id, {
            expectedRevision: agent.revision,
            ...(variablesDirty ? { environmentVariables, authoringContext: { workspaceId, targetId } } : {}),
            ...(normalizedName !== agent.name ? { name: normalizedName } : {}),
            ...(description !== (agent.description ?? "")
              ? { description: description || null }
              : {}),
            ...(configurationDirty
              ? {
                  authoringContext: { workspaceId, targetId },
                  backendOverrides: overrides,
                  sedesTools: sedesTools ?? null,
                }
              : {}),
          })
        : await store.create({
            name: normalizedName,
            ...(description ? { description } : {}),
            authoringContext: { workspaceId, targetId },
            backendOverrides: overrides,
            environmentVariables,
            ...(sedesTools ? { sedesTools } : {}),
          });
      setName(saved.name);
      setDescription(saved.description ?? "");
      setOverrides(saved.backendOverrides);
      setSedesTools(saved.sedesTools);
      setEnvironmentVariables(saved.environmentVariables ?? {});
      guard.proceed(agentPath(saved.id), { replace: true });
    } catch (cause) {
      if (!(await recoverConflict(cause))) setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <form
        className="agents-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <header className="agents-editor-header">
          <div>
            <Button
              className="agents-editor-mobile-back"
              type="button"
              variant="ghost"
              onClick={() => navigate(agentsPath())}
            >
              <ArrowLeft size={16} aria-hidden="true" /> Agents
            </Button>
            <h1>{agent ? agent.name : "Create Agent"}</h1>
            <p>
              Project and Configure using validate settings; they are not saved.
            </p>
          </div>
          {agent && (
            <Button
              ref={deleteTrigger}
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={15} aria-hidden="true" /> Delete
            </Button>
          )}
        </header>
        <div className="agents-editor-fields">
          <label className="agent-editor-field">
            <span>Name</span>
            <Input
              ref={nameRef}
              value={name}
              maxLength={160}
              disabled={pending}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="agent-editor-field">
            <span>Description</span>
            <Textarea
              value={description}
              maxLength={4096}
              disabled={pending}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          {agent && (
            <div className="agent-editor-field">
              <span>Backend</span>
              <p>{agent.backend.label.text}</p>
            </div>
          )}
          <label className="agent-editor-field">
            <span>Project</span>
            <small id="agent-project-description">
              Temporary workspace used to validate current catalogs.
            </small>
            <Select
              value={workspaceId}
              disabled={pending}
              onValueChange={(nextWorkspaceId) => {
                setWorkspaceId(nextWorkspaceId);
                setTargetId("");
                setOptions(undefined);
                setAuthoringTargets([]);
                loadOptions(nextWorkspaceId, "");
              }}
            >
              <SelectTrigger
                ref={projectRef}
                aria-label="Project"
                aria-describedby="agent-project-description"
              >
                <SelectValue placeholder="Choose a Project" />
              </SelectTrigger>
              <SelectContent>
                {availableWorkspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.label.text}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="agent-editor-field">
            <span>Configure using</span>
            <small id="agent-target-description">
              This target supplies options but is not saved.
            </small>
            <Select
              value={targetId}
              disabled={pending || !workspaceId || optionsLoading}
              onValueChange={(nextTargetId) => {
                const nextTarget = authoringTargets.find(
                  ({ id }) => id === nextTargetId,
                );
                if (
                  !agent &&
                  nextTarget &&
                  configuredBackendTypeId &&
                  nextTarget.backend.typeId !== configuredBackendTypeId &&
                  (overrides.length > 0 || sedesTools !== undefined)
                ) {
                  setError(
                    "Return every setting and Sedes tools to their defaults before changing backend.",
                  );
                  return;
                }
                setTargetId(nextTargetId);
                loadOptions(workspaceId, nextTargetId);
              }}
            >
              <SelectTrigger
                ref={targetRef}
                aria-label="Configure using"
                aria-describedby="agent-target-description"
              >
                <SelectValue placeholder="Choose a target" />
              </SelectTrigger>
              <SelectContent>
                {targetOptions.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.label.text === target.backend.label.text
                      ? target.label.text
                      : `${target.label.text} · ${target.backend.label.text}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
        </div>
        {optionsLoading && (
          <p role="status" aria-live="polite">
            Refreshing available settings…
          </p>
        )}
        {configuration && (
          <AgentConfigurationEditor
            descriptor={configuration}
            overrides={overrides}
            disabled={pending || optionsLoading}
            onChange={(next) => {
              setOverrides(next);
              loadOptions(workspaceId, targetId, next);
            }}
          />
        )}
        <section className="agent-editor-section" aria-label="Agent environment variables">
          <header><h2>Environment variables</h2><p>Reusable overrides for threads created with this Agent. Inherited values are resolved when a thread is created.</p></header>
          {!targetId && <p className="environment-variable-help">Choose a Configure using target to preview inherited values.</p>}
          {variablesPreview.loading && <p role="status">Loading inherited variables…</p>}
          {variablesPreview.error && <p role="alert" className="environment-variable-error">{variablesPreview.error}</p>}
          <EnvironmentVariableEditor scope="agent" value={environmentVariables} disabled={pending}
            inherited={variablesPreview.result ? [
              { scope: "environment", values: variablesPreview.result.snapshot.layers.environment },
              { scope: "backend", values: variablesPreview.result.snapshot.layers.backend },
            ] : []} onChange={setEnvironmentVariables} />
          <p className="environment-variable-help">Only this Agent’s overrides and unsets are saved. Existing threads keep their saved snapshots.</p>
        </section>
        {toolCatalog && (
          <AgentToolPolicyEditor
            catalog={toolCatalog}
            value={sedesTools}
            disabled={pending || optionsLoading}
            onChange={(next) => {
              setSedesTools(next);
              loadOptions(workspaceId, targetId, overrides, next);
            }}
          />
        )}
        {error && <p role="alert">{error}</p>}
        <div className="agents-editor-actions">
          <Button
            type="button"
            variant="ghost"
            disabled={pending}
            onClick={() => navigate(agentsPath())}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={pending || (agent ? !dirty : false)}>
            {pending ? "Saving…" : agent ? "Save" : "Create Agent"}
          </Button>
        </div>
      </form>

      <Dialog
        open={Boolean(guard.pendingRoute)}
        onOpenChange={(open) => !open && guard.cancel()}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard unsaved Agent changes?</DialogTitle>
            <DialogDescription>
              Your local Agent edits have not been saved.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={guard.cancel}>
              Keep editing
            </Button>
            <Button variant="destructive" onClick={guard.discardAndContinue}>
              Discard
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {agent && (
        <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <DialogContent
            onCloseAutoFocus={(event) => {
              if (!deleteTrigger.current?.isConnected) return;
              event.preventDefault();
              deleteTrigger.current.focus();
            }}
          >
            <DialogHeader>
              <DialogTitle>Delete {agent.name}?</DialogTitle>
              <DialogDescription>
                This removes only the saved preset. Existing threads are
                unchanged. Thread templates that use this Agent will need
                attention.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  setPending(true);
                  setError("");
                  void store
                    .delete(agent.id, { expectedRevision: agent.revision })
                    .then(
                      () => {
                        setDeleteOpen(false);
                        guard.proceed(agentsPath(), { replace: true });
                      },
                      async (cause: unknown) => {
                        if (!(await recoverConflict(cause))) {
                          setError(messageFrom(cause));
                        }
                        setPending(false);
                        setDeleteOpen(false);
                      },
                    );
                }}
              >
                Delete Agent
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function toolSummary(
  policy: {
    readonly enabled: boolean;
    readonly selectedToolCount: number;
    readonly accessBoundary: "thread" | "environment" | "unrestricted";
    readonly presentation: {
      readonly surface: "native" | "cli";
      readonly mode: "progressive" | "individual";
    };
  } | null,
): string {
  if (!policy) return "Default tools";
  const mode = ` · ${
    policy.presentation.surface === "native" ? "Native" : "CLI"
  } · ${policy.presentation.mode === "progressive" ? "Progressive" : "Individual"}`;
  const accessBoundary =
    ` · ${{
      thread: "Ask outside this thread",
      environment: "Ask outside this environment",
      unrestricted: "Allow without asking",
    }[policy.accessBoundary]}`;
  return policy.enabled
    ? `${policy.selectedToolCount} enabled${accessBoundary}${mode}`
    : `Off · ${policy.selectedToolCount} selected${accessBoundary}${mode}`;
}
