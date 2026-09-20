import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  AgentToolPresentation,
  AgentToolPresentationMode,
  AgentToolPresentationSurface,
  NormalizedThreadAgentToolPolicy,
  NormalizedThreadSnapshot,
} from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";

export const PI_NATIVE_CACHE_WARNING =
  "This changes the tools sent to Pi. The next turn may miss prompt cache and cost more.";

type AgentToolPolicy = NormalizedThreadAgentToolPolicy;
type AgentToolGroup = AgentToolPolicy["groups"][number];

interface AgentToolPolicyDraft {
  readonly baseRevision: number;
  readonly baseEnabled: boolean;
  readonly baseEnabledToolIds: readonly string[];
  readonly basePresentation: AgentToolPolicy["presentation"];
  readonly baseAccessBoundary: AgentToolPolicy["accessBoundary"];
  readonly enabled: boolean;
  readonly enabledToolIds: readonly string[];
  readonly presentation: AgentToolPolicy["presentation"];
  readonly accessBoundary: AgentToolPolicy["accessBoundary"];
}

function enabledToolIds(policy: AgentToolPolicy): readonly string[] {
  return policy.groups.flatMap(({ tools }) =>
    tools.filter(({ enabled }) => enabled).map(({ id }) => id),
  );
}

function draftFrom(policy: AgentToolPolicy): AgentToolPolicyDraft {
  const ids = enabledToolIds(policy);
  return {
    baseRevision: policy.revision,
    baseEnabled: policy.enabled,
    baseEnabledToolIds: ids,
    basePresentation: policy.presentation,
    baseAccessBoundary: policy.accessBoundary,
    enabled: policy.enabled,
    enabledToolIds: ids,
    presentation: policy.presentation,
    accessBoundary: policy.accessBoundary,
  };
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((id, index) => id === right[index])
  );
}

function dirty(draft: AgentToolPolicyDraft): boolean {
  return (
    draft.enabled !== draft.baseEnabled ||
    draft.presentation.surface !== draft.basePresentation.surface ||
    draft.presentation.mode !== draft.basePresentation.mode ||
    draft.accessBoundary !==
      draft.baseAccessBoundary ||
    !sameIds(draft.enabledToolIds, draft.baseEnabledToolIds)
  );
}

function effectiveNativeIds(
  enabled: boolean,
  ids: readonly string[],
): readonly string[] {
  return enabled ? ids : [];
}

type PiToolAccessMode = "read_only" | "ask" | "full";

const presentationLabels: Readonly<Record<AgentToolPresentationMode, string>> = {
  progressive: "Progressive discovery (recommended)",
  individual: "Individual operations",
};

const surfaceLabels: Readonly<Record<AgentToolPresentationSurface, string>> = {
  native: "Native tools",
  cli: "Sedes CLI",
};

function isSideEffectFreeRead(tool: AgentToolGroup["tools"][number]): boolean {
  return (
    tool.effects.application === "read" &&
    tool.effects.modelUsage === "none" &&
    tool.effects.external === "none"
  );
}

function progressiveGatewayNames(
  policy: AgentToolPolicy,
  enabled: boolean,
  ids: readonly string[],
  toolAccessMode: PiToolAccessMode,
): readonly string[] {
  if (!enabled) return [];
  const selected = new Set(ids);
  const tools = policy.groups
    .flatMap(({ tools }) => tools)
    .filter(({ id, available }) => selected.has(id) && available !== false);
  return [
    "sedes_catalog",
    ...(tools.some(isSideEffectFreeRead) ? ["sedes_read"] : []),
    ...(toolAccessMode !== "read_only" &&
    tools.some((tool) => !isSideEffectFreeRead(tool))
      ? ["sedes_act"]
      : []),
  ];
}

function currentPiToolAccessMode(
  snapshot: NormalizedThreadSnapshot,
): PiToolAccessMode | undefined {
  const value = snapshot.settings.values.find(
    ({ id }) => id === "tool_access",
  )?.desiredValue;
  return value === "read_only" || value === "ask" || value === "full"
    ? value
    : undefined;
}

