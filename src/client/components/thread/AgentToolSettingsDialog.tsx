import { useEffect, useId, useMemo, useRef, useState } from "react";
import type {
  AgentToolPresentation,
  AgentToolPresentationMode,
  AgentToolPresentationSurface,
  NormalizedThreadAgentToolPolicy,
  NormalizedThreadSnapshot,
  ToolPolicySet,
} from "../../../shared/index.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { messageFrom } from "../../stores/ApplicationClientStore.js";
import { Button } from "@client/components/ui/button";
import { Checkbox } from "@client/components/ui/checkbox";
import { Switch } from "@client/components/ui/switch";
import { NativeSelect } from "@client/components/ui/native-select";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";

export const NATIVE_TOOL_CACHE_WARNING =
  "This changes the native tools sent to the model. The next turn may miss prompt cache and cost more.";

type AgentToolPolicy = NormalizedThreadAgentToolPolicy;
type AgentToolGroup = AgentToolPolicy["groups"][number];

interface AgentToolPolicyDraft {
  readonly baseRevision: number;
  readonly baseEnabled: boolean;
  readonly baseEnabledToolIds: readonly string[];
  readonly basePresentation: AgentToolPolicy["presentation"];
  readonly baseResourceScope: AgentToolPolicy["resourceScope"];
  readonly enabled: boolean;
  readonly enabledToolIds: readonly string[];
  readonly presentation: AgentToolPolicy["presentation"];
  readonly resourceScope: AgentToolPolicy["resourceScope"];
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
    baseResourceScope: policy.resourceScope,
    enabled: policy.enabled,
    enabledToolIds: ids,
    presentation: policy.presentation,
    resourceScope: policy.resourceScope,
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
    draft.resourceScope.allowOtherEnvironments !== draft.baseResourceScope.allowOtherEnvironments ||
    draft.resourceScope.allowOtherProjects !== draft.baseResourceScope.allowOtherProjects ||
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

function needsNativeToolConfirmation(
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
  if (policy.runtimeAvailability.availability === "unavailable") return "Unavailable";
  return `${enabledToolIds(policy).length} enabled`;
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
  const nativeToolCacheWarningId = `${dialogId}-pi-native-cache-warning`;
  const policyFingerprint = `${policy.revision}:${policy.enabled}:${policy.presentation.surface}:${policy.presentation.mode}:${policy.resourceScope.allowOtherEnvironments}:${policy.resourceScope.allowOtherProjects}:${policy.groups
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
  const [policySets, setPolicySets] = useState<readonly ToolPolicySet[]>([]);
  const [policySetsLoading, setPolicySetsLoading] = useState(false);
  const [policySetError, setPolicySetError] = useState("");
  const [policySetsRefresh, setPolicySetsRefresh] = useState(0);
  const [selectedPolicySetId, setSelectedPolicySetId] = useState("");
  const [applyingPolicy, setApplyingPolicy] = useState(false);
  const [appliedPolicyMessage, setAppliedPolicyMessage] = useState("");
  const applyRequest = useRef<AbortController | null>(null);
  const applyButtonRef = useRef<HTMLButtonElement>(null);
  const restoreApplyFocus = useRef(false);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const isDirty = dirty(draft);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    setPolicySetsLoading(true);
    setPolicySetError("");
    void store.listToolPolicySets(abort.signal).then(({ items }) => {
      if (abort.signal.aborted) return;
      setPolicySets(items);
      setSelectedPolicySetId(current => items.some(item => item.id === current) ? current : "");
      setPolicySetsLoading(false);
    }, (cause: unknown) => {
      if (abort.signal.aborted) return;
      setPolicySetError(messageFrom(cause));
      setPolicySetsLoading(false);
    });
    return () => abort.abort();
  }, [open, store, policySetsRefresh]);

  useEffect(() => {
    setPolicySets([]);
    setSelectedPolicySetId("");
    setAppliedPolicyMessage("");
    setApplyingPolicy(false);
    restoreApplyFocus.current = false;
    return () => {
      applyRequest.current?.abort();
      applyRequest.current = null;
    };
  }, [open, store]);

  useEffect(() => {
    if (open && !applyingPolicy && restoreApplyFocus.current) {
      restoreApplyFocus.current = false;
      if (document.activeElement === document.body || document.activeElement === applyButtonRef.current) {
        applyButtonRef.current?.focus();
      }
    }
  }, [open, applyingPolicy]);

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
      if (pending || applyingPolicy || dirty(current)) return current;
      return draftFrom(policy);
    });
    setSelectedGroupId((current) =>
      policy.groups.some(({ id }) => id === current)
        ? current
        : (policy.groups[0]?.id ?? ""),
    );
  }, [open, pending, applyingPolicy, policyFingerprint]);

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
  const available = authoritative && !disabled && !pending && !applyingPolicy;
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
  const applyPolicySet = async () => {
    if (!editable || policySetsLoading || !selectedPolicySetId || applyRequest.current) return;
    const request = new AbortController();
    applyRequest.current = request;
    restoreApplyFocus.current = document.activeElement === applyButtonRef.current;
    setApplyingPolicy(true);
    setPolicySetError("");
    setAppliedPolicyMessage("");
    setConfirming(false);
    try {
      const selected = await store.getToolPolicySet(selectedPolicySetId, request.signal);
      if (request.signal.aborted) return;
      const ids = new Set(selected.enabledToolIds);
      if (selected.enabledToolIds.some(id => !orderedIds.includes(id))) {
        throw new Error("This policy includes tools this thread does not support. Choose another policy set or select tools manually.");
      }
      setDraft(current => ({
        ...current,
        enabled: true,
        enabledToolIds: orderedIds.filter(id => ids.has(id)),
        resourceScope: { ...selected.resourceScope },
      }));
      setAppliedPolicyMessage(`Loaded ${selected.name} (revision ${selected.revision}) into this draft. Review the settings, then Save.`);
    } catch (cause) {
      if (!request.signal.aborted) setPolicySetError(messageFrom(cause));
    } finally {
      if (applyRequest.current === request) applyRequest.current = null;
      if (!request.signal.aborted) setApplyingPolicy(false);
    }
  };
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
        resourceScope: draft.resourceScope,
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
      needsNativeToolConfirmation(
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
        size="lg"
        aria-describedby={dialogDescriptionId}
        returnFocusRef={returnFocusRef}
        onEscapeKeyDown={(event) => {
          if (!confirming) return;
          event.preventDefault();
          setConfirming(false);
        }}
      >
        <DialogHeader>
          <DialogTitle>Agent tools</DialogTitle>
          <DialogDescription id={dialogDescriptionId}>
            Choose the Sedes tools this thread may use. CLI access changes apply
            to subsequent tool requests, including during a turn. Surface and
            presentation changes require an idle thread.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
        {policy.origin && <p className="agent-tool-policy-origin">
          Original policy: {originalPolicyDescription(policy.origin)}.
          {" "}These settings are saved on this thread; later default or policy-set changes do not update it.
        </p>}
        <section className="agent-tool-policy-apply" aria-label="Apply policy set">
          <label htmlFor={`${dialogId}-policy-set`}>Apply policy set</label>
          <div className="agent-tool-policy-apply-controls">
            <NativeSelect id={`${dialogId}-policy-set`} aria-label="Policy set"
              aria-describedby={`${dialogId}-policy-set-description`}
              value={selectedPolicySetId} disabled={!editable || policySetsLoading || policySets.length === 0}
              onChange={event => { setSelectedPolicySetId(event.target.value); setPolicySetError(""); }}>
              <option value="">{policySetsLoading ? "Loading policy sets…" : policySets.length === 0 ? "No policy sets available" : "Choose a policy set…"}</option>
              {policySets.map(set => <option key={set.id} value={set.id}>{set.name}</option>)}
            </NativeSelect>
            <Button ref={applyButtonRef} type="button" variant="outline"
              disabled={!editable || policySetsLoading || !selectedPolicySetId}
              onClick={() => void applyPolicySet()}>{applyingPolicy ? "Applying…" : "Apply"}</Button>
          </div>
          <p id={`${dialogId}-policy-set-description`}>Replace this draft’s tools and access settings. Presentation stays unchanged; Save applies the changes to this thread.</p>
          <p className="agent-tool-policy-apply-status" role="status" aria-live="polite">{appliedPolicyMessage}</p>
          {policySetError && <DialogAlert tone="danger" action={
            <Button type="button" size="sm" variant="outline" onClick={() => setPolicySetsRefresh(value => value + 1)}>Retry policy sets</Button>
          }>{policySetError}</DialogAlert>}
        </section>
        {policy.runtimeAvailability.availability === "unavailable" && (
          <p role="status">
            <strong>Sedes tools are unavailable for this thread.</strong>{" "}
            {policy.runtimeAvailability.reason.text}{" "}
            Your saved tool selections are retained and can still be changed.
          </p>
        )}
        <div className="agent-tool-dialog-global">
          <label className="agent-tool-dialog-setting">
            <span>
              <strong>Enable agent tools</strong>
              <small>Expose the selected tools to this thread.</small>
            </span>
            <Switch
              aria-label="Enable agent tools"
              checked={draft.enabled}
              disabled={!editable}
              onCheckedChange={(enabled) =>
                setDraft((current) => ({ ...current, enabled }))
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
                <SelectTrigger aria-label="Agent tool surface">
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
                <SelectTrigger aria-label="Agent tool presentation">
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
          <label className="agent-tool-dialog-setting">
            <span>
              <strong>Allow other environments</strong>
              <small>Access resources on other execution hosts. When off, lists and searches stay in this environment; direct requests outside it are denied.</small>
            </span>
            <Switch
              aria-label="Allow other environments"
              checked={draft.resourceScope.allowOtherEnvironments}
              disabled={!editable}
              onCheckedChange={(allowOtherEnvironments) => setDraft((current) => ({
                ...current,
                resourceScope: { ...current.resourceScope, allowOtherEnvironments },
              }))}
            />
          </label>
          <label className="agent-tool-dialog-setting">
            <span>
              <strong>Allow other projects</strong>
              <small>Access resources in other projects. When off, lists and searches stay in this project; direct requests outside it are denied.</small>
            </span>
            <Switch
              aria-label="Allow other projects"
              checked={draft.resourceScope.allowOtherProjects}
              disabled={!editable}
              onCheckedChange={(allowOtherProjects) => setDraft((current) => ({
                ...current,
                resourceScope: { ...current.resourceScope, allowOtherProjects },
              }))}
            />
          </label>
        </div>

        <div className="agent-tool-dialog-panes">
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

        </DialogBody>

        {(unavailableMessage || showStaleWarning || error || confirming) && (
          <div className="agent-tool-dialog-notices">
            {unavailableMessage && (
              <DialogAlert role="status">{unavailableMessage}</DialogAlert>
            )}
            {showStaleWarning && (
              <DialogAlert tone="warning" role="alert">
                Agent tool settings changed in another client. Save will not
                overwrite the newer settings.
              </DialogAlert>
            )}
            {error && <DialogAlert tone="danger">{error}</DialogAlert>}
            {confirming && (
              <DialogAlert
                id={nativeToolCacheWarningId}
                tone="warning"
                role="alert"
              >
                {NATIVE_TOOL_CACHE_WARNING}
              </DialogAlert>
            )}
          </div>
        )}

        <DialogFooter>
          {confirming ? (
            <>
              <Button variant="outline" onClick={() => setConfirming(false)}>
                Keep editing
              </Button>
              <Button
                ref={confirmButtonRef}
                aria-describedby={nativeToolCacheWarningId}
                disabled={!canSave}
                onClick={submit}
              >
                Save changes
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button disabled={!canSave} onClick={save}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function originalPolicyDescription(origin: NonNullable<AgentToolPolicy["origin"]>): string {
  const source = origin.source.charAt(0).toUpperCase() + origin.source.slice(1);
  if (origin.policySet) return `${origin.policySet.name} (revision ${origin.policySet.revision}) · from ${source}`;
  return origin.source === "default" ? "No policy selected (default)" : `Disabled · from ${source}`;
}
