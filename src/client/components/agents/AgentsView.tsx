import "./agents.css";
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
import { navigate, navigateUp, settingsPath, useRoute } from "../../app/router.js";
import { useDirtyNavigationGuard } from "../../app/use-dirty-navigation-guard.js";
import {
  AgentClientStore,
  useAgentStore,
  type AgentDetailState,
} from "../../agents/AgentClientStore.js";
import { ApiError } from "../../api/ApiClient.js";
import {
  messageFrom,
  useApplicationStore,
  type ApplicationClientStore,
} from "../../stores/ApplicationClientStore.js";
import { Bot, Plus, Trash2 } from "lucide-react";
import { BackendBrandIcon } from "../brand-icons.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import { DiscardChangesDialog } from "@client/components/ui/discard-changes-dialog";
import { EmptyState } from "@client/components/ui/empty-state";
import { Input } from "@client/components/ui/input";
import { Textarea } from "@client/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import { DangerZone, DangerZoneItem } from "../settings/DangerZone.js";
import { EntityList, EntityRow } from "../settings/EntityList.js";
import { SaveBar } from "../settings/SaveBar.js";
import { SettingsActionRow, SettingsField } from "../settings/SettingsField.js";
import { followLink } from "../settings/SettingsNav.js";
import { SettingsBackLink, SettingsPage } from "../settings/SettingsPage.js";
import { SettingsSearch } from "../settings/SettingsSearch.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import {
  SettingsDetailHeader,
  SettingsEditor,
  SettingsSplit,
  type SettingsEditorSection,
} from "../settings/SettingsSplit.js";
import { useSettingsSplitFocus } from "../settings/use-settings-split-focus.js";
import { AgentConfigurationEditor } from "./AgentConfigurationEditor.js";
import { AgentToolPolicyEditor } from "./AgentToolPolicyEditor.js";

const listPath = settingsPath("agents");
const newPath = settingsPath("agents", { mode: "new" });
const agentPath = (agentId: string) => settingsPath("agents", { mode: "view", resourceId: agentId });

/**
 * Settings › Agents: one Agent store while the page is shown, over the
 * principal's workspaces for validation.
 */
export function AgentsSettingsPage({ applicationStore }: {
  readonly applicationStore: ApplicationClientStore;
}): React.JSX.Element {
  const store = useMemo(() => new AgentClientStore(applicationStore.api), [applicationStore]);
  useEffect(() => () => store.dispose(), [store]);
  const workspaces = useApplicationStore(applicationStore).snapshot?.workspaces;
  return <AgentsView store={store} workspaces={workspaces ?? noWorkspaces} />;
}

const noWorkspaces: readonly NormalizedWorkspaceSummary[] = [];

/**
 * Saved Agents on the settings kit's split inventory: the list beside the
 * selected Agent, or one at a time in the stack. An Agent is a small preset,
 * so its detail is its editor (`/settings/agents/:id`); `/~new` creates one.
 */