function needsPiNativeConfirmation(
  draft: AgentToolPolicyDraft,
  policy: AgentToolPolicy,
  toolAccessMode: PiToolAccessMode | undefined,
): boolean {
  const nativeNames = (
    presentation: AgentToolPresentation,
    enabled: boolean,
    ids: readonly string[],
  ): readonly string[] => {
    if (presentation.surface !== "native") return [];
    if (presentation.mode === "individual") {
      return effectiveNativeIds(enabled, ids);
    }
    if (!toolAccessMode) {
      return enabled ? ["sedes_catalog", ...ids] : [];
    }
    return progressiveGatewayNames(policy, enabled, ids, toolAccessMode);
  };
  return !sameIds(
    nativeNames(
      draft.basePresentation,
      draft.baseEnabled,
      draft.baseEnabledToolIds,
    ),
    nativeNames(
      draft.presentation,
      draft.enabled,
      draft.enabledToolIds,
    ),
  );
}

export function agentToolPolicySummary(policy: AgentToolPolicy): string {
  if (!policy.enabled) return "Off";
  const count = enabledToolIds(policy).length;
  const presentation = `${
    policy.presentation.surface === "native" ? "Native" : "CLI"
  } · ${
    policy.presentation.mode === "progressive" ? "Progressive" : "Individual"
  }`;
  const accessBoundary =
    {
      thread: "Ask outside this thread",
      environment: "Ask outside this environment",
      unrestricted: "Allow without asking",
    }[policy.accessBoundary];
  return `${count} enabled · ${accessBoundary} · ${presentation}`;
}

function effectSummary(tool: AgentToolGroup["tools"][number]): string {
  if (tool.effects.modelUsage === "agent_execution") {
    return "Starts model execution";
  }
  if (tool.effects.external === "durable_side_effect") {
    return "Has a durable external side effect";
  }
  if (tool.effects.application === "read") return "Reads Sedes data";
  if (tool.effects.application === "destructive") return "Destructive change";
  return "Changes Sedes data";
}

