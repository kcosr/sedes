import "./tool-clients.css";
import { useEffect, useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import type {
  CreateToolClientRequest,
  ReplaceToolClientRequest,
  ToolClient,
  ToolClientCredentialResult,
  ToolClientOptions,
} from "../../../shared/index.js";
import { ApiError, type ApiClient } from "../../api/ApiClient.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { ExactToolSelector } from "../agents/ExactToolSelector.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { Checkbox } from "@client/components/ui/checkbox";
import { ConfirmDialog } from "@client/components/ui/confirm-dialog";
import { DiscardChangesDialog } from "@client/components/ui/discard-changes-dialog";
import {
  Dialog,
  DialogAlert,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import { EmptyState } from "@client/components/ui/empty-state";
import { Input } from "@client/components/ui/input";
import { Label } from "@client/components/ui/label";
import { NativeSelect } from "@client/components/ui/native-select";
import { StatusPill } from "@client/components/ui/status-pill";
import type { Tone } from "@client/components/ui/tone";
import { DangerZone, DangerZoneItem } from "../settings/DangerZone.js";
import { EntityList, EntityRow } from "../settings/EntityList.js";
import { SaveBar } from "../settings/SaveBar.js";
import { SettingsField, SwitchField } from "../settings/SettingsField.js";
import { SettingsBackLink, SettingsPage } from "../settings/SettingsPage.js";
import { SettingsSection } from "../settings/SettingsSection.js";
import { useSettingsEscapeLevel } from "../settings/settings-escape.js";

type ToolClientApi = Pick<
  ApiClient,
  | "getToolClientOptions"
  | "listToolClients"
  | "getToolClient"
  | "createToolClient"
  | "replaceToolClient"
  | "rotateToolClient"
  | "revokeToolClient"
>;

export interface ToolClientSettingsResources {
  readonly workspaces: readonly {
    readonly id: string;
    readonly environmentId: string;
    readonly label: string;
    readonly available: boolean;
  }[];
  readonly threads: readonly {
    readonly id: string;
    readonly workspaceId: string;
    readonly title: string;
    readonly available: boolean;
    readonly archived: boolean;
  }[];
}

export interface ToolClientSettingsControls {
  readonly api: ToolClientApi;
  readonly endpoint: string;
  readonly resources: ToolClientSettingsResources;
}

interface ToolClientDraft {
  readonly mode: "create" | "edit";
  readonly requestId: string;
  readonly clientId?: string;
  readonly baseRevision?: number;
  readonly name: string;
  readonly enabled: boolean;
  readonly toolIds: readonly string[];
  readonly defaultEnvironmentId: string;
  readonly allowedEnvironmentIds: readonly string[];
  readonly defaultWorkspaceId: string;
  readonly defaultThreadId: string;
}

type DraftField = "name" | "tools" | "environment" | "thread";
interface DraftError {
  readonly field: DraftField;
  readonly message: string;
}

type Confirmation =
  | { readonly kind: "rotate"; readonly client: ToolClient }
  | { readonly kind: "revoke"; readonly client: ToolClient };

export function ToolClientsSettingsPage({
  controls,
}: {
  readonly controls: ToolClientSettingsControls;
}): React.JSX.Element {
  const [options, setOptions] = useState<ToolClientOptions>();
  const [clients, setClients] = useState<readonly ToolClient[]>([]);
  const [draft, setDraft] = useState<ToolClientDraft>();
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldError, setFieldError] = useState<DraftError>();
  const [savedAt, setSavedAt] = useState<number>();
  const [credential, setCredential] =
    useState<ToolClientCredentialResult>();
  const [confirmation, setConfirmation] = useState<Confirmation>();
  const [createOrigin, setCreateOrigin] = useState<ToolClientDraft>();
  const [discarding, setDiscarding] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    setLoading(true);
    setError("");
    void Promise.all([
      controls.api.getToolClientOptions(abort.signal),
      controls.api.listToolClients({ pageSize: 100, signal: abort.signal }),
    ]).then(
      ([nextOptions, page]) => {
        setOptions(nextOptions);
        setClients(page.items);
        setLoading(false);
      },
      (cause: unknown) => {
        if (abort.signal.aborted) return;
        setError(messageFrom(cause));
        setLoading(false);
      },
    );
    return () => abort.abort();
  }, [controls.api]);

  const openDraft = (next: ToolClientDraft | undefined): void => {
    setDraft(next);
    setError("");
    setFieldError(undefined);
  };
  const selectClient = (client: ToolClient): void =>
    openDraft(draftFromClient(client));
  const startCreate = (): void => {
    if (!options) return;
    const defaultEnvironment =
      options.environments.find(({ available }) => available) ??
      options.environments[0];
    const next: ToolClientDraft = {
      mode: "create",
      requestId: crypto.randomUUID(),
      name: "",
      enabled: true,
      toolIds: [],
      defaultEnvironmentId: defaultEnvironment?.id ?? "",
      allowedEnvironmentIds: defaultEnvironment ? [defaultEnvironment.id] : [],
      defaultWorkspaceId: "",
      defaultThreadId: "",
    };
    setCreateOrigin(next);
    openDraft(next);
  };
  const replaceClient = (client: ToolClient): void => {
    setClients((current) =>
      [...current.filter(({ id }) => id !== client.id), client].sort(
        (left, right) =>
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      ),
    );
  };

  const submit = async (): Promise<void> => {
    if (!draft || !options || pending) return;
    const validation = validateDraft(draft);
    setFieldError(validation);
    if (validation) return;
    setPending(true);
    setError("");
    try {
      if (draft.mode === "create") {
        const result = await controls.api.createToolClient(
          createRequestFromDraft(draft),
        );
        replaceClient(result.client);
        setDraft(draftFromClient(result.client));
        setCredential(result);
        return;
      }
      const client = await controls.api.replaceToolClient(
        required(draft.clientId),
        replaceRequestFromDraft(draft),
      );
      replaceClient(client);
      setDraft(draftFromClient(client));
      setSavedAt(Date.now());
    } catch (cause) {
      if (draft.mode === "create") {
        const admitted = conflictClient(cause) ?? (await recoverCreate(draft));
        if (admitted) {
          replaceClient(admitted);
          setDraft(draftFromClient(admitted));
          setError(
            "The client was created, but its credential was not received. Rotate it to issue a new credential, or revoke it.",
          );
          return;
        }
      } else if (cause instanceof ApiError && cause.code === "conflict") {
        const refreshed = await controls.api
          .getToolClient(required(draft.clientId))
          .catch(() => undefined);
        if (refreshed) {
          replaceClient(refreshed);
          setDraft(draftFromClient(refreshed));
        }
        setError(
          "This tool client changed in another session. The current server version has been loaded.",
        );
        return;
      }
      setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };

  const recoverCreate = async (
    createDraft: ToolClientDraft,
  ): Promise<ToolClient | undefined> => {
    try {
      const recovery = await controls.api.listToolClients({
        creationRequestId: createDraft.requestId,
        pageSize: 1,
      });
      return recovery.items[0];
    } catch {
      return undefined;
    }
  };

  const confirmAction = async (action: Confirmation): Promise<void> => {
    setPending(true);
    setError("");
    try {
      if (action.kind === "rotate") {
        const result = await controls.api.rotateToolClient(
          action.client.id,
          action.client.policyRevision,
        );
        replaceClient(result.client);
        setDraft(draftFromClient(result.client));
        setCredential(result);
      } else {
        const revoked = await controls.api.revokeToolClient(
          action.client.id,
          action.client.policyRevision,
        );
        replaceClient(revoked);
        setDraft(draftFromClient(revoked));
      }
    } catch (cause) {
      const refreshed = await controls.api
        .getToolClient(action.client.id)
        .catch(() => undefined);
      if (refreshed) {
        replaceClient(refreshed);
        setDraft(draftFromClient(refreshed));
        if (
          action.kind === "rotate" &&
          refreshed.credentialGeneration > action.client.credentialGeneration
        ) {
          setError(
            "The credential rotated, but its value was not received. Rotate again to issue another credential, or revoke the client.",
          );
          return;
        }
      }
      setError(messageFrom(cause));
    } finally {
      setPending(false);
    }
  };

  const selectedClient =
    draft?.mode === "edit"
      ? clients.find(({ id }) => id === draft.clientId)
      : undefined;
  // Compared with what the editor opened with: the create origin, or the saved client.
  const draftOrigin =
    draft?.mode === "create"
      ? createOrigin
      : selectedClient && draftFromClient(selectedClient);
  const draftEdited =
    draft !== undefined && JSON.stringify(draft) !== JSON.stringify(draftOrigin);
  // Its "‹ Tool clients" and Escape close an open editor, asking first when it has edits.
  const closeEditor = (): void => (draftEdited ? setDiscarding(true) : openDraft(undefined));
  useSettingsEscapeLevel(draft ? closeEditor : undefined);
  // With nothing to list, the empty state carries the one "New client" action.
  const empty = options !== undefined && clients.length === 0 && !draft;

  return (
    <SettingsPage
      title="Tool clients"
      description="Issue revocable principal-scoped credentials for external Sedes CLI clients."
      width="wide"
      actions={
        options && !empty ? (
          <Button variant="outline" disabled={pending} onClick={startCreate}>
            <Plus aria-hidden="true" />
            New client
          </Button>
        ) : undefined
      }
    >
      {loading ? (
        <p className="settings-loading" role="status">
          Loading tool clients…
        </p>
      ) : null}
      {!loading && !options ? (
        <Callout
          tone="danger"
          role="alert"
          action={
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              Reload
            </Button>
          }
        >
          {error || "Tool clients could not be loaded."}
        </Callout>
      ) : null}
      {empty ? (
        <EmptyState
          icon={<KeyRound />}
          title="No tool clients yet"
          description="Create one to give an external Sedes CLI its own revocable credential."
          action={
            <Button disabled={pending} onClick={startCreate}>
              <Plus aria-hidden="true" />
              New client
            </Button>
          }
        />
      ) : null}
      {options && (clients.length > 0 || draft) ? (
        <div
          className="settings-master-detail"
          data-detail-open={Boolean(draft)}
          data-list-empty={clients.length === 0 || undefined}
        >
          <section
            className="settings-master-detail-list"
            data-sticky="true"
            aria-label="Tool clients"
          >
            {clients.length === 0 ? null : (
              <EntityList>
                {clients.map((client) => {
                  const state = clientState(client);
                  return (
                    <EntityRow
                      key={client.id}
                      icon={<KeyRound />}
                      title={client.name}
                      subtitle={`${availableToolCount(client)}/${client.toolIds.length} tools · ${environmentSummary(client, options)}`}
                      status={<StatusPill tone={state.tone}>{state.label}</StatusPill>}
                      selected={draft?.clientId === client.id}
                      onSelect={() => selectClient(client)}
                    />
                  );
                })}
              </EntityList>
            )}
          </section>
          <section
            className="settings-master-detail-pane"
            aria-label="Tool client editor"
          >
            {draft ? (
              <ToolClientEditor
                draft={draft}
                client={selectedClient}
                options={options}
                resources={controls.resources}
                endpoint={controls.endpoint}
                disabled={pending || selectedClient?.state === "revoked"}
                dirty={draftEdited}
                pending={pending}
                error={error}
                fieldError={fieldError}
                savedAt={savedAt}
                onChange={(next) => {
                  setDraft(next);
                  setFieldError(undefined);
                }}
                onSubmit={() => void submit()}
                onCancel={() =>
                  openDraft(selectedClient ? draftFromClient(selectedClient) : undefined)
                }
                onClose={closeEditor}
                onRotate={
                  selectedClient && selectedClient.state !== "revoked"
                    ? () => setConfirmation({ kind: "rotate", client: selectedClient })
                    : undefined
                }
                onRevoke={
                  selectedClient && selectedClient.state !== "revoked"
                    ? () => setConfirmation({ kind: "revoke", client: selectedClient })
                    : undefined
                }
              />
            ) : (
              <EmptyState
                variant="inline"
                title="Select a client to inspect it, or create a new one."
              />
            )}
          </section>
        </div>
      ) : null}
      <CredentialDialog
        result={credential}
        endpoint={controls.endpoint}
        onClose={() => setCredential(undefined)}
      />
      <ConfirmDialog
        open={confirmation?.kind === "rotate"}
        onOpenChange={(open) => !open && setConfirmation(undefined)}
        title="Rotate credential?"
        description="The previous credential stops working immediately. The replacement is shown once."
        confirmLabel="Rotate credential"
        pendingLabel="Rotating…"
        onConfirm={async () => {
          if (confirmation) await confirmAction(confirmation);
        }}
      />
      <ConfirmDialog
        open={confirmation?.kind === "revoke"}
        onOpenChange={(open) => !open && setConfirmation(undefined)}
        tone="danger"
        title="Revoke tool client?"
        description="Revocation is terminal. Every credential for this client stops working immediately."
        confirmLabel="Revoke permanently"
        pendingLabel="Revoking…"
        onConfirm={async () => {
          if (confirmation) await confirmAction(confirmation);
        }}
      />
      <DiscardChangesDialog
        open={discarding && draft !== undefined}
        onOpenChange={setDiscarding}
        description="This tool client has edits that have not been saved."
        discardLabel="Discard and close"
        onDiscard={() => {
          setDiscarding(false);
          openDraft(undefined);
        }}
      />
    </SettingsPage>
  );
}