export function AgentsView({
  store,
  workspaces,
}: {
  readonly store: AgentClientStore;
  readonly workspaces: readonly NormalizedWorkspaceSummary[];
}): React.JSX.Element {
  const route = useRoute();
  const location = route.name === "settings" && route.page === "agents" ? route : undefined;
  const creating = location?.mode === "new";
  const agentId = location?.mode === "view" ? location.resourceId : undefined;
  const state = useAgentStore(store);
  const [search, setSearch] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useSettingsSplitFocus({
    root,
    location: location ? {
      path: settingsPath("agents", location),
      ...(location.resourceId ? { resourceId: location.resourceId } : {}),
      ...(location.mode ? { mode: location.mode } : {}),
    } : undefined,
  });

  useEffect(() => {
    const timer = window.setTimeout(() => void store.refresh(search), 250);
    return () => window.clearTimeout(timer);
  }, [search, store]);

  useEffect(() => {
    if (agentId) void store.loadAgent(agentId);
    else store.clearSelection();
  }, [agentId, creating, store]);

  // No Agents at all: one empty state, with the action that creates the first.
  const empty = !creating && !agentId && !search && !state.error && state.items.length === 0
    && state.status !== "idle" && state.status !== "loading";
  const list = (
    <>
      <SettingsSearch
        label="Search Agents"
        placeholder="Search Agents"
        maxLength={160}
        value={search}
        onValueChange={setSearch}
      />
      {state.error ? (
        <Callout tone="danger" role="alert">
          {state.error}
        </Callout>
      ) : null}
      {state.items.length > 0 ? (
        <EntityList>
          {state.items.map((agent) => (
            <EntityRow
              key={agent.id}
              data-resource-id={agent.id}
              icon={<BackendBrandIcon brand={agent.backend.brand} />}
              title={agent.name}
              subtitle={`${agent.backend.label.text} · ${agent.overrideCount} override${agent.overrideCount === 1 ? "" : "s"} · ${toolSummary(agent.sedesTools)}`}
              selected={agentId === agent.id}
              href={agentPath(agent.id)}
              onSelect={(event) => followLink(event, agentPath(agent.id))}
            />
          ))}
        </EntityList>
      ) : null}
      {(state.status === "idle" || state.status === "loading") &&
        state.items.length === 0 && (
          <p className="settings-loading agents-list-status" role="status">
            Loading Agents…
          </p>
        )}
      {state.status !== "idle" &&
        state.status !== "loading" &&
        state.items.length === 0 && !empty && (
          <EmptyState
            variant="inline"
            icon={<Bot />}
            title={search ? "No Agents match this search." : "No Agents yet."}
          />
        )}
      {state.nextCursor && (
        <Button
          variant="ghost"
          className="agents-load-more"
          disabled={state.loadingMore}
          onClick={() => void store.loadMore()}
        >
          {state.loadingMore ? "Loading…" : "Load more"}
        </Button>
      )}
    </>
  );

  return (
    <div ref={root} className="agents-settings">
      <SettingsPage
        title="Agents"
        description="Save model, execution, and Sedes tool choices for new threads."
        width="wide"
        selection={creating || agentId ? "editor" : "none"}
        actions={
          !creating && !empty ? (
            <Button variant="outline" onClick={() => navigate(newPath)}>
              <Plus aria-hidden="true" /> Create Agent
            </Button>
          ) : undefined
        }
      >
        <SettingsSplit listLabel="Saved Agents" list={list} empty={empty}>
          {empty ? (
            <EmptyState
              icon={<Bot />}
              title="No Agents yet"
              description="An Agent saves model, execution, and Sedes tool choices to start new threads from."
              action={
                <Button onClick={() => navigate(newPath)}>
                  <Plus aria-hidden="true" /> Create Agent
                </Button>
              }
            />
          ) : creating ? (
            <AgentEditor store={store} workspaces={workspaces} />
          ) : agentId ? (
            <AgentDetail
              agentId={agentId}
              detail={state.detail}
              store={store}
              workspaces={workspaces}
            />
          ) : (
            <EmptyState
              icon={<Bot />}
              title="Select an Agent"
              description="Choose an Agent to inspect or edit its saved configuration."
            />
          )}
        </SettingsSplit>
      </SettingsPage>
    </div>
  );
}

/**
 * The route's Agent: its editor once loaded, or why it is unavailable. The
 * detail belongs to the Agent it was loaded for, so until this route's load
 * starts, the Agent is loading; a failure stays until the route changes or
 * a retry succeeds.
 */