export function AgentToolSettingsDialog({
  store,
  snapshot,
  authoritative,
  disabled,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  readonly store: ThreadClientStore;
  readonly snapshot: NormalizedThreadSnapshot;
  readonly authoritative: boolean;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly returnFocusRef?: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const policy = snapshot.agentTools;
  const dialogId = useId();
  const dialogDescriptionId = `${dialogId}-description`;
  const piNativeCacheWarningId = `${dialogId}-pi-native-cache-warning`;
  const policyFingerprint = `${policy.revision}:${policy.enabled}:${policy.presentation.surface}:${policy.presentation.mode}:${policy.accessBoundary}:${policy.groups
    .flatMap(({ id, order, tools }) => [
      `${id}:${order}`,
      ...tools.map(
        (tool) =>
          `${tool.id}:${tool.order}:${tool.enabled}:${tool.available}:${tool.unavailableReason?.text ?? ""}`,
      ),
    ])
    .join(",")}:${policy.presentationOptions
    .map(({ surface, modes }) => `${surface}:${modes.join("+")}`)
    .join(",")}`;
  const [draft, setDraft] = useState<AgentToolPolicyDraft>(() =>
    draftFrom(policy),
  );
  const [selectedGroupId, setSelectedGroupId] = useState(
    () => policy.groups[0]?.id ?? "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const isDirty = dirty(draft);

  useEffect(() => {
    if (!open) {
      if (!pending) {
        setDraft(draftFrom(policy));
        setError("");
        setConfirming(false);
      }
      return;
    }
    setDraft((current) => {
      if (pending || dirty(current)) return current;
      return draftFrom(policy);
    });
    setSelectedGroupId((current) =>
      policy.groups.some(({ id }) => id === current)
        ? current
        : (policy.groups[0]?.id ?? ""),
    );
  }, [open, pending, policyFingerprint]);

  useEffect(() => {
    if (confirming) confirmButtonRef.current?.focus();
  }, [confirming]);

  const selectedGroup = useMemo(
    () =>
      policy.groups.find(({ id }) => id === selectedGroupId) ??
      policy.groups[0],
    [policy.groups, selectedGroupId],
  );
  const idle = snapshot.runState === "idle" || snapshot.runState === "failed";
  const presentationUnchanged =
    draft.presentation.surface === policy.presentation.surface &&
    draft.presentation.mode === policy.presentation.mode;
  const liveCliPolicy =
    policy.presentation.surface === "cli" && presentationUnchanged;
  const available = authoritative && !disabled && !pending;
  const editable = available && (idle || liveCliPolicy);
  const presentationEditable = available && idle;
  const stale = policy.revision !== draft.baseRevision;
  const canSave = editable && isDirty && !stale;
  const showStaleWarning = stale && isDirty && !pending;
  const selectedPresentationOption =
    policy.presentationOptions.find(
      ({ surface }) => surface === draft.presentation.surface,
    ) ?? policy.presentationOptions[0]!;

  const orderedIds = policy.groups.flatMap(({ tools }) =>
    tools.map(({ id }) => id),
  );
  const setSelectedIds = (next: ReadonlySet<string>) => {
    setDraft((current) => ({
      ...current,
      enabledToolIds: orderedIds.filter((id) => next.has(id)),
    }));
  };
  const toggleTool = (toolId: string, checked: boolean) => {
    const next = new Set(draft.enabledToolIds);
    if (checked) next.add(toolId);
    else next.delete(toolId);
    setSelectedIds(next);
  };
  const groupState = (group: AgentToolGroup): boolean | "indeterminate" => {
    const selectable = group.tools.filter(
      ({ available }) => available !== false,
    );
    const selected = selectable.filter(({ id }) =>
      draft.enabledToolIds.includes(id),
    ).length;
    if (selected === 0) return false;
    if (selected === selectable.length) return true;
    return "indeterminate";
  };
  const toggleGroup = (group: AgentToolGroup) => {
    const next = new Set(draft.enabledToolIds);
    if (groupState(group) === true) {
      for (const { id, available } of group.tools) {
        if (available !== false) next.delete(id);
      }
    } else {
      for (const { id, available } of group.tools) {
        if (available !== false) next.add(id);
      }
    }
    setSelectedIds(next);
  };

  const submit = () => {
    if (!canSave) return;
    setConfirming(false);
    setPending(true);
    setError("");
    void store
      .setAgentToolPolicy({
        expectedPolicyRevision: draft.baseRevision,
        enabled: draft.enabled,
        enabledToolIds: draft.enabledToolIds,
        presentation: draft.presentation,
        accessBoundary: draft.accessBoundary,
      })
      .then(
        () => {
          setPending(false);
          setError("");
          onOpenChange(false);
        },
        (cause: unknown) => {
          setError(messageFrom(cause));
          setPending(false);
        },
      );
  };
  const save = () => {
    if (!canSave) return;
    if (
      needsPiNativeConfirmation(
        draft,
        policy,
        currentPiToolAccessMode(snapshot),
      )
    ) {
      setConfirming(true);
      return;
    }
    submit();
  };

  const unavailableMessage = !authoritative
    ? "Waiting for an authoritative thread snapshot."
    : !idle && !liveCliPolicy
      ? policy.presentation.surface === "cli"
        ? "Wait until the thread is idle to save presentation changes."
        : "Agent tools can be changed when the thread is idle."
      : disabled
        ? "Agent tool settings are temporarily unavailable."
        : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="agent-tool-dialog"
        aria-describedby={dialogDescriptionId}
        onEscapeKeyDown={(event) => {
          if (!confirming) return;
          event.preventDefault();
          setConfirming(false);
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader className="agent-tool-dialog-header">
          <DialogTitle>Agent tools</DialogTitle>
          <DialogDescription id={dialogDescriptionId}>
            Choose the Sedes tools this thread may use. CLI access changes apply
            to subsequent tool requests, including during a turn. Surface and
            presentation changes require an idle thread.
          </DialogDescription>
        </DialogHeader>

        <div className="agent-tool-dialog-global">
          <label className="agent-tool-dialog-setting">
            <span>
              <strong>Enable agent tools</strong>
              <small>Expose the selected tools to this thread.</small>
            </span>
            <Checkbox
              aria-label="Enable agent tools"
              checked={draft.enabled}
              disabled={!editable}
              onCheckedChange={(checked) =>
                setDraft((current) => ({
                  ...current,
                  enabled: checked === true,
                }))
              }
            />
          </label>
          {policy.presentationOptions.length > 1 && (
            <label className="agent-tool-dialog-setting">
              <span>
                <strong>Surface</strong>
                <small>Use native tools or Sedes CLI commands.</small>
              </span>
              <Select
                value={draft.presentation.surface}
                disabled={!presentationEditable}
                onValueChange={(surface) => {
                  const option = policy.presentationOptions.find(
                    (candidate) => candidate.surface === surface,
                  );
                  if (!option) return;
                  setDraft((current) => ({
                    ...current,
                    presentation: {
                      surface: surface as AgentToolPresentationSurface,
                      mode: option.modes.includes(current.presentation.mode)
                        ? current.presentation.mode
                        : option.modes[0]!,
                    },
                  }));
                }}
              >
                <SelectTrigger size="sm" aria-label="Agent tool surface">
                  <SelectValue>
                    {surfaceLabels[draft.presentation.surface]}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent position="popper">
                  {policy.presentationOptions.map((option) => (
                    <SelectItem key={option.surface} value={option.surface}>
                      {surfaceLabels[option.surface]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          {selectedPresentationOption.modes.length > 1 && (
            <label className="agent-tool-dialog-setting">
              <span>
                <strong>Presentation</strong>
                <small>
                  Choose progressive discovery or individual operations.
                </small>
              </span>
              <Select
                value={draft.presentation.mode}
                disabled={!presentationEditable}
                onValueChange={(mode) =>
                  setDraft((current) => ({
                    ...current,
                    presentation: {
                      ...current.presentation,
                      mode: mode as AgentToolPresentationMode,
                    },
                  }))
                }
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Agent tool presentation"
                >
                  <SelectValue>
                    {draft.presentation.mode === "progressive"
                      ? "Progressive"
                      : "Individual"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent position="popper">
                  {selectedPresentationOption.modes.map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      {presentationLabels[mode]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
          <label
            className="agent-tool-dialog-setting agent-tool-environment-access-setting"
            data-caution={
              draft.accessBoundary === "unrestricted"
                ? "true"
                : "false"
            }
          >
            <span>
              <strong>Access boundary</strong>
              <small>
                Choose which resources enabled tools can access without approval.
              </small>
            </span>
            <Select
              value={draft.accessBoundary}
              disabled={!editable}
              onValueChange={(accessBoundary) =>
                setDraft((current) => ({
                  ...current,
                  accessBoundary:
                    accessBoundary as AgentToolPolicyDraft["accessBoundary"],
                }))
              }
            >
              <SelectTrigger
                size="sm"
                aria-label="Access boundary"
              >
                <SelectValue>
                  {{
                    thread: "Ask outside this thread",
                    environment: "Ask outside this environment",
                    unrestricted: "Allow without asking",
                  }[draft.accessBoundary]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent position="popper">
                <SelectItem value="thread">Ask outside this thread</SelectItem>
                <SelectItem
                  value="environment"
                  textValue="Ask outside this environment"
                >
                  <span className="agent-tool-environment-access-option">
                    <strong>Ask outside this environment</strong>
                    <small>
                      Show an approval before an enabled Sedes tool reads or
                      changes resources in another execution environment.
                    </small>
                  </span>
                </SelectItem>
                <SelectItem value="unrestricted" textValue="Allow without asking">
                  <span className="agent-tool-environment-access-option">
                    <strong>Allow without asking</strong>
                    <small>
                      Enabled Sedes tools may read or change any
                      principal-owned environment without a Sedes environment
                      prompt.
                    </small>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>

        <div className="agent-tool-dialog-body">
          <nav className="agent-tool-group-nav" aria-label="Agent tool groups">
            {policy.groups.map((group) => (
              <div
                key={group.id}
                className="agent-tool-group-nav-row"
                data-active={selectedGroup?.id === group.id ? "true" : "false"}
              >
                <label className="agent-tool-group-toggle-target">
                  <Checkbox
                    aria-label={`Select all ${group.label.text} tools`}
                    checked={groupState(group)}
                    disabled={
                      !editable ||
                      group.tools.every(({ available }) => available === false)
                    }
                    onCheckedChange={() => toggleGroup(group)}
                  />
                </label>
                <button
                  type="button"
                  aria-current={
                    selectedGroup?.id === group.id ? "page" : undefined
                  }
                  onClick={() => setSelectedGroupId(group.id)}
                >
                  {group.label.text}
                </button>
              </div>
            ))}
          </nav>

          <section
            className="agent-tool-group-content"
            aria-label={selectedGroup?.label.text}
          >
            {selectedGroup && (
              <>
                <header>
                  <h3>{selectedGroup.label.text}</h3>
                  <p>{selectedGroup.description.text}</p>
                </header>
                <div className="agent-tool-dialog-list">
                  {selectedGroup.tools.map((tool) => {
                    const descriptionId = `${dialogId}-${tool.id}-description`;
                    const effectId = `${dialogId}-${tool.id}-effect`;
                    return (
                      <label key={tool.id} className="agent-tool-dialog-tool">
                        <Checkbox
                          aria-label={tool.label.text}
                          aria-describedby={
                            tool.description
                              ? `${descriptionId} ${effectId}`
                              : effectId
                          }
                          checked={draft.enabledToolIds.includes(tool.id)}
                          disabled={!editable || tool.available === false}
                          onCheckedChange={(checked) =>
                            toggleTool(tool.id, checked === true)
                          }
                        />
                        <span>
                          <strong>{tool.label.text}</strong>
                          {tool.description && (
                            <small id={descriptionId}>
                              {tool.description.text}
                            </small>
                          )}
                          {tool.available === false && (
                            <small className="agent-tool-unavailable-reason">
                              {tool.unavailableReason?.text ??
                                "Currently unavailable."}
                            </small>
                          )}
                          <small id={effectId} className="agent-tool-effect">
                            {effectSummary(tool)}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        </div>

        {(unavailableMessage || showStaleWarning || error || confirming) && (
          <div className="agent-tool-dialog-notices">
            {unavailableMessage && <p role="status">{unavailableMessage}</p>}
            {showStaleWarning && (
              <p role="alert">
                Agent tool settings changed in another client. Save will not
                overwrite the newer settings.
              </p>
            )}
            {error && <p role="alert">{error}</p>}
            {confirming && (
              <p id={piNativeCacheWarningId} role="alert">
                {PI_NATIVE_CACHE_WARNING}
              </p>
            )}
          </div>
        )}

        <DialogFooter className="agent-tool-dialog-footer">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {confirming ? (
            <>
              <Button variant="secondary" onClick={() => setConfirming(false)}>
                Keep editing
              </Button>
              <Button
                ref={confirmButtonRef}
                aria-describedby={piNativeCacheWarningId}
                disabled={!canSave}
                onClick={submit}
              >
                Save changes
              </Button>
            </>
          ) : (
            <Button disabled={!canSave} onClick={save}>
              {pending ? "Saving…" : "Save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
