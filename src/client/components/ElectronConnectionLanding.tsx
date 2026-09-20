import { useEffect, useId, useRef, useState } from "react";
import {
  Cable,
  LoaderCircle,
  Monitor,
  Pencil,
  Plus,
  Server,
  Trash2,
} from "lucide-react";
import {
  DEFAULT_SSH_REMOTE_PORT,
  ELECTRON_CONNECTION_NAME_MAX_LENGTH,
  ELECTRON_SSH_HOST_MAX_LENGTH,
  type ElectronConnectionProfile,
  type ElectronConnectionProfileInput,
} from "../app/electron-connections.js";
import { serverFromPairingInput } from "../authentication/pairing-link.js";
import { Button } from "./ui/button.js";
import { Checkbox } from "./ui/checkbox.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog.js";
import { Input } from "./ui/input.js";
import { Label } from "./ui/label.js";
import { RadioGroup, RadioGroupItem } from "./ui/radio-group.js";

export interface ElectronConnectionLandingProps {
  readonly profiles: readonly ElectronConnectionProfile[];
  readonly loading?: boolean;
  readonly globalError?: string;
  readonly profileErrors?: Readonly<Record<string, string | undefined>>;
  readonly connectingProfileId?: string | null;
  readonly connectionFinalizing?: boolean;
  readonly currentProfileId?: string | null;
  readonly autoConnectAtStartup: boolean;
  readonly onConnect: (profileId: string) => Promise<void>;
  readonly onCancelConnect: () => Promise<void>;
  readonly onAutoConnectAtStartupChange: (enabled: boolean) => Promise<void>;
  readonly onSaveAndConnect: (
    input: ElectronConnectionProfileInput,
    profileId?: string,
  ) => Promise<void>;
  readonly onDelete: (profileId: string) => Promise<void>;
  readonly onReturnToCurrent?: () => Promise<void>;
  readonly onResetPreferences?: () => Promise<void>;
}

interface ProfileDraft {
  readonly profileId?: string;
  readonly kind: "direct" | "ssh";
  readonly name: string;
  readonly baseUrl: string;
  readonly sshHost: string;
  readonly remotePort: string;
}

type PendingAction =
  | { readonly kind: "connect"; readonly profileId: string }
  | { readonly kind: "save"; readonly profileId?: string }
  | { readonly kind: "delete"; readonly profileId: string }
  | { readonly kind: "cancel" }
  | { readonly kind: "reset" }
  | { readonly kind: "auto-connect" };

const newProfileDraft: ProfileDraft = {
  kind: "direct",
  name: "",
  baseUrl: "",
  sshHost: "",
  remotePort: String(DEFAULT_SSH_REMOTE_PORT),
};

