import { type EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import { EnvironmentVariablesDialog } from "./environment-variables/EnvironmentVariablesDialog.js";
import { useEnvironmentVariablePreview } from "./environment-variables/use-environment-variable-preview.js";
import { variableRows } from "./environment-variables/environment-variable-presentation.js";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_THREAD_TITLE,
  type CreateThreadTemplateRequest,
  type DeleteThreadTemplateRequest,
  type ExecutionWorkspaceSelection,
  type NormalizedEnvironmentSummary,
  type NormalizedExecutionTargetDescriptor,
  type NormalizedWorkspaceSummary,
  type ResolveSavedAgentResult,
  type SavedAgentSummary,
  type ThreadTemplate,
  type UpdateThreadTemplateRequest,
} from "../../shared/index.js";
import { navigate, newAgentPath } from "../app/router.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { messageFrom } from "../stores/ApplicationClientStore.js";
import { useKeyboardInset } from "../app/use-keyboard-inset.js";
import { usePickerFocus } from "../lib/use-picker-focus.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { useMediaQuery } from "../app/use-media-query.js";
import {
  environmentDisplayLabel,
  targetDisplayLabel,
  workspaceDisplayLabel,
} from "../app/sidebar-scope-presentation.js";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import { ChevronDown, Folder, Plus, Search, SlidersHorizontal } from "lucide-react";
import { SearchableSelect } from "./ui/searchable-select.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@client/components/ui/dialog";
import {
  EnvironmentScopeIcon,
  TargetScopeIcon,
} from "./scope-selector-icons.js";

import { AddProjectDialog } from "./AddProjectDialog.js";

const MOBILE_NEW_THREAD_MEDIA_QUERY = "(pointer: coarse), (max-width: 819px)";
const AGENT_PAGE_SIZE = 50;
const TEMPLATE_PAGE_SIZE = 100;

type CreationSelection =
  | { readonly kind: "unselected" }
  | { readonly kind: "custom" }
  | { readonly kind: "saved_agent"; readonly agentId: string };

type TemplateEditorMode = "create" | "update";

function sortTemplates(
  templates: readonly ThreadTemplate[],
): readonly ThreadTemplate[] {
  return [...templates].sort(
    (left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: "base" }) ||
      left.id.localeCompare(right.id),
  );
}

function executionWorkspacesMatch(
  left: ExecutionWorkspaceSelection | undefined,
  right: ExecutionWorkspaceSelection | undefined,
): boolean {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === "direct" || right.kind === "direct") return true;
  return (
    left.workspaceAccess === right.workspaceAccess &&
    left.networkProfile === right.networkProfile
  );
}

export interface NewThreadCreationScope {
  readonly environmentId: string | null;
  readonly targetId: string | null;
  readonly projectName: string | null;
}