function AgentDetail({
  agentId,
  detail,
  store,
  workspaces,
}: {
  readonly agentId: string;
  readonly detail: AgentDetailState;
  readonly store: AgentClientStore;
  readonly workspaces: readonly NormalizedWorkspaceSummary[];
}): React.JSX.Element {
  const ready = detail.status === "ready" && detail.agentId === agentId;
  // A successful retry replaces the focused Retry button with the editor;
  // hand focus to the editor's heading unless the user has moved it.
  const retryFocusPane = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const pane = retryFocusPane.current;
    if (!ready || !pane) return;
    retryFocusPane.current = null;
    const active = pane.ownerDocument.activeElement;
    if (active && active !== pane.ownerDocument.body) return;
    pane.querySelector<HTMLElement>("[data-detail-heading]")?.focus();
  }, [ready]);
  if (ready) {
    return (
      <AgentEditor
        key={detail.agent.id}
        store={store}
        workspaces={workspaces}
        agent={detail.agent}
      />
    );
  }
  if (detail.status === "error" && detail.agentId === agentId) {
    return (
      <section aria-label="Agent unavailable" className="agents-unavailable">
        <SettingsDetailHeader
          back={<SettingsBackLink stackOnly href={listPath} label="Agents" />}
          title="Agent unavailable"
          description="It may have been deleted, or the link is out of date."
        />
        <Callout
          tone="danger"
          role="alert"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={detail.retrying}
              onClick={(event) => {
                const button = event.currentTarget;
                retryFocusPane.current = button.ownerDocument.activeElement === button
                  ? button.closest("section")?.parentElement ?? null
                  : null;
                void store.loadAgent(agentId);
              }}
            >
              {detail.retrying ? "Retrying…" : "Retry"}
            </Button>
          }
        >
          {detail.error}
        </Callout>
      </section>
    );
  }
  return <p className="settings-loading" role="status">Loading Agent…</p>;
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
  const [nameError, setNameError] = useState("");
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
  const sections: SettingsEditorSection[] = [
    { id: "agent-details", label: "Details" },
    { id: "agent-validation", label: "Validate" },
    ...(configuration ? [{ id: "agent-configuration", label: "Configuration" }] : []),
    { id: "agent-variables", label: "Variables" },
    ...(toolCatalog ? [{ id: "agent-tools", label: "Sedes tools" }] : []),
  ];

  const save = async (): Promise<void> => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      setNameError("Enter an Agent name.");
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

  const reset = (): void => {
    setName(agent?.name ?? "");
    setDescription(agent?.description ?? "");
    setEnvironmentVariables(agent?.environmentVariables ?? {});
    setOverrides(agent?.backendOverrides ?? []);
    setSedesTools(agent?.sedesTools);
    setError("");
    setNameError("");
    if (workspaceId && targetId) {
      loadOptions(workspaceId, targetId, agent?.backendOverrides ?? [], agent?.sedesTools);
    }
  };

  const deleteAgent = async (): Promise<void> => {
    if (!agent) return;
    setPending(true);
    setError("");
    try {
      await store.delete(agent.id, { expectedRevision: agent.revision });
      // Back to the list the way the "‹ Agents" link goes.
      guard.proceed(listPath, { up: true });
    } catch (cause) {
      if (await recoverConflict(cause)) return;
      throw new Error(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <SettingsEditor
        label="Agent editor"
        back={<SettingsBackLink stackOnly href={listPath} label="Agents" />}
        title={agent ? agent.name : "Create Agent"}
        description="Project and Configure using validate settings; they are not saved."
        sections={sections}
        errors={error ? (
          <Callout tone="danger" role="alert">
            {error}
          </Callout>
        ) : null}
        onSubmit={() => void save()}
        saveBar={
          <SaveBar
            creating={!agent}
            dirty={dirty}
            saving={pending}
            saveLabel={agent ? "Save" : "Create Agent"}
            // Cancel resets an Agent's edits in place, or leaves the create flow.
            onCancel={() => (agent ? reset() : navigateUp(listPath))}
          />
        }
      >
        <SettingsSection id="agent-details" title="Details" card>
          <SettingsField label="Name" error={nameError || undefined}>
            <Input
              ref={nameRef}
              value={name}
              maxLength={160}
              disabled={pending}
              autoComplete="off"
              onChange={(event) => {
                setName(event.target.value);
                setNameError("");
              }}
            />
          </SettingsField>
          <SettingsField label="Description" description="Optional. Shown when choosing an Agent.">
            <Textarea
              className="agents-description"
              value={description}
              maxLength={4096}
              disabled={pending}
              onChange={(event) => setDescription(event.target.value)}
            />
          </SettingsField>
          {agent && (
            <SettingsActionRow
              title="Backend"
              description={agent.backend.label.text}
            />
          )}
        </SettingsSection>
        <SettingsSection
          id="agent-validation"
          title="Validate against"
          description="A project and target supply the current catalogs while you edit."
          card
        >
          <SettingsField
            label="Project"
            description="Temporary workspace used to validate current catalogs."
          >
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
              <SelectTrigger ref={projectRef} className="w-full" aria-label="Project">
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
          </SettingsField>
          <SettingsField
            label="Configure using"
            description="This target supplies options but is not saved."
          >
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
              <SelectTrigger ref={targetRef} className="w-full" aria-label="Configure using">
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
          </SettingsField>
          {optionsLoading && (
            <p className="settings-loading" role="status" aria-live="polite">
              Refreshing available settings…
            </p>
          )}
        </SettingsSection>
        {configuration && (
          <AgentConfigurationEditor
            id="agent-configuration"
            descriptor={configuration}
            overrides={overrides}
            disabled={pending || optionsLoading}
            onChange={(next) => {
              setOverrides(next);
              loadOptions(workspaceId, targetId, next);
            }}
          />
        )}
        <SettingsSection
          id="agent-variables"
          title="Environment variables"
          description="Reusable overrides for threads created with this Agent. Inherited values are resolved when a thread is created. Only this Agent’s overrides and unsets are saved; existing threads keep their saved snapshots."
        >
          {!targetId && (
            <p className="settings-loading">
              Choose a Configure using target to preview inherited values.
            </p>
          )}
          {variablesPreview.loading && (
            <p className="settings-loading" role="status">Loading inherited variables…</p>
          )}
          {variablesPreview.error && (
            <Callout tone="danger" role="alert">{variablesPreview.error}</Callout>
          )}
          <EnvironmentVariableEditor scope="agent" value={environmentVariables} disabled={pending}
            inherited={variablesPreview.result ? [
              { scope: "environment", values: variablesPreview.result.snapshot.layers.environment },
              { scope: "backend", values: variablesPreview.result.snapshot.layers.backend },
            ] : []} onChange={setEnvironmentVariables} />
        </SettingsSection>
        {toolCatalog && (
          <AgentToolPolicyEditor
            id="agent-tools"
            catalog={toolCatalog}
            value={sedesTools}
            disabled={pending || optionsLoading}
            onChange={(next) => {
              setSedesTools(next);
              loadOptions(workspaceId, targetId, overrides, next);
            }}
          />
        )}
        {agent && (
          <DangerZone>
            <DangerZoneItem
              title="Delete Agent"
              description="Removes only the saved preset. Existing threads are unchanged; thread templates that use it will need attention."
              action={
                <Button
                  ref={deleteTrigger}
                  type="button"
                  variant="destructive-outline"
                  disabled={pending}
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 aria-hidden="true" /> Delete…
                </Button>
              }
            />
          </DangerZone>
        )}
      </SettingsEditor>

      <DiscardChangesDialog
        open={Boolean(guard.pendingRoute)}
        onOpenChange={(open) => {
          if (!open) guard.cancel();
        }}
        title="Discard unsaved Agent changes?"
        description="Your local Agent edits have not been saved."
        discardLabel="Discard"
        onDiscard={guard.discardAndContinue}
      />

      {agent && (
        <ConfirmDialog
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          tone="danger"
          title={`Delete ${agent.name}?`}
          description="This removes only the saved preset. Existing threads are unchanged. Thread templates that use this Agent will need attention."
          confirmLabel="Delete Agent"
          pendingLabel="Deleting…"
          onConfirm={deleteAgent}
          returnFocusRef={deleteTrigger}
        />
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