export function ElectronConnectionLanding({
  profiles,
  loading = false,
  globalError,
  profileErrors = {},
  connectingProfileId = null,
  connectionFinalizing = false,
  currentProfileId = null,
  autoConnectAtStartup,
  onConnect,
  onCancelConnect,
  onAutoConnectAtStartupChange,
  onSaveAndConnect,
  onDelete,
  onReturnToCurrent,
  onResetPreferences,
}: ElectronConnectionLandingProps): React.JSX.Element {
  const canPresentInitialEditor =
    !loading && profiles.length === 0 && !globalError;
  const [editor, setEditor] = useState<ProfileDraft | null>(() =>
    canPresentInitialEditor ? newProfileDraft : null,
  );
  const presentedEmptyEditor = useRef(canPresentInitialEditor);
  const [editorError, setEditorError] = useState("");
  const [localGlobalError, setLocalGlobalError] = useState("");
  const [autoConnectError, setAutoConnectError] = useState("");
  const [localProfileErrors, setLocalProfileErrors] = useState<
    Readonly<Record<string, string>>
  >({});
  const [deleteProfile, setDeleteProfile] =
    useState<ElectronConnectionProfile | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [switchTarget, setSwitchTarget] =
    useState<ElectronConnectionProfile | null>(null);
  const [savedSwitch, setSavedSwitch] = useState<{
    readonly input: ElectronConnectionProfileInput;
    readonly profileId?: string;
  } | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const preferencesNeedReset = Boolean(
    onResetPreferences && (localGlobalError || globalError),
  );

  useEffect(() => {
    if (
      !loading &&
      profiles.length === 0 &&
      editor === null &&
      !preferencesNeedReset &&
      !presentedEmptyEditor.current
    ) {
      presentedEmptyEditor.current = true;
      setEditor(newProfileDraft);
    }
  }, [editor, loading, preferencesNeedReset, profiles.length]);

  const externallyConnecting = connectingProfileId !== null;
  const locked = loading || pending !== null || externallyConnecting;
  const interactionLocked = locked || preferencesNeedReset;

  const connect = async (profileId: string): Promise<void> => {
    setPending({ kind: "connect", profileId });
    setLocalProfileErrors((current) => omitKey(current, profileId));
    try {
      await onConnect(profileId);
    } catch (error) {
      setLocalProfileErrors((current) => ({
        ...current,
        [profileId]: messageFrom(error, "Could not connect to Sedes."),
      }));
    } finally {
      setPending(null);
    }
  };

  const cancelConnect = async (): Promise<void> => {
    setPending({ kind: "cancel" });
    try {
      await onCancelConnect();
    } catch (error) {
      const profileId = connectingProfileId;
      if (profileId) {
        setLocalProfileErrors((current) => ({
          ...current,
          [profileId]: messageFrom(error, "Could not cancel the connection."),
        }));
      }
    } finally {
      setPending(null);
    }
  };

  const save = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!editor) return;

    let input: ElectronConnectionProfileInput;
    try {
      input = validateDraft(editor, profiles);
    } catch (error) {
      setEditorError(messageFrom(error, "Check the connection details."));
      return;
    }

    if (currentProfileId !== null) {
      setSavedSwitch({ input, profileId: editor.profileId });
      return;
    }

    await saveValidated(input, editor.profileId);
  };

  const saveValidated = async (
    input: ElectronConnectionProfileInput,
    profileId?: string,
  ): Promise<void> => {
    setPending({ kind: "save", profileId });
    setEditorError("");
    try {
      await onSaveAndConnect(input, profileId);
      setEditor(null);
    } catch (error) {
      setEditorError(messageFrom(error, "Could not save this connection."));
    } finally {
      setPending(null);
    }
  };

  const remove = async (): Promise<void> => {
    if (!deleteProfile) return;
    const profileId = deleteProfile.id;
    setPending({ kind: "delete", profileId });
    setDeleteError("");
    try {
      await onDelete(profileId);
      setDeleteProfile(null);
      setLocalProfileErrors((current) => omitKey(current, profileId));
    } catch (error) {
      setDeleteError(messageFrom(error, "Could not delete this connection."));
    } finally {
      setPending(null);
    }
  };

  const reset = async (): Promise<void> => {
    if (!onResetPreferences) return;
    setPending({ kind: "reset" });
    setLocalGlobalError("");
    try {
      await onResetPreferences();
      setEditor(newProfileDraft);
    } catch (error) {
      setLocalGlobalError(
        messageFrom(error, "Could not reset the saved connections."),
      );
    } finally {
      setPending(null);
    }
  };

  const updateAutoConnect = async (enabled: boolean): Promise<void> => {
    setPending({ kind: "auto-connect" });
    setAutoConnectError("");
    try {
      await onAutoConnectAtStartupChange(enabled);
    } catch (error) {
      setAutoConnectError(
        messageFrom(error, "Could not update the startup connection setting."),
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <main
      className="electron-connections"
      aria-labelledby="electron-connections-title"
    >
      <div className="electron-connections__surface">
        <header className="electron-connections__header">
          <div>
            <h1 id="electron-connections-title">Choose a Sedes connection</h1>
            <p>
              Run Sedes on this device, connect directly to a server, or use a
              managed tunnel through your existing OpenSSH setup.
            </p>
          </div>
          {profiles.length > 0 && !editor ? (
            <Button
              type="button"
              disabled={interactionLocked}
              onClick={() => {
                setEditor(newProfileDraft);
                setEditorError("");
              }}
            >
              <Plus aria-hidden="true" />
              Add connection
            </Button>
          ) : null}
        </header>

        {!loading ? (
          <div className="electron-connections__startup-setting">
            <Checkbox
              id="electron-auto-connect-at-startup"
              checked={autoConnectAtStartup}
              disabled={interactionLocked}
              onCheckedChange={(checked) =>
                void updateAutoConnect(checked === true)
              }
            />
            <div>
              <Label htmlFor="electron-auto-connect-at-startup">
                Connect automatically at startup
              </Label>
              <p>Uses the last successfully connected profile.</p>
              {autoConnectError ? <p role="alert">{autoConnectError}</p> : null}
            </div>
          </div>
        ) : null}

        {localGlobalError || globalError ? (
          <div className="electron-connections__global-error" role="alert">
            <p>{localGlobalError || globalError}</p>
            {onResetPreferences ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={locked}
                onClick={() => void reset()}
              >
                {pending?.kind === "reset"
                  ? "Resetting…"
                  : "Reset saved connections"}
              </Button>
            ) : null}
          </div>
        ) : null}

        {loading ? (
          <div className="electron-connections__loading" role="status">
            <LoaderCircle aria-hidden="true" />
            Loading saved connections…
          </div>
        ) : (
          <>
            {profiles.length > 0 ? (
              <ul
                className="electron-connections__list"
                aria-label="Saved connections"
              >
                {profiles.map((profile) => {
                  const isConnecting =
                    connectingProfileId === profile.id ||
                    (pending?.kind === "connect" &&
                      pending.profileId === profile.id);
                  const error =
                    localProfileErrors[profile.id] ?? profileErrors[profile.id];
                  const isCurrent = currentProfileId === profile.id;
                  return (
                    <li className="electron-connection-card" key={profile.id}>
                      <div
                        className="electron-connection-card__icon"
                        aria-hidden="true"
                      >
                        {profile.kind === "local" ? (
                          <Monitor />
                        ) : profile.kind === "direct" ? (
                          <Server />
                        ) : (
                          <Cable />
                        )}
                      </div>
                      <div className="electron-connection-card__body">
                        <div className="electron-connection-card__heading">
                          <h2>{profile.name}</h2>
                          <span>
                            {profile.kind === "local"
                              ? "Local"
                              : profile.kind === "direct"
                                ? "Direct"
                                : "SSH"}
                          </span>
                        </div>
                        <p className="electron-connection-card__summary">
                          {profile.kind === "local"
                            ? "Runs Sedes on this device while the desktop app is open."
                            : profile.kind === "direct"
                            ? profile.baseUrl
                            : `${profile.sshHost} · remote port ${profile.remotePort}`}
                        </p>
                        {isCurrent ? (
                          <p className="electron-connection-card__current">
                            Currently running
                          </p>
                        ) : null}
                        {isConnecting && !connectionFinalizing ? (
                          <p
                            className="electron-connection-card__progress"
                            role="status"
                            aria-live="polite"
                          >
                            <LoaderCircle aria-hidden="true" />
                            Connecting…
                          </p>
                        ) : null}
                        {error ? (
                          <p
                            className="electron-connection-card__error"
                            role="alert"
                          >
                            {error}
                          </p>
                        ) : null}
                      </div>
                      <div className="electron-connection-card__actions">
                        {isConnecting && !connectionFinalizing ? (
                          <Button
                            type="button"
                            variant="outline"
                            disabled={pending?.kind === "cancel"}
                            onClick={() => void cancelConnect()}
                          >
                            {pending?.kind === "cancel"
                              ? "Cancelling…"
                              : "Cancel"}
                          </Button>
                        ) : isConnecting && connectionFinalizing ? (
                          <Button type="button" disabled>
                            Finishing switch…
                          </Button>
                        ) : isCurrent && onReturnToCurrent ? (
                          <Button
                            type="button"
                            disabled={interactionLocked}
                            onClick={() => void onReturnToCurrent()}
                          >
                            Back to Local
                          </Button>
                        ) : (
                          <Button
                            type="button"
                            disabled={interactionLocked}
                            onClick={() => {
                              if (
                                currentProfileId !== null &&
                                profile.id !== currentProfileId
                              ) {
                                setSwitchTarget(profile);
                              } else {
                                void connect(profile.id);
                              }
                            }}
                          >
                            Connect
                          </Button>
                        )}
                        {profile.kind !== "local" ? (
                          <>
                            <Button
                              type="button"
                              variant="outline"
                              size="icon"
                              aria-label={`Edit ${profile.name}`}
                              disabled={interactionLocked}
                              onClick={() => {
                                setEditor(draftFromProfile(profile));
                                setEditorError("");
                              }}
                            >
                              <Pencil aria-hidden="true" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Delete ${profile.name}`}
                              disabled={interactionLocked}
                              onClick={() => {
                                setDeleteProfile(profile);
                                setDeleteError("");
                              }}
                            >
                              <Trash2 aria-hidden="true" />
                            </Button>
                          </>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : !editor && !preferencesNeedReset ? (
              <section className="electron-connections__empty">
                <Server aria-hidden="true" />
                <h2>No saved connections</h2>
                <p>Add a server connection to start using Sedes.</p>
                <Button
                  type="button"
                  onClick={() => setEditor(newProfileDraft)}
                >
                  <Plus aria-hidden="true" />
                  Add connection
                </Button>
              </section>
            ) : null}

            {editor ? (
              <ConnectionEditor
                draft={editor}
                error={editorError}
                pending={pending?.kind === "save"}
                locked={interactionLocked && pending?.kind !== "save"}
                onChange={(next) => {
                  setEditor(next);
                  setEditorError("");
                }}
                onCancel={() => {
                  setEditor(null);
                  setEditorError("");
                }}
                onSubmit={(event) => void save(event)}
              />
            ) : null}
          </>
        )}
      </div>

      <Dialog
        open={switchTarget !== null || savedSwitch !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSwitchTarget(null);
            setSavedSwitch(null);
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Switch away from Local?</DialogTitle>
            <DialogDescription>
              After{" "}
              {switchTarget?.name ??
                savedSwitch?.input.name ??
                "the new connection"}{" "}
              connects, the desktop app will stop the local Sedes server. Active
              local agents and terminals will stop. Local data and
              configuration will remain.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setSwitchTarget(null);
                setSavedSwitch(null);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={() => {
                const target = switchTarget;
                const saved = savedSwitch;
                setSwitchTarget(null);
                setSavedSwitch(null);
                if (target) void connect(target.id);
                if (saved) void saveValidated(saved.input, saved.profileId);
              }}
            >
              Connect to{" "}
              {switchTarget?.name ?? savedSwitch?.input.name ?? "connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteProfile !== null}
        onOpenChange={(open) => {
          if (!open && pending?.kind !== "delete") {
            setDeleteProfile(null);
            setDeleteError("");
          }
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete connection?</DialogTitle>
            <DialogDescription>
              Delete {deleteProfile?.name ?? "this connection"}? You will need
              to enter its details again to reconnect.
            </DialogDescription>
            {deleteError ? (
              <p role="alert" className="electron-connections__dialog-error">
                {deleteError}
              </p>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending?.kind === "delete"}
              onClick={() => setDeleteProfile(null)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending?.kind === "delete"}
              onClick={() => void remove()}
            >
              {pending?.kind === "delete" ? "Deleting…" : "Delete connection"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function ConnectionEditor({
  draft,
  error,
  pending,
  locked,
  onChange,
  onCancel,
  onSubmit,
}: {
  readonly draft: ProfileDraft;
  readonly error: string;
  readonly pending: boolean;
  readonly locked: boolean;
  readonly onChange: (draft: ProfileDraft) => void;
  readonly onCancel: () => void;
  readonly onSubmit: (event: React.FormEvent) => void;
}): React.JSX.Element {
  const prefix = useId();
  const disabled = pending || locked;
  return (
    <section
      className="electron-connection-editor"
      aria-labelledby={`${prefix}-title`}
    >
      <div className="electron-connection-editor__heading">
        <div>
          <p className="electron-connections__eyebrow">
            {draft.profileId ? "Edit connection" : "New connection"}
          </p>
          <h2 id={`${prefix}-title`}>
            {draft.profileId ? "Update connection" : "Connect to Sedes"}
          </h2>
        </div>
      </div>
      <form onSubmit={onSubmit}>
        <fieldset disabled={disabled}>
          <legend>Connection type</legend>
          <RadioGroup
            value={draft.kind}
            onValueChange={(value) =>
              onChange({ ...draft, kind: value as "direct" | "ssh" })
            }
            className="electron-connection-editor__types"
          >
            <Label className="electron-connection-editor__type">
              <RadioGroupItem value="direct" />
              <span>
                <strong>Direct</strong>
                <small>Connect to an HTTP or HTTPS server.</small>
              </span>
            </Label>
            <Label className="electron-connection-editor__type">
              <RadioGroupItem value="ssh" />
              <span>
                <strong>SSH</strong>
                <small>Forward a remote loopback server securely.</small>
              </span>
            </Label>
          </RadioGroup>
        </fieldset>

        <div className="electron-connection-editor__field">
          <Label htmlFor={`${prefix}-name`}>Name</Label>
          <Input
            id={`${prefix}-name`}
            autoFocus
            autoComplete="off"
            maxLength={ELECTRON_CONNECTION_NAME_MAX_LENGTH}
            value={draft.name}
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...draft, name: event.target.value })
            }
            placeholder="Work server"
          />
        </div>

        {draft.kind === "direct" ? (
          <div className="electron-connection-editor__field">
            <Label htmlFor={`${prefix}-url`}>Sedes server URL</Label>
            <Input
              id={`${prefix}-url`}
              type="url"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={draft.baseUrl}
              disabled={disabled}
              onChange={(event) =>
                onChange({ ...draft, baseUrl: event.target.value })
              }
              placeholder="https://sedes.example"
            />
            <p>
              Enter a complete HTTP or HTTPS origin without a path or
              credentials.
            </p>
          </div>
        ) : (
          <>
            <div className="electron-connection-editor__field">
              <Label htmlFor={`${prefix}-host`}>SSH host alias</Label>
              <Input
                id={`${prefix}-host`}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                maxLength={ELECTRON_SSH_HOST_MAX_LENGTH}
                value={draft.sshHost}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...draft, sshHost: event.target.value })
                }
                placeholder="my-server"
              />
            </div>
            <div className="electron-connection-editor__field electron-connection-editor__port">
              <Label htmlFor={`${prefix}-port`}>Remote Sedes port</Label>
              <Input
                id={`${prefix}-port`}
                type="number"
                inputMode="numeric"
                min={1}
                max={65_535}
                step={1}
                value={draft.remotePort}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...draft, remotePort: event.target.value })
                }
              />
            </div>
            <div className="electron-connection-editor__ssh-note">
              <strong>Uses your system OpenSSH configuration</strong>
              <p>
                User names, keys, agents, proxy jumps, and host verification
                come from your normal SSH setup. Sedes cannot prompt for a
                password or passphrase. If connection fails, verify
                <code>ssh {draft.sshHost.trim() || "<alias>"}</code> in a
                terminal first.
              </p>
            </div>
          </>
        )}

        {error ? (
          <p className="electron-connection-editor__error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="electron-connection-editor__actions">
          <Button
            type="button"
            variant="outline"
            disabled={disabled}
            onClick={onCancel}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={disabled}>
            {pending ? "Connecting…" : "Save & connect"}
          </Button>
        </div>
      </form>
    </section>
  );
}

function draftFromProfile(profile: ElectronConnectionProfile): ProfileDraft {
  if (profile.kind === "local") {
    throw new Error("The built-in Local connection cannot be edited.");
  }
  return profile.kind === "direct"
    ? {
        profileId: profile.id,
        kind: "direct",
        name: profile.name,
        baseUrl: profile.baseUrl,
        sshHost: "",
        remotePort: String(DEFAULT_SSH_REMOTE_PORT),
      }
    : {
        profileId: profile.id,
        kind: "ssh",
        name: profile.name,
        baseUrl: "",
        sshHost: profile.sshHost,
        remotePort: String(profile.remotePort),
      };
}

function validateDraft(
  draft: ProfileDraft,
  profiles: readonly ElectronConnectionProfile[],
): ElectronConnectionProfileInput {
  const name = draft.name.trim();
  if (!name) throw new Error("Enter a connection name.");
  if (name.length > ELECTRON_CONNECTION_NAME_MAX_LENGTH) {
    throw new Error(
      `Connection names must be ${ELECTRON_CONNECTION_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (
    profiles.some(
      (profile) =>
        profile.id !== draft.profileId &&
        profile.name.toLowerCase() === name.toLowerCase(),
    )
  ) {
    throw new Error(`A connection named “${name}” already exists.`);
  }
  if (draft.kind === "direct") {
    return {
      kind: "direct",
      name,
      baseUrl: serverFromPairingInput(draft.baseUrl),
    };
  }
  const sshHost = draft.sshHost.trim();
  if (!sshHost) throw new Error("Enter an SSH host alias.");
  if (
    sshHost.length > ELECTRON_SSH_HOST_MAX_LENGTH ||
    sshHost.startsWith("-") ||
    !/^[A-Za-z0-9_.-]+$/u.test(sshHost)
  ) {
    throw new Error(
      "SSH host aliases may contain only letters, numbers, periods, underscores, and hyphens, and must not begin with a hyphen.",
    );
  }
  const remotePort = Number(draft.remotePort);
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
    throw new Error(
      "Remote Sedes port must be an integer from 1 through 65535.",
    );
  }
  return { kind: "ssh", name, sshHost, remotePort };
}

function omitKey(
  values: Readonly<Record<string, string>>,
  key: string,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values).filter(([name]) => name !== key),
  );
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