export function NewThreadControl({
  store,
  workspaces,
  environments,
  executionTargets,
  creationScope,
  className,
  children,
  onCreated,
}: {
  readonly store: ApplicationClientStore;
  readonly environments: readonly NormalizedEnvironmentSummary[];
  readonly workspaces: readonly NormalizedWorkspaceSummary[];
  /** Complete inventory, including targets that cannot currently create. */
  readonly executionTargets: readonly NormalizedExecutionTargetDescriptor[];
  /** Viewer-local inventory scope. Project names and exact environment/target ids constrain creation, not authority. */
  readonly creationScope: NewThreadCreationScope;
  readonly className?: string;
  readonly children: React.ReactNode;
  readonly onCreated: (threadId: string) => void;
}): React.JSX.Element {
  const pickerId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const surfaceHeadingRef = useRef<HTMLHeadingElement>(null);
  const agentInputRef = useRef<HTMLInputElement>(null);
  const agentTriggerRef = useRef<HTMLButtonElement>(null);
  const agentFocus = usePickerFocus(agentInputRef);
  const restoreTriggerFocus = useRef(false);
  const restoreOnDismiss = useRef(true);
  const agentRequest = useRef<AbortController | undefined>(undefined);
  const resolutionRequest = useRef<AbortController | undefined>(undefined);
  const templateRequest = useRef<AbortController | undefined>(undefined);
  const templateSelectionGeneration = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [pendingProject, setPendingProject] = useState<{ id: string; environmentId: string }>();
  const [projectScopeReleased, setProjectScopeReleased] = useState(false);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<string>();
  const [requiresWorkspaceReselection, setRequiresWorkspaceReselection] =
    useState(false);
  const [requiresTargetReselection, setRequiresTargetReselection] =
    useState(false);
  const [selection, setSelection] = useState<CreationSelection>({
    kind: "unselected",
  });
  const [selectedAgentSummary, setSelectedAgentSummary] =
    useState<Pick<SavedAgentSummary, "id" | "name" | "backend">>();
  const [selectedTargetId, setSelectedTargetId] = useState<string>();
  const [executionWorkspace, setExecutionWorkspace] =
    useState<ExecutionWorkspaceSelection>();
  const [title, setTitle] = useState(DEFAULT_THREAD_TITLE);
  const [agents, setAgents] = useState<readonly SavedAgentSummary[]>([]);
  const [agentSearch, setAgentSearch] = useState("");
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [activeAgentIndex, setActiveAgentIndex] = useState(0);
  const [nextAgentCursor, setNextAgentCursor] = useState<string>();
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [agentsLoaded, setAgentsLoaded] = useState(false);
  const [agentLoadError, setAgentLoadError] = useState("");
  const [resolution, setResolution] = useState<ResolveSavedAgentResult>();
  const [resolutionLoading, setResolutionLoading] = useState(false);
  const [environmentVariables, setEnvironmentVariables] = useState<EnvironmentVariableOverrides>({});
  const [variablesOpen, setVariablesOpen] = useState(false);
  const [variablesRefresh, setVariablesRefresh] = useState(0);
  const variablesTrigger = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [templates, setTemplates] = useState<readonly ThreadTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesLoaded, setTemplatesLoaded] = useState(false);
  const [templateLoadError, setTemplateLoadError] = useState("");
  const [selectedTemplate, setSelectedTemplate] = useState<ThreadTemplate>();
  const [templateAgentMissing, setTemplateAgentMissing] = useState(false);
  const [templateEditorMode, setTemplateEditorMode] =
    useState<TemplateEditorMode>();
  const [templateName, setTemplateName] = useState("");
  const [templatePending, setTemplatePending] = useState(false);
  const [deleteTemplateConfirm, setDeleteTemplateConfirm] = useState(false);
  const mobileShell = useMediaQuery(MOBILE_NEW_THREAD_MEDIA_QUERY);
  const keyboardInset = useKeyboardInset(mobileShell && pickerOpen);
  // Sidebar scope is an initial manual-selection preference. A template owns
  // its complete scope and must remain selectable from any sidebar filter.
  const selectionScope = selectedTemplate
    ? { environmentId: null, targetId: null, projectName: null }
    : {
        ...creationScope,
        projectName: projectScopeReleased ? null : creationScope.projectName,
      };
  const scopedTarget = executionTargets.find(
    ({ id }) => id === selectionScope.targetId,
  );
  const scopedEnvironmentId =
    selectionScope.environmentId ?? scopedTarget?.environmentId;
  const scopeConflict = Boolean(
    selectionScope.environmentId &&
      scopedTarget &&
      scopedTarget.environmentId !== selectionScope.environmentId,
  );
  const creatableEnvironments = useMemo(
    () =>
      environments.filter(
        (environment) =>
          environment.available &&
          (!scopedEnvironmentId || environment.id === scopedEnvironmentId) &&
          (selectionScope.projectName === null ||
            workspaces.some(
              (workspace) =>
                workspace.available &&
                workspace.environmentId === environment.id &&
                workspace.label.text === selectionScope.projectName,
            )) &&
          executionTargets.some(
            (target) =>
              target.available &&
              target.environmentId === environment.id &&
              (!selectionScope.targetId ||
                target.id === selectionScope.targetId),
          ),
      ),
    [
      selectionScope.targetId,
      selectionScope.projectName,
      environments,
      executionTargets,
      scopedEnvironmentId,
      workspaces,
    ],
  );
  const explicitlySelectedEnvironment = creatableEnvironments.find(
    ({ id }) => id === selectedEnvironmentId,
  );
  const selectedEnvironment =
    explicitlySelectedEnvironment ??
    (selectedEnvironmentId === undefined && creatableEnvironments.length === 1
      ? creatableEnvironments[0]
      : undefined);
  const effectiveEnvironmentId = scopedEnvironmentId ?? selectedEnvironment?.id;
  const workspaceOptions = useMemo(
    () =>
      effectiveEnvironmentId
        ? workspaces.filter(
            (option) =>
              (selectionScope.projectName === null ||
                option.label.text === selectionScope.projectName) &&
              option.environmentId === effectiveEnvironmentId,
          )
        : [],
    [selectionScope.projectName, effectiveEnvironmentId, workspaces],
  );
  const creatableWorkspaces = useMemo(
    () => workspaceOptions.filter((option) => option.available),
    [workspaceOptions],
  );
  const explicitlySelectedWorkspace = creatableWorkspaces.find(
    ({ id }) => id === selectedWorkspaceId,
  );
  const explicitWorkspaceBecameIneligible =
    selectedWorkspaceId !== undefined && !explicitlySelectedWorkspace;
  const selectedWorkspace =
    explicitlySelectedWorkspace ??
    (!requiresWorkspaceReselection && !explicitWorkspaceBecameIneligible
      ? creatableWorkspaces.length === 1
        ? creatableWorkspaces[0]
        : undefined
      : undefined);
  const eligibleTargets = useMemo(
    () =>
      effectiveEnvironmentId
        ? executionTargets.filter(
            ({ id, environmentId, available }) =>
              available &&
              environmentId === effectiveEnvironmentId &&
              (!selectionScope.targetId || id === selectionScope.targetId),
          )
        : [],
    [selectionScope.targetId, effectiveEnvironmentId, executionTargets],
  );
  const explicitlySelectedTarget = eligibleTargets.find(
    ({ id }) => id === selectedTargetId,
  );
  const selectedTarget =
    explicitlySelectedTarget ??
    (!requiresTargetReselection &&
    selectedTargetId === undefined &&
    eligibleTargets.length === 1
      ? eligibleTargets[0]
      : undefined);
  const selectedExecutionWorkspace: ExecutionWorkspaceSelection | undefined =
    executionWorkspace ??
    (selectedTarget?.workspaceExecution.kind === "selectable"
      ? selectedTarget.workspaceExecution.default
      : selectedTarget
        ? { kind: "direct" }
        : undefined);
  const isolatedNetworkProfiles =
    selectedTarget?.workspaceExecution.kind === "selectable"
      ? selectedTarget.workspaceExecution.isolatedNetworkProfiles
      : [];
  const needsTargetPicker =
    selectionScope.targetId === null && effectiveEnvironmentId !== undefined;
  const needsWorkspacePicker =
    (selectionScope.projectName === null ||
      workspaceOptions.length > 1 ||
      requiresWorkspaceReselection) &&
    effectiveEnvironmentId !== undefined;
  const needsEnvironmentPicker =
    !scopedEnvironmentId &&
    (creatableEnvironments.length > 1 ||
      (selectedEnvironmentId !== undefined && !explicitlySelectedEnvironment));
  const resolvedTargets = resolution?.candidates ?? [];
  const selectedResolvedTarget = resolvedTargets.find(
    ({ target }) => target.id === selectedTarget?.id,
  );
  const manualCanOpen =
    creatableEnvironments.length > 0 &&
    !scopeConflict &&
    (!selectionScope.targetId || Boolean(scopedTarget?.available));
  const canOpen =
    manualCanOpen || templates.length > 0 || Boolean(templateLoadError);
  // A template's Agent is only a captured reference until the catalog lookup
  // confirms it still exists. Do not preview a missing or unresolved Agent.
  const previewAgentAvailable = !templateAgentMissing && (selection.kind !== "saved_agent" || selectedAgentSummary?.id === selection.agentId);
  const variablesPreview = useEnvironmentVariablePreview(store.api,
    pickerOpen && selectedTarget?.available && previewAgentAvailable ? selectedTarget.id : undefined,
    selection.kind === "saved_agent" ? selection.agentId : undefined, variablesRefresh);
  const variablesSnapshot = variablesPreview.result ? { ...variablesPreview.result.snapshot, layers: { ...variablesPreview.result.snapshot.layers, thread: environmentVariables } } : undefined;
  const effectiveVariableCount = variablesSnapshot ? variableRows(Object.entries(variablesSnapshot.layers).map(([scope, values]) => ({ scope: scope as "environment" | "backend" | "agent" | "thread", values }))).filter(row => row.entry.kind !== "unset").length : 0;
  const canCreate = Boolean(
    variablesPreview.result &&
    !pendingProject &&
    !scopeConflict &&
    selectedEnvironment?.available &&
    selectedWorkspace?.available &&
    selectedTarget?.available &&
    selectedExecutionWorkspace &&
    (selection.kind === "custom"
      ? selectedTarget
      : selection.kind === "saved_agent" &&
        !resolutionLoading &&
        selectedResolvedTarget),
  );
  const templateDraftMatches = Boolean(
    selectedTemplate &&
    selectedWorkspace?.id === selectedTemplate.workspaceId &&
    selectedTarget?.id === selectedTemplate.targetId &&
    selection.kind === "saved_agent" &&
    selection.agentId === selectedTemplate.agentId &&
    JSON.stringify(environmentVariables) === JSON.stringify(selectedTemplate.environmentVariables ?? {}) &&
    executionWorkspacesMatch(
      selectedExecutionWorkspace,
      selectedTemplate.executionWorkspace,
    ),
  );
  const templateDirty = Boolean(selectedTemplate && !templateDraftMatches);
  const templateNeedsAttention = Boolean(
    selectedTemplate &&
    (templateAgentMissing ||
      !selectedWorkspace?.available ||
      !selectedTarget?.available ||
      (selection.kind === "saved_agent" &&
        !resolutionLoading &&
        resolution !== undefined &&
        !selectedResolvedTarget)),
  );
  const canSaveTemplate = Boolean(
    selectedWorkspace?.available &&
    selectedTarget?.available &&
    selectedExecutionWorkspace &&
    selection.kind === "saved_agent" &&
    !resolutionLoading &&
    selectedResolvedTarget,
  );
  const unavailableScopeMessage = (() => {
    if (scopeConflict) {
      return "The selected Environment, Target, and Project do not belong to the same execution scope.";
    }
    const requestedEnvironment = environments.find(
      ({ id }) => id === selectionScope.environmentId,
    );
    if (selectionScope.environmentId && !requestedEnvironment) {
      return "The selected Environment is no longer configured.";
    }
    if (requestedEnvironment && !requestedEnvironment.available) {
      return (
        requestedEnvironment.diagnostic?.text ??
        `${environmentDisplayLabel(requestedEnvironment, environments)} is unavailable.`
      );
    }
    if (selectionScope.targetId && !scopedTarget) {
      return "The selected Target is no longer configured.";
    }
    if (scopedTarget && !scopedTarget.available) {
      return (
        scopedTarget.unavailableReason?.text ??
        `${targetDisplayLabel({
          target: scopedTarget,
          targets: executionTargets,
          environments,
          includeEnvironment: environments.length > 1,
        })} is unavailable.`
      );
    }
    if (
      selectionScope.projectName !== null &&
      !workspaces.some(
        (workspace) => workspace.label.text === selectionScope.projectName,
      )
    ) {
      return "The selected Project is no longer remembered.";
    }
    return "No available Project and Target share this execution scope.";
  })();
  const agentChoices = useMemo(
    () => ["custom", ...agents.map(({ id }) => id)],
    [agents],
  );

  // Keep the active descendant valid as asynchronous search results change.
  const activeAgentChoiceIndex = Math.min(activeAgentIndex, agentChoices.length - 1);
  const activeAgentChoice = agentChoices[activeAgentChoiceIndex];
  const activeAgentOptionRef = useCallback((node: HTMLButtonElement | null) => {
    node?.scrollIntoView({ block: "nearest" });
  }, []);

  const resetPanel = () => {
    setVariablesOpen(false);
    setEnvironmentVariables({});
    templateSelectionGeneration.current += 1;
    agentRequest.current?.abort();
    resolutionRequest.current?.abort();
    setSelectedWorkspaceId(undefined);
    setSelectedEnvironmentId(undefined);
    setAddProjectOpen(false);
    setPendingProject(undefined);
    setProjectScopeReleased(false);
    setRequiresWorkspaceReselection(false);
    setRequiresTargetReselection(false);
    setSelection({ kind: "unselected" });
    setSelectedAgentSummary(undefined);
    setSelectedTargetId(undefined);
    setExecutionWorkspace(undefined);
    setTitle(DEFAULT_THREAD_TITLE);
    setAgentSearch("");
    setAgentPickerOpen(false);
    setAgents([]);
    setNextAgentCursor(undefined);
    setAgentsLoaded(false);
    setAgentLoadError("");
    setResolution(undefined);
    setResolutionLoading(false);
    setSelectedTemplate(undefined);
    setTemplateAgentMissing(false);
    setTemplateEditorMode(undefined);
    setTemplateName("");
    setTemplatePending(false);
    setDeleteTemplateConfirm(false);
    setError("");
  };

  useEffect(() => {
    if (!pendingProject || !workspaces.some(({ id }) => id === pendingProject.id)) return;
    setProjectScopeReleased(true);
    setSelectedWorkspaceId(pendingProject.id);
    setSelectedEnvironmentId(pendingProject.environmentId);
    setRequiresWorkspaceReselection(false);
    setPendingProject(undefined);
  }, [pendingProject, workspaces]);

  // Templates belong to the API's principal, not the currently selected
  // project. Once started, keep the catalog read across scope/picker changes.
  useEffect(() => () => {
    templateRequest.current?.abort();
    templateRequest.current = undefined;
  }, [store.api]);

  useEffect(() => {
    if (templatesLoaded || templateRequest.current || (!pickerOpen && manualCanOpen)) return;
    const controller = new AbortController();
    templateRequest.current = controller;
    setTemplatesLoading(true);
    setTemplateLoadError("");
    void (async () => {
      const items: ThreadTemplate[] = [];
      let cursor: string | undefined;
      do {
        const page = await store.api.listThreadTemplates({
          ...(cursor ? { cursor } : {}),
          pageSize: TEMPLATE_PAGE_SIZE,
          signal: controller.signal,
        });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor && !controller.signal.aborted);
      if (controller.signal.aborted) return;
      setTemplates(sortTemplates(items));
      setTemplatesLoaded(true);
    })()
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setTemplateLoadError(messageFrom(cause));
        setTemplatesLoaded(false);
      })
      .finally(() => {
        if (templateRequest.current === controller) {
          templateRequest.current = undefined;
          setTemplatesLoading(false);
        }
      });
  }, [manualCanOpen, pickerOpen, store.api, templatesLoaded]);

  useEffect(() => {
    if (selectedTemplate) return;
    setPickerOpen(false);
    resetPanel();
    restoreTriggerFocus.current = false;
  }, [
    creationScope.environmentId,
    creationScope.targetId,
    creationScope.projectName,
  ]);

  useEffect(() => {
    if (canOpen) return;
    setPickerOpen(false);
    resetPanel();
    restoreTriggerFocus.current = false;
  }, [canOpen]);

  // Once a draft is open, retain even inferred destinations by identity so
  // inventory changes cannot silently move it to another machine or directory.
  useEffect(() => {
    if (!pickerOpen) return;
    if (selectedEnvironmentId === undefined && selectedEnvironment)
      setSelectedEnvironmentId(selectedEnvironment.id);
    if (selectedWorkspaceId === undefined && selectedWorkspace)
      setSelectedWorkspaceId(selectedWorkspace.id);
    if (selectedTargetId === undefined && selectedTarget)
      setSelectedTargetId(selectedTarget.id);
  }, [
    pickerOpen,
    selectedEnvironmentId,
    selectedEnvironment,
    selectedWorkspaceId,
    selectedWorkspace,
    selectedTargetId,
    selectedTarget,
  ]);

  useEffect(() => {
    if (
      selectedWorkspaceId === undefined ||
      creatableWorkspaces.some(({ id }) => id === selectedWorkspaceId)
    ) {
      return;
    }
    setSelectedWorkspaceId(undefined);
    setRequiresWorkspaceReselection(true);
    setSelection({ kind: "unselected" });
    setSelectedAgentSummary(undefined);
    setResolution(undefined);
  }, [creatableWorkspaces, selectedWorkspaceId]);

  useEffect(() => {
    if (pickerOpen) return;
    if (!restoreTriggerFocus.current) return;
    restoreTriggerFocus.current = false;
    triggerRef.current?.focus();
  }, [mobileShell, pickerOpen]);

  const loadAgents = async (options?: {
    readonly append?: boolean;
    readonly cursor?: string;
    readonly search?: string;
    readonly targetId?: string;
  }) => {
    agentRequest.current?.abort();
    const controller = new AbortController();
    agentRequest.current = controller;
    setAgentsLoading(true);
    setAgentLoadError("");
    if (!options?.append) {
      setAgents([]);
      setAgentsLoaded(false);
    }
    try {
      const page = await store.api.listSavedAgents({
        ...(options?.targetId ? { targetId: options.targetId } : {}),
        ...(options?.search?.trim()
          ? { nameSearch: options.search.trim() }
          : {}),
        ...(options?.cursor ? { cursor: options.cursor } : {}),
        pageSize: AGENT_PAGE_SIZE,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      setAgents((current) =>
        options?.append ? [...current, ...page.items] : page.items,
      );
      setNextAgentCursor(page.nextCursor);
      setAgentsLoaded(true);
    } catch (cause) {
      if (controller.signal.aborted) return;
      setAgentLoadError(messageFrom(cause));
      setAgentsLoaded(true);
    } finally {
      if (agentRequest.current === controller) setAgentsLoading(false);
    }
  };

  useEffect(() => {
    if (!pickerOpen || !selectedTarget) {
      agentRequest.current?.abort();
      setAgents([]);
      setNextAgentCursor(undefined);
      setAgentsLoaded(false);
      setAgentLoadError("");
      return;
    }
    const timeout = window.setTimeout(
      () => {
        void loadAgents({
          search: agentSearch,
          targetId: selectedTarget.id,
        });
      },
      agentSearch ? 180 : 0,
    );
    return () => window.clearTimeout(timeout);
  }, [agentSearch, pickerOpen, selectedTarget?.id]);

  const resolveAgent = async (agentId: string, workspaceId: string) => {
    resolutionRequest.current?.abort();
    const controller = new AbortController();
    resolutionRequest.current = controller;
    setResolutionLoading(true);
    setResolution(undefined);
    setError("");
    try {
      const result = await store.api.resolveSavedAgent(
        agentId,
        {
          workspaceId,
          ...(selectedTarget ? { targetId: selectedTarget.id } : {}),
        },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      const constrainedResult = selectedTarget
        ? {
            ...result,
            candidates: result.candidates.filter(
              ({ target }) => target.id === selectedTarget.id,
            ),
          }
        : result;
      setResolution(constrainedResult);
      if (constrainedResult.candidates.length === 1) {
        setSelectedTargetId(constrainedResult.candidates[0]!.target.id);
        setRequiresTargetReselection(false);
        setExecutionWorkspace(undefined);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(messageFrom(cause));
    } finally {
      if (resolutionRequest.current === controller) {
        setResolutionLoading(false);
      }
    }
  };

  useEffect(() => {
    if (
      selection.kind !== "saved_agent" ||
      selectedAgentSummary?.id !== selection.agentId ||
      !selectedWorkspace?.available ||
      !selectedTarget?.available
    ) {
      setResolution(undefined);
      return;
    }
    void resolveAgent(selection.agentId, selectedWorkspace.id);
  }, [
    selection,
    selectedAgentSummary?.id,
    selectedWorkspace?.id,
    selectedWorkspace?.available,
    selectedTarget?.id,
    selectedTarget?.available,
  ]);

  const closePicker = (restoreFocus: boolean) => {
    restoreTriggerFocus.current = restoreFocus;
    setPickerOpen(false);
    resetPanel();
  };

  const chooseAgent = (choice: string) => {
    templateSelectionGeneration.current += 1;
    setAgentPickerOpen(false);
    setAgentSearch("");
    setActiveAgentIndex(0);
    setResolution(undefined);
    setError("");
    setTemplateAgentMissing(false);
    setSelectedAgentSummary(
      choice === "custom" ? undefined : agents.find(({ id }) => id === choice),
    );
    setSelection(
      choice === "custom"
        ? { kind: "custom" }
        : { kind: "saved_agent", agentId: choice },
    );
  };

  const applyManualDefaults = () => {
    templateSelectionGeneration.current += 1;
    const target = executionTargets.find(
      ({ id }) => id === creationScope.targetId,
    );
    setSelectedTemplate(undefined);
    setEnvironmentVariables({});
    setSelectedEnvironmentId(creationScope.environmentId ?? target?.environmentId);
    setSelectedWorkspaceId(undefined);
    setSelectedTargetId(target?.available ? target.id : undefined);
    setExecutionWorkspace(undefined);
    setRequiresWorkspaceReselection(false);
    setRequiresTargetReselection(false);
    setSelection({ kind: "unselected" });
    setSelectedAgentSummary(undefined);
    setResolution(undefined);
    setTemplateAgentMissing(false);
    setTemplateEditorMode(undefined);
    setTemplateName("");
    setDeleteTemplateConfirm(false);
    setError("");
  };

  const applyTemplate = (template: ThreadTemplate) => {
    const generation = ++templateSelectionGeneration.current;
    const target = executionTargets.find(({ id }) => id === template.targetId);
    const workspace = workspaces.find(({ id }) => id === template.workspaceId);
    setSelectedTemplate(template);
    setEnvironmentVariables(template.environmentVariables ?? {});
    setSelectedEnvironmentId(target?.environmentId ?? workspace?.environmentId);
    setSelectedWorkspaceId(workspace?.available ? workspace.id : undefined);
    setSelectedTargetId(target?.available ? target.id : undefined);
    setExecutionWorkspace(template.executionWorkspace);
    setRequiresWorkspaceReselection(!workspace?.available);
    setRequiresTargetReselection(!target?.available);
    setSelection({ kind: "saved_agent", agentId: template.agentId });
    setSelectedAgentSummary(undefined);
    setResolution(undefined);
    setTemplateAgentMissing(false);
    setTemplateEditorMode(undefined);
    setTemplateName("");
    setDeleteTemplateConfirm(false);
    setError("");
    void (async () => {
      let cursor: string | undefined;
      do {
        const page = await store.api.listSavedAgents({ cursor, pageSize: 100 });
        if (generation !== templateSelectionGeneration.current) return;
        const agent = page.items.find(({ id }) => id === template.agentId);
        if (agent) {
          setSelectedAgentSummary({
            id: agent.id,
            name: agent.name,
            backend: agent.backend,
          });
          return;
        }
        cursor = page.nextCursor;
      } while (cursor);

      if (generation !== templateSelectionGeneration.current) return;
      setSelection({ kind: "unselected" });
      setSelectedAgentSummary(undefined);
      setResolution(undefined);
      setTemplateAgentMissing(true);
    })().catch((cause) => {
      if (generation !== templateSelectionGeneration.current) return;
      setSelection({ kind: "unselected" });
      setSelectedAgentSummary(undefined);
      setResolution(undefined);
      setTemplateAgentMissing(true);
      setError(messageFrom(cause));
    });
  };

  const beginTemplateEditor = (mode: TemplateEditorMode) => {
    setTemplateEditorMode(mode);
    setTemplateName(mode === "update" ? (selectedTemplate?.name ?? "") : "");
    setDeleteTemplateConfirm(false);
    setError("");
  };

  const saveTemplate = async () => {
    if (
      !canSaveTemplate ||
      selection.kind !== "saved_agent" ||
      !selectedWorkspace ||
      !selectedTarget ||
      !selectedExecutionWorkspace ||
      !templateEditorMode ||
      templatePending
    ) {
      return;
    }
    const normalizedName = templateName.trim();
    if (!normalizedName) {
      setError("Enter a template name.");
      return;
    }
    setTemplatePending(true);
    setError("");
    try {
      let saved: ThreadTemplate;
      if (templateEditorMode === "update" && selectedTemplate) {
        const request: UpdateThreadTemplateRequest = {
          expectedRevision: selectedTemplate.revision,
          name: normalizedName,
          workspaceId: selectedWorkspace.id,
          targetId: selectedTarget.id,
          executionWorkspace: selectedExecutionWorkspace,
          agentId: selection.agentId,
          ...(Object.keys(environmentVariables).length > 0 || selectedTemplate?.environmentVariables ? { environmentVariables } : {}),
        };
        saved = await store.api.updateThreadTemplate(
          selectedTemplate.id,
          request,
        );
      } else {
        const request: CreateThreadTemplateRequest = {
          name: normalizedName,
          workspaceId: selectedWorkspace.id,
          targetId: selectedTarget.id,
          executionWorkspace: selectedExecutionWorkspace,
          agentId: selection.agentId,
          ...(Object.keys(environmentVariables).length > 0 || selectedTemplate?.environmentVariables ? { environmentVariables } : {}),
        };
        saved = await store.api.createThreadTemplate(request);
      }
      setTemplates((current) =>
        sortTemplates([...current.filter(({ id }) => id !== saved.id), saved]),
      );
      setSelectedTemplate(saved);
      setTemplateEditorMode(undefined);
      setTemplateName("");
      setDeleteTemplateConfirm(false);
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setTemplatePending(false);
    }
  };

  const deleteTemplate = async () => {
    if (!selectedTemplate || templatePending) return;
    setTemplatePending(true);
    setError("");
    try {
      const request: DeleteThreadTemplateRequest = {
        expectedRevision: selectedTemplate.revision,
      };
      await store.api.deleteThreadTemplate(selectedTemplate.id, request);
      setTemplates((current) =>
        current.filter(({ id }) => id !== selectedTemplate.id),
      );
      applyManualDefaults();
    } catch (cause) {
      setError(messageFrom(cause));
    } finally {
      setTemplatePending(false);
    }
  };

  const create = async () => {
    if (!selectedWorkspace?.available || !canCreate || pending) return;
    setError("");
    setPending(true);
    try {
      const normalized =
        title.replace(/[\r\n]+/g, " ").trim() || DEFAULT_THREAD_TITLE;
      const result = await store.createThread({
        workspaceId: selectedWorkspace.id,
        title: normalized,
        executionWorkspace: selectedExecutionWorkspace!,
        environmentVariables,
        environmentVariablesRevision: variablesPreview.result!.revision,
        configuration:
          selection.kind === "saved_agent"
            ? {
                kind: "saved_agent",
                agentId: selection.agentId,
                targetId: selectedResolvedTarget!.target.id,
              }
            : { kind: "custom", targetId: selectedTarget!.id },
      });
      setPickerOpen(false);
      resetPanel();
      onCreated(result.threadId);
    } catch (cause) {
      const creationError = messageFrom(cause);
      setError(creationError);
      if (selection.kind === "saved_agent") {
        const agentId = selection.agentId;
        void loadAgents({
          search: agentSearch,
          targetId: selectedTarget?.id,
        });
        try {
          await store.api.getSavedAgent(agentId);
          setVariablesRefresh(current => current + 1);
          await resolveAgent(agentId, selectedWorkspace.id);
          setError(creationError);
        } catch {
          setSelection({ kind: "unselected" });
          setSelectedAgentSummary(undefined);
          setResolution(undefined);
          setError(
            "That Agent is no longer available. Choose another Agent or use Custom.",
          );
          window.setTimeout(() => agentTriggerRef.current?.focus(), 0);
        }
      } else {
        setVariablesRefresh(current => current + 1);
      }
    } finally {
      setPending(false);
    }
  };

  const begin = () => {
    if (!canOpen || pending) return;
    setError("");
    if (!pickerOpen) {
      applyManualDefaults();
      setTitle(DEFAULT_THREAD_TITLE);
      setPickerOpen(true);
      return;
    }
    closePicker(true);
  };

  const resolutionMessage = (() => {
    if (selection.kind !== "saved_agent") return "";
    if (resolutionLoading) return "Checking where this Agent can run…";
    if (!resolution) return "";
    if (resolution.candidates.length === 0) {
      return (
        resolution.failures[0]?.reason.text ??
        "This Agent is not currently available in this project."
      );
    }
    if (resolution.candidates.length === 1) {
      const candidate = resolution.candidates[0]!;
      const toolPolicy = candidate.sedesTools.resolvedPolicy;
      const resolved = executionTargets.find(
        ({ id }) => id === candidate.target.id,
      );
      const toolPolicySummary = !toolPolicy.enabled
        ? "Off"
        : {
      thread: "Ask outside this thread",
      environment: "Ask outside this environment",
      unrestricted: "Allow without asking",
    }[toolPolicy.accessBoundary];
      return `Runs on ${
        resolved
          ? targetDisplayLabel({
              target: resolved,
              targets: executionTargets,
              environments,
              includeEnvironment: false,
            })
          : candidate.target.label.text
      }. Sedes tools: ${toolPolicySummary}.`;
    }
    return "Choose where this Agent should run.";
  })();

  return (
    <Dialog
      open={pickerOpen}
      modal={mobileShell}
      onOpenChange={(open) => {
        if (open) return;
        if (pending || templatePending || variablesOpen) return;
        const restoreFocus = restoreOnDismiss.current;
        restoreOnDismiss.current = true;
        closePicker(restoreFocus);
      }}
    >
      <div className="new-thread-control">
        <Button
          ref={triggerRef}
          data-testid="new-thread-trigger"
          className={className}
          type="button"
          disabled={!canOpen || pending}
          aria-expanded={pickerOpen}
          aria-controls={pickerOpen ? pickerId : undefined}
          onClick={begin}
        >
          {pending ? "Creating…" : children}
        </Button>
      </div>
      {pickerOpen && canOpen && (
        <DialogContent
          className="new-thread-target-picker"
          style={{ "--new-thread-keyboard-inset": `${keyboardInset}px` } as CSSProperties}
          overlayClassName="new-thread-sheet-overlay"
          id={pickerId}
          placement="side"
          showOverlay={mobileShell}
          aria-describedby={`${pickerId}-description`}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (mobileShell) {
              window.setTimeout(() => surfaceHeadingRef.current?.focus(), 0);
              return;
            }
            window.setTimeout(() => {
              titleInputRef.current?.focus();
              titleInputRef.current?.select();
            }, 0);
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (restoreTriggerFocus.current) triggerRef.current?.focus();
          }}
          onPointerDownOutside={(event) => {
            const target = event.target;
            if (
              pending || addProjectOpen || variablesOpen ||
              (target instanceof Node && triggerRef.current?.contains(target))
            ) {
              event.preventDefault();
              return;
            }
            restoreOnDismiss.current = false;
          }}
          onEscapeKeyDown={(event) => {
            if (pending || addProjectOpen || variablesOpen) {
              event.preventDefault();
              return;
            }
            if (agentPickerOpen) {
              event.preventDefault();
              setAgentPickerOpen(false);
              setAgentSearch("");
              return;
            }
            event.preventDefault();
            closePicker(true);
          }}
        >
          <header className="new-thread-surface-header">
            <DialogTitle ref={surfaceHeadingRef} tabIndex={-1}>
              New thread
            </DialogTitle>
            <DialogDescription id={`${pickerId}-description`}>
              Choose a template or configure a new thread.
            </DialogDescription>
          </header>
          <div className="new-thread-surface-body">
            <label htmlFor={`${pickerId}-template`}>Template</label>
            <SearchableSelect
              label="Template"
              searchLabel="Search templates"
              emptyLabel="No matching templates"
              value={selectedTemplate?.id ?? "manual"}
              disabled={pending || templatePending || templatesLoading}
              triggerProps={{ id: `${pickerId}-template` }}
              contentClassName="new-thread-searchable-content"
              options={[
                {
                  value: "manual",
                  label: "Configure manually",
                  icon: <SlidersHorizontal size={14} />,
                  pinned: true,
                },
                ...templates.map((template) => {
                  const target = executionTargets.find(
                    ({ id }) => id === template.targetId,
                  );
                  const environment = environments.find(
                    ({ id }) => id === target?.environmentId,
                  );
                  return {
                    value: template.id,
                    label: template.name,
                    description: [
                      ...(environment && environment.kind !== "local"
                        ? [environmentDisplayLabel(environment, environments)]
                        : []),
                      template.capturedWorkspaceName,
                      template.capturedAgentName,
                    ].join(" · "),
                    searchTerms: [
                      environment?.label.text ?? "",
                      target?.label.text ?? template.capturedTargetName,
                      target?.backend.label.text ?? "",
                    ],
                    icon: environment || target ? (
                      <>
                        {environment && <EnvironmentScopeIcon kind={environment.kind} />}
                        {target && <TargetScopeIcon brand={target.backend.brand} />}
                      </>
                    ) : undefined,
                  };
                }),
              ]}
              onValueChange={(value) => {
                if (value === "manual") {
                  applyManualDefaults();
                  return;
                }
                const template = templates.find(({ id }) => id === value);
                if (template) applyTemplate(template);
              }}
            />
            {(templateLoadError ||
              (!templatesLoading &&
                templatesLoaded &&
                templates.length === 0)) && (
              <small
                className={
                  templateLoadError
                    ? "new-thread-target-error"
                    : "new-thread-agent-status"
                }
                role={templateLoadError ? "alert" : undefined}
              >
                {templateLoadError || "No templates saved yet."}
              </small>
            )}
            <label htmlFor={`${pickerId}-title`}>Thread name</label>
            <Input
              ref={titleInputRef}
              id={`${pickerId}-title`}
              type="text"
              value={title}
              maxLength={240}
              disabled={pending}
              placeholder={DEFAULT_THREAD_TITLE}
              autoComplete="off"
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canCreate) {
                  event.preventDefault();
                  void create();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  closePicker(true);
                }
              }}
            />
            {needsEnvironmentPicker && (
              <>
                <label htmlFor={`${pickerId}-environment`}>Environment</label>
                <SearchableSelect
                  label="Environment"
                  searchLabel="Search environments"
                  emptyLabel="No matching environments"
                  value={selectedEnvironment?.id ?? ""}
                  placeholder="Choose an environment"
                  disabled={pending}
                  triggerProps={{
                    id: `${pickerId}-environment`,
                    "data-environment-id": selectedEnvironment?.id ?? "",
                  }}
                  contentClassName="new-thread-searchable-content"
                  options={creatableEnvironments.map((environment) => ({
                    value: environment.id,
                    label: environmentDisplayLabel(environment, environments),
                    icon: <EnvironmentScopeIcon kind={environment.kind} />,
                    searchTerms: [environment.kind],
                  }))}
                  onValueChange={(value) => {
                    setSelectedEnvironmentId(value);
                    setSelectedWorkspaceId(undefined);
                    setRequiresWorkspaceReselection(false);
                    setSelectedTargetId(undefined);
                    setRequiresTargetReselection(false);
                    setExecutionWorkspace(undefined);
                    setSelection({ kind: "unselected" });
                    setSelectedAgentSummary(undefined);
                    setResolution(undefined);
                    setAgents([]);
                    setNextAgentCursor(undefined);
                    setAgentsLoaded(false);
                    setError("");
                  }}
                />
              </>
            )}
            {needsTargetPicker && (
              <>
                <label htmlFor={`${pickerId}-target`}>Target</label>
                <SearchableSelect
                  label="Target"
                  searchLabel="Search targets"
                  emptyLabel="No matching targets"
                  value={selectedTarget?.id ?? ""}
                  placeholder="Choose where to run"
                  disabled={pending}
                  triggerProps={{
                    id: `${pickerId}-target`,
                    "data-target-id": selectedTarget?.id ?? "",
                  }}
                  contentClassName="new-thread-searchable-content"
                  options={eligibleTargets.map((target) => ({
                    value: target.id,
                    label: targetDisplayLabel({
                      target,
                      targets: eligibleTargets,
                      environments,
                      includeEnvironment: false,
                    }),
                    icon: <TargetScopeIcon brand={target.backend.brand} />,
                    searchTerms: [
                      target.backend.label.text,
                      selectedEnvironment?.label.text ?? "",
                    ],
                  }))}
                  onValueChange={(value) => {
                    setSelectedTargetId(value);
                    setRequiresTargetReselection(false);
                    setExecutionWorkspace(undefined);
                    setSelection({ kind: "unselected" });
                    setSelectedAgentSummary(undefined);
                    setResolution(undefined);
                    setAgents([]);
                    setNextAgentCursor(undefined);
                    setAgentsLoaded(false);
                    setError("");
                  }}
                />
              </>
            )}
            {needsWorkspacePicker && (
              <>
                <label htmlFor={`${pickerId}-workspace`}>Project</label>
                <SearchableSelect
                  label="Project"
                  searchLabel="Search projects"
                  emptyLabel="No matching projects"
                  value={selectedWorkspace?.id ?? ""}
                  placeholder="Choose a project"
                  disabled={pending}
                  triggerProps={{
                    id: `${pickerId}-workspace`,
                    "data-workspace-id": selectedWorkspace?.id ?? "",
                  }}
                  contentClassName="new-thread-searchable-content"
                  options={creatableWorkspaces.map((workspace) => ({
                    value: workspace.id,
                    label: workspaceDisplayLabel({
                      workspace,
                      workspaces: creatableWorkspaces,
                      environments,
                      includeEnvironment: false,
                    }),
                    icon: <Folder size={14} />,
                    searchTerms: [
                      workspace.displayPath.text,
                      selectedEnvironment?.label.text ?? "",
                    ],
                  }))}
                  onValueChange={(value) => {
                    setSelectedWorkspaceId(value);
                    setRequiresWorkspaceReselection(false);
                    setExecutionWorkspace(undefined);
                    setSelection({ kind: "unselected" });
                    setSelectedAgentSummary(undefined);
                    setResolution(undefined);
                    setError("");
                  }}
                />
              </>
            )}
            <Button type="button" size="sm" variant="outline" className="new-thread-add-project"
              disabled={pending || Boolean(pendingProject)} onClick={() => setAddProjectOpen(true)}>
              <Plus size={14} /> {pendingProject ? "Adding project…" : "Add project"}
            </Button>
            {addProjectOpen && <AddProjectDialog store={store} environments={environments}
              initialEnvironmentId={effectiveEnvironmentId}
              environmentLocked={effectiveEnvironmentId !== undefined}
              onClose={() => setAddProjectOpen(false)}
              onAdded={(id, environmentId) => setPendingProject({ id, environmentId })} />}
            {selectedTarget?.workspaceExecution.kind === "selectable" && (
              <>
                <label htmlFor={`${pickerId}-workspace-execution`}>
                  Workspace execution
                </label>
                <Select
                  value={
                    selectedExecutionWorkspace?.kind === "isolated"
                      ? selectedExecutionWorkspace.workspaceAccess
                      : (selectedExecutionWorkspace?.kind ?? "")
                  }
                  disabled={pending}
                  onValueChange={(value) => {
                    if (value === "direct") {
                      setExecutionWorkspace({ kind: "direct" });
                      return;
                    }
                    if (value === "writable_clone" || value === "read_only") {
                      setExecutionWorkspace({
                        kind: "isolated",
                        workspaceAccess: value,
                        networkProfile:
                          isolatedNetworkProfiles.find(
                            (profile) => profile === "isolated",
                          ) ?? isolatedNetworkProfiles[0]!,
                      });
                    }
                  }}
                >
                  <SelectTrigger
                    id={`${pickerId}-workspace-execution`}
                    className="w-full"
                    size="sm"
                  >
                    <SelectValue placeholder="Choose workspace execution" />
                  </SelectTrigger>
                  <SelectContent className="new-thread-select-content">
                    <SelectItem value="direct">Project directly</SelectItem>
                    <SelectItem value="writable_clone">
                      Writable isolated clone
                    </SelectItem>
                    <SelectItem value="read_only">
                      Read-only project with writable home
                    </SelectItem>
                  </SelectContent>
                </Select>
                {selectedExecutionWorkspace?.kind === "isolated" && (
                  <>
                    <label htmlFor={`${pickerId}-workspace-network`}>
                      Network
                    </label>
                    <Select
                      value={selectedExecutionWorkspace.networkProfile}
                      disabled={pending}
                      onValueChange={(value) => {
                        const profile = isolatedNetworkProfiles.find(
                          (candidate) => candidate === value,
                        );
                        if (profile) {
                          setExecutionWorkspace({
                            kind: "isolated",
                            workspaceAccess:
                              selectedExecutionWorkspace.workspaceAccess,
                            networkProfile: profile,
                          });
                        }
                      }}
                    >
                      <SelectTrigger
                        id={`${pickerId}-workspace-network`}
                        className="w-full"
                        size="sm"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="new-thread-select-content">
                        {isolatedNetworkProfiles.map((profile) => (
                          <SelectItem key={profile} value={profile}>
                            {profile === "isolated"
                              ? "Isolated"
                              : "Execution host"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </>
                )}
              </>
            )}
            <label htmlFor={`${pickerId}-agent`}>Agent</label>
            <Popover open={agentPickerOpen} onOpenChange={(open) => {
              setAgentPickerOpen(open);
              if (!open) setAgentSearch("");
            }}>
              <PopoverTrigger asChild>
                <Button
                  ref={agentTriggerRef}
                  id={`${pickerId}-agent`}
                  type="button"
                  variant="outline"
                  className="searchable-select-trigger"
                  role="combobox"
                  aria-label="Agent"
                  aria-haspopup="listbox"
                  aria-expanded={agentPickerOpen}
                  aria-controls={agentPickerOpen ? `${pickerId}-agent-options` : undefined}
                  disabled={pending || !selectedWorkspace || !selectedTarget}
                  onPointerDown={agentFocus.onPointerDown}
                  onKeyDown={(event) => {
                    agentFocus.onKeyDown(event);
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      setActiveAgentIndex(event.key === "ArrowUp" ? agentChoices.length - 1 : 0);
                      setAgentPickerOpen(true);
                    }
                  }}
                >
                  <span className="searchable-select-value">
                    {selection.kind === "custom" ? "Custom" : selectedAgentSummary?.name ??
                      (templateAgentMissing && selectedTemplate ? `${selectedTemplate.capturedAgentName} (deleted)` :
                        !selectedTarget || !selectedWorkspace ? "Choose Target and Project first" :
                          agentsLoading ? "Loading Agents…" : "Choose an Agent")}
                  </span>
                  <ChevronDown size={14} aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="searchable-select-popover new-thread-searchable-content"
                align="start"
                sideOffset={6}
                collisionPadding={8}
                aria-label="Choose an agent"
                onOpenAutoFocus={agentFocus.onOpenAutoFocus}
                onEscapeKeyDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setAgentPickerOpen(false);
                  setAgentSearch("");
                }}
              >
                <div className="searchable-select-search">
                  <Search size={15} aria-hidden="true" />
                  <Input
                    ref={agentInputRef}
                    role="combobox"
                    aria-label="Search Agents"
                    placeholder="Search Agents"
                    aria-autocomplete="list"
                    aria-expanded="true"
                    aria-controls={`${pickerId}-agent-options`}
                    aria-activedescendant={`${pickerId}-agent-option-${activeAgentChoiceIndex}`}
                    value={agentSearch}
                    maxLength={160}
                    autoComplete="off"
                    disabled={pending}
                    onChange={(event) => {
                      setAgentSearch(event.target.value);
                      setAgentPickerOpen(true);
                      setActiveAgentIndex(0);
                      if (selection.kind !== "unselected") {
                        setSelection({ kind: "unselected" });
                        setSelectedAgentSummary(undefined);
                        setResolution(undefined);
                      }
                    }}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing) return;
                      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                        event.preventDefault();
                        setAgentPickerOpen(true);
                        setActiveAgentIndex((current) => {
                          const delta = event.key === "ArrowDown" ? 1 : -1;
                          return Math.max(
                            0,
                            Math.min(agentChoices.length - 1, Math.min(current, agentChoices.length - 1) + delta),
                          );
                        });
                      } else if (event.key === "Enter" && agentPickerOpen) {
                        event.preventDefault();
                        const choice = activeAgentChoice;
                        if (choice) chooseAgent(choice);
                      }
                    }}
                  />
                </div>
                <div className="new-thread-agent-options">
                  <div
                    id={`${pickerId}-agent-options`}
                    role="listbox"
                    aria-label="Agents"
                    className="new-thread-agent-list"
                  >
                    <button
                      id={`${pickerId}-agent-option-0`}
                      role="option"
                      aria-selected={selection.kind === "custom"}
                      data-active={activeAgentChoiceIndex === 0 || undefined}
                      ref={activeAgentChoiceIndex === 0 ? activeAgentOptionRef : undefined}
                      className="new-thread-agent-option"
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseAgent("custom")}
                    >
                      <span className="new-thread-agent-option-icon">
                        <SlidersHorizontal size={14} strokeWidth={1.8} />
                      </span>
                      <span className="new-thread-agent-option-copy">
                        <strong>Custom</strong>
                        <small>
                          Use the selected target's current defaults
                        </small>
                      </span>
                    </button>
                    {agents.map((agent, index) => (
                      <button
                        key={agent.id}
                        id={`${pickerId}-agent-option-${index + 1}`}
                        data-active={activeAgentChoiceIndex === index + 1 || undefined}
                        ref={activeAgentChoiceIndex === index + 1 ? activeAgentOptionRef : undefined}
                        role="option"
                        aria-selected={
                          selection.kind === "saved_agent" &&
                          selection.agentId === agent.id
                        }
                        className="new-thread-agent-option"
                        type="button"
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => chooseAgent(agent.id)}
                      >
                        <span className="new-thread-agent-option-icon">
                          <TargetScopeIcon brand={agent.backend.brand} />
                        </span>
                        <span className="new-thread-agent-option-copy">
                          <strong>{agent.name}</strong>
                          <small>
                            {agent.backend.label.text} · {agent.id.slice(0, 8)}
                          </small>
                        </span>
                      </button>
                    ))}
                  </div>
                  {agentsLoading && (
                    <span className="new-thread-agent-option-status">
                      Loading Agents…
                    </span>
                  )}
                  {!agentsLoading && agentsLoaded && agents.length === 0 && (
                    <span className="new-thread-agent-option-status">
                      No saved Agents found.
                    </span>
                  )}
                  {nextAgentCursor && !agentsLoading && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() =>
                        void loadAgents({
                          append: true,
                          cursor: nextAgentCursor,
                          search: agentSearch,
                          targetId: selectedTarget?.id,
                        })
                      }
                    >
                      Load more Agents
                    </Button>
                  )}
                </div>
              </PopoverContent>
            </Popover>
            {agentsLoaded && agents.length === 0 && !agentSearch && (
              <div className="new-thread-agent-empty">
                <span>No saved Agents yet.</span>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => chooseAgent("custom")}
                >
                  Use Custom
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => navigate(newAgentPath())}
                >
                  Create an Agent
                </Button>
              </div>
            )}
            {(agentLoadError ||
              (!templateNeedsAttention && resolutionMessage)) && (
              <small
                className={
                  resolution?.candidates.length === 0 || agentLoadError
                    ? "new-thread-target-error"
                    : "new-thread-agent-status"
                }
                role={
                  resolution?.candidates.length === 0 || agentLoadError
                    ? "alert"
                    : "status"
                }
                aria-live={
                  resolution?.candidates.length === 0 || agentLoadError
                    ? "assertive"
                    : "polite"
                }
              >
                {agentLoadError || resolutionMessage}
              </small>
            )}
            <section className="environment-variable-creation" aria-label="Thread environment variables">
              <h3>Environment variables</h3>
              <Button ref={variablesTrigger} type="button" variant="outline" disabled={!variablesSnapshot || pending} onClick={() => setVariablesOpen(true)}>
                <SlidersHorizontal size={16} />{variablesPreview.loading ? "Loading variables…" : `${effectiveVariableCount} effective variables · ${Object.keys(environmentVariables).length} thread changes`}
              </Button>
              <small>Environment → Backend → Agent → Thread. Review values before creating.</small>
              {variablesPreview.error && <><p role="alert" className="environment-variable-error">{variablesPreview.error}</p><Button type="button" size="sm" variant="outline" onClick={() => setVariablesRefresh(current => current + 1)}>Retry variable preview</Button></>}
            </section>
            <section
              className="new-thread-template-actions"
              aria-label="Template actions"
            >
              {selectedTemplate ? (
                <>
                  <div className="new-thread-template-status">
                    <strong>
                      {templateNeedsAttention
                        ? "Needs attention"
                        : templateDirty
                          ? `Modified from ${selectedTemplate.name}`
                          : `Using ${selectedTemplate.name}`}
                    </strong>
                    {templateNeedsAttention && (
                      <small>
                        Choose an available Project, Target, and saved Agent,
                        then update the template.
                      </small>
                    )}
                  </div>
                  {!templateEditorMode && (
                    <div className="new-thread-template-buttons">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={
                          templatePending ||
                          (!templateNeedsAttention &&
                            templateDirty &&
                            !canSaveTemplate)
                        }
                        onClick={() => beginTemplateEditor("update")}
                      >
                        {templateNeedsAttention || !templateDirty
                          ? "Edit template…"
                          : "Update template…"}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!canSaveTemplate || templatePending}
                        onClick={() => beginTemplateEditor("create")}
                      >
                        Save as new…
                      </Button>
                      {templateDirty && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={templatePending}
                          onClick={() => applyTemplate(selectedTemplate)}
                        >
                          Reset changes
                        </Button>
                      )}
                      {selection.kind === "custom" && (
                        <small>
                          Choose a saved Agent to save this setup as a template.
                        </small>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="new-thread-template-buttons">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!canSaveTemplate || templatePending}
                    onClick={() => beginTemplateEditor("create")}
                  >
                    Save as template…
                  </Button>
                  {selection.kind === "custom" && (
                    <small>
                      Choose a saved Agent to save this setup as a template.
                    </small>
                  )}
                </div>
              )}
              {templateEditorMode && (
                <div className="new-thread-template-editor">
                  {templateEditorMode === "update" &&
                    selectedTemplate &&
                    !deleteTemplateConfirm && (
                      <div
                        className="new-thread-template-update-confirm"
                        role="alert"
                      >
                        <strong>Replace {selectedTemplate.name}?</strong>
                        <span>
                          Saving will replace this template with the current
                          setup. Existing threads are unaffected.
                        </span>
                      </div>
                    )}
                  <label htmlFor={`${pickerId}-template-name`}>
                    Template name
                  </label>
                  <Input
                    id={`${pickerId}-template-name`}
                    value={templateName}
                    maxLength={160}
                    disabled={templatePending}
                    autoComplete="off"
                    placeholder="Name this template"
                    onChange={(event) => setTemplateName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        void saveTemplate();
                      }
                    }}
                  />
                  <div className="new-thread-template-buttons">
                    <Button
                      type="button"
                      size="sm"
                      disabled={
                        !canSaveTemplate ||
                        templatePending ||
                        !templateName.trim()
                      }
                      onClick={() => void saveTemplate()}
                    >
                      {templatePending
                        ? "Saving…"
                        : templateEditorMode === "update"
                          ? "Replace template"
                          : "Save template"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={templatePending}
                      onClick={() => {
                        setTemplateEditorMode(undefined);
                        setTemplateName("");
                        setDeleteTemplateConfirm(false);
                      }}
                    >
                      Back
                    </Button>
                    {templateEditorMode === "update" &&
                      selectedTemplate &&
                      !deleteTemplateConfirm && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={templatePending}
                          onClick={() => setDeleteTemplateConfirm(true)}
                        >
                          Delete template
                        </Button>
                      )}
                  </div>
                  {deleteTemplateConfirm && selectedTemplate && (
                    <div
                      className="new-thread-template-delete-confirm"
                      role="alert"
                    >
                      <span>
                        Delete {selectedTemplate.name}? Existing threads are
                        unaffected.
                      </span>
                      <div className="new-thread-template-buttons">
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          disabled={templatePending}
                          onClick={() => void deleteTemplate()}
                        >
                          {templatePending ? "Deleting…" : "Delete"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={templatePending}
                          onClick={() => setDeleteTemplateConfirm(false)}
                        >
                          Keep template
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
            {error && (
              <small className="new-thread-target-error" role="alert">
                {error}
              </small>
            )}
          </div>
          <footer className="new-thread-target-actions">
            <Button
              type="button"
              disabled={!canCreate || pending}
              onClick={() => void create()}
            >
              {pending ? "Creating…" : "Create thread"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || templatePending}
              onClick={() => closePicker(true)}
            >
              Cancel
            </Button>
          </footer>
        </DialogContent>
      )}
      {variablesOpen && variablesSnapshot && <EnvironmentVariablesDialog open onOpenChange={setVariablesOpen} snapshot={variablesSnapshot}
        description="Review values before creating this thread." context={<p className="environment-variable-help">{selectedEnvironment?.label.text} · {selectedTarget?.label.text} · {selectedAgentSummary?.name ?? "Custom"}</p>}
        startupReason={variablesPreview.result?.startup.reason} restoreFocus={() => variablesTrigger.current?.focus()}
        onApply={next => { setEnvironmentVariables(next); setVariablesOpen(false); }} />}
      {!canOpen && (
        <small className="new-thread-target-unavailable" role="alert">
          {unavailableScopeMessage}
        </small>
      )}
    </Dialog>
  );
}
