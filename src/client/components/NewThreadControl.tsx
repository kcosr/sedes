import { type EnvironmentVariableOverrides } from "../../shared/protocol/environment-variables.js";
import { EnvironmentVariablesDialog } from "./environment-variables/EnvironmentVariablesDialog.js";
import { useEnvironmentVariablePreview } from "./environment-variables/use-environment-variable-preview.js";
import { variableRows } from "./environment-variables/environment-variable-presentation.js";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  DEFAULT_THREAD_TITLE,
  type CreateThreadTemplateRequest,
  type DeleteThreadTemplateRequest,
  type ExecutionWorkspaceSelection,
  type NormalizedEnvironmentSummary,
  type NormalizedExecutionTargetDescriptor,
  type NormalizedProjectSummary,
  type NormalizedWorkspaceSummary,
  type ResolveSavedAgentResult,
  type SavedAgentSummary,
  type ThreadTemplate,
  type UpdateThreadTemplateRequest,
} from "../../shared/index.js";
import { navigate, settingsPath } from "../app/router.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { messageFrom } from "../stores/ApplicationClientStore.js";
import { usePickerFocus } from "../lib/use-picker-focus.js";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover.js";
import { useTouchDensity } from "../app/use-touch-density.js";
import {
  environmentDisplayLabel,
  targetDisplayLabel,
} from "../app/sidebar-scope-presentation.js";
import { describeProjectLocations } from "../app/project-locations.js";
import { Button } from "@client/components/ui/button";
import { Callout } from "@client/components/ui/callout";
import { Field } from "@client/components/ui/field";
import { menuDescriptionClass, menuEmptyClass, menuRowClass } from "@client/components/ui/floating";
import { Input } from "@client/components/ui/input";
import { cn } from "@client/lib/utils";
import { Check, ChevronDown, Folder, Plus, SlidersHorizontal } from "lucide-react";
import { SearchableSelect, SearchableSelectSearch } from "./ui/searchable-select.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@client/components/ui/select";
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
  EnvironmentScopeIcon,
  TargetScopeIcon,
} from "./scope-selector-icons.js";

import { AddProjectDialog } from "./AddProjectDialog.js";
import "./new-thread-control.css";

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
  readonly projectId: string | null;
}

interface LocationChoice {
  readonly workspace: NormalizedWorkspaceSummary;
  /** Why a thread cannot start here now; absent when it can. */
  readonly unavailable?: string;
}

/** A project as the picker offers it: its locations within the scope. */
interface ProjectChoice {
  readonly project: NormalizedProjectSummary;
  /** Locations on the scoped environment, or every location without one. */
  readonly locations: readonly LocationChoice[];
  /** The locations a thread can start in now. */
  readonly creatable: readonly NormalizedWorkspaceSummary[];
  /** Why none of them can; absent when one can. */
  readonly unavailable?: string;
}

const NO_LOCATIONS: readonly NormalizedWorkspaceSummary[] = [];

