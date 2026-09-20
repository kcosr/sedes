import { useEffect, useRef, useState } from "react";
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
import { Checkbox } from "@client/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import { Input } from "@client/components/ui/input";

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
  const [notice, setNotice] = useState("");
  const [credential, setCredential] =
    useState<ToolClientCredentialResult>();
  const [confirmation, setConfirmation] = useState<Confirmation>();

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

  const selectClient = (client: ToolClient): void => {
    setDraft(draftFromClient(client));
    setError("");
    setNotice("");
  };
  const startCreate = (): void => {
    if (!options) return;
    const defaultEnvironment =
      options.environments.find(({ available }) => available) ??
      options.environments[0];
    setDraft({
      mode: "create",
      requestId: crypto.randomUUID(),
      name: "",
      enabled: true,
      toolIds: [],
      defaultEnvironmentId: defaultEnvironment?.id ?? "",
      allowedEnvironmentIds: defaultEnvironment ? [defaultEnvironment.id] : [],
      defaultWorkspaceId: "",
      defaultThreadId: "",
    });
    setError("");
    setNotice("");
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
    if (validation) {
      setError(validation);
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
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
      setNotice("Tool client saved.");
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

  const confirmAction = async (): Promise<void> => {
    const action = confirmation;
    if (!action || pending) return;
    setConfirmation(undefined);
    setPending(true);
    setError("");
    setNotice("");
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
        setNotice("Tool client revoked. Its credentials can no longer be used.");
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

  return (
    <>
      <header className="tool-clients-page-header">
        <div>
          <h3 className="settings-page-title">Tool clients</h3>
          <p>
            Issue revocable principal-scoped credentials for external Sedes
            CLI clients.
          </p>
        </div>
        <Button size="sm" disabled={!options || pending} onClick={startCreate}>
          New client
        </Button>
      </header>
      {loading ? <p role="status">Loading tool clients…</p> : null}
      {!loading && !options ? (
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      ) : null}
      {options ? (
        <div className="tool-clients-layout" data-editor-open={Boolean(draft)}>
          <aside className="tool-clients-list" aria-label="Tool clients">
            {clients.length === 0 ? (
              <p className="tool-clients-empty">No tool clients yet.</p>
            ) : (
              clients.map((client) => (
                <button
                  key={client.id}
                  type="button"
                  className="tool-client-list-item"
                  aria-current={draft?.clientId === client.id ? "page" : undefined}
                  onClick={() => selectClient(client)}
                >
                  <strong>{client.name}</strong>
                  <span>
                    {stateLabel(client)} · {availableToolCount(client)}/
                    {client.toolIds.length} tools
                  </span>
                  <small>
                    {environmentSummary(client, options)}
                  </small>
                  <small>
                    Created {formatTime(client.createdAt)} · Updated {formatTime(client.updatedAt)}
                  </small>
                  <small>
                    Last used: {client.lastUsedAt ? formatTime(client.lastUsedAt) : "Never used"}
                  </small>
                </button>
              ))
            )}
          </aside>
          <section className="tool-client-editor" aria-label="Tool client editor">
            {draft ? (
              <ToolClientEditor
                draft={draft}
                client={selectedClient}
                options={options}
                resources={controls.resources}
                endpoint={controls.endpoint}
                disabled={pending || selectedClient?.state === "revoked"}
                onChange={setDraft}
                onSubmit={() => void submit()}
                onCancel={() => {
                  setDraft(undefined);
                  setError("");
                  setNotice("");
                }}
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
              <div className="tool-client-editor-empty">
                Select a client to inspect it, or create a new one.
              </div>
            )}
          </section>
        </div>
      ) : null}
      {error ? <p className="tool-clients-message" role="alert">{error}</p> : null}
      {notice ? <p className="tool-clients-message" role="status">{notice}</p> : null}
      <CredentialDialog
        result={credential}
        endpoint={controls.endpoint}
        onClose={() => setCredential(undefined)}
      />
      <ConfirmationDialog
        confirmation={confirmation}
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => void confirmAction()}
      />
    </>
  );
}

function ToolClientEditor({
  draft,
  client,
  options,
  resources,
  endpoint,
  disabled,
  onChange,
  onSubmit,
  onCancel,
  onRotate,
  onRevoke,
}: {
  readonly draft: ToolClientDraft;
  readonly client?: ToolClient;
  readonly options: ToolClientOptions;
  readonly resources: ToolClientSettingsResources;
  readonly endpoint: string;
  readonly disabled: boolean;
  readonly onChange: (draft: ToolClientDraft) => void;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
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

  return (
    <div className="tool-client-editor-form">
      <header>
        <h4>{draft.mode === "create" ? "New tool client" : client?.name}</h4>
        {client ? (
          <p>
            Created {formatTime(client.createdAt)} · Updated {formatTime(client.updatedAt)}
          </p>
        ) : (
          <p>The credential will be shown once after creation.</p>
        )}
      </header>
      {httpWarning ? (
        <p className="tool-client-http-warning" role="alert">
          This server uses HTTP. Tool client credentials cross the network in
          cleartext; prefer HTTPS through Tailscale Serve.
        </p>
      ) : null}
      {client?.availability === "needs_attention" ? (
        <p className="tool-client-attention" role="status">
          This client needs attention because a selected tool or configured
          default is no longer available.
        </p>
      ) : null}
      <label className="tool-client-field">
        <span>Name</span>
        <Input
          aria-label="Tool client name"
          value={draft.name}
          maxLength={240}
          disabled={disabled}
          onChange={(event) => onChange({ ...draft, name: event.target.value })}
        />
      </label>
      {draft.mode === "edit" ? (
        <label className="tool-client-toggle">
          <span>
            <strong>Enabled</strong>
            <small>Disabled clients cannot use any credential.</small>
          </span>
          <Checkbox
            aria-label="Enable tool client"
            checked={draft.enabled}
            disabled={disabled}
            onCheckedChange={(checked) =>
              onChange({ ...draft, enabled: checked === true })
            }
          />
        </label>
      ) : null}
      <section className="tool-client-policy-section">
        <h5>Exact tool access</h5>
        <ExactToolSelector
          groups={options.groups}
          selectedToolIds={draft.toolIds}
          unavailableToolIds={unavailableToolIds}
          disabled={disabled}
          showEffects
          onChange={(toolIds) => onChange({ ...draft, toolIds })}
        />
      </section>
      {riskyTools.length > 0 ? (
        <p className="tool-client-risk-warning" role="status">
          Selected tools can start model work, create durable side effects, or
          make destructive application changes. Grant only what this client
          needs.
        </p>
      ) : null}
      <label className="tool-client-field">
        <span>Default environment</span>
        <select
          className="settings-native-select"
          aria-label="Default environment"
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
        </select>
      </label>
      <fieldset className="tool-client-environments">
        <legend>Allowed environments</legend>
        <small>Only these explicit environments may be accessed.</small>
        {options.environments.map((environment) => (
          <label key={environment.id}>
            <Checkbox
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
            <span>{environment.label}{environment.available ? "" : " (unavailable)"}</span>
          </label>
        ))}
      </fieldset>
      <label className="tool-client-field">
        <span>Default workspace (optional)</span>
        <select
          className="settings-native-select"
          aria-label="Default workspace"
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
        </select>
      </label>
      <label className="tool-client-field">
        <span>Default thread (optional)</span>
        <select
          className="settings-native-select"
          aria-label="Default thread"
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
        </select>
      </label>
      <div className="tool-client-editor-actions">
        {onRevoke ? (
          <Button variant="destructive" disabled={disabled} onClick={onRevoke}>
            Revoke
          </Button>
        ) : null}
        {onRotate ? (
          <Button variant="outline" disabled={disabled} onClick={onRotate}>
            Rotate credential
          </Button>
        ) : null}
        <span />
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        {client?.state !== "revoked" ? (
          <Button disabled={disabled} onClick={onSubmit}>
            {draft.mode === "create" ? "Create client" : "Save"}
          </Button>
        ) : null}
      </div>
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
  const closeRef = useRef<HTMLButtonElement>(null);
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
      <DialogContent
        className="tool-client-credential-dialog"
        showCloseButton={false}
        aria-describedby="tool-client-credential-description"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Save this credential now</DialogTitle>
          <DialogDescription id="tool-client-credential-description">
            The credential for {result?.client.name ?? "this tool client"} is
            shown once. Closing this dialog permanently loses this value.
          </DialogDescription>
        </DialogHeader>
        {httpWarning ? (
          <div className="tool-client-http-warning" role="alert">
            <p>
              This HTTP endpoint sends the durable credential in cleartext.
              Prefer HTTPS through Tailscale Serve.
            </p>
            <label>
              <Checkbox
                aria-label="Acknowledge cleartext credential risk"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              I understand and still want to copy this configuration.
            </label>
          </div>
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
        {copied ? <p role="status">{copied}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={!canCopy} onClick={() => copy("Configuration", configuration)}>
            Copy configuration
          </Button>
          <Button ref={closeRef} onClick={onClose}>I saved it — close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmationDialog({
  confirmation,
  onCancel,
  onConfirm,
}: {
  readonly confirmation?: Confirmation;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): React.JSX.Element {
  const revoke = confirmation?.kind === "revoke";
  return (
    <Dialog open={Boolean(confirmation)} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false} aria-describedby="tool-client-confirm-description">
        <DialogHeader>
          <DialogTitle>{revoke ? "Revoke tool client?" : "Rotate credential?"}</DialogTitle>
          <DialogDescription id="tool-client-confirm-description">
            {revoke
              ? "Revocation is terminal. Every credential for this client stops working immediately."
              : "The previous credential stops working immediately. The replacement is shown once."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant={revoke ? "destructive" : "default"} onClick={onConfirm}>
            {revoke ? "Revoke permanently" : "Rotate credential"}
          </Button>
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

function validateDraft(draft: ToolClientDraft): string | undefined {
  if (!draft.name.trim()) return "Enter a tool client name.";
  if (draft.toolIds.length === 0) return "Select at least one tool.";
  if (!draft.defaultEnvironmentId) return "Select a default environment.";
  if (!draft.allowedEnvironmentIds.includes(draft.defaultEnvironmentId)) {
    return "The default environment must be allowed.";
  }
  if (draft.defaultThreadId && !draft.defaultWorkspaceId) {
    return "A default thread requires a default workspace.";
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

function stateLabel(client: ToolClient): string {
  if (client.state === "revoked") return "Revoked";
  if (client.state === "disabled") return "Disabled";
  return client.availability === "needs_attention"
    ? "Enabled · needs attention"
    : "Enabled";
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