function ToolClientEditor({
  draft,
  client,
  options,
  resources,
  endpoint,
  disabled,
  dirty,
  pending,
  error,
  fieldError,
  savedAt,
  onChange,
  onSubmit,
  onCancel,
  onClose,
  onRotate,
  onRevoke,
}: {
  readonly draft: ToolClientDraft;
  readonly client?: ToolClient;
  readonly options: ToolClientOptions;
  readonly resources: ToolClientSettingsResources;
  readonly endpoint: string;
  readonly disabled: boolean;
  /** The draft differs from what the editor opened with. */
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly error: string;
  readonly fieldError?: DraftError;
  readonly savedAt?: number;
  readonly onChange: (draft: ToolClientDraft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly onClose: () => void;
  readonly onRotate?: () => void;
  readonly onRevoke?: () => void;
}): React.JSX.Element {
  const knownToolIds = options.groups.flatMap(({ tools }) =>
    tools.map(({ id }) => id),
  );
  const unavailableToolIds = draft.toolIds.filter(
    (id) => !knownToolIds.includes(id),
  );
  const workspaces = resources.workspaces.filter(
    ({ environmentId }) => environmentId === draft.defaultEnvironmentId,
  );
  const threads = resources.threads.filter(
    ({ workspaceId }) => workspaceId === draft.defaultWorkspaceId,
  );
  const riskyTools = options.groups
    .flatMap(({ tools }) => tools)
    .filter(
      (tool) =>
        draft.toolIds.includes(tool.id) &&
        (tool.effects.application === "destructive" ||
          tool.effects.modelUsage === "agent_execution" ||
          tool.effects.external === "durable_side_effect"),
    );
  const httpWarning = new URL(endpoint).protocol === "http:";
  const revoked = client?.state === "revoked";
  const errorFor = (field: DraftField) =>
    fieldError?.field === field ? fieldError.message : undefined;

  return (
    <div className="settings-pane-form tool-client-editor">
      <header className="settings-pane-header">
        <SettingsBackLink
          label="Tool clients"
          className="settings-master-detail-back"
          onNavigate={onClose}
        />
        <h2 className="settings-pane-title">
          {draft.mode === "create" ? "New tool client" : client?.name}
        </h2>
        <p className="settings-pane-meta">
          {client
            ? clientTimeline(client)
            : "The credential will be shown once after creation."}
        </p>
      </header>
      {error ? (
        <Callout tone="danger" role="alert">
          {error}
        </Callout>
      ) : null}
      {revoked ? (
        <Callout>
          Tool client revoked. Its credentials can no longer be used.
        </Callout>
      ) : null}
      {client?.availability === "needs_attention" && !revoked ? (
        <Callout tone="warning" role="status">
          Needs attention: a selected tool or configured default is no longer
          available.
        </Callout>
      ) : null}
      {httpWarning && !revoked ? (
        <Callout tone="warning">
          This server uses HTTP, so tool client credentials cross the network
          in cleartext. Prefer HTTPS through Tailscale Serve.
        </Callout>
      ) : null}
      <SettingsSection title="Client" card>
        <SettingsField
          id="tool-client-name"
          label="Name"
          error={errorFor("name")}
        >
          <Input
            aria-label="Tool client name"
            value={draft.name}
            maxLength={240}
            disabled={disabled}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
          />
        </SettingsField>
        {draft.mode === "edit" ? (
          <SwitchField
            label="Enable tool client"
            description="Disabled clients cannot use any credential."
            checked={draft.enabled}
            disabled={disabled}
            onCheckedChange={(enabled) => onChange({ ...draft, enabled })}
          />
        ) : null}
      </SettingsSection>
      <SettingsSection
        title="Exact tool access"
        description="The client can call only the tools selected here."
        card
      >
        {errorFor("tools") ? (
          <Callout tone="danger" role="alert">
            {errorFor("tools")}
          </Callout>
        ) : null}
        {riskyTools.length > 0 ? (
          <Callout tone="warning" role="status">
            Selected tools marked High risk can start model work or make
            durable or destructive changes. Grant only what this client needs.
          </Callout>
        ) : null}
        <ExactToolSelector
          // Each client opens with its groups collapsed (a create keeps its
          // request id, so its groups stay as they were once it is saved).
          key={draft.requestId}
          groups={options.groups}
          selectedToolIds={draft.toolIds}
          unavailableToolIds={unavailableToolIds}
          disabled={disabled}
          showEffects
          onChange={(toolIds) => onChange({ ...draft, toolIds })}
        />
      </SettingsSection>
      <SettingsSection
        title="Environments and defaults"
        description="Only the allowed environments may be accessed."
        card
      >
        <SettingsField
          id="tool-client-default-environment"
          label="Default environment"
          error={errorFor("environment")}
        >
          <NativeSelect
            value={draft.defaultEnvironmentId}
            disabled={disabled}
            onChange={(event) => {
              const defaultEnvironmentId = event.target.value;
              onChange({
                ...draft,
                defaultEnvironmentId,
                allowedEnvironmentIds: [defaultEnvironmentId],
                defaultWorkspaceId: "",
                defaultThreadId: "",
              });
            }}
          >
            <option value="" disabled>Select an environment</option>
            {options.environments.map((environment) => (
              <option key={environment.id} value={environment.id}>
                {environment.label}{environment.available ? "" : " (unavailable)"}
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
        <SettingsField
          label="Allowed environments"
          description="The default environment is always allowed."
          layout="stacked"
        >
          <div className="tool-client-environments">
            {options.environments.map((environment) => (
              <div className="settings-choice" key={environment.id}>
                <Checkbox
                  id={`tool-client-allow-${environment.id}`}
                  aria-label={`Allow ${environment.label}`}
                  checked={draft.allowedEnvironmentIds.includes(environment.id)}
                  disabled={disabled || environment.id === draft.defaultEnvironmentId}
                  onCheckedChange={(checked) => {
                    const next = new Set(draft.allowedEnvironmentIds);
                    if (checked === true) next.add(environment.id);
                    else next.delete(environment.id);
                    onChange({ ...draft, allowedEnvironmentIds: [...next] });
                  }}
                />
                <Label htmlFor={`tool-client-allow-${environment.id}`}>
                  {environment.label}{environment.available ? "" : " (unavailable)"}
                </Label>
              </div>
            ))}
          </div>
        </SettingsField>
        <SettingsField
          id="tool-client-default-workspace"
          label="Default workspace"
          description="Optional."
        >
          <NativeSelect
            value={draft.defaultWorkspaceId}
            disabled={disabled || !draft.defaultEnvironmentId}
            onChange={(event) =>
              onChange({
                ...draft,
                defaultWorkspaceId: event.target.value,
                defaultThreadId: "",
              })
            }
          >
            <option value="">No default workspace</option>
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.label}{workspace.available ? "" : " (unavailable)"}
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
        <SettingsField
          id="tool-client-default-thread"
          label="Default thread"
          description="Optional; needs a default workspace."
          error={errorFor("thread")}
        >
          <NativeSelect
            value={draft.defaultThreadId}
            disabled={disabled || !draft.defaultWorkspaceId}
            onChange={(event) =>
              onChange({ ...draft, defaultThreadId: event.target.value })
            }
          >
            <option value="">No default thread</option>
            {threads.map((thread) => (
              <option key={thread.id} value={thread.id}>
                {thread.title}{thread.available && !thread.archived ? "" : " (unavailable)"}
              </option>
            ))}
          </NativeSelect>
        </SettingsField>
      </SettingsSection>
      {onRotate || onRevoke ? (
        <DangerZone>
          {onRotate ? (
            <DangerZoneItem
              title="Rotate credential"
              description="Issue a new credential. The current one stops working immediately."
              action={
                <Button variant="outline" disabled={disabled} onClick={onRotate}>
                  Rotate credential…
                </Button>
              }
            />
          ) : null}
          {onRevoke ? (
            <DangerZoneItem
              title="Revoke client"
              description="Permanently stop every credential for this client. This can't be undone."
              action={
                <Button variant="outline" disabled={disabled} onClick={onRevoke}>
                  Revoke…
                </Button>
              }
            />
          ) : null}
        </DangerZone>
      ) : null}
      {revoked ? null : (
        <SaveBar
          dirty={dirty}
          creating={draft.mode === "create"}
          saving={pending}
          savedAt={savedAt}
          saveLabel={draft.mode === "create" ? "Create client" : "Save"}
          savingLabel={draft.mode === "create" ? "Creating…" : "Saving…"}
          saveDisabled={disabled}
          onCancel={onCancel}
          onSave={onSubmit}
        />
      )}
    </div>
  );
}

function CredentialDialog({
  result,
  endpoint,
  onClose,
}: {
  readonly result?: ToolClientCredentialResult;
  readonly endpoint: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState("");
  const httpWarning = new URL(endpoint).protocol === "http:";
  const canCopy = !httpWarning || acknowledged;
  const token = result?.credential ?? "";
  const configuration = `export SEDES_AGENT_TOOL_ENDPOINT="${endpoint}"\nexport SEDES_AGENT_TOOL_CLIENT_TOKEN="${token}"`;

  useEffect(() => {
    if (!result) return;
    setRevealed(false);
    setAcknowledged(false);
    setCopied("");
  }, [result]);

  const copy = (label: string, value: string): void => {
    if (!canCopy) return;
    if (!navigator.clipboard?.writeText) {
      setCopied(`Could not copy ${label.toLowerCase()}.`);
      return;
    }
    void navigator.clipboard.writeText(value).then(
      () => setCopied(`${label} copied.`),
      () => setCopied(`Could not copy ${label.toLowerCase()}.`),
    );
  };

  return (
    <Dialog open={Boolean(result)} onOpenChange={() => undefined}>
      <DialogContent size="md" showClose={false} dismissible={false}>
        <DialogHeader>
          <DialogTitle>Save this credential now</DialogTitle>
          <DialogDescription>
            The credential for {result?.client.name ?? "this tool client"} is
            shown once. Closing this dialog permanently loses this value.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {httpWarning ? (
            <DialogAlert tone="warning" title="Cleartext endpoint">
              <p className="m-0">
                This HTTP endpoint sends the durable credential in cleartext.
                Prefer HTTPS through Tailscale Serve.
              </p>
              <div className="settings-choice tool-client-acknowledge">
                <Checkbox
                  id="tool-client-acknowledge-cleartext"
                  aria-label="Acknowledge cleartext credential risk"
                  checked={acknowledged}
                  onCheckedChange={(checked) => setAcknowledged(checked === true)}
                />
                <Label htmlFor="tool-client-acknowledge-cleartext">
                  I understand and still want to copy this configuration.
                </Label>
              </div>
            </DialogAlert>
          ) : null}
          <div className="tool-client-credential-values">
            <div>
              <span>Endpoint</span>
              <code>{endpoint}</code>
              <Button size="sm" variant="outline" disabled={!canCopy} onClick={() => copy("Endpoint", endpoint)}>
                Copy endpoint
              </Button>
            </div>
            <div>
              <span>Token</span>
              <code>{revealed ? token : maskedToken(token)}</code>
              <Button size="sm" variant="ghost" onClick={() => setRevealed((value) => !value)}>
                {revealed ? "Hide token" : "Reveal token"}
              </Button>
              <Button size="sm" variant="outline" disabled={!canCopy} onClick={() => copy("Token", token)}>
                Copy token
              </Button>
            </div>
          </div>
          {copied ? <p className="tool-client-copy-status" role="status">{copied}</p> : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" disabled={!canCopy} onClick={() => copy("Configuration", configuration)}>
            Copy configuration
          </Button>
          <Button data-autofocus onClick={onClose}>I saved it — close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function draftFromClient(client: ToolClient): ToolClientDraft {
  return {
    mode: "edit",
    requestId: client.creationRequestId,
    clientId: client.id,
    baseRevision: client.policyRevision,
    name: client.name,
    enabled: client.state === "enabled",
    toolIds: client.toolIds,
    defaultEnvironmentId: client.defaultEnvironmentId ?? "",
    allowedEnvironmentIds: client.allowedEnvironmentIds,
    defaultWorkspaceId: client.defaultWorkspaceId ?? "",
    defaultThreadId: client.defaultThreadId ?? "",
  };
}

function createRequestFromDraft(draft: ToolClientDraft): CreateToolClientRequest {
  return {
    requestId: draft.requestId,
    name: draft.name,
    toolIds: [...draft.toolIds],
    defaultEnvironmentId: draft.defaultEnvironmentId,
    allowedEnvironmentIds: [...draft.allowedEnvironmentIds],
    ...(draft.defaultWorkspaceId ? { defaultWorkspaceId: draft.defaultWorkspaceId } : {}),
    ...(draft.defaultThreadId ? { defaultThreadId: draft.defaultThreadId } : {}),
  };
}

function replaceRequestFromDraft(draft: ToolClientDraft): ReplaceToolClientRequest {
  return {
    name: draft.name,
    toolIds: [...draft.toolIds],
    defaultEnvironmentId: draft.defaultEnvironmentId,
    allowedEnvironmentIds: [...draft.allowedEnvironmentIds],
    ...(draft.defaultWorkspaceId ? { defaultWorkspaceId: draft.defaultWorkspaceId } : {}),
    ...(draft.defaultThreadId ? { defaultThreadId: draft.defaultThreadId } : {}),
    enabled: draft.enabled,
    expectedRevision: required(draft.baseRevision),
  };
}

function validateDraft(draft: ToolClientDraft): DraftError | undefined {
  if (!draft.name.trim()) return { field: "name", message: "Enter a tool client name." };
  if (draft.toolIds.length === 0) return { field: "tools", message: "Select at least one tool." };
  if (!draft.defaultEnvironmentId) {
    return { field: "environment", message: "Select a default environment." };
  }
  if (!draft.allowedEnvironmentIds.includes(draft.defaultEnvironmentId)) {
    return { field: "environment", message: "The default environment must be allowed." };
  }
  if (draft.defaultThreadId && !draft.defaultWorkspaceId) {
    return { field: "thread", message: "A default thread requires a default workspace." };
  }
  return undefined;
}

function conflictClient(cause: unknown): ToolClient | undefined {
  if (!(cause instanceof ApiError) || cause.code !== "conflict") return undefined;
  const details = cause.details;
  if (!details || typeof details !== "object" || !("client" in details)) {
    return undefined;
  }
  return (details as { readonly client?: ToolClient }).client;
}

function availableToolCount(client: ToolClient): number {
  return client.tools.filter(({ available }) => available).length;
}

function clientState(client: ToolClient): { readonly label: string; readonly tone: Tone } {
  if (client.state === "revoked") return { label: "Revoked", tone: "neutral" };
  if (client.state === "disabled") return { label: "Disabled", tone: "neutral" };
  return client.availability === "needs_attention"
    ? { label: "Needs attention", tone: "warning" }
    : { label: "Enabled", tone: "success" };
}

function environmentSummary(
  client: ToolClient,
  options: ToolClientOptions,
): string {
  const defaultLabel =
    options.environments.find(({ id }) => id === client.defaultEnvironmentId)
      ?.label ?? client.defaultEnvironmentId ?? "No default";
  const additional = Math.max(0, client.allowedEnvironmentIds.length - 1);
  return additional > 0
    ? `${defaultLabel} + ${additional} allowed`
    : `${defaultLabel} only`;
}

/** "Created … · Updated … · Last used …", leaving out an update that is the creation. */
function clientTimeline(client: ToolClient): string {
  return [
    `Created ${formatTime(client.createdAt)}`,
    client.updatedAt === client.createdAt ? undefined : `Updated ${formatTime(client.updatedAt)}`,
    client.lastUsedAt ? `Last used ${formatTime(client.lastUsedAt)}` : "Never used",
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function maskedToken(token: string): string {
  return token ? "hatc1_••••••••••••••••" : "";
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("tool_client_editor_state_invalid");
  return value;
}