export function NewThreadControl({
  store,
  projects,
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
  /** Active projects, including empty ones. */
  readonly projects: readonly NormalizedProjectSummary[];
  /** Active locations. */
  readonly workspaces: readonly NormalizedWorkspaceSummary[];
  /** Complete inventory, including targets that cannot currently create. */
  readonly executionTargets: readonly NormalizedExecutionTargetDescriptor[];
  /** Viewer-local inventory scope. Exact project/environment/target ids constrain creation, not authority. */
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
  // The location Add project created, until the snapshot publishes it.
  const [pendingLocationId, setPendingLocationId] = useState<string>();
  const [projectScopeReleased, setProjectScopeReleased] = useState(false);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>();
  const [requiresWorkspaceReselection, setRequiresWorkspaceReselection] =
    useState(false);
  const [requiresTargetReselection, setRequiresTargetReselection] =
    useState(false);
  const [selection, setSelection] = useState<CreationSelection>({
    kind: "custom",
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
  const mobileShell = useTouchDensity();
  // Sidebar scope is an initial manual-selection preference. A template owns
  // its complete scope and must remain selectable from any sidebar filter.
  const selectionScope: NewThreadCreationScope = selectedTemplate
    ? { environmentId: null, targetId: null, projectId: null }
    : creationScope;
  const scopedTarget = executionTargets.find(
    ({ id }) => id === selectionScope.targetId,
  );
  const scopedEnvironmentId =
    selectionScope.environmentId ?? scopedTarget?.environmentId;
  const scopedEnvironment = environments.find(
    ({ id }) => id === scopedEnvironmentId,
  );
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
      environments,
      executionTargets,
      scopedEnvironmentId,
    ],
  );
  const projectLocations = useMemo(
    () => describeProjectLocations({ projects, workspaces, environments }),
    [environments, projects, workspaces],
  );
  // A location is compatible with the scope when it is on the scoped
  // environment (a scoped target's environment included). It can start a
  // thread when it, its environment and a Target there are available.
  const projectEntries = useMemo((): readonly ProjectChoice[] => {
    const creatableEnvironmentIds = new Set(
      creatableEnvironments.map(({ id }) => id),
    );
    const environmentById = new Map(
      environments.map((environment) => [environment.id, environment]),
    );
    const locationsByProject = new Map<string, LocationChoice[]>();
    for (const workspace of workspaces) {
      if (
        scopedEnvironmentId &&
        workspace.environmentId !== scopedEnvironmentId
      ) {
        continue;
      }
      const locations = locationsByProject.get(workspace.projectId) ?? [];
      locations.push({
        workspace,
        ...(!workspace.available ||
        !environmentById.get(workspace.environmentId)?.available
          ? { unavailable: "Unavailable" }
          : !creatableEnvironmentIds.has(workspace.environmentId)
            ? { unavailable: "No available target" }
            : {}),
      });
      locationsByProject.set(workspace.projectId, locations);
    }
    return projects.map((project) => {
      const locations = locationsByProject.get(project.id) ?? [];
      const creatable = locations
        .filter(({ unavailable }) => unavailable === undefined)
        .map(({ workspace }) => workspace);
      const unavailable =
        locations.length === 0
          ? "No locations"
          : locations.every(({ unavailable }) => unavailable === "Unavailable")
            ? "Unavailable"
            : "No available target";
      return {
        project,
        locations,
        creatable,
        ...(creatable.length === 0 ? { unavailable } : {}),
      };
    });
  }, [
    creatableEnvironments,
    environments,
    projects,
    scopedEnvironmentId,
    workspaces,
  ]);
  // An empty match (the scoped project has no location to start in here)
  // releases only the project facet; the environment and target still hold.
  const requestedProject = projectEntries.find(
    ({ project }) => project.id === selectionScope.projectId,
  );
  const scopedProjectUnmatched =
    selectionScope.projectId !== null &&
    (requestedProject?.creatable.length ?? 0) === 0;
  const scopedProjectId =
    projectScopeReleased || scopedProjectUnmatched
      ? null
      : selectionScope.projectId;
  const projectChoices = useMemo(
    () =>
      scopedProjectId !== null
        ? projectEntries.filter(({ project }) => project.id === scopedProjectId)
        : // With an environment, only projects that have a location there.
          projectEntries.filter(
            ({ locations }) => locations.length > 0 || !scopedEnvironmentId,
          ),
    [projectEntries, scopedEnvironmentId, scopedProjectId],
  );
  const creatableProjects = projectChoices.filter(
    ({ creatable }) => creatable.length > 0,
  );
  const selectedProject =
    selectedProjectId === undefined
      ? creatableProjects.length === 1
        ? creatableProjects[0]
        : undefined
      : creatableProjects.find(
          ({ project }) => project.id === selectedProjectId,
        );
  const locationOptions = selectedProject?.locations ?? [];
  const creatableWorkspaces = selectedProject?.creatable ?? NO_LOCATIONS;
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
  // Targets follow the location's environment. Before one is chosen, an
  // environment every remaining choice shares lets the Target come first.
  const locationEnvironmentIds = new Set(
    creatableWorkspaces.map(({ environmentId }) => environmentId),
  );
  const effectiveEnvironmentId =
    selectedWorkspace?.environmentId ??
    scopedEnvironmentId ??
    (selectedProject
      ? locationEnvironmentIds.size === 1
        ? [...locationEnvironmentIds][0]
        : undefined
      : creatableEnvironments.length === 1
        ? creatableEnvironments[0]!.id
        : undefined);
  const effectiveEnvironment = environments.find(
    ({ id }) => id === effectiveEnvironmentId,
  );
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
  // A project the scope fixes needs no picker, nor does its one location.
  const needsProjectPicker = scopedProjectId === null;
  const needsLocationPicker =
    selectedProject !== undefined &&
    (needsProjectPicker ||
      locationOptions.length > 1 ||
      requiresWorkspaceReselection ||
      explicitWorkspaceBecameIneligible);
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
    !pendingLocationId &&
    !scopeConflict &&
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
      return "The selected Environment and Target do not belong to the same execution scope.";
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
    return "No Target is available in this execution scope.";
  })();
  // Why the scoped project gave way, when the sidebar names one.
  const scopedProjectNote = (() => {
    if (!scopedProjectUnmatched || projectScopeReleased || !requestedProject) {
      return undefined;
    }
    const project = projectLocations.projectLabel(requestedProject.project.id);
    const where = scopedEnvironment
      ? ` on ${environmentDisplayLabel(scopedEnvironment, environments)}`
      : "";
    return requestedProject.locations.length === 0
      ? `${project} has no location${where || "s"}.`
      : `${project} has no available location${where}.`;
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
    setSelectedProjectId(undefined);
    setSelectedWorkspaceId(undefined);
    setAddProjectOpen(false);
    setPendingLocationId(undefined);
    setProjectScopeReleased(false);
    setRequiresWorkspaceReselection(false);
    setRequiresTargetReselection(false);
    setSelection({ kind: "custom" });
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

  // A location on another environment clears the Target and its Agent, as
  // choosing another environment does; a still-compatible Target is kept.
  const releaseTargetOutside = (environmentId: string) => {
    const targetId = selectedTargetId ?? selectedTarget?.id;
    const target = executionTargets.find(({ id }) => id === targetId);
    if (!target || target.environmentId === environmentId) return;
    setSelectedTargetId(undefined);
    setRequiresTargetReselection(false);
    setExecutionWorkspace(undefined);
    setSelection({ kind: "custom" });
    setSelectedAgentSummary(undefined);
    setResolution(undefined);
    setAgents([]);
    setNextAgentCursor(undefined);
    setAgentsLoaded(false);
  };

  useEffect(() => {
    const added = workspaces.find(({ id }) => id === pendingLocationId);
    if (!added || !projects.some(({ id }) => id === added.projectId)) return;
    setProjectScopeReleased(true);
    setSelectedProjectId(added.projectId);
    setSelectedWorkspaceId(added.id);
    setRequiresWorkspaceReselection(false);
    releaseTargetOutside(added.environmentId);
    setPendingLocationId(undefined);
  }, [pendingLocationId, projects, workspaces]);

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
    creationScope.projectId,
  ]);

  useEffect(() => {
    if (canOpen) return;
    setPickerOpen(false);
    resetPanel();
    restoreTriggerFocus.current = false;
  }, [canOpen]);

  // Once a draft is open, retain even inferred destinations by identity so
  // inventory changes cannot silently move it to another project, machine or
  // directory.
  useEffect(() => {
    if (!pickerOpen) return;
    if (selectedProjectId === undefined && selectedProject)
      setSelectedProjectId(selectedProject.project.id);
    if (selectedWorkspaceId === undefined && selectedWorkspace)
      setSelectedWorkspaceId(selectedWorkspace.id);
    if (selectedTargetId === undefined && selectedTarget)
      setSelectedTargetId(selectedTarget.id);
  }, [
    pickerOpen,
    selectedProjectId,
    selectedProject,
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

  const chooseProject = (projectId: string) => {
    if (projectId === selectedProject?.project.id) return;
    const choice = projectChoices.find(({ project }) => project.id === projectId);
    setSelectedProjectId(projectId);
    setSelectedWorkspaceId(undefined);
    setRequiresWorkspaceReselection(false);
    setExecutionWorkspace(undefined);
    setSelection({ kind: "custom" });
    setSelectedAgentSummary(undefined);
    setResolution(undefined);
    setError("");
    const environmentIds = new Set(
      choice?.creatable.map(({ environmentId }) => environmentId),
    );
    if (environmentIds.size === 1) releaseTargetOutside([...environmentIds][0]!);
  };

  const chooseLocation = (workspaceId: string) => {
    const workspace = creatableWorkspaces.find(({ id }) => id === workspaceId);
    if (!workspace || workspace.id === selectedWorkspace?.id) return;
    setSelectedWorkspaceId(workspace.id);
    setRequiresWorkspaceReselection(false);
    setExecutionWorkspace(undefined);
    setSelection({ kind: "custom" });
    setSelectedAgentSummary(undefined);
    setResolution(undefined);
    setError("");
    releaseTargetOutside(workspace.environmentId);
  };

  const applyManualDefaults = () => {
    templateSelectionGeneration.current += 1;
    const target = executionTargets.find(
      ({ id }) => id === creationScope.targetId,
    );
    setSelectedTemplate(undefined);
    setEnvironmentVariables({});
    setSelectedProjectId(undefined);
    setSelectedWorkspaceId(undefined);
    setSelectedTargetId(target?.available ? target.id : undefined);
    setExecutionWorkspace(undefined);
    setRequiresWorkspaceReselection(false);
    setRequiresTargetReselection(false);
    setSelection({ kind: "custom" });
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
    setSelectedProjectId(workspace?.projectId);
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
          id={pickerId}
          layout="side"
          size="sm"
          layer={mobileShell ? "over-dialog" : "dialog"}
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
          <DialogHeader>
            <DialogTitle ref={surfaceHeadingRef} tabIndex={-1}>
              New thread
            </DialogTitle>
            <DialogDescription id={`${pickerId}-description`}>
              Choose a template or configure a new thread.
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <Field label="Template" id={`${pickerId}-template`}>
            <SearchableSelect
              label="Template"
              searchLabel="Search templates"
              emptyLabel="No matching templates"
              value={selectedTemplate?.id ?? "manual"}
              disabled={pending || templatePending || templatesLoading}
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
            {!templateLoadError &&
              !templatesLoading &&
              templatesLoaded &&
              templates.length === 0 && (
                <p className="new-thread-field-note">No templates saved yet.</p>
              )}
            </Field>
            {templateLoadError && (
              <DialogAlert tone="danger">{templateLoadError}</DialogAlert>
            )}
            <Field label="Thread name" id={`${pickerId}-title`}>
            <Input
              ref={titleInputRef}
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
            </Field>
            {needsProjectPicker && (
              <Field
                label="Project"
                id={`${pickerId}-project`}
                description={scopedProjectNote}
              >
                <SearchableSelect
                  label="Project"
                  searchLabel="Search projects"
                  emptyLabel="No matching projects"
                  value={selectedProject?.project.id ?? ""}
                  placeholder="Choose a project"
                  disabled={pending}
                  triggerProps={{
                    "data-project-id": selectedProject?.project.id ?? "",
                  }}
                  options={projectChoices.map(({ project, locations, unavailable }) => ({
                    value: project.id,
                    label: projectLocations.projectLabel(project.id) ?? project.name,
                    icon: <Folder size={14} />,
                    searchTerms: locations.flatMap(({ workspace }) => [
                      workspace.label.text,
                      workspace.displayPath.text,
                      environments.find(({ id }) => id === workspace.environmentId)
                        ?.label.text ?? "",
                    ]),
                    ...(unavailable ? { disabled: true, unavailable } : {}),
                  }))}
                  onValueChange={chooseProject}
                />
              </Field>
            )}
            {needsLocationPicker && (
              <Field label="Location" id={`${pickerId}-location`}>
                <SearchableSelect
                  label="Location"
                  searchLabel="Search locations"
                  emptyLabel="No matching locations"
                  value={selectedWorkspace?.id ?? ""}
                  placeholder="Choose a location"
                  disabled={pending}
                  triggerProps={{
                    "data-workspace-id": selectedWorkspace?.id ?? "",
                  }}
                  options={locationOptions.map(({ workspace, unavailable }) => {
                    const environment = environments.find(
                      ({ id }) => id === workspace.environmentId,
                    );
                    return {
                      value: workspace.id,
                      label:
                        projectLocations.locationLabel(workspace.id) ??
                        workspace.displayPath.text,
                      icon: environment ? (
                        <EnvironmentScopeIcon kind={environment.kind} />
                      ) : (
                        <Folder size={14} />
                      ),
                      searchTerms: [
                        workspace.label.text,
                        environment?.label.text ?? "",
                      ],
                      ...(unavailable ? { disabled: true, unavailable } : {}),
                    };
                  })}
                  onValueChange={chooseLocation}
                />
              </Field>
            )}
            <Button type="button" size="sm" variant="outline" className="new-thread-add-project"
              disabled={pending || Boolean(pendingLocationId)} onClick={() => setAddProjectOpen(true)}>
              <Plus size={14} /> {pendingLocationId ? "Adding project…" : "Add project"}
            </Button>
            {addProjectOpen && <AddProjectDialog store={store} environments={environments}
              initialEnvironmentId={effectiveEnvironmentId}
              environmentLocked={scopedEnvironmentId !== undefined}
              onClose={() => setAddProjectOpen(false)}
              onAdded={(id) => setPendingLocationId(id)} />}
            {needsTargetPicker && (
              <Field label="Target" id={`${pickerId}-target`}>
                <SearchableSelect
                  label="Target"
                  searchLabel="Search targets"
                  emptyLabel="No matching targets"
                  value={selectedTarget?.id ?? ""}
                  placeholder="Choose where to run"
                  disabled={pending}
                  triggerProps={{
                    "data-target-id": selectedTarget?.id ?? "",
                  }}
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
                      effectiveEnvironment?.label.text ?? "",
                    ],
                  }))}
                  onValueChange={(value) => {
                    setSelectedTargetId(value);
                    setRequiresTargetReselection(false);
                    setExecutionWorkspace(undefined);
                    setSelection({ kind: "custom" });
                    setSelectedAgentSummary(undefined);
                    setResolution(undefined);
                    setAgents([]);
                    setNextAgentCursor(undefined);
                    setAgentsLoaded(false);
                    setError("");
                  }}
                />
              </Field>
            )}
            {selectedTarget?.workspaceExecution.kind === "selectable" && (
              <>
                <Field label="Workspace execution" id={`${pickerId}-workspace-execution`}>
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
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose workspace execution" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="direct">Project directly</SelectItem>
                    <SelectItem value="writable_clone">
                      Writable isolated clone
                    </SelectItem>
                    <SelectItem value="read_only">
                      Read-only project with writable home
                    </SelectItem>
                  </SelectContent>
                </Select>
                </Field>
                {selectedExecutionWorkspace?.kind === "isolated" && (
                  <Field label="Network" id={`${pickerId}-workspace-network`}>
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
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {isolatedNetworkProfiles.map((profile) => (
                          <SelectItem key={profile} value={profile}>
                            {profile === "isolated"
                              ? "Isolated"
                              : "Execution host"}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                )}
              </>
            )}
            <Field label="Agent" id={`${pickerId}-agent`}>
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
                        !selectedTarget || !selectedWorkspace ? "Choose Project, Location and Target first" :
                          agentsLoading ? "Loading Agents…" : "Choose an Agent")}
                  </span>
                  <ChevronDown size={14} aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                className="searchable-select-popover"
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
                <SearchableSelectSearch
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
                <div className="searchable-select-options">
                  <div
                    id={`${pickerId}-agent-options`}
                    role="listbox"
                    aria-label="Agents"
                    className="flex flex-col"
                  >
                    <button
                      id={`${pickerId}-agent-option-0`}
                      role="option"
                      aria-selected={selection.kind === "custom"}
                      data-active={activeAgentChoiceIndex === 0 || undefined}
                      ref={activeAgentChoiceIndex === 0 ? activeAgentOptionRef : undefined}
                      className={cn(menuRowClass, "shrink-0 data-active:bg-(--hover) aria-selected:font-medium")}
                      type="button"
                      tabIndex={-1}
                      onMouseDown={(event) => event.preventDefault()}
                      onPointerMove={(event) => {
                        if (event.pointerType === "mouse") setActiveAgentIndex(0);
                      }}
                      onClick={() => chooseAgent("custom")}
                    >
                      <SlidersHorizontal aria-hidden="true" />
                      <span className="min-w-0 flex-1">
                        Custom{" "}
                        <span
                          data-slot="searchable-select-item-description"
                          className={menuDescriptionClass}
                        >
                          Use the selected target's current defaults
                        </span>
                      </span>
                      {selection.kind === "custom" && (
                        <Check className="size-4 text-foreground" aria-hidden="true" />
                      )}
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
                        className={cn(menuRowClass, "shrink-0 data-active:bg-(--hover) aria-selected:font-medium")}
                        type="button"
                        tabIndex={-1}
                        onMouseDown={(event) => event.preventDefault()}
                        onPointerMove={(event) => {
                          if (event.pointerType === "mouse") setActiveAgentIndex(index + 1);
                        }}
                        onClick={() => chooseAgent(agent.id)}
                      >
                        <span className="flex shrink-0 items-center text-muted-foreground" aria-hidden="true">
                          <TargetScopeIcon brand={agent.backend.brand} />
                        </span>
                        <span className="min-w-0 flex-1">
                          {agent.name}{" "}
                          <span
                            data-slot="searchable-select-item-description"
                            className={menuDescriptionClass}
                          >
                            {agent.backend.label.text} · {agent.id.slice(0, 8)}
                          </span>
                        </span>
                        {selection.kind === "saved_agent" &&
                          selection.agentId === agent.id && (
                            <Check className="size-4 text-foreground" aria-hidden="true" />
                          )}
                      </button>
                    ))}
                  </div>
                  {agentsLoading && (
                    <p role="status" className={cn(menuEmptyClass, "m-0")}>
                      Loading Agents…
                    </p>
                  )}
                  {!agentsLoading && agentsLoaded && agents.length === 0 && (
                    <p role="status" className={cn(menuEmptyClass, "m-0")}>
                      No saved Agents found.
                    </p>
                  )}
                  {nextAgentCursor && !agentsLoading && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full"
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
            </Field>
            {agentsLoaded && agents.length === 0 && !agentSearch && (
              <div className="new-thread-agent-empty">
                <span>No saved Agents yet.</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => chooseAgent("custom")}
                >
                  Use Custom
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // The dialog would otherwise stay over Settings.
                    closePicker(false);
                    navigate(settingsPath("agents", { mode: "new" }));
                  }}
                >
                  Create an Agent
                </Button>
              </div>
            )}
            {(agentLoadError ||
              (!templateNeedsAttention && resolutionMessage)) &&
              (resolution?.candidates.length === 0 || agentLoadError ? (
                <DialogAlert tone="danger" aria-live="assertive">
                  {agentLoadError || resolutionMessage}
                </DialogAlert>
              ) : (
                <p className="new-thread-field-note" role="status" aria-live="polite">
                  {resolutionMessage}
                </p>
              ))}
            <section
              className="new-thread-variables"
              aria-labelledby={`${pickerId}-variables`}
            >
              <h3 id={`${pickerId}-variables`}>Environment variables</h3>
              <Button ref={variablesTrigger} type="button" variant="outline" disabled={!variablesSnapshot || pending} onClick={() => setVariablesOpen(true)}>
                <SlidersHorizontal />{variablesPreview.loading ? "Loading variables…" : `${effectiveVariableCount} effective variables · ${Object.keys(environmentVariables).length} thread changes`}
              </Button>
              <p className="new-thread-field-note">Environment → Backend → Agent → Thread. Review values before creating.</p>
              {variablesPreview.error && (
                <DialogAlert
                  tone="danger"
                  action={
                    <Button type="button" size="sm" variant="outline" onClick={() => setVariablesRefresh(current => current + 1)}>
                      Retry variable preview
                    </Button>
                  }
                >
                  {variablesPreview.error}
                </DialogAlert>
              )}
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
                        Choose an available Project, Location, Target, and
                        saved Agent, then update the template.
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
                      <Callout
                        tone="warning"
                        role="alert"
                        title={`Replace ${selectedTemplate.name}?`}
                      >
                        Saving will replace this template with the current
                        setup. Existing threads are unaffected.
                      </Callout>
                    )}
                  <Field label="Template name" id={`${pickerId}-template-name`}>
                  <Input
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
                  </Field>
                  <div className="new-thread-template-buttons">
                    {templateEditorMode === "update" &&
                      selectedTemplate &&
                      !deleteTemplateConfirm && (
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="mr-auto"
                          disabled={templatePending}
                          onClick={() => setDeleteTemplateConfirm(true)}
                        >
                          Delete template
                        </Button>
                      )}
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={templatePending}
                      onClick={() => {
                        setTemplateEditorMode(undefined);
                        setTemplateName("");
                        setDeleteTemplateConfirm(false);
                      }}
                    >
                      Back
                    </Button>
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
                  </div>
                  {deleteTemplateConfirm && selectedTemplate && (
                    <Callout
                      tone="danger"
                      role="alert"
                      title={`Delete ${selectedTemplate.name}?`}
                      action={
                        <>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={templatePending}
                            onClick={() => setDeleteTemplateConfirm(false)}
                          >
                            Keep template
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="destructive"
                            disabled={templatePending}
                            onClick={() => void deleteTemplate()}
                          >
                            {templatePending ? "Deleting…" : "Delete"}
                          </Button>
                        </>
                      }
                    >
                      Existing threads are unaffected.
                    </Callout>
                  )}
                </div>
              )}
            </section>
            {error && <DialogAlert tone="danger">{error}</DialogAlert>}
          </DialogBody>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending || templatePending}
              onClick={() => closePicker(true)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!canCreate || pending}
              onClick={() => void create()}
            >
              {pending ? "Creating…" : "Create thread"}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
      {variablesOpen && variablesSnapshot && <EnvironmentVariablesDialog open onOpenChange={setVariablesOpen} snapshot={variablesSnapshot}
        description="Review values before creating this thread." context={<p className="environment-variable-help">{effectiveEnvironment?.label.text} · {selectedTarget?.label.text} · {selectedAgentSummary?.name ?? "Custom"}</p>}
        startupReason={variablesPreview.result?.startup.reason} returnFocusRef={variablesTrigger}
        onApply={next => { setEnvironmentVariables(next); setVariablesOpen(false); }} />}
      {!canOpen && (
        <small className="new-thread-target-unavailable" role="alert">
          {unavailableScopeMessage}
        </small>
      )}
    </Dialog>
  );
}
