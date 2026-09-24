import { runThreadArchiveCheck } from "../operations/thread-archive.js";
import { SearchableSelect } from "./ui/searchable-select.js";
import { useSidebarDisclosure, useSidebarDisclosures } from "../app/sidebar-disclosures.js";
import * as Collapsible from "@radix-ui/react-collapsible";
import {
  createContext,
  Fragment,
  forwardRef,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  BulkInventoryAction,
  BulkInventoryMutationRequest,
  NormalizedApplicationThreadSummary,
  NormalizedThreadGroup,
  NormalizedThreadDescendant,
  NormalizedThreadForkOrigin,
  NormalizedThreadLineagePlacement,
  OpenTaskDisposition,
  ThreadArchiveImpact,
} from "../../shared/index.js";
import {
  agentsPath,
  navigate,
  threadPath,
  threadTurnPath,
  usagePath,
} from "../app/router.js";
import {
  resolveModePreferences,
  sidebarEffectiveTimestamp,
  type SidebarDensity,
  type SidebarFlatGroup,
  type SidebarGroupBy,
  type SidebarSortPreferences,
  type SidebarSortBy,
} from "../app/sidebar-view-model.js";
import {
  resetSidebarMode,
  setSidebarGroupBy,
  setSidebarGroupForks,
  setSidebarInventoryScope,
  setSidebarScopeCollapsed,
  setSidebarShowBackendIcons,
  setSidebarShowFilter,
  setSidebarStackBy,
  updateSidebarModePreferences,
  useSidebarViewPreferences,
} from "../app/sidebar-view-store.js";

import {
  deriveSidebarInventoryScope,
  deriveSidebarLocationSuppression,
  filterThreadsBySidebarScope,
  sidebarScopeRepairAtCursor,
  transitionSidebarInventoryScope,
} from "../app/sidebar-scope.js";
import {
  environmentDisplayLabel,
  scopeSummaryPresentation,
  targetDisplayLabel,
  workspaceDisplayLabel,
} from "../app/sidebar-scope-presentation.js";
import type {
  ApplicationClientState,
  ApplicationClientStore,
} from "../stores/ApplicationClientStore.js";
import { messageFrom } from "../stores/ApplicationClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import {
  getClickNamesToFilter,
  subscribeClickNamesToFilter,
  getPanelPresentation,
} from "../app/settings.js";
import {
  resolvePanelPresentation,
  type PanelPresentation,
} from "../workspace-panels/panel-presentation.js";
import {
  shortAutomationTime,
  shortRelativeTime,
  snoozeLabel,
} from "../lib/time.js";
import {
  AlarmClock,
  ArchiveRestore,
  Archive,
  ArrowDownToDot,
  ArrowDownWideNarrow,
  ArrowUpFromDot,
  ArrowUpWideNarrow,
  Box,
  Bookmark,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  CircleX,
  Clock,
  Folder,
  ListFilter,
  ListPlus,
  ListTodo,
  MessageCircleQuestion,
  LoaderCircle,
  ListTree,
  Layers3,
  MoreHorizontal,
  PencilLine,
  Pin,
  PinOff,
  Plus,
  Search,
  TriangleAlert,
  Terminal as TerminalIcon,
} from "lucide-react";
import { NewThreadControl } from "./NewThreadControl.js";
import { SidebarViewControls } from "./SidebarViewControls.js";
import { ThreadContextMenu } from "./ThreadContextMenu.js";
import { Button } from "@client/components/ui/button";
import { Input } from "@client/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@client/components/ui/dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuTrigger,
} from "@client/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";

import {
  deriveSidebarLineage,
  type DescendantAggregate,
  type SidebarLineageNode,
} from "../lineage/sidebar-lineage.js";
import {
  isUpcomingThread,
  projectSidebarFlatGroups,
  sidebarWakeTimestamp,
} from "../lineage/sidebar-flat-projections.js";
import {
  projectSidebarStacks,
  type SidebarStackEntry,
  type SidebarStackedGroup,
} from "../lineage/sidebar-group-projections.js";
import { createThreadSearchMatcher } from "../lineage/sidebar-search.js";
import { ForkProvenanceButton } from "./lineage/ForkProvenanceButton.js";
import { ArchiveDropdown } from "./thread/ArchiveThreadChoices.js";
import { ArchiveChoicesDialog } from "./thread/ArchiveChoicesDialog.js";
import {
  SettleImpactDialog,
  settleNeedsConfirmation,
} from "./thread/SettleImpactDialog.js";
import { SnoozeDialog } from "./thread/SnoozeDialog.js";
import { BackendBrandIcon } from "./brand-icons.js";
import {
  EnvironmentScopeIcon,
  TargetScopeIcon,
} from "./scope-selector-icons.js";
import {
  FlatThreadRow,
  flatRowGlyphIcon,
  flatRowGlyphKind,
  type FlatThreadRowTaskSummary,
  type FlatThreadRowForkInfo,
} from "./thread/FlatThreadRow.js";
import {
  ThreadPeekCard,
  useThreadPeek,
  type ThreadPeekBindings,
} from "./thread/ThreadPeekCard.js";
import { ThreadGroupRoster } from "./thread/ThreadGroupRoster.js";
import { ThreadStackActionDialog } from "./thread/ThreadStackActionDialog.js";
import { useTaskDrag } from "../tasks/task-drag.js";
import {
  environmentTintStyle,
  resolveEnvironmentPaletteTones,
} from "../app/environment-palette.js";
import { useEnvironmentPalette } from "../app/use-environment-palette.js";
import { useEnvironmentColorsEnabled } from "../app/use-environment-colors-enabled.js";
import { AddProjectDialog } from "./AddProjectDialog.js";
import { SidebarFooterActions } from "./SidebarFooterActions.js";
import {
  activePrimaryShortcutModifier,
  keyboardShortcutAriaKey,
  keyboardShortcutLabel,
  matchesKeyboardShortcut,
  primaryShortcutModifierForKey,
  SIDEBAR_ADJACENT_THREAD_COMMANDS,
  SIDEBAR_QUICK_SWITCH_COMMANDS,
  SIDEBAR_QUICK_SWITCH_CONFIRMATION_MS,
  SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS,
  type PrimaryShortcutModifier,
} from "../app/keyboard-shortcuts.js";

/** Upcoming shows at most this many rows before the "N more…" expander. */
const UPCOMING_VISIBLE_CAP = 5;
/** Large flat groups stay bounded until the reader explicitly expands them. */
const FLAT_GROUP_VISIBLE_CAP = 20;
const ALL_PROJECTS_FILTER_VALUE = "__all_projects__";
const PROJECT_NAME_FILTER_PREFIX = "project-name:";
const ALL_ENVIRONMENTS_FILTER_VALUE = "__all_environments__";
const ALL_TARGETS_FILTER_VALUE = "__all_targets__";
const ALL_GROUPS_FILTER_VALUE = "__all_groups__";
const UNGROUPED_FILTER_VALUE = "__ungrouped__";

type EnvironmentTintStyleForWorkspace = (
  workspaceId: string,
) => React.CSSProperties | undefined;

type SidebarQuickSwitchState =
  | { readonly kind: "idle" }
  | {
      readonly kind: "hints";
      readonly modifier: PrimaryShortcutModifier;
      readonly threadIds: readonly string[];
    }
  | {
      readonly kind: "confirmation";
      readonly modifier: PrimaryShortcutModifier;
      readonly threadId: string;
      readonly commandIndex: number;
    };

interface SidebarQuickSwitchHint {
  readonly ariaKey: string;
  readonly confirmation: boolean;
  readonly label: string;
}

interface PendingSidebarQuickSwitch {
  readonly modifier: PrimaryShortcutModifier;
  readonly threadIds: readonly string[];
  readonly timerId: number;
}

const IDLE_SIDEBAR_QUICK_SWITCH: SidebarQuickSwitchState = { kind: "idle" };

const SidebarQuickSwitchContext = createContext<SidebarQuickSwitchState>(
  IDLE_SIDEBAR_QUICK_SWITCH,
);

function useSidebarQuickSwitchHint(
  threadId: string,
): SidebarQuickSwitchHint | undefined {
  const state = useContext(SidebarQuickSwitchContext);
  if (state.kind === "idle") return undefined;
  const index =
    state.kind === "confirmation"
      ? state.threadId === threadId
        ? state.commandIndex
        : -1
      : state.threadIds.indexOf(threadId);
  const command = SIDEBAR_QUICK_SWITCH_COMMANDS[index];
  if (command === undefined) return undefined;
  return {
    ariaKey: keyboardShortcutAriaKey(command.defaultBinding, state.modifier),
    confirmation: state.kind === "confirmation",
    label: keyboardShortcutLabel(command.defaultBinding, state.modifier),
  };
}

function sidebarThreadRowIsRendered(
  row: HTMLElement,
  container: HTMLElement,
): boolean {
  let current: HTMLElement | null = row;
  while (current && current !== container) {
    const style = window.getComputedStyle(current);
    if (
      current.hidden ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden"
    ) {
      return false;
    }
    current = current.parentElement;
  }
  return current === container;
}

function visibleSidebarQuickSwitchThreadIds(
  container: HTMLElement | null,
): readonly string[] {
  return visibleSidebarThreadRows(container)
    .slice(0, SIDEBAR_QUICK_SWITCH_COMMANDS.length)
    .map((row) => row.dataset.threadId!);
}

function visibleSidebarThreadRows(
  container: HTMLElement | null,
): readonly HTMLElement[] {
  if (container === null) return [];
  const rows: HTMLElement[] = [];
  const seen = new Set<string>();
  for (const row of container.querySelectorAll<HTMLElement>(
    "[data-thread-id]",
  )) {
    const threadId = row.dataset.threadId;
    if (
      threadId === undefined ||
      seen.has(threadId) ||
      !sidebarThreadRowIsRendered(row, container)
    ) {
      continue;
    }
    seen.add(threadId);
    rows.push(row);
  }
  return rows;
}

function sidebarAdjacentThreadRow(
  container: HTMLElement | null,
  selectedThreadId: string | undefined,
  direction: -1 | 1,
): HTMLElement | undefined {
  const rows = visibleSidebarThreadRows(container);
  if (rows.length === 0) return undefined;
  let selectedIndex = rows.findIndex(
    (row) => row.dataset.threadId === selectedThreadId,
  );
  if (selectedIndex < 0 && container !== null) {
    const selectedSurface = container.querySelector<HTMLElement>(
      '[data-selected="true"]',
    );
    const selectedRow = selectedSurface?.closest<HTMLElement>(
      "[data-thread-id]",
    );
    selectedIndex = selectedRow ? rows.indexOf(selectedRow) : -1;
  }
  if (selectedIndex < 0) return direction > 0 ? rows[0] : rows.at(-1);
  return rows[selectedIndex + direction];
}

function keyboardEventTargetBlocksSidebarNavigation(
  target: EventTarget | null,
): boolean {
  if (!(target instanceof Element)) return false;
  const editable = target.closest(
    'input, textarea, select, [role="textbox"], [contenteditable]:not([contenteditable="false"])',
  );
  if (editable === null) return false;
  return !(
    editable instanceof HTMLTextAreaElement &&
    editable.dataset.sidebarNavigationWhenEmpty === "true" &&
    editable.value.length === 0
  );
}

export function InventorySidebar({
  state,
  store,
  threadRegistry,
  selectedThreadId,
  onSelectThread,
  onNavigate,
  onOpenSettings,
  showFooterConnectionStatus = false,
  peekEnabled = true,
  scrollPosition,
}: {
  state: ApplicationClientState;
  store: ApplicationClientStore;
  threadRegistry?: ThreadStoreRegistry;
  selectedThreadId?: string;
  onSelectThread?: SelectThread;
  onNavigate: (options?: { readonly keepDrawerOpen?: boolean }) => void;
  onOpenSettings: (trigger: HTMLButtonElement) => void;
  /** Desktop fallback for routes whose navigation trigger is not rendered. */
  showFooterConnectionStatus?: boolean;
  /** Desktop-only detail preview; the full-screen mobile drawer disables it. */
  peekEnabled?: boolean;
  /** Client-session position retained by the shell while the drawer is closed. */
  scrollPosition?: { current: number };
}): React.JSX.Element {
  const snapshot = state.snapshot;
  const workspaces = snapshot?.workspaces ?? [];
  const environments = snapshot?.environments ?? [];
  const nonLocalEnvironments = environments.filter(
    ({ kind }) => kind !== "local",
  );
  const executionTargets = snapshot?.executionTargets ?? [];
  const threadGroups = snapshot?.groups ?? [];
  const viewPreferences = useSidebarViewPreferences();
  const environmentPalette = useEnvironmentPalette();
  const environmentPaletteTones = useMemo(
    () =>
      resolveEnvironmentPaletteTones(
        environments.map(({ id }) => id),
        environmentPalette,
      ),
    [environmentPalette, environments],
  );
  const environmentColorsEnabled = useEnvironmentColorsEnabled();
  const scopeContentId = useId();
  const scope = useMemo(
    () =>
      deriveSidebarInventoryScope(
        { environments, executionTargets, workspaces, groups: threadGroups },
        viewPreferences,
      ),
    [environments, executionTargets, threadGroups, viewPreferences, workspaces],
  );
  const environmentTintMode =
    !environmentColorsEnabled || environments.length <= 1
      ? "none"
      : scope.effectiveEnvironmentId === null
        ? "rows"
        : "sidebar";
  const sidebarEnvironmentTone = scope.effectiveEnvironmentId
    ? environmentPaletteTones.get(scope.effectiveEnvironmentId)
    : undefined;
  const sidebarEnvironmentTintStyle =
    environmentTintMode === "sidebar" && sidebarEnvironmentTone
      ? environmentTintStyle(sidebarEnvironmentTone)
      : undefined;
  const projectFilterName = scope.projectName;
  const environmentFilter = environments.find(
    ({ id }) => id === scope.environmentId,
  );
  const targetFilter = executionTargets.find(({ id }) => id === scope.targetId);
  const groupFilter = threadGroups.find(({ id }) => id === scope.groupId);
  const scopeSummaryPresentationValue = scopeSummaryPresentation({
    environment: environmentFilter,
    target: targetFilter,
    projectName: projectFilterName,
    environments,
    targets: executionTargets,
    workspaces,
  });
  const projectNameOptions = [...new Set([
    ...scope.projectOptions.map((workspace) => workspace.label.text),
    ...(scope.projectName === null ? [] : [scope.projectName]),
  ])].map((name) => {
    const matching = scope.projectOptions.filter((workspace) => workspace.label.text === name);
    return {
      id: `${PROJECT_NAME_FILTER_PREFIX}${name}`,
      label: name,
      available: matching.some((workspace) => workspace.available &&
        environments.find(({ id }) => id === workspace.environmentId)?.available !== false),
      searchTerms: matching.flatMap((workspace) => [
        workspace.displayPath.text,
        environments.find(({ id }) => id === workspace.environmentId)?.label.text ?? "",
      ]),
    };
  });
  const groupScopeLabel = scope.ungrouped ? "Ungrouped" : groupFilter?.name;
  const scopeSummary = [
    scopeSummaryPresentationValue.fullLabel,
    groupScopeLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const visibleScopeSummary = groupScopeLabel
    ? [scopeSummaryPresentationValue.visibleLabel, groupScopeLabel]
        .filter(Boolean)
        .join(" · ")
    : scopeSummaryPresentationValue.visibleLabel || "All threads";
  const scopePreferenceKey = [
    viewPreferences.environmentFilterId,
    viewPreferences.targetFilterId,
    viewPreferences.projectFilterName,
    viewPreferences.groupFilterId,
    viewPreferences.ungroupedFilter,
  ].join("\0");
  const [pendingOpenedWorkspace, setPendingOpenedWorkspace] = useState<
    | {
        readonly id: string;
        readonly scopePreferenceKey: string;
      }
    | undefined
  >();
  useEffect(() => {
    if (!pendingOpenedWorkspace) return;
    if (pendingOpenedWorkspace.scopePreferenceKey !== scopePreferenceKey) {
      setPendingOpenedWorkspace(undefined);
      return;
    }
    const openedWorkspace = workspaces.find(({ id }) => id === pendingOpenedWorkspace.id);
    if (openedWorkspace) {
      const eventId = store.normalized.replayCursor;
      setSidebarInventoryScope(
        { projectFilterName: openedWorkspace.label.text },
        eventId
          ? {
              projectFilterPublication: {
                projectName: openedWorkspace.label.text,
                eventId,
              },
            }
          : undefined,
      );
      setPendingOpenedWorkspace(undefined);
      return;
    }
  }, [pendingOpenedWorkspace, scopePreferenceKey, workspaces]);
  useEffect(() => {
    if (!state.authoritative || !snapshot || scope.repair === null) {
      return;
    }
    const repair = sidebarScopeRepairAtCursor(
      scope.repair,
      viewPreferences,
      store.normalized.replayCursor,
      state.connection === "connected",
    );
    if (repair) setSidebarInventoryScope(repair);
  }, [
    scope.repair,
    snapshot,
    state.authoritative,
    state.connection,
    store,
    viewPreferences,
  ]);
  const groupBy = viewPreferences.groupBy;
  const modePreferences = resolveModePreferences(viewPreferences, groupBy);
  const flatModePreferences =
    groupBy === "project"
      ? undefined
      : resolveModePreferences(viewPreferences, groupBy);
  const grouped = viewPreferences.groupForks;
  const allDescendants = useMemo(
    () =>
      Object.values(state.descendantPages).flatMap(
        ({ descendants: page }) => page,
      ),
    [state.descendantPages],
  );
  const threads = useMemo(
    () => filterThreadsBySidebarScope(state.visibleThreads, workspaces, scope),
    [scope, state.visibleThreads, workspaces],
  );
  const descendants = useMemo(
    () =>
      allDescendants.filter(
        ({ thread }) =>
          filterThreadsBySidebarScope([thread], workspaces, scope).length > 0,
      ),
    [allDescendants, scope, workspaces],
  );
  const scopedSnapshot = useMemo(() => {
    if (!snapshot || scope.activeFilterCount === 0) return snapshot;
    const scopedThreads = filterThreadsBySidebarScope(
      snapshot.threads,
      workspaces,
      scope,
    );
    return {
      ...snapshot,
      threads: [...scopedThreads],
      // Protocol lineage-family totals are global. Under a project filter,
      // expose only counts proven by loaded rows in this workspace; global
      // totals remain available separately for archive impact.
      lineageFamilies: loadedScopedLineageFamilies(
        scopedThreads.map(({ id }) => id),
        snapshot.forkOrigins,
        descendants,
      ),
    };
  }, [descendants, scope, snapshot, workspaces]);
  const globalLineageFamilyCounts = useMemo(
    () =>
      new Map(
        snapshot?.lineageFamilies.map(({ sourceThreadId, descendantCount }) => [
          sourceThreadId,
          descendantCount,
        ]) ?? [],
      ),
    [snapshot?.lineageFamilies],
  );
  const scopedLineageFamilyCounts = useMemo(
    () =>
      new Map(
        scopedSnapshot?.lineageFamilies.map(
          ({ sourceThreadId, descendantCount }) => [
            sourceThreadId,
            descendantCount,
          ],
        ) ?? [],
      ),
    [scopedSnapshot?.lineageFamilies],
  );
  const taskSummaryByThreadId = useMemo(() => {
    const summaries = new Map<string, FlatThreadRowTaskSummary>();
    for (const task of snapshot?.tasks ?? []) {
      if (task.scope.kind !== "thread" || task.completedAt !== null) continue;
      const current = summaries.get(task.scope.threadId) ?? {
        openCount: 0,
      };
      summaries.set(task.scope.threadId, {
        openCount: current.openCount + 1,
      });
    }
    return summaries;
  }, [snapshot?.tasks]);
  const keepShownThread = (thread: NormalizedApplicationThreadSummary) =>
    (viewPreferences.show.snoozed || thread.inventoryState !== "snoozed") &&
    (viewPreferences.show.settled || thread.inventoryState !== "settled") &&
    (viewPreferences.show.drafts || thread.backingState !== "unbound");
  /**
   * The project view honors the global Show filters too: snoozed, settled,
   * and draft threads are removed before lineage derivation
   * (deriveSidebarLineage otherwise re-adds every snapshot thread when search
   * is empty), and the Snoozed and Settled shelves disappear entirely while
   * their filters are off.
   */
  const projection = useMemo(() => {
    if (!scopedSnapshot || groupBy !== "project") return undefined;
    const { show } = viewPreferences;
    const filtered = !show.snoozed || !show.settled || !show.drafts;
    return deriveSidebarLineage({
      snapshot: filtered
        ? {
            ...scopedSnapshot,
            threads: [...scopedSnapshot.threads.filter(keepShownThread)],
          }
        : scopedSnapshot,
      visibleThreads: filtered ? threads.filter(keepShownThread) : threads,
      descendants: filtered
        ? descendants.filter(({ thread }) => keepShownThread(thread))
        : descendants,
      grouped,
      search: state.search,
    });
  }, [
    descendants,
    grouped,
    groupBy,
    scopedSnapshot,
    state.search,
    threads,
    viewPreferences,
  ]);
  /**
   * Flat projector input: paged lineage descendants merge into the visible
   * summaries (deduped by id, visibleThreads wins) so descendants loaded via
   * "Show all runs/forks" survive the view switch. While searching, only true
   * matches remain — visibleThreads appends non-matching nested ancestors for
   * Projects tree context, which flat views must not render. Search is a
   * simple filter rather than a ranked-results projection.
   */
  const flatThreads = useMemo(() => {
    const byId = new Map(threads.map((thread) => [thread.id, thread]));
    for (const { thread } of descendants) {
      if (!byId.has(thread.id)) byId.set(thread.id, thread);
    }
    const merged = [...byId.values()];
    if (!state.search.trim()) return merged;
    return merged.filter(
      createThreadSearchMatcher(state.search, scopedSnapshot),
    );
  }, [descendants, scopedSnapshot, state.search, threads]);
  /** Flat rows and buckets contain relative/future time, so refresh on each
   * wall-clock minute while a flat mode is visible. This also naturally
   * rebuckets Timeline at midnight, week, month, and year boundaries. */
  const [clockNow, setClockNow] = useState(() => Date.now());
  useEffect(() => {
    if (groupBy === "project") return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const now = Date.now();
      timer = setTimeout(
        () => {
          setClockNow(Date.now());
          schedule();
        },
        Math.max(1_000, 60_010 - (now % 60_000)),
      );
    };
    setClockNow(Date.now());
    schedule();
    return () => clearTimeout(timer);
  }, [groupBy]);
  const flatGroups = useMemo<readonly SidebarFlatGroup[]>(
    () =>
      groupBy === "project"
        ? []
        : projectSidebarFlatGroups(
            groupBy,
            flatThreads,
            viewPreferences,
            clockNow,
          ),
    [clockNow, flatThreads, groupBy, viewPreferences],
  );
  const workspaceById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace])),
    [workspaces],
  );
  const workspaceStackLabels = useMemo(
    () =>
      new Map(
        workspaces.map((workspace) => [
          workspace.id,
          workspaceDisplayLabel({
            workspace,
            workspaces,
            environments: environments.filter(({ kind }) => kind !== "local"),
            includeEnvironment: false,
          }),
        ]),
      ),
    [environments, workspaces],
  );
  const effectiveStackBy =
    state.search.trim() ||
    (viewPreferences.stackBy === "group" &&
      (scope.groupId !== null || scope.ungrouped))
      ? "none"
      : viewPreferences.stackBy;
  const stackedFlatGroups = useMemo(
    () =>
      projectSidebarStacks({
        groups: flatGroups,
        stackBy: effectiveStackBy,
        threadGroups,
        workspaceLabels: workspaceStackLabels,
      }),
    [effectiveStackBy, flatGroups, threadGroups, workspaceStackLabels],
  );
  const environmentById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.id, environment])),
    [environments],
  );
  const targetById = useMemo(
    () => new Map(executionTargets.map((target) => [target.id, target])),
    [executionTargets],
  );
  const environmentTintStyleForWorkspace: EnvironmentTintStyleForWorkspace = (
    workspaceId,
  ) => {
    if (environmentTintMode !== "rows") return undefined;
    const environmentId = workspaceById.get(workspaceId)?.environmentId;
    const tone = environmentId
      ? environmentPaletteTones.get(environmentId)
      : undefined;
    return tone ? environmentTintStyle(tone) : undefined;
  };
  const scopedRepresentedThreads = useMemo(() => {
    const byId = new Map(
      (scopedSnapshot?.threads ?? []).map((thread) => [thread.id, thread]),
    );
    for (const { thread } of descendants) byId.set(thread.id, thread);
    return [...byId.values()];
  }, [descendants, scopedSnapshot?.threads]);
  const locationSuppression = useMemo(
    () =>
      deriveSidebarLocationSuppression(
        scope,
        groupBy === "project" ? scopedRepresentedThreads : flatThreads,
        {
          projectGrouped: groupBy === "project",
          environmentCount: environments.length,
        },
      ),
    [
      environments.length,
      flatThreads,
      groupBy,
      scope,
      scopedRepresentedThreads,
    ],
  );
  const projectOrganizationGroups = useMemo<readonly SidebarFlatGroup[]>(() => {
    if (groupBy !== "project" || !projection) return [];
    const groups: SidebarFlatGroup[] = [];
    for (const workspace of scope.projectOptions) {
      if (
        projectFilterName !== null &&
        workspace.label.text !== projectFilterName
      ) {
        continue;
      }
      const threads = flattenProjectNodes(
        sortProjectNodes(
          projection.rootsByBucket.get(`workspace:${workspace.id}`) ?? [],
          compareProjectRoots(modePreferences),
        ),
      );
      if (threads.length === 0) continue;
      groups.push({
        key: `workspace:${workspace.id}`,
        label: workspaceDisplayLabel({
          workspace,
          workspaces: scope.projectOptions,
          environments: environments.filter(({ kind }) => kind !== "local"),
          includeEnvironment: locationSuppression.showEnvironment,
        }),
        kind: "state",
        futureTimes: false,
        threads,
      });
    }
    const shelves = [
      {
        key: "automations",
        label: "Automations",
        visible: true,
        compare: compareProjectRoots(modePreferences),
      },
      {
        key: "snoozed",
        label: "Snoozed",
        visible: viewPreferences.show.snoozed,
        compare: compareSnoozedRoots,
      },
      {
        key: "settled",
        label: "Settled",
        visible: viewPreferences.show.settled,
        compare: compareProjectRoots(modePreferences),
      },
    ] as const;
    for (const shelf of shelves) {
      if (!shelf.visible) continue;
      const threads = flattenProjectNodes(
        sortProjectNodes(
          projection.rootsByBucket.get(shelf.key) ?? [],
          shelf.compare,
        ),
      );
      if (threads.length === 0) continue;
      groups.push({
        key: shelf.key,
        label: shelf.label,
        kind: "state",
        futureTimes: shelf.key === "snoozed",
        threads,
      });
    }
    return groups;
  }, [
    environments,
    groupBy,
    locationSuppression.showEnvironment,
    modePreferences,
    projectFilterName,
    projection,
    scope.projectOptions,
    viewPreferences.show.settled,
    viewPreferences.show.snoozed,
  ]);
  const stackedProjectGroups = useMemo(
    () =>
      projectSidebarStacks({
        groups: projectOrganizationGroups,
        stackBy: effectiveStackBy,
        threadGroups,
        workspaceLabels: workspaceStackLabels,
      }),
    [
      effectiveStackBy,
      projectOrganizationGroups,
      threadGroups,
      workspaceStackLabels,
    ],
  );
  const workspaceLabelFor = (
    workspaceId: string,
    includeEnvironment = false,
  ) => {
    const workspace = workspaceById.get(workspaceId);
    return workspace
      ? workspaceDisplayLabel({
          workspace,
          workspaces,
          environments: nonLocalEnvironments,
          includeEnvironment,
        })
      : undefined;
  };
  const environmentLabelFor = (workspaceId: string) => {
    const workspace = workspaceById.get(workspaceId);
    const environment = workspace
      ? environmentById.get(workspace.environmentId)
      : undefined;
    return environment
      ? environmentDisplayLabel(environment, environments)
      : undefined;
  };
  const targetLabelFor = (targetId: string) => {
    const target = targetById.get(targetId);
    return target
      ? targetDisplayLabel({
          target,
          targets: executionTargets,
          environments,
          includeEnvironment: false,
        })
      : undefined;
  };
  const shelfLocationLabelFor = (
    thread: NormalizedApplicationThreadSummary,
  ) => {
    const parts: string[] = [];
    if (scope.projectName === null) {
      const workspaceLabel = workspaceLabelFor(
        thread.workspaceId,
        locationSuppression.showEnvironment,
      );
      if (workspaceLabel) parts.push(workspaceLabel);
    }
    return parts.length > 0 ? parts.join(" · ") : undefined;
  };
  /**
   * Fork context for the flat rows' quiet ⑂ affordance, archive impact, and
   * the context menu's lineage placement/provenance commands.
   */
  const forkContext = useMemo(() => {
    const origins = new Map<string, NormalizedThreadForkOrigin>();
    const titles = new Map<string, string>();
    for (const { thread: descendantThread, origin } of descendants) {
      origins.set(origin.childThreadId, origin);
      titles.set(descendantThread.id, descendantThread.title.text);
    }
    for (const origin of snapshot?.forkOrigins ?? []) {
      origins.set(origin.childThreadId, origin);
    }
    for (const summary of snapshot?.threads ?? []) {
      titles.set(summary.id, summary.title.text);
    }
    // Freshest placement wins, mirroring deriveSidebarLineage's precedence.
    const placements = new Map<string, NormalizedThreadLineagePlacement>();
    for (const placement of [
      ...descendants.map(({ placement: paged }) => paged),
      ...(snapshot?.lineagePlacements ?? []),
    ]) {
      const current = placements.get(placement.childThreadId);
      if (!current || placement.revision >= current.revision) {
        placements.set(placement.childThreadId, placement);
      }
    }
    const familyCounts = new Map(
      snapshot?.lineageFamilies.map(({ sourceThreadId, descendantCount }) => [
        sourceThreadId,
        descendantCount,
      ]) ?? [],
    );
    const loadedFamilyCounts = new Map<string, number>();
    const loadedThreadIds = new Set([
      ...(snapshot?.threads.map(({ id }) => id) ?? []),
      ...descendants.map(({ thread }) => thread.id),
    ]);
    for (const threadId of loadedThreadIds) {
      const seen = new Set([threadId]);
      let currentId = threadId;
      while (true) {
        const sourceId = origins.get(currentId)?.sourceThreadId;
        if (!sourceId || seen.has(sourceId)) break;
        loadedFamilyCounts.set(
          sourceId,
          (loadedFamilyCounts.get(sourceId) ?? 0) + 1,
        );
        seen.add(sourceId);
        currentId = sourceId;
      }
    }
    return { origins, titles, placements, familyCounts, loadedFamilyCounts };
  }, [descendants, snapshot]);
  const forkInfoFor = (
    thread: NormalizedApplicationThreadSummary,
  ): FlatThreadRowForkInfo | undefined => {
    const origin = forkContext.origins.get(thread.id);
    if (origin) {
      const sourceTitle = origin.sourceThreadId
        ? forkContext.titles.get(origin.sourceThreadId)
        : undefined;
      return sourceTitle ? { isChild: true, sourceTitle } : { isChild: true };
    }
    const descendantCount =
      (scope.activeFilterCount === 0
        ? forkContext.familyCounts
        : scopedLineageFamilyCounts
      ).get(thread.id) ?? 0;
    return descendantCount > 0
      ? { isChild: false, descendantCount }
      : undefined;
  };
  /** Lineage inputs for a flat row's context menu (placement + provenance). */
  const menuLineageFor = (
    thread: NormalizedApplicationThreadSummary,
  ): FlatRowMenuLineage => {
    const origin = forkContext.origins.get(thread.id);
    return {
      origin,
      placement: forkContext.placements.get(thread.id),
      sourceTitle: origin?.sourceThreadId
        ? forkContext.titles.get(origin.sourceThreadId)
        : undefined,
    };
  };
  const [flatCollapsed, setFlatCollapsed] = useSidebarDisclosures(`flat:${groupBy}`);
  const [projectFlatCollapsed, setProjectFlatCollapsed] = useSidebarDisclosures("flat:project");
  const [flatExpanded, setFlatExpanded] = useState<
    Partial<Record<SidebarGroupBy, Record<string, boolean>>>
  >({});
  // The peek pop-out is suppressed while the view-options popover is open
  // (spec: "Hidden while the options popover is open").
  const [viewOptionsOpen, setViewOptionsOpen] = useState(false);
  const peek = useThreadPeek({
    enabled:
      peekEnabled && Boolean(flatModePreferences?.peek) && !viewOptionsOpen,
  });
  const peekTarget = useMemo(() => {
    if (peek.peekId === null) return undefined;
    for (const group of stackedFlatGroups) {
      for (const entry of group.entries) {
        const thread =
          entry.kind === "thread"
            ? entry.thread.id === peek.peekId
              ? entry.thread
              : undefined
            : entry.members.find(({ id }) => id === peek.peekId);
        if (thread) {
          return {
            thread,
            futureTimes:
              group.futureTimes ||
              (group.kind === "pinned" && isUpcomingThread(thread)),
          };
        }
      }
    }
    return undefined;
  }, [peek.peekId, stackedFlatGroups]);
  const handleSortChange = (sortBy: SidebarSortBy) => {
    if (modePreferences.sortBy === sortBy) {
      // Re-selecting the active sort flips its direction.
      updateSidebarModePreferences(groupBy, {
        direction: modePreferences.direction === "asc" ? "desc" : "asc",
      });
      return;
    }
    updateSidebarModePreferences(groupBy, {
      sortBy,
      direction: sortBy === "alpha" ? "asc" : "desc",
    });
  };
  const scrollContainer = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const container = scrollContainer.current;
    if (!container || !scrollPosition) return;
    container.scrollTop = scrollPosition.current;
    return () => {
      scrollPosition.current = container.scrollTop;
    };
  }, [scrollPosition]);
  const quickSwitchStateRef = useRef<SidebarQuickSwitchState>(
    IDLE_SIDEBAR_QUICK_SWITCH,
  );
  const quickSwitchCallbacksRef = useRef({ onNavigate, onSelectThread });
  const sidebarNavigationThreadIdRef = useRef(selectedThreadId);
  useEffect(() => {
    quickSwitchCallbacksRef.current = { onNavigate, onSelectThread };
  }, [onNavigate, onSelectThread]);
  useEffect(() => {
    sidebarNavigationThreadIdRef.current = selectedThreadId;
  }, [selectedThreadId]);
  const [quickSwitchState, setQuickSwitchState] =
    useState<SidebarQuickSwitchState>(IDLE_SIDEBAR_QUICK_SWITCH);
  useEffect(() => {
    let pendingQuickSwitch: PendingSidebarQuickSwitch | undefined;
    let confirmationTimerId: number | undefined;
    const publishQuickSwitchState = (next: SidebarQuickSwitchState) => {
      quickSwitchStateRef.current = next;
      setQuickSwitchState(next);
    };
    const cancelPendingQuickSwitch = () => {
      if (pendingQuickSwitch === undefined) return;
      window.clearTimeout(pendingQuickSwitch.timerId);
      pendingQuickSwitch = undefined;
    };
    const cancelConfirmation = () => {
      if (confirmationTimerId === undefined) return;
      window.clearTimeout(confirmationTimerId);
      confirmationTimerId = undefined;
    };
    const beginQuickSwitch = (modifier: PrimaryShortcutModifier) => {
      if (
        (quickSwitchStateRef.current.kind === "hints" &&
          quickSwitchStateRef.current.modifier === modifier) ||
        pendingQuickSwitch?.modifier === modifier
      ) {
        return;
      }
      cancelPendingQuickSwitch();
      cancelConfirmation();
      if (quickSwitchStateRef.current.kind !== "idle") {
        publishQuickSwitchState(IDLE_SIDEBAR_QUICK_SWITCH);
      }
      const threadIds = visibleSidebarQuickSwitchThreadIds(
        scrollContainer.current,
      );
      let timerId = 0;
      timerId = window.setTimeout(() => {
        if (pendingQuickSwitch?.timerId !== timerId) return;
        pendingQuickSwitch = undefined;
        publishQuickSwitchState({ kind: "hints", modifier, threadIds });
      }, SIDEBAR_QUICK_SWITCH_HOLD_DELAY_MS);
      pendingQuickSwitch = {
        modifier,
        threadIds,
        timerId,
      };
    };
    const clearQuickSwitch = () => {
      cancelPendingQuickSwitch();
      cancelConfirmation();
      if (quickSwitchStateRef.current.kind === "idle") return;
      publishQuickSwitchState(IDLE_SIDEBAR_QUICK_SWITCH);
    };
    const clearQuickSwitchHints = () => {
      cancelPendingQuickSwitch();
      if (quickSwitchStateRef.current.kind !== "hints") return;
      publishQuickSwitchState(IDLE_SIDEBAR_QUICK_SWITCH);
    };
    const confirmQuickSwitch = (
      modifier: PrimaryShortcutModifier,
      threadId: string,
      commandIndex: number,
    ) => {
      cancelConfirmation();
      publishQuickSwitchState({
        kind: "confirmation",
        modifier,
        threadId,
        commandIndex,
      });
      const timerId = window.setTimeout(() => {
        if (confirmationTimerId !== timerId) return;
        confirmationTimerId = undefined;
        if (quickSwitchStateRef.current.kind === "confirmation") {
          publishQuickSwitchState(IDLE_SIDEBAR_QUICK_SWITCH);
        }
      }, SIDEBAR_QUICK_SWITCH_CONFIRMATION_MS);
      confirmationTimerId = timerId;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifierKey = primaryShortcutModifierForKey(event.key);
      const modifier = activePrimaryShortcutModifier(event);
      // Recover even if the browser or OS swallowed the original key-up.
      if (modifierKey === undefined && modifier === undefined) {
        clearQuickSwitch();
      }
      if (event.defaultPrevented || event.isComposing) return;
      if (modifierKey !== undefined) {
        // Hints are a hold-one-modifier gesture. Cancel as soon as another
        // modifier joins it; system chords (for example macOS screenshots)
        // may consume every subsequent key and key-up event.
        if (modifier !== modifierKey || event.altKey || event.shiftKey) {
          clearQuickSwitch();
          return;
        }
        beginQuickSwitch(modifierKey);
        return;
      }
      if (modifier === undefined || event.repeat) return;
      // A second key ends the hold gesture. Preserve the visible snapshot long
      // enough to resolve a number command, then clear so a swallowed primary
      // key-up after any chord cannot strand the hints.
      cancelPendingQuickSwitch();
      const commandIndex = SIDEBAR_QUICK_SWITCH_COMMANDS.findIndex(
        ({ defaultBinding }) => matchesKeyboardShortcut(event, defaultBinding),
      );
      const threadIds =
        quickSwitchStateRef.current.kind === "hints" &&
        quickSwitchStateRef.current.modifier === modifier
          ? quickSwitchStateRef.current.threadIds
          : visibleSidebarQuickSwitchThreadIds(scrollContainer.current);
      if (commandIndex < 0) {
        clearQuickSwitch();
        return;
      }
      const threadId = threadIds[commandIndex];
      if (threadId === undefined) {
        clearQuickSwitch();
        return;
      }
      confirmQuickSwitch(modifier, threadId, commandIndex);
      event.preventDefault();
      quickSwitchCallbacksRef.current.onSelectThread?.(
        threadId,
        getPanelPresentation(),
      );
      navigate(threadPath(threadId));
      quickSwitchCallbacksRef.current.onNavigate();
    };
    const handleKeyUp = (event: KeyboardEvent) => {
      const released = primaryShortcutModifierForKey(event.key);
      if (released !== undefined) clearQuickSwitchHints();
    };
    const handlePointerDown = (event: PointerEvent) => {
      if (activePrimaryShortcutModifier(event) === undefined) {
        clearQuickSwitch();
      }
    };
    window.addEventListener("keydown", handleKeyDown, { capture: true });
    window.addEventListener("keyup", handleKeyUp, { capture: true });
    window.addEventListener("blur", clearQuickSwitch);
    window.addEventListener("focus", clearQuickSwitch);
    window.addEventListener("pagehide", clearQuickSwitch);
    window.addEventListener("pointerdown", handlePointerDown, {
      capture: true,
    });
    document.addEventListener("visibilitychange", clearQuickSwitch);
    return () => {
      cancelPendingQuickSwitch();
      cancelConfirmation();
      window.removeEventListener("keydown", handleKeyDown, { capture: true });
      window.removeEventListener("keyup", handleKeyUp, { capture: true });
      window.removeEventListener("blur", clearQuickSwitch);
      window.removeEventListener("focus", clearQuickSwitch);
      window.removeEventListener("pagehide", clearQuickSwitch);
      window.removeEventListener("pointerdown", handlePointerDown, {
        capture: true,
      });
      document.removeEventListener("visibilitychange", clearQuickSwitch);
    };
  }, []);
  useEffect(() => {
    const handleAdjacentThreadShortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        keyboardEventTargetBlocksSidebarNavigation(event.target)
      ) {
        return;
      }
      const direction = matchesKeyboardShortcut(
        event,
        SIDEBAR_ADJACENT_THREAD_COMMANDS.previous.defaultBinding,
      )
        ? -1
        : matchesKeyboardShortcut(
              event,
              SIDEBAR_ADJACENT_THREAD_COMMANDS.next.defaultBinding,
            )
          ? 1
          : undefined;
      if (direction === undefined) return;
      const row = sidebarAdjacentThreadRow(
        scrollContainer.current,
        sidebarNavigationThreadIdRef.current,
        direction,
      );
      const threadId = row?.dataset.threadId;
      if (!row || threadId === undefined) return;
      event.preventDefault();
      sidebarNavigationThreadIdRef.current = threadId;
      quickSwitchCallbacksRef.current.onSelectThread?.(
        threadId,
        getPanelPresentation(),
      );
      navigate(threadPath(threadId));
      row.scrollIntoView?.({ block: "nearest" });
      quickSwitchCallbacksRef.current.onNavigate();
    };
    // Bubble phase deliberately lets focused panel and editor shortcuts keep
    // their established meaning before this global sidebar fallback runs.
    window.addEventListener("keydown", handleAdjacentThreadShortcut);
    return () =>
      window.removeEventListener("keydown", handleAdjacentThreadShortcut);
  }, []);
  const viewKey = `${groupBy}:${effectiveStackBy}`;
  const previousViewKey = useRef(viewKey);
  // View switch: 120ms crossfade (CSS suppresses it under reduced motion)
  // and the selection stays the anchor — scroll it into view after reflow.
  useEffect(() => {
    if (previousViewKey.current === viewKey) return;
    previousViewKey.current = viewKey;
    const container = scrollContainer.current;
    if (!container) return;
    container.classList.remove("sidebar-view-fade");
    void container.offsetWidth;
    container.classList.add("sidebar-view-fade");
    if (!selectedThreadId) return;
    const stackGroups =
      groupBy === "project" ? stackedProjectGroups : stackedFlatGroups;
    const selectedEntry = stackGroups
      .flatMap(({ entries }) => entries)
      .find((entry) =>
        entry.kind === "thread"
          ? entry.thread.id === selectedThreadId
          : entry.members.some(({ id }) => id === selectedThreadId),
      );
    const anchorThreadId =
      selectedEntry?.kind === "stack"
        ? selectedEntry.representative.id
        : selectedThreadId;
    const escaped =
      typeof CSS !== "undefined" && typeof CSS.escape === "function"
        ? CSS.escape(anchorThreadId)
        : anchorThreadId;
    const row = container.querySelector<HTMLElement>(
      `[data-thread-id="${escaped}"]`,
    );
    row?.scrollIntoView?.({ block: "nearest" });
  }, [
    groupBy,
    selectedThreadId,
    stackedFlatGroups,
    stackedProjectGroups,
    viewKey,
  ]);
  const selectedThread = snapshot?.threads.find(
    ({ id }) => id === selectedThreadId,
  );
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [projectExpanded, setProjectExpanded] = useSidebarDisclosures("projects");
  useEffect(() => {
    if (projectFilterName !== null || !selectedThread?.workspaceId)
      return;
    setProjectExpanded((current) =>
      current[selectedThread.workspaceId] !== undefined
        ? current
        : { ...current, [selectedThread.workspaceId]: true },
    );
  }, [projectFilterName, selectedThreadId, selectedThread?.workspaceId, setProjectExpanded]);
  const shownThreads = threads.filter(keepShownThread);
  const active = shownThreads.filter(
    ({ inventoryState, automation }) =>
      inventoryState === "active" && !automation,
  );
  const automated = shownThreads.filter(
    ({ inventoryState, automation }) =>
      inventoryState === "active" && Boolean(automation),
  );
  const snoozed = shownThreads.filter(
    ({ inventoryState }) => inventoryState === "snoozed",
  );
  const settled = shownThreads.filter(
    ({ inventoryState }) => inventoryState === "settled",
  );
  const scopedInventoryThreads = scopedSnapshot?.threads ?? [];
  const scopedAutomationCount = scopedInventoryThreads.filter(
    ({ inventoryState, automation }) =>
      inventoryState === "active" && Boolean(automation),
  ).length;
  const scopedSnoozedCount = scopedInventoryThreads.filter(
    ({ inventoryState }) => inventoryState === "snoozed",
  ).length;
  const scopedSettledCount = scopedInventoryThreads.filter(
    ({ inventoryState }) => inventoryState === "settled",
  ).length;
  return (
    <SidebarQuickSwitchContext.Provider value={quickSwitchState}>
      <div
        className="sidebar-inner"
        data-environment-tint-mode={environmentTintMode}
        data-environment-palette={environmentPalette}
        data-quick-switch-visible={
          quickSwitchState.kind === "hints" ? "true" : undefined
        }
        style={sidebarEnvironmentTintStyle}
      >
        <header className="sidebar-header">
          <Collapsible.Root
            className="sidebar-scope"
            open={!viewPreferences.scopeCollapsed}
            onOpenChange={(open) => setSidebarScopeCollapsed(!open)}
          >
            <div className="sidebar-scope-header">
              <Collapsible.Trigger
                className="sidebar-scope-trigger"
                aria-label={`${viewPreferences.scopeCollapsed ? "Expand" : "Collapse"} thread scope${scope.activeFilterCount > 0 ? `, ${scope.activeFilterCount} active: ${scopeSummary}` : ""}`}
                aria-controls={scopeContentId}
                aria-expanded={!viewPreferences.scopeCollapsed}
                title={scope.activeFilterCount > 0 ? scopeSummary : undefined}
              >
                <span className="sidebar-scope-trigger-copy">
                  <span className="sidebar-scope-heading">
                    Scope
                    {scope.activeFilterCount > 0 && (
                      <em
                        aria-label={`${scope.activeFilterCount} active scope filters`}
                      >
                        {scope.activeFilterCount}
                      </em>
                    )}
                  </span>
                  {viewPreferences.scopeCollapsed &&
                    scope.activeFilterCount > 0 && (
                      <span className="sidebar-scope-summary">
                        {visibleScopeSummary}
                      </span>
                    )}
                </span>
                <ChevronDown className="sidebar-scope-chevron" size={14} />
              </Collapsible.Trigger>
              {scope.activeFilterCount > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="sidebar-scope-clear"
                  onClick={() =>
                    setSidebarInventoryScope({
                      environmentFilterId: null,
                      targetFilterId: null,
                      projectFilterName: null,
                      groupFilterId: null,
                      ungroupedFilter: false,
                    })
                  }
                >
                  Clear
                </Button>
              )}
            </div>
            <Collapsible.Content
              id={scopeContentId}
              className="sidebar-scope-content"
            >
              {(environments.length > 1 || scope.environmentId !== null) && (
                <ScopeSelect
                  label="Environment"
                  icon={<ListTree size={14} strokeWidth={1.8} />}
                  value={scope.environmentId ?? ALL_ENVIRONMENTS_FILTER_VALUE}
                  allValue={ALL_ENVIRONMENTS_FILTER_VALUE}
                  allLabel="All environments"
                  testId="environment-filter"
                  options={scope.environmentOptions.map((environment) => ({
                    id: environment.id,
                    label: environmentDisplayLabel(environment, environments),
                    available: environment.available,
                    icon: <EnvironmentScopeIcon kind={environment.kind} />,
                    searchTerms: [environment.label.text, environment.kind],
                  }))}
                  onChange={(value) =>
                    setSidebarInventoryScope(
                      transitionSidebarInventoryScope(
                        {
                          environments,
                          executionTargets,
                          workspaces,
                          groups: threadGroups,
                        },
                        viewPreferences,
                        {
                          environmentFilterId:
                            value === ALL_ENVIRONMENTS_FILTER_VALUE
                              ? null
                              : value,
                        },
                      ),
                    )
                  }
                />
              )}
              {(scope.targetOptions.length > 1 || scope.targetId !== null) && (
                <ScopeSelect
                  label="Target"
                  icon={<Box size={14} strokeWidth={1.8} />}
                  value={scope.targetId ?? ALL_TARGETS_FILTER_VALUE}
                  allValue={ALL_TARGETS_FILTER_VALUE}
                  allLabel="All targets"
                  testId="target-filter"
                  options={scope.targetOptions.map((target) => ({
                    id: target.id,
                    label: targetDisplayLabel({
                      target,
                      targets: scope.targetOptions,
                      environments: nonLocalEnvironments,
                      includeEnvironment:
                        environments.length > 1 && scope.environmentId === null,
                    }),
                    available: target.available,
                    icon: <TargetScopeIcon brand={target.backend.brand} />,
                    searchTerms: [
                      target.backend.label.text,
                      environments.find(({ id }) => id === target.environmentId)?.label.text ?? "",
                    ],
                  }))}
                  onChange={(value) =>
                    setSidebarInventoryScope(
                      transitionSidebarInventoryScope(
                        {
                          environments,
                          executionTargets,
                          workspaces,
                          groups: threadGroups,
                        },
                        viewPreferences,
                        {
                          targetFilterId:
                            value === ALL_TARGETS_FILTER_VALUE ? null : value,
                        },
                      ),
                    )
                  }
                />
              )}
              <ScopeSelect
                label="Project"
                icon={<Folder size={14} strokeWidth={1.8} />}
                value={scope.projectName === null ? ALL_PROJECTS_FILTER_VALUE : `${PROJECT_NAME_FILTER_PREFIX}${scope.projectName}`}
                allValue={ALL_PROJECTS_FILTER_VALUE}
                allLabel="All projects"
                testId="project-filter"
                options={projectNameOptions}
                onChange={(value) =>
                  setSidebarInventoryScope(
                    transitionSidebarInventoryScope(
                      {
                        environments,
                        executionTargets,
                        workspaces,
                        groups: threadGroups,
                      },
                      viewPreferences,
                      {
                        projectFilterName:
                          value === ALL_PROJECTS_FILTER_VALUE ? null : value.slice(PROJECT_NAME_FILTER_PREFIX.length),
                      },
                    ),
                  )
                }
              />
              <div className="sidebar-group-scope-row">
                <ScopeSelect
                  label="Group"
                  icon={<Layers3 size={14} strokeWidth={1.8} />}
                  value={
                    scope.ungrouped
                      ? UNGROUPED_FILTER_VALUE
                      : (scope.groupId ?? ALL_GROUPS_FILTER_VALUE)
                  }
                  allValue={ALL_GROUPS_FILTER_VALUE}
                  allLabel="All groups"
                  testId="group-filter"
                  options={[
                    {
                      id: UNGROUPED_FILTER_VALUE,
                      label: "Ungrouped",
                      available: true,
                      pinned: true,
                    },
                    ...scope.groupOptions.map((group) => ({
                      id: group.id,
                      label: `${group.name} (${group.activeMemberCount})`,
                      available: true,
                    })),
                  ]}
                  onChange={(value) =>
                    setSidebarInventoryScope({
                      groupFilterId:
                        value === ALL_GROUPS_FILTER_VALUE ||
                        value === UNGROUPED_FILTER_VALUE
                          ? null
                          : value,
                      ungroupedFilter: value === UNGROUPED_FILTER_VALUE,
                    })
                  }
                />
                {groupFilter && (
                  <GroupManagementControl group={groupFilter} store={store} />
                )}
              </div>
            </Collapsible.Content>
          </Collapsible.Root>
          <div className="sidebar-create-actions">
            <NewThreadControl
              store={store}
              workspaces={workspaces}
              environments={environments}
              executionTargets={executionTargets}
              creationScope={{
                environmentId: scope.environmentId,
                targetId: scope.targetId,
                projectName: scope.projectName,
              }}
              className="sidebar-create-action"
              onCreated={(threadId) => {
                onSelectThread?.(threadId, getPanelPresentation());
                navigate(threadPath(threadId));
                onNavigate();
              }}
            >
              <Plus size={15} strokeWidth={1.8} /> New thread
            </NewThreadControl>
            <Button
              className="sidebar-create-action"
              data-testid="workspace-picker"
              onClick={() => setAddProjectOpen(true)}
            >
              <Plus size={15} strokeWidth={1.8} /> Add project
            </Button>
          </div>
          <div className="sidebar-search-row">
            <label className="search-box">
              <Search size={14} strokeWidth={1.8} />
              <span className="sr-only">Search threads</span>
              <Input
                type="search"
                className="border-0 bg-transparent shadow-none focus-visible:ring-0 dark:bg-transparent"
                placeholder="Search threads"
                value={state.search}
                onChange={(event) => store.setSearch(event.target.value)}
              />
            </label>
            <SidebarViewControls
              preferences={viewPreferences}
              onGroupByChange={setSidebarGroupBy}
              onStackByChange={setSidebarStackBy}
              onSortChange={handleSortChange}
              onDensityChange={(density) => {
                if (groupBy !== "project") {
                  updateSidebarModePreferences(groupBy, { density });
                }
              }}
              onPeekToggle={() => {
                if (groupBy !== "project") {
                  updateSidebarModePreferences(groupBy, {
                    peek: !flatModePreferences?.peek,
                  });
                }
              }}
              onPinnedOnlyToggle={() => {
                if (groupBy !== "project") {
                  updateSidebarModePreferences(groupBy, {
                    pinnedOnly: !flatModePreferences?.pinnedOnly,
                  });
                }
              }}
              onShowToggle={(key) =>
                setSidebarShowFilter(key, !viewPreferences.show[key])
              }
              onGroupForksToggle={() =>
                setSidebarGroupForks(!viewPreferences.groupForks)
              }
              onBackendIconsToggle={() =>
                setSidebarShowBackendIcons(!viewPreferences.showBackendIcons)
              }
              onResetMode={() => resetSidebarMode(groupBy)}
              onOptionsOpenChange={setViewOptionsOpen}
            />
          </div>
        </header>

        <nav
          ref={scrollContainer}
          className="inventory-scroll"
          aria-label="Threads and automations"
        >
          {groupBy !== "project" ? (
            <FlatGroupList
              groups={stackedFlatGroups}
              groupBy={groupBy}
              density={flatModePreferences!.density}
              mobile={!peekEnabled}
              showBackendBrand={viewPreferences.showBackendIcons}
              searchActive={Boolean(state.search)}
              pinnedOnly={flatModePreferences!.pinnedOnly}
              projectFilterLabel={
                scope.activeFilterCount > 0 ? scopeSummary : undefined
              }
              collapsed={flatCollapsed}
              onToggleGroup={(groupKey, open) =>
                setFlatCollapsed((current) => ({
                  ...current,
                  [groupKey]: !open,
                }))
              }
              expanded={flatExpanded[groupBy] ?? {}}
              onExpandGroup={(groupKey) =>
                setFlatExpanded((current) => ({
                  ...current,
                  [groupBy]: { ...current[groupBy], [groupKey]: true },
                }))
              }
              selectedThreadId={selectedThreadId}
              workspaceLabelFor={(workspaceId) =>
                workspaceLabelFor(workspaceId)
              }
              environmentLabelFor={environmentLabelFor}
              showProjectLabel={locationSuppression.showProject}
              showEnvironmentLabel={locationSuppression.showEnvironment}
              forkInfoFor={forkInfoFor}
              taskSummaryFor={(threadId) => taskSummaryByThreadId.get(threadId)}
              menuLineageFor={menuLineageFor}
              archiveDescendantCountFor={(threadId) =>
                globalLineageFamilyCounts.get(threadId) ?? 0
              }
              configurationCopyPendingFor={(threadId) =>
                state.pendingThreadConfigurationCopySourceIds.includes(threadId)
              }
              descendantPagingFor={(threadId) => {
                if (scope.activeFilterCount > 0) {
                  return { canLoad: false, loading: false };
                }
                const page = state.descendantPages[threadId];
                const canLoad =
                  Boolean(page?.nextCursor) ||
                  (!page?.loaded &&
                    (forkContext.familyCounts.get(threadId) ?? 0) >
                      (forkContext.loadedFamilyCounts.get(threadId) ?? 0));
                return {
                  canLoad,
                  loading: page?.loading ?? false,
                  error: page?.error,
                };
              }}
              store={store}
              threadRegistry={threadRegistry}
              onSelectThread={onSelectThread}
              onNavigate={onNavigate}
              peekBind={peek.bind}
              onDismissPeek={peek.hide}
              onFilterGroup={(groupId) =>
                setSidebarInventoryScope({
                  groupFilterId: groupId,
                  ungroupedFilter: false,
                })
              }
              renderGroupManagement={(
                group,
                elevated,
                onInteractionOpenChange,
              ) => (
                <GroupManagementControl
                  group={group}
                  store={store}
                  elevated={elevated}
                  onInteractionOpenChange={onInteractionOpenChange}
                />
              )}
              environmentTintStyleForWorkspace={
                environmentTintStyleForWorkspace
              }
            />
          ) : (
            <>
              <section className="projects-section">
                <div className="projects-header">
                  <h2>Projects</h2>

                </div>
                {effectiveStackBy !== "none" ? (
                  <FlatGroupList
                    groups={stackedProjectGroups}
                    groupBy="project"
                    density="compact"
                    mobile={!peekEnabled}
                    showBackendBrand={viewPreferences.showBackendIcons}
                    searchActive={false}
                    pinnedOnly={false}
                    projectFilterLabel={
                      scope.activeFilterCount > 0 ? scopeSummary : undefined
                    }
                    collapsed={projectFlatCollapsed}
                    onToggleGroup={(groupKey, open) =>
                      setProjectFlatCollapsed((current) => ({
                        ...current,
                        [groupKey]: !open,
                      }))
                    }
                    expanded={flatExpanded.project ?? {}}
                    onExpandGroup={(groupKey) =>
                      setFlatExpanded((current) => ({
                        ...current,
                        project: { ...current.project, [groupKey]: true },
                      }))
                    }
                    selectedThreadId={selectedThreadId}
                    workspaceLabelFor={(workspaceId) =>
                      workspaceLabelFor(workspaceId)
                    }
                    environmentLabelFor={environmentLabelFor}
                    showProjectLabel={false}
                    showEnvironmentLabel={locationSuppression.showEnvironment}
                    forkInfoFor={forkInfoFor}
                    taskSummaryFor={(threadId) =>
                      taskSummaryByThreadId.get(threadId)
                    }
                    menuLineageFor={menuLineageFor}
                    archiveDescendantCountFor={(threadId) =>
                      globalLineageFamilyCounts.get(threadId) ?? 0
                    }
                    configurationCopyPendingFor={(threadId) =>
                      state.pendingThreadConfigurationCopySourceIds.includes(
                        threadId,
                      )
                    }
                    descendantPagingFor={(threadId) => {
                      if (scope.activeFilterCount > 0) {
                        return { canLoad: false, loading: false };
                      }
                      const page = state.descendantPages[threadId];
                      return {
                        canLoad:
                          Boolean(page?.nextCursor) ||
                          (!page?.loaded &&
                            (forkContext.familyCounts.get(threadId) ?? 0) >
                              (forkContext.loadedFamilyCounts.get(threadId) ??
                                0)),
                        loading: page?.loading ?? false,
                        error: page?.error,
                      };
                    }}
                    store={store}
                    threadRegistry={threadRegistry}
                    onSelectThread={onSelectThread}
                    onNavigate={onNavigate}
                    peekBind={peek.bind}
                    onDismissPeek={peek.hide}
                    onFilterGroup={(groupId) =>
                      setSidebarInventoryScope({
                        groupFilterId: groupId,
                        ungroupedFilter: false,
                      })
                    }
                    renderGroupManagement={(
                      group,
                      elevated,
                      onInteractionOpenChange,
                    ) => (
                      <GroupManagementControl
                        group={group}
                        store={store}
                        elevated={elevated}
                        onInteractionOpenChange={onInteractionOpenChange}
                      />
                    )}
                    environmentTintStyleForWorkspace={
                      environmentTintStyleForWorkspace
                    }
                  />
                ) : (
                  scope.projectOptions
                    .filter(
                      (workspace) =>
                        projectFilterName === null ||
                        workspace.label.text === projectFilterName,
                    )
                    .map((workspace, workspaceIndex) => {
                      const projectDisplayLabel = workspaceDisplayLabel({
                        workspace,
                        workspaces: scope.projectOptions,
                        environments: nonLocalEnvironments,
                        includeEnvironment: locationSuppression.showEnvironment,
                      });
                      const isActive =
                        workspace.label.text === projectFilterName;
                      const expanded =
                        projectExpanded[workspace.id] ??
                        (isActive ||
                          workspace.id === selectedThread?.workspaceId ||
                          (selectedThread === undefined &&
                            workspaceIndex === 0));
                      const projectNodes = sortProjectNodes(
                        projection?.rootsByBucket.get(
                          `workspace:${workspace.id}`,
                        ) ?? [],
                        compareProjectRoots(modePreferences),
                      );
                      return (
                        <Collapsible.Root
                          key={workspace.id}
                          className="project-group"
                          open={expanded}
                          onOpenChange={(open) => {
                            setProjectExpanded((previous) => ({
                              ...previous,
                              [workspace.id]: open,
                            }));
                          }}
                        >
                          <div className="project-row-shell">
                            <Collapsible.Trigger
                              className="project-row"
                              data-testid="project-row"
                              data-active={isActive ? "true" : "false"}
                            >
                              <Folder size={14} strokeWidth={1.8} />
                              <span className="project-name">
                                {projectDisplayLabel}
                              </span>
                              <ChevronDown
                                size={13}
                                strokeWidth={1.8}
                                className="project-chevron"
                              />
                            </Collapsible.Trigger>
                            <button
                              type="button"
                              className="project-filter-shortcut"
                              aria-label={
                                isActive
                                  ? `Clear ${workspace.label.text} filter`
                                  : `Filter to ${workspace.label.text}`
                              }
                              aria-pressed={isActive}
                              title={
                                isActive
                                  ? `Clear ${workspace.label.text} filter`
                                  : `Filter to ${workspace.label.text}`
                              }
                              onClick={() => {
                                setSidebarInventoryScope(
                                  transitionSidebarInventoryScope(
                                    {
                                      environments,
                                      executionTargets,
                                      workspaces,
                                      groups: threadGroups,
                                    },
                                    viewPreferences,
                                    {
                                      projectFilterName: isActive
                                        ? null
                                        : workspace.label.text,
                                    },
                                  ),
                                );
                                if (!isActive) {
                                  setProjectExpanded((current) => ({
                                    ...current,
                                    [workspace.id]: true,
                                  }));
                                }
                              }}
                            >
                              <ListFilter size={13} strokeWidth={1.8} />
                            </button>
                          </div>
                          <Collapsible.Content className="project-threads">
                            <LineageRows
                              nodes={projectNodes}
                              state={state}
                              store={store}
                              threadRegistry={threadRegistry}
                              selectedThreadId={selectedThreadId}
                              onSelectThread={onSelectThread}
                              onNavigate={onNavigate}
                              grouped={grouped}
                              showBackendBrand={
                                viewPreferences.showBackendIcons
                              }
                              locationLabelFor={() => undefined}
                              taskSummaryFor={(threadId) =>
                                taskSummaryByThreadId.get(threadId)
                              }
                              archiveDescendantCountFor={(threadId) =>
                                globalLineageFamilyCounts.get(threadId) ?? 0
                              }
                              allowDescendantPaging={
                                scope.activeFilterCount === 0
                              }
                              environmentTintStyleForWorkspace={
                                environmentTintStyleForWorkspace
                              }
                            />
                          </Collapsible.Content>
                        </Collapsible.Root>
                      );
                    })
                )}
              </section>
              {effectiveStackBy === "none" &&
                active.length === 0 &&
                automated.length === 0 &&
                !state.search && (
                  <div className="sidebar-empty">
                    <p>No active threads</p>
                    <small>
                      {scope.activeFilterCount > 0
                        ? `No active threads in ${scopeSummary}.`
                        : "Start a thread when an idea is ready."}
                    </small>
                  </div>
                )}
              {effectiveStackBy === "none" &&
                state.search &&
                projection?.matchingIds.size === 0 && (
                  <div className="sidebar-empty">
                    <p>No matching threads</p>
                    <small>
                      Searches titles, projects, environments, and targets.
                    </small>
                  </div>
                )}
              {effectiveStackBy === "none" && (
                <>
                  <Shelf
                    title="Automations"
                    count={scopedAutomationCount}
                    nodes={sortProjectNodes(
                      projection?.rootsByBucket.get("automations") ?? [],
                      compareProjectRoots(modePreferences),
                    )}
                    state={state}
                    selectedThreadId={selectedThreadId}
                    onSelectThread={onSelectThread}
                    onNavigate={onNavigate}
                    kind="automations"
                    store={store}
                    threadRegistry={threadRegistry}
                    showBackendBrand={viewPreferences.showBackendIcons}
                    locationLabelFor={shelfLocationLabelFor}
                    taskSummaryFor={(threadId) =>
                      taskSummaryByThreadId.get(threadId)
                    }
                    archiveDescendantCountFor={(threadId) =>
                      globalLineageFamilyCounts.get(threadId) ?? 0
                    }
                    allowDescendantPaging={scope.activeFilterCount === 0}
                    environmentTintStyleForWorkspace={
                      environmentTintStyleForWorkspace
                    }
                  />
                  {viewPreferences.show.snoozed && (
                    <Shelf
                      title="Snoozed"
                      count={scopedSnoozedCount}
                      nodes={sortProjectNodes(
                        projection?.rootsByBucket.get("snoozed") ?? [],
                        compareSnoozedRoots,
                      )}
                      state={state}
                      selectedThreadId={selectedThreadId}
                      onSelectThread={onSelectThread}
                      onNavigate={onNavigate}
                      kind="snoozed"
                      store={store}
                      threadRegistry={threadRegistry}
                      showBackendBrand={viewPreferences.showBackendIcons}
                      locationLabelFor={shelfLocationLabelFor}
                      taskSummaryFor={(threadId) =>
                        taskSummaryByThreadId.get(threadId)
                      }
                      archiveDescendantCountFor={(threadId) =>
                        globalLineageFamilyCounts.get(threadId) ?? 0
                      }
                      allowDescendantPaging={scope.activeFilterCount === 0}
                      environmentTintStyleForWorkspace={
                        environmentTintStyleForWorkspace
                      }
                    />
                  )}
                  {viewPreferences.show.settled && (
                    <Shelf
                      title="Settled"
                      count={scopedSettledCount}
                      nodes={sortProjectNodes(
                        projection?.rootsByBucket.get("settled") ?? [],
                        compareProjectRoots(modePreferences),
                      )}
                      state={state}
                      selectedThreadId={selectedThreadId}
                      onSelectThread={onSelectThread}
                      onNavigate={onNavigate}
                      kind="settled"
                      store={store}
                      threadRegistry={threadRegistry}
                      showBackendBrand={viewPreferences.showBackendIcons}
                      locationLabelFor={shelfLocationLabelFor}
                      taskSummaryFor={(threadId) =>
                        taskSummaryByThreadId.get(threadId)
                      }
                      archiveDescendantCountFor={(threadId) =>
                        globalLineageFamilyCounts.get(threadId) ?? 0
                      }
                      allowDescendantPaging={scope.activeFilterCount === 0}
                      environmentTintStyleForWorkspace={
                        environmentTintStyleForWorkspace
                      }
                    />
                  )}
                </>
              )}
            </>
          )}
        </nav>
        <footer className="sidebar-footer">
          <SidebarFooterActions
            api={store.api}
            providerPulseEnabled={state.providerPulseEnabled}
            experimentalUsageEnabled={state.experimentalUsageEnabled}
            advisories={snapshot?.advisories}
            connection={
              showFooterConnectionStatus ? state.connection : undefined
            }
            onOpenSettings={onOpenSettings}
            onOpenUsage={() => {
              navigate(usagePath());
              onNavigate();
            }}
            onOpenAgents={() => {
              navigate(agentsPath());
              onNavigate();
            }}
            onOpenArchivedThreads={() => {
              navigate("/archived");
              onNavigate();
            }}
          />
        </footer>
        {peekTarget && peek.position && (
          <ThreadPeekCard
            thread={peekTarget.thread}
            workspaceLabel={
              workspaceLabelFor(peekTarget.thread.workspaceId) ?? "Workspace"
            }
            workspacePath={
              workspaceById.get(peekTarget.thread.workspaceId)?.displayPath.text
            }
            workspaceAvailable={
              workspaceById.get(peekTarget.thread.workspaceId)?.available
            }
            environmentLabel={environmentLabelFor(
              peekTarget.thread.workspaceId,
            )}
            showEnvironment={environments.length > 1}
            environmentAvailable={
              environmentById.get(
                workspaceById.get(peekTarget.thread.workspaceId)
                  ?.environmentId ?? "",
              )?.available
            }
            targetLabel={targetLabelFor(peekTarget.thread.targetId)}
            targetAvailable={
              targetById.get(peekTarget.thread.targetId)?.available
            }
            futureTimes={peekTarget.futureTimes}
            fork={forkInfoFor(peekTarget.thread)}
            position={peek.position}
            panelRef={peek.panelRef}
          />
        )}
        {addProjectOpen && <AddProjectDialog
          store={store}
          environments={environments}
          initialEnvironmentId={scope.effectiveEnvironmentId ?? undefined}
          environmentLocked={scope.effectiveEnvironmentId !== null}
          onClose={() => setAddProjectOpen(false)}
          onAdded={(workspaceId) => {
            // Wait for the authoritative catalog before persisting the new filter.
            setPendingOpenedWorkspace({ id: workspaceId, scopePreferenceKey });
            setProjectExpanded((current) => ({ ...current, [workspaceId]: true }));
          }}
        />}
      </div>
    </SidebarQuickSwitchContext.Provider>
  );
}

type SelectThread = (threadId: string, presentation: PanelPresentation) => void;

function GroupManagementControl({
  group,
  store,
  elevated = false,
  onInteractionOpenChange,
}: {
  readonly group: NormalizedThreadGroup;
  readonly store: ApplicationClientStore;
  readonly elevated?: boolean;
  readonly onInteractionOpenChange?: (open: boolean) => void;
}): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "delete">();
  const [name, setName] = useState(group.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const open = (next: "rename" | "delete") => {
    onInteractionOpenChange?.(true);
    setName(group.name);
    setError("");
    setDialog(next);
  };
  const close = () => {
    if (!pending) setDialog(undefined);
  };
  useEffect(() => {
    onInteractionOpenChange?.(menuOpen || dialog !== undefined);
  }, [dialog, menuOpen, onInteractionOpenChange]);
  const submit = () => {
    if (pending) return;
    const nextName = name.trim();
    if (dialog === "rename" && !nextName) return;
    setPending(true);
    setError("");
    const operation =
      dialog === "rename"
        ? store.renameThreadGroup(group, nextName)
        : store.deleteThreadGroup(group);
    void operation
      .then(() => {
        if (dialog === "delete") {
          setSidebarInventoryScope({
            groupFilterId: null,
            ungroupedFilter: false,
          });
        }
        setDialog(undefined);
      })
      .catch((cause: unknown) => setError(messageFrom(cause)))
      .finally(() => setPending(false));
  };
  return (
    <>
      <DropdownMenu
        open={menuOpen}
        onOpenChange={(nextOpen) => {
          if (nextOpen) onInteractionOpenChange?.(true);
          setMenuOpen(nextOpen);
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className="sidebar-group-manage"
            aria-label={`Manage group ${group.name}`}
            title="Manage group"
          >
            <MoreHorizontal size={15} />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className={elevated ? "z-[100]" : undefined}
        >
          <DropdownMenuItem onSelect={() => open("rename")}>
            Rename group…
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => open("delete")}
          >
            Delete group…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog
        open={dialog !== undefined}
        onOpenChange={(value) => !value && close()}
      >
        <DialogContent
          className={elevated ? "z-[101]" : undefined}
          overlayClassName={elevated ? "z-[100]" : undefined}
        >
          <DialogHeader>
            <DialogTitle>
              {dialog === "rename" ? "Rename group" : "Delete group"}
            </DialogTitle>
            <DialogDescription>
              {dialog === "delete"
                ? group.memberCount === 0
                  ? `Delete “${group.name}”?`
                  : `Delete “${group.name}” and ungroup ${group.memberCount} thread${group.memberCount === 1 ? "" : "s"}?`
                : "Group names are shared across all projects in your account."}
            </DialogDescription>
          </DialogHeader>
          {dialog === "rename" && (
            <Input
              autoFocus
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
          )}
          {error && (
            <p className="thread-row-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={close}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant={dialog === "delete" ? "destructive" : "default"}
              disabled={pending || (dialog === "rename" && !name.trim())}
              onClick={submit}
            >
              {pending
                ? "Saving…"
                : dialog === "delete"
                  ? "Delete group"
                  : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ScopeSelect({
  label,
  icon,
  value,
  allValue,
  allLabel,
  options,
  testId,
  onChange,
}: {
  readonly label: string;
  readonly icon: React.ReactNode;
  readonly value: string;
  readonly allValue: string;
  readonly allLabel: string;
  readonly options: readonly {
    readonly id: string;
    readonly label: string;
    readonly available: boolean;
    readonly icon?: React.ReactNode;
    readonly searchTerms?: readonly string[];
    readonly pinned?: boolean;
  }[];
  readonly testId: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  const plural = `${label.toLocaleLowerCase()}s`;
  return (
    <SearchableSelect
      label={`${label} filter`}
      fieldLabel={label}
      searchLabel={`Search ${plural}`}
      emptyLabel={`No matching ${plural}`}
      value={value}
      options={[
        { value: allValue, label: allLabel, icon, pinned: true },
        ...options.map((option) => ({
          value: option.id,
          label: `${option.label}${option.available ? "" : " — Unavailable"}`,
          icon: option.icon ?? icon,
          searchTerms: option.searchTerms,
          pinned: option.pinned,
        })),
      ]}
      triggerProps={{
        className: "sidebar-scope-select",
        "data-testid": testId,
        "data-scope-value": value,
      }}
      onValueChange={onChange}
    />
  );
}

function Shelf({
  title,
  count,
  nodes,
  state,
  selectedThreadId,
  onSelectThread,
  onNavigate,
  kind,
  store,
  threadRegistry,
  showBackendBrand,
  locationLabelFor,
  taskSummaryFor,
  archiveDescendantCountFor,
  allowDescendantPaging,
  environmentTintStyleForWorkspace,
}: {
  title: string;
  count: number;
  nodes: readonly SidebarLineageNode[];
  state: ApplicationClientState;
  selectedThreadId?: string;
  onSelectThread?: SelectThread;
  onNavigate: (options?: { readonly keepDrawerOpen?: boolean }) => void;
  kind: "automations" | "snoozed" | "settled";
  store: ApplicationClientStore;
  threadRegistry?: ThreadStoreRegistry;
  showBackendBrand: boolean;
  locationLabelFor: (
    thread: NormalizedApplicationThreadSummary,
  ) => string | undefined;
  taskSummaryFor: (threadId: string) => FlatThreadRowTaskSummary | undefined;
  archiveDescendantCountFor: (threadId: string) => number;
  allowDescendantPaging: boolean;
  environmentTintStyleForWorkspace: EnvironmentTintStyleForWorkspace;
}): React.JSX.Element {
  const [open, setOpen] = useSidebarDisclosure("shelves", kind, true);
  return (
    <Collapsible.Root
      className={`inventory-shelf ${kind}`}
      data-testid="inventory-shelf"
      data-shelf={kind}
      open={open}
      onOpenChange={setOpen}
    >
      <Collapsible.Trigger className="shelf-trigger">
        <span>
          {title} <em>· {count}</em>
        </span>
        <ChevronDown
          size={13}
          strokeWidth={1.8}
          className={open ? "rotate" : ""}
        />
      </Collapsible.Trigger>
      <Collapsible.Content>
        <LineageRows
          nodes={nodes}
          state={state}
          store={store}
          threadRegistry={threadRegistry}
          selectedThreadId={selectedThreadId}
          onSelectThread={onSelectThread}
          onNavigate={onNavigate}
          grouped
          compact
          kind={kind}
          showBackendBrand={showBackendBrand}
          locationLabelFor={locationLabelFor}
          taskSummaryFor={taskSummaryFor}
          archiveDescendantCountFor={archiveDescendantCountFor}
          allowDescendantPaging={allowDescendantPaging}
          environmentTintStyleForWorkspace={environmentTintStyleForWorkspace}
        />
        {nodes.length === 0 && (
          <p className="shelf-empty">
            {kind === "automations" ? "No automations." : `Nothing ${kind}.`}
          </p>
        )}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

interface GroupModeRowOptions {
  readonly selected: boolean;
  readonly peekBindings?: ThreadPeekBindings;
  readonly showGroupLabel?: boolean;
  readonly beforeSelect?: () => void;
  readonly containerTag?: "li" | "div";
  readonly containerClassName?: string;
  readonly containerTestId?: string;
  readonly stackGroupId?: string;
  readonly stackWorkspaceId?: string;
  readonly showProjectLabel?: boolean;
  readonly representativeThreadId?: string;
  readonly onInteractionOpenChange?: (open: boolean) => void;
  readonly stackFace?: {
    readonly actions: React.ReactNode;
    readonly wrapContextMenu: (children: React.ReactNode) => React.ReactNode;
    readonly representativeSelected: boolean;
    readonly returnFocusRef: React.RefObject<HTMLElement | null>;
  };
}

type RenderGroupModeRow = (
  thread: NormalizedApplicationThreadSummary,
  options: GroupModeRowOptions,
) => React.ReactNode;

const STACK_ACTION_LONG_PRESS_DELAY_MS = 550;
const STACK_ACTION_LONG_PRESS_MOVE_TOLERANCE_PX = 10;

function ThreadStackItem({
  entry,
  stack,
  density,
  mobile,
  selectedThreadId,
  store,
  onNavigate,
  renderRow,
  peekBind,
  onDismissPeek,
  onFilterGroup,
  renderGroupManagement,
}: {
  readonly entry: Extract<SidebarStackEntry, { readonly kind: "stack" }>;
  readonly stack:
    | {
        readonly kind: "group";
        readonly id: string;
        readonly label: string;
        readonly group: NormalizedThreadGroup;
      }
    | {
        readonly kind: "project";
        readonly id: string;
        readonly label: string;
      };
  readonly density: SidebarDensity;
  readonly mobile: boolean;
  readonly selectedThreadId?: string;
  readonly store: ApplicationClientStore;
  readonly onNavigate: (options?: {
    readonly keepDrawerOpen?: boolean;
  }) => void;
  readonly renderRow: RenderGroupModeRow;
  readonly peekBind: (id: string) => ThreadPeekBindings;
  readonly onDismissPeek: () => void;
  readonly onFilterGroup?: (groupId: string) => void;
  readonly renderGroupManagement?: (
    group: NormalizedThreadGroup,
    elevated: boolean,
    onInteractionOpenChange: (open: boolean) => void,
  ) => React.ReactNode;
}): React.JSX.Element {
  const taskDrag = useTaskDrag();
  const [open, setOpen] = useState(false);
  const [autoFocusMembers, setAutoFocusMembers] = useState(false);
  const [stackMenuOpen, setStackMenuOpen] = useState(false);
  const [stackActionOpen, setStackActionOpen] = useState(false);
  const [stackAction, setStackAction] = useState<BulkInventoryAction>();
  const [stackImpact, setStackImpact] =
    useState<
      Awaited<ReturnType<ApplicationClientStore["getBulkInventoryImpact"]>>
    >();
  const [stackImpactLoading, setStackImpactLoading] = useState(false);
  const [stackMutationPending, setStackMutationPending] = useState(false);
  const [stackRequestLocked, setStackRequestLocked] = useState(false);
  const [stackActionError, setStackActionError] = useState("");
  const stackFaceLink = useRef<HTMLElement | null>(null);
  const stackSurfaceInteractionOpen = useRef(false);
  const stackLongPressTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const stackLongPressOrigin = useRef<{ x: number; y: number } | undefined>(
    undefined,
  );
  const suppressStackClick = useRef(false);
  const suppressStackClickTimer = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const impactRequestSequence = useRef(0);
  const requestedStackAction = useRef<
    | {
        readonly action: BulkInventoryAction;
        readonly threadIds: readonly string[];
      }
    | undefined
  >(undefined);
  const confirmedMutation = useRef<BulkInventoryMutationRequest | undefined>(
    undefined,
  );
  const interactionOpen = useRef(false);
  const activeInteractions = useRef(new Set<string>());
  const handleOpenChange = (next: boolean) => {
    if (!next && interactionOpen.current) return;
    setOpen(next);
  };
  const closeTimer = useRef<number | undefined>(undefined);
  const taskDragOpenTimer = useRef<number | undefined>(undefined);
  const cancelTaskDragOpen = () => {
    if (taskDragOpenTimer.current === undefined) return;
    window.clearTimeout(taskDragOpenTimer.current);
    taskDragOpenTimer.current = undefined;
  };
  useEffect(
    () => () => {
      cancelTaskDragOpen();
    },
    [],
  );
  useEffect(() => {
    if (taskDrag?.activeTaskId === undefined) cancelTaskDragOpen();
  }, [taskDrag?.activeTaskId]);
  const cancelClose = () => {
    if (closeTimer.current === undefined) return;
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
  };
  const openRoster = () => {
    cancelClose();
    if (stackSurfaceInteractionOpen.current) return;
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelClose();
    if (interactionOpen.current) return;
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = undefined;
      handleOpenChange(false);
    }, 140);
  };
  const handleInteractionOpenChange = (key: string, next: boolean) => {
    if (next) activeInteractions.current.add(key);
    else activeInteractions.current.delete(key);
    const anyOpen = activeInteractions.current.size > 0;
    interactionOpen.current = anyOpen;
    if (anyOpen) {
      onDismissPeek();
      cancelClose();
      setOpen(true);
    }
  };
  const cancelStackLongPress = () => {
    if (stackLongPressTimer.current) {
      clearTimeout(stackLongPressTimer.current);
    }
    stackLongPressTimer.current = undefined;
    stackLongPressOrigin.current = undefined;
  };
  const openMobileRoster = () => {
    cancelStackLongPress();
    stackSurfaceInteractionOpen.current = false;
    setStackMenuOpen(false);
    cancelClose();
    setAutoFocusMembers(false);
    setOpen(true);
    onDismissPeek();
  };
  const beginStackLongPress = (event: React.PointerEvent<HTMLElement>) => {
    if (
      (event.pointerType !== "touch" && event.pointerType !== "pen") ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    cancelStackLongPress();
    stackLongPressOrigin.current = {
      x: event.clientX,
      y: event.clientY,
    };
    stackLongPressTimer.current = setTimeout(() => {
      stackLongPressTimer.current = undefined;
      stackLongPressOrigin.current = undefined;
      suppressStackClick.current = true;
      if (suppressStackClickTimer.current) {
        clearTimeout(suppressStackClickTimer.current);
      }
      suppressStackClickTimer.current = setTimeout(() => {
        suppressStackClick.current = false;
        suppressStackClickTimer.current = undefined;
      }, 1_000);
      openMobileRoster();
    }, STACK_ACTION_LONG_PRESS_DELAY_MS);
  };
  const moveStackLongPress = (event: React.PointerEvent<HTMLElement>) => {
    const origin = stackLongPressOrigin.current;
    if (
      !origin ||
      Math.hypot(event.clientX - origin.x, event.clientY - origin.y) <=
        STACK_ACTION_LONG_PRESS_MOVE_TOLERANCE_PX
    ) {
      return;
    }
    cancelStackLongPress();
  };
  useEffect(
    () => () => {
      cancelClose();
      cancelStackLongPress();
      if (suppressStackClickTimer.current) {
        clearTimeout(suppressStackClickTimer.current);
      }
    },
    [],
  );
  const memberCount = entry.members.length;
  const settleCount = entry.members.filter(
    ({ inventoryState }) => inventoryState !== "settled",
  ).length;
  const unsettleCount = entry.members.filter(
    ({ inventoryState }) => inventoryState === "settled",
  ).length;
  const rosterId = `thread-stack-roster-${entry.stackBy}-${entry.stackId}`;

  const loadStackImpact = (
    action: BulkInventoryAction,
    threadIds: readonly string[],
  ) => {
    const sequence = ++impactRequestSequence.current;
    setStackImpactLoading(true);
    setStackActionError("");
    setStackImpact(undefined);
    confirmedMutation.current = undefined;
    setStackRequestLocked(false);
    void store
      .getBulkInventoryImpact(action, threadIds)
      .then((impact) => {
        if (impactRequestSequence.current !== sequence) return;
        setStackImpact(impact);
      })
      .catch((error: unknown) => {
        if (impactRequestSequence.current !== sequence) return;
        setStackActionError(messageFrom(error));
      })
      .finally(() => {
        if (impactRequestSequence.current === sequence) {
          setStackImpactLoading(false);
        }
      });
  };
  const requestStackAction = (action: BulkInventoryAction) => {
    const threadIds = Object.freeze(entry.members.map(({ id }) => id));
    requestedStackAction.current = { action, threadIds };
    confirmedMutation.current = undefined;
    stackSurfaceInteractionOpen.current = true;
    setStackMenuOpen(false);
    setOpen(false);
    onDismissPeek();
    setStackAction(action);
    setStackActionOpen(true);
    loadStackImpact(action, threadIds);
  };
  const openRosterFromMenu = () => {
    setAutoFocusMembers(true);
    window.setTimeout(() => {
      stackSurfaceInteractionOpen.current = false;
      openRoster();
    }, 0);
  };
  const reloadStackImpact = () => {
    const request = requestedStackAction.current;
    if (!request) return;
    loadStackImpact(request.action, request.threadIds);
  };
  const confirmStackAction = (options: {
    readonly openTaskDisposition?: OpenTaskDisposition;
  }) => {
    if (!stackImpact || stackMutationPending) return;
    const request =
      confirmedMutation.current ??
      store.createBulkInventoryMutationRequest(stackImpact, options);
    confirmedMutation.current = request;
    setStackRequestLocked(true);
    setStackMutationPending(true);
    setStackActionError("");
    void store
      .mutateBulkInventory(request)
      .then((result) => {
        setStackActionOpen(false);
        if (
          request.action === "archive" &&
          selectedThreadId &&
          result.changedThreadIds.includes(selectedThreadId)
        ) {
          navigate("/");
          onNavigate({ keepDrawerOpen: true });
        }
      })
      .catch((error: unknown) => setStackActionError(messageFrom(error)))
      .finally(() => setStackMutationPending(false));
  };

  const actionAvailable = (action: BulkInventoryAction) =>
    action === "settle"
      ? settleCount > 0
      : action === "unsettle"
        ? unsettleCount > 0
        : memberCount > 0;
  const actionCount = (action: BulkInventoryAction) =>
    action === "settle"
      ? settleCount
      : action === "unsettle"
        ? unsettleCount
        : memberCount;
  const actionIcon = (action: BulkInventoryAction, size: number) =>
    action === "settle" ? (
      <ArrowDownToDot size={size} strokeWidth={1.8} />
    ) : action === "unsettle" ? (
      <ArrowUpFromDot size={size} strokeWidth={1.8} />
    ) : (
      <Archive size={size} strokeWidth={1.8} />
    );
  const stackActionButtons = (surface: "face" | "header") =>
    (["settle", "unsettle", "archive"] as const).map((action) => (
      <button
        key={action}
        type="button"
        className={
          surface === "face"
            ? `thread-quick-action thread-quick-action-icon${action === "archive" ? " thread-row-archive" : ""}`
            : "thread-stack-header-action"
        }
        data-testid={`thread-stack-${surface}-${action}`}
        aria-label={`${capitalize(action)} ${actionCount(action)} ${actionCount(action) === 1 ? "thread" : "threads"} in ${stack.label}`}
        title={`${capitalize(action)} stack`}
        disabled={!actionAvailable(action) || stackMutationPending}
        onClick={() => requestStackAction(action)}
      >
        {actionIcon(action, surface === "face" ? 15 : 16)}
      </button>
    ));

  const wrapStackContextMenu = (children: React.ReactNode) =>
    mobile ? (
      <div
        style={{ display: "contents" }}
        onPointerDownCapture={beginStackLongPress}
        onPointerMove={moveStackLongPress}
        onPointerUp={cancelStackLongPress}
        onPointerCancel={cancelStackLongPress}
        onContextMenuCapture={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openMobileRoster();
        }}
        onClickCapture={(event) => {
          if (!suppressStackClick.current) return;
          suppressStackClick.current = false;
          if (suppressStackClickTimer.current) {
            clearTimeout(suppressStackClickTimer.current);
            suppressStackClickTimer.current = undefined;
          }
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        {children}
      </div>
    ) : (
      <ContextMenu
        open={stackMenuOpen}
        onOpenChange={(next) => {
          stackSurfaceInteractionOpen.current = next;
          setStackMenuOpen(next);
          if (next) {
            cancelClose();
            setOpen(false);
            onDismissPeek();
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <div style={{ display: "contents" }}>{children}</div>
        </ContextMenuTrigger>
        <ContextMenuContent
          data-testid="thread-stack-context-menu"
          aria-label={`Actions for ${stack.label} stack`}
          collisionPadding={12}
        >
          <ContextMenuLabel>
            {stack.label} · {memberCount} threads
          </ContextMenuLabel>
          <ContextMenuItem onSelect={openRosterFromMenu}>
            <Layers3 size={18} strokeWidth={1.8} />
            View threads
          </ContextMenuItem>
          {(["settle", "unsettle", "archive"] as const).map((action) => (
            <ContextMenuItem
              key={action}
              variant={action === "archive" ? "destructive" : "default"}
              disabled={!actionAvailable(action)}
              onSelect={() => requestStackAction(action)}
            >
              {actionIcon(action, 18)}
              {capitalize(action)} stack
            </ContextMenuItem>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    );
  const stackSelected = entry.members.some(({ id }) => id === selectedThreadId);
  const stackBindings: ThreadPeekBindings | undefined = mobile
    ? undefined
    : {
        onPointerEnter: (event) => {
          if (event.pointerType === "mouse") {
            setAutoFocusMembers(false);
            openRoster();
          }
        },
        onPointerLeave: scheduleClose,
        onDragEnter: (event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          cancelClose();
          if (open || taskDragOpenTimer.current !== undefined) return;
          taskDragOpenTimer.current = window.setTimeout(() => {
            taskDragOpenTimer.current = undefined;
            setAutoFocusMembers(false);
            openRoster();
          }, 180);
        },
        onDragLeave: (event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          if (
            event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            return;
          }
          cancelTaskDragOpen();
          scheduleClose();
        },
        // Keyboard activation belongs to the visible representative. The
        // roster remains available through hover and the context menu.
        onFocus: () => undefined,
        onBlur: () => undefined,
      };
  const anchor = renderRow(entry.representative, {
    selected: stackSelected,
    showGroupLabel: stack.kind === "group",
    showProjectLabel: stack.kind === "project" ? true : undefined,
    containerClassName: "thread-stack-item",
    containerTestId:
      stack.kind === "group" ? "thread-group-stack" : "project-stack",
    stackGroupId: stack.kind === "group" ? stack.id : undefined,
    stackWorkspaceId: stack.kind === "project" ? stack.id : undefined,
    representativeThreadId: entry.representative.id,
    peekBindings: stackBindings,
    stackFace: {
      actions: stackActionButtons("face"),
      wrapContextMenu: wrapStackContextMenu,
      representativeSelected: entry.representative.id === selectedThreadId,
      returnFocusRef: stackFaceLink,
    },
  });
  return (
    <>
      <ThreadGroupRoster
        label={stack.label}
        members={entry.members}
        representativeId={entry.representative.id}
        selectedId={selectedThreadId}
        density={density}
        presentation={mobile ? "sheet" : "popover"}
        open={open}
        onOpenChange={handleOpenChange}
        contentId={rosterId}
        autoFocusMembers={autoFocusMembers}
        anchor={anchor as React.ReactElement}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onDragEnter={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          cancelTaskDragOpen();
          cancelClose();
        }}
        onDragOver={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          cancelClose();
        }}
        onDragLeave={(event) => {
          if (!taskDrag?.isTaskDrag(event.dataTransfer)) return;
          if (
            event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            return;
          }
          scheduleClose();
        }}
        onFocusCapture={cancelClose}
        onBlurCapture={scheduleClose}
        headerActions={
          <>
            {mobile ? stackActionButtons("header") : null}
            {stack.kind === "group" &&
            onFilterGroup &&
            renderGroupManagement ? (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Filter by ${stack.label}`}
                  title="Filter by group"
                  onClick={() => {
                    handleOpenChange(false);
                    onFilterGroup(stack.id);
                  }}
                >
                  <ListFilter />
                </Button>
                {renderGroupManagement(stack.group, true, (next) =>
                  handleInteractionOpenChange("group-management", next),
                )}
              </>
            ) : null}
          </>
        }
        renderMember={(member, { close, isSelected }) =>
          renderRow(member, {
            selected: isSelected,
            showGroupLabel: stack.kind !== "group",
            showProjectLabel: stack.kind !== "project",
            containerTag: "div",
            beforeSelect: () => {
              onDismissPeek();
              close();
            },
            onInteractionOpenChange: (next) =>
              handleInteractionOpenChange(`thread:${member.id}`, next),
            peekBindings: mobile ? undefined : peekBind(member.id),
          })
        }
      />
      <ThreadStackActionDialog
        open={stackActionOpen}
        onOpenChange={(next) => {
          if (stackMutationPending && !next) return;
          setStackActionOpen(next);
          stackSurfaceInteractionOpen.current = next || stackMenuOpen;
        }}
        label={stack.label}
        action={stackAction}
        impact={stackImpact}
        loading={stackImpactLoading}
        pending={stackMutationPending}
        requestLocked={stackRequestLocked}
        error={stackActionError}
        onReload={reloadStackImpact}
        onConfirm={confirmStackAction}
        threadTitleFor={(threadId) =>
          entry.members.find(({ id }) => id === threadId)?.title.text
        }
        returnFocusRef={stackFaceLink}
      />
    </>
  );
}

/**
 * The flat (time / state / none) sidebar body: shelf-styled collapsible group
 * headers over FlatThreadRow lists. `none` renders its single group without a
 * header (spec: one list, no headers). Collapse state lives in the parent so
 * it is remembered per group mode within the session.
 */
function FlatGroupList({
  groups,
  groupBy,
  density,
  mobile,
  showBackendBrand,
  searchActive,
  pinnedOnly,
  projectFilterLabel,
  collapsed,
  onToggleGroup,
  expanded,
  onExpandGroup,
  selectedThreadId,
  workspaceLabelFor,
  environmentLabelFor,
  showProjectLabel,
  showEnvironmentLabel,
  forkInfoFor,
  taskSummaryFor,
  menuLineageFor,
  archiveDescendantCountFor,
  configurationCopyPendingFor,
  descendantPagingFor,
  store,
  threadRegistry,
  onSelectThread,
  onNavigate,
  peekBind,
  onDismissPeek,
  onFilterGroup,
  renderGroupManagement,
  environmentTintStyleForWorkspace,
}: {
  readonly groups: readonly SidebarStackedGroup[];
  readonly groupBy: SidebarGroupBy;
  readonly density: SidebarDensity;
  readonly mobile: boolean;
  readonly showBackendBrand: boolean;
  readonly searchActive: boolean;
  readonly pinnedOnly: boolean;
  readonly projectFilterLabel?: string;
  readonly collapsed: Readonly<Record<string, boolean>>;
  readonly onToggleGroup: (groupKey: string, open: boolean) => void;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly onExpandGroup: (groupKey: string) => void;
  readonly selectedThreadId?: string;
  readonly workspaceLabelFor: (workspaceId: string) => string | undefined;
  readonly environmentLabelFor: (workspaceId: string) => string | undefined;
  readonly showProjectLabel: boolean;
  readonly showEnvironmentLabel: boolean;
  readonly forkInfoFor: (
    thread: NormalizedApplicationThreadSummary,
  ) => FlatThreadRowForkInfo | undefined;
  readonly taskSummaryFor: (
    threadId: string,
  ) => FlatThreadRowTaskSummary | undefined;
  readonly menuLineageFor: (
    thread: NormalizedApplicationThreadSummary,
  ) => FlatRowMenuLineage;
  readonly archiveDescendantCountFor: (threadId: string) => number;
  readonly configurationCopyPendingFor: (threadId: string) => boolean;
  readonly descendantPagingFor: (threadId: string) => FlatDescendantPaging;
  readonly store: ApplicationClientStore;
  readonly threadRegistry?: ThreadStoreRegistry;
  readonly onSelectThread?: SelectThread;
  readonly onNavigate: (options?: {
    readonly keepDrawerOpen?: boolean;
  }) => void;
  readonly peekBind: (id: string) => ThreadPeekBindings;
  readonly onDismissPeek: () => void;
  readonly onFilterGroup: (groupId: string) => void;
  readonly renderGroupManagement: (
    group: NormalizedThreadGroup,
    elevated: boolean,
    onInteractionOpenChange: (open: boolean) => void,
  ) => React.ReactNode;
  readonly environmentTintStyleForWorkspace: EnvironmentTintStyleForWorkspace;
}): React.JSX.Element {
  if (groups.length === 0) {
    return (
      <div className="sidebar-empty">
        {searchActive ? (
          <>
            <p>
              {pinnedOnly
                ? "No matching pinned threads"
                : "No matching threads"}
            </p>
            <small>Searches titles, projects, environments, and targets.</small>
          </>
        ) : pinnedOnly ? (
          <>
            <p>No pinned threads in this scope</p>
            <small>Adjust the scope or Show filters, or pin a thread.</small>
          </>
        ) : (
          <>
            <p>No threads to show</p>
            <small>
              {projectFilterLabel
                ? `No threads in ${projectFilterLabel} match the current Show filters.`
                : "Adjust the Show filters or start a thread."}
            </small>
          </>
        )}
      </div>
    );
  }
  return (
    <>
      {groups.map((group) => {
        const open = !(collapsed[group.key] ?? false);
        const visibleCap =
          group.kind === "pinned"
            ? Number.POSITIVE_INFINITY
            : group.kind === "upcoming"
              ? UPCOMING_VISIBLE_CAP
              : FLAT_GROUP_VISIBLE_CAP;
        const capped =
          !searchActive &&
          !(expanded[group.key] ?? false) &&
          group.entries.length > visibleCap;
        const visibleEntries = capped
          ? group.entries.filter(
              (entry, index) =>
                index < visibleCap ||
                (entry.kind === "thread"
                  ? entry.thread.id === selectedThreadId
                  : entry.members.some(({ id }) => id === selectedThreadId)),
            )
          : group.entries;
        const hiddenEntryCount = group.entries.length - visibleEntries.length;
        const renderRow: RenderGroupModeRow = (thread, options) => (
          <FlatRowItem
            thread={thread}
            futureTimes={
              group.futureTimes ||
              (group.kind === "pinned" && isUpcomingThread(thread))
            }
            density={density}
            showBackendBrand={showBackendBrand}
            selected={options.selected}
            workspaceLabel={workspaceLabelFor(thread.workspaceId)}
            environmentLabel={environmentLabelFor(thread.workspaceId)}
            showProjectLabel={options.showProjectLabel ?? showProjectLabel}
            showEnvironmentLabel={showEnvironmentLabel}
            fork={forkInfoFor(thread)}
            taskSummary={taskSummaryFor(thread.id)}
            lineage={menuLineageFor(thread)}
            archiveDescendantCount={archiveDescendantCountFor(thread.id)}
            configurationCopyPending={configurationCopyPendingFor(thread.id)}
            descendantPaging={descendantPagingFor(thread.id)}
            store={store}
            threadRegistry={threadRegistry}
            onSelectThread={onSelectThread}
            onNavigate={onNavigate}
            peekBindings={options.peekBindings}
            environmentTintStyle={environmentTintStyleForWorkspace(
              thread.workspaceId,
            )}
            showGroupLabel={options.showGroupLabel}
            beforeSelect={options.beforeSelect}
            containerTag={options.containerTag}
            containerClassName={options.containerClassName}
            containerTestId={options.containerTestId}
            stackGroupId={options.stackGroupId}
            stackWorkspaceId={options.stackWorkspaceId}
            representativeThreadId={options.representativeThreadId}
            onInteractionOpenChange={options.onInteractionOpenChange}
            stackFace={options.stackFace}
          />
        );
        const list = (
          <>
            <ul className="lineage-list">
              {visibleEntries.map((entry) =>
                entry.kind === "thread" ? (
                  <Fragment key={entry.key}>
                    {renderRow(entry.thread, {
                      selected: entry.thread.id === selectedThreadId,
                      peekBindings: peekBind(entry.thread.id),
                    })}
                  </Fragment>
                ) : (
                  <ThreadStackItem
                    key={entry.key}
                    entry={entry}
                    stack={
                      entry.stackBy === "group"
                        ? {
                            kind: "group",
                            id: entry.stackId,
                            label: entry.label,
                            group: entry.group,
                          }
                        : {
                            kind: "project",
                            id: entry.stackId,
                            label: entry.label,
                          }
                    }
                    density={density}
                    mobile={mobile}
                    selectedThreadId={selectedThreadId}
                    store={store}
                    onNavigate={onNavigate}
                    renderRow={renderRow}
                    peekBind={peekBind}
                    onDismissPeek={onDismissPeek}
                    onFilterGroup={onFilterGroup}
                    renderGroupManagement={renderGroupManagement}
                  />
                ),
              )}
            </ul>
            {capped && (
              <Button
                variant="ghost"
                size="xs"
                className="lineage-more flat-group-more"
                onClick={() => onExpandGroup(group.key)}
              >
                {hiddenEntryCount} more…
              </Button>
            )}
          </>
        );
        if (group.kind === "all") {
          return (
            <div
              key={`${groupBy}:${group.key}`}
              className="inventory-shelf flat-group"
              data-testid="flat-group"
              data-group={group.key}
            >
              {list}
            </div>
          );
        }
        return (
          <Collapsible.Root
            key={`${groupBy}:${group.key}`}
            className="inventory-shelf flat-group"
            data-testid="flat-group"
            data-group={group.key}
            open={open}
            onOpenChange={(next) => onToggleGroup(group.key, next)}
          >
            <Collapsible.Trigger className="shelf-trigger">
              <span>
                {group.label} <em>· {group.threadCount}</em>
              </span>
              <ChevronDown
                size={13}
                strokeWidth={1.8}
                className={open ? "rotate" : ""}
              />
            </Collapsible.Trigger>
            <Collapsible.Content>{list}</Collapsible.Content>
          </Collapsible.Root>
        );
      })}
    </>
  );
}

/** Lineage inputs a flat row's context menu needs (provenance + placement). */
interface FlatRowMenuLineage {
  readonly origin?: NormalizedThreadForkOrigin;
  readonly placement?: NormalizedThreadLineagePlacement;
  readonly sourceTitle?: string;
}

interface FlatDescendantPaging {
  readonly canLoad: boolean;
  readonly loading: boolean;
  readonly error?: string;
}

/**
 * One flat-view row: FlatThreadRow plus the same lifecycle / archive hover
 * actions the project-view ThreadRow offers, wrapped in the same
 * ThreadContextMenu (rename, snooze, settle, fork, automation settings,
 * lineage placement), and the peek hover/focus bindings on the list item.
 */
function FlatRowItemContent(
  {
    thread,
    futureTimes,
    density,
    showBackendBrand,
    selected,
    workspaceLabel,
    environmentLabel,
    showProjectLabel,
    showEnvironmentLabel,
    fork,
    taskSummary,
    lineage,
    archiveDescendantCount,
    configurationCopyPending,
    descendantPaging,
    store,
    threadRegistry,
    onSelectThread,
    onNavigate,
    peekBindings,
    environmentTintStyle,
    showGroupLabel = true,
    beforeSelect,
    containerTag = "li",
    containerClassName,
    containerTestId,
    stackGroupId,
    stackWorkspaceId,
    representativeThreadId,
    onInteractionOpenChange,
    stackFace,
  }: {
    readonly thread: NormalizedApplicationThreadSummary;
    readonly futureTimes: boolean;
    readonly density: SidebarDensity;
    readonly showBackendBrand: boolean;
    readonly selected: boolean;
    readonly workspaceLabel?: string;
    readonly environmentLabel?: string;
    readonly showProjectLabel: boolean;
    readonly showEnvironmentLabel: boolean;
    readonly fork?: FlatThreadRowForkInfo;
    readonly taskSummary?: FlatThreadRowTaskSummary;
    readonly lineage: FlatRowMenuLineage;
    readonly archiveDescendantCount: number;
    readonly configurationCopyPending: boolean;
    readonly descendantPaging: FlatDescendantPaging;
    readonly store: ApplicationClientStore;
    readonly threadRegistry?: ThreadStoreRegistry;
    readonly onSelectThread?: SelectThread;
    readonly onNavigate: (options?: {
      readonly keepDrawerOpen?: boolean;
    }) => void;
    readonly peekBindings?: ThreadPeekBindings;
    readonly environmentTintStyle?: React.CSSProperties;
    readonly showGroupLabel?: boolean;
    readonly beforeSelect?: () => void;
    readonly containerTag?: "li" | "div";
    readonly containerClassName?: string;
    readonly containerTestId?: string;
    readonly stackGroupId?: string;
    readonly stackWorkspaceId?: string;
    readonly representativeThreadId?: string;
    readonly onInteractionOpenChange?: (open: boolean) => void;
    readonly stackFace?: GroupModeRowOptions["stackFace"];
  },
  forwardedRef: React.ForwardedRef<HTMLElement>,
): React.JSX.Element {
  const clickNamesToFilter = useSyncExternalStore(
    subscribeClickNamesToFilter,
    getClickNamesToFilter,
  );
  const quickSwitchHint = useSidebarQuickSwitchHint(thread.id);
  const actionPending = useRef(false);
  const [pendingAction, setPendingAction] = useState<"quick" | "archive">();
  const [pinPending, setPinPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [archiveChoicesOpen, setArchiveChoicesOpen] = useState(false);
  const [archiveInitialImpact, setArchiveInitialImpact] = useState<ThreadArchiveImpact>();
  const [settleChoicesOpen, setSettleChoicesOpen] = useState(false);
  const [settleImpact, setSettleImpact] = useState<ThreadArchiveImpact>();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  // Inline rename mirrors the project-view ThreadRow's contract: the row
  // swaps to an autofocused input, Enter/blur commit, Escape cancels, and the
  // keyboard paths restore focus to the row link afterwards.
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState("");
  const renamePending = useRef(false);
  const cancelRename = useRef(false);
  const restoreRowFocus = useRef(false);
  const listItem = useRef<HTMLElement | null>(null);
  /**
   * FlatThreadRow owns its internal link button (no ref surface), so the
   * focus target for the menu's snooze dialog is resolved from the list item
   * after every render — the button remounts when a rename ends.
   */
  const rowLink = useRef<HTMLElement | null>(null);
  useEffect(() => {
    rowLink.current =
      listItem.current?.querySelector<HTMLElement>(".flat-row-link") ?? null;
    if (stackFace) stackFace.returnFocusRef.current = rowLink.current;
  });
  useEffect(() => {
    if (renaming || !restoreRowFocus.current) return;
    restoreRowFocus.current = false;
    listItem.current?.querySelector<HTMLElement>(".flat-row-link")?.focus();
  }, [renaming]);
  const beginRename = () => {
    cancelRename.current = false;
    setRenameTitle(thread.title.text);
    setRenameError("");
    setRenaming(true);
  };
  const commitRename = () => {
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    if (renamePending.current) return;
    const next = renameTitle.trim();
    if (!next || next === thread.title.text) {
      setRenaming(false);
      return;
    }
    renamePending.current = true;
    void store
      .renameThread(thread, next)
      .then(() => setRenaming(false))
      .catch((error: unknown) => {
        setRenaming(false);
        setRenameError(messageFrom(error));
      })
      .finally(() => {
        renamePending.current = false;
      });
  };
  const quickAction =
    thread.inventoryState === "snoozed"
      ? ("wake" as const)
      : thread.inventoryState === "settled"
        ? ("unsettle" as const)
        : ("settle" as const);
  const renameGlyphKind = flatRowGlyphKind(thread);
  const renameGlyphVisible =
    thread.attention.unseenCompletion || renameGlyphKind !== "idle";
  const openArchiveChoices = (impact: ThreadArchiveImpact) => {
    setArchiveInitialImpact(impact);
    actionPending.current = false;
    setPendingAction(undefined);
    setArchiveChoicesOpen(true);
  };
  const runInventoryAction = (
    kind: "quick" | "archive",
    action: "wake" | "settle" | "unsettle" | "archive",
  ) => {
    if (actionPending.current) return;
    actionPending.current = true;
    setPendingAction(kind);
    setActionError("");
    if (action === "archive") {
      void runThreadArchiveCheck({
        thread, store, onChoices: openArchiveChoices,
        onArchived: () => {
          if (selected) {
            navigate("/");
            onNavigate({ keepDrawerOpen: true });
          }
        },
      }).finally(() => {
        actionPending.current = false;
        setPendingAction(undefined);
      });
      return;
    }
    const mutation =
      action === "settle"
        ? store.getThreadArchiveImpact(thread.id).then((impact) => {
            if (settleNeedsConfirmation(impact)) {
              setSettleImpact(impact);
              setSettleChoicesOpen(true);
              return;
            }
            return store.mutateInventory(thread, action, {
              expectedStashedPromptCount: 0,
            });
          })
        : store.mutateInventory(thread, action);
    void mutation
      .catch((error: unknown) => setActionError(messageFrom(error)))
      .finally(() => {
        actionPending.current = false;
        setPendingAction(undefined);
      });
  };
  const actions = (
    <>
      {quickAction && (
        <button
          type="button"
          className={`thread-quick-action ${quickAction === "wake" ? "" : "thread-quick-action-icon"}`}
          aria-label={`${capitalize(quickAction)} ${thread.title.text}`}
          title={capitalize(quickAction)}
          disabled={pendingAction !== undefined}
          onClick={() => runInventoryAction("quick", quickAction)}
        >
          {quickAction === "wake" ? (
            "Wake"
          ) : quickAction === "settle" ? (
            <ArrowDownToDot size={15} strokeWidth={1.8} />
          ) : (
            <ArrowUpFromDot size={15} strokeWidth={1.8} />
          )}
        </button>
      )}
      {thread.inventoryState !== "snoozed" && (
        <button
          type="button"
          className="thread-quick-action thread-quick-action-icon"
          aria-label={`Snooze ${thread.title.text}`}
          title="Snooze"
          disabled={pendingAction !== undefined}
          onClick={() => setSnoozeOpen(true)}
        >
          <Clock size={15} strokeWidth={1.8} />
        </button>
      )}
      <button
        type="button"
        className="thread-quick-action thread-quick-action-icon"
        aria-label={`${thread.pinned ? "Unpin" : "Pin"} ${thread.title.text || "Untitled thread"}`}
        aria-pressed={thread.pinned}
        title={thread.pinned ? "Unpin" : "Pin"}
        disabled={pinPending}
        onClick={() => {
          if (pinPending) return;
          setPinPending(true);
          setActionError("");
          void store
            .setThreadPinned(thread, !thread.pinned)
            .catch((error: unknown) => setActionError(messageFrom(error)))
            .finally(() => setPinPending(false));
        }}
      >
        {thread.pinned ? (
          <PinOff size={15} strokeWidth={1.8} />
        ) : (
          <Pin size={15} strokeWidth={1.8} />
        )}
      </button>
      {archiveDescendantCount > 0 ? (
        <ArchiveDropdown
          thread={thread}
          store={store}
          descendantCount={archiveDescendantCount}
          directWhenNoChoices
          disabled={pendingAction !== undefined}
          onArchived={() => {
            if (selected) {
              navigate("/");
              onNavigate({ keepDrawerOpen: true });
            }
          }}
        >
          <button
            type="button"
            className="thread-row-archive"
            data-testid="thread-row-archive"
            aria-label={`Archive ${thread.title.text || "Untitled thread"}`}
            title="Archive"
          >
            <Archive size={14} strokeWidth={1.8} />
          </button>
        </ArchiveDropdown>
      ) : (
        <button
          type="button"
          className="thread-row-archive"
          data-testid="thread-row-archive"
          aria-label={`Archive ${thread.title.text || "Untitled thread"}`}
          title="Archive"
          disabled={pendingAction !== undefined}
          onClick={() => runInventoryAction("archive", "archive")}
        >
          <Archive size={14} strokeWidth={1.8} />
        </button>
      )}
    </>
  );
  const row = renaming ? (
    // The rename shell reuses FlatThreadRow's layout classes. It is always
    // the compact single-line shape: the card shell stacks its link contents
    // vertically, which would strand an exceptional glyph above the input.
    <div
      className="flat-row flat-row-compact"
      data-testid="flat-thread-row"
      data-density="compact"
      data-selected={selected ? "true" : "false"}
    >
      <form
        className="flat-row-link thread-row-rename"
        onSubmit={(event) => {
          event.preventDefault();
          restoreRowFocus.current = true;
          commitRename();
        }}
      >
        <span
          className="flat-row-glyph"
          data-glyph={
            renameGlyphVisible
              ? thread.attention.unseenCompletion && renameGlyphKind === "idle"
                ? "unseen"
                : renameGlyphKind
              : undefined
          }
          aria-hidden="true"
        >
          {thread.attention.unseenCompletion && renameGlyphKind === "idle" ? (
            <span className="flat-row-unseen-dot" />
          ) : renameGlyphVisible ? (
            flatRowGlyphIcon(renameGlyphKind)
          ) : null}
        </span>
        <label className="sr-only" htmlFor={`flat-row-title-${thread.id}`}>
          Thread title
        </label>
        <input
          id={`flat-row-title-${thread.id}`}
          data-testid="thread-row-rename"
          autoFocus
          maxLength={240}
          value={renameTitle}
          onChange={(event) => setRenameTitle(event.target.value)}
          onBlur={commitRename}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              cancelRename.current = true;
              restoreRowFocus.current = true;
              setRenaming(false);
            }
          }}
        />
      </form>
    </div>
  ) : (
    <FlatThreadRow
      thread={thread}
      density={density}
      showBackendBrand={showBackendBrand}
      futureTimes={futureTimes}
      selected={selected}
      workspaceLabel={workspaceLabel}
      environmentLabel={environmentLabel}
      showProjectLabel={showProjectLabel}
      showEnvironmentLabel={showEnvironmentLabel}
      fork={fork}
      taskSummary={taskSummary}
      quickSwitchHint={quickSwitchHint}
      showCompactGroupLabel={Boolean(stackGroupId)}
      showCompactProjectLabel={Boolean(stackWorkspaceId)}
      groupLabel={
        !showGroupLabel || thread.groupId === null
          ? undefined
          : store
              .getSnapshot()
              .snapshot?.groups.find(({ id }) => id === thread.groupId)?.name
      }
      onGroupSelect={() => {
        if (thread.groupId === null) return;
        setSidebarInventoryScope({
          groupFilterId: thread.groupId,
          ungroupedFilter: false,
        });
      }}
      clickNamesToFilter={clickNamesToFilter}
      onProjectSelect={() => {
        const workspace = store.getSnapshot().snapshot?.workspaces.find(
          ({ id }) => id === (stackWorkspaceId ?? thread.workspaceId),
        );
        if (workspace) setSidebarInventoryScope({ projectFilterName: workspace.label.text });
      }}
      onEnvironmentSelect={() => {
        const environmentId = store.getSnapshot().snapshot?.workspaces.find(
          ({ id }) => id === thread.workspaceId,
        )?.environmentId;
        if (environmentId === undefined) return;
        setSidebarInventoryScope({ environmentFilterId: environmentId });
      }}
      actions={stackFace?.actions ?? actions}
      selectAriaCurrent={
        stackFace && !stackFace.representativeSelected ? false : undefined
      }
      onOpenQuestions={(event) => {
        beforeSelect?.();
        threadRegistry?.get(thread.id).requestQuestionInboxOpen();
        onSelectThread?.(
          thread.id,
          resolvePanelPresentation(getPanelPresentation(), event.shiftKey),
        );
        navigate(threadPath(thread.id));
        onNavigate();
      }}
      onSelect={(event) => {
        beforeSelect?.();
        onSelectThread?.(
          thread.id,
          resolvePanelPresentation(getPanelPresentation(), event.shiftKey),
        );
        navigate(threadPath(thread.id));
        onNavigate();
      }}
    />
  );
  const threadContent = (
    <>
      <ThreadContextMenu
        thread={thread}
        store={store}
        onNavigate={onNavigate}
        onRename={beginRename}
        disabled={renaming}
        onAction={(action) => {
          // Archiving the open thread leaves the workspace view, matching
          // the project-view row's context menu behavior.
          if (action === "archive" && selected) {
            navigate("/");
            onNavigate({ keepDrawerOpen: true });
          }
        }}
        returnFocusRef={rowLink}
        origin={lineage.origin}
        sourceTitle={lineage.sourceTitle}
        placement={lineage.placement}
        threadRegistry={threadRegistry}
        familyDescendantCount={archiveDescendantCount}
        configurationCopyPending={configurationCopyPending}
        onInteractionOpenChange={onInteractionOpenChange}
      >
        {/* The menu trigger needs a DOM child; display:contents keeps this
            wrapper out of layout so FlatThreadRow's CSS applies unchanged. */}
        <div style={{ display: "contents" }}>{row}</div>
      </ThreadContextMenu>
      <ArchiveChoicesDialog
        open={archiveChoicesOpen}
        initialImpact={archiveInitialImpact}
        onOpenChange={setArchiveChoicesOpen}
        thread={thread}
        store={store}
        descendantCount={0}
        disabled={pendingAction !== undefined}
        onPendingChange={(pending) => {
          actionPending.current = pending;
          setPendingAction(pending ? "archive" : undefined);
        }}
        onArchived={() => {
          if (selected) {
            navigate("/");
            onNavigate({ keepDrawerOpen: true });
          }
        }}
        returnFocusRef={rowLink}
      />
      <SettleImpactDialog
        open={settleChoicesOpen}
        onOpenChange={setSettleChoicesOpen}
        impact={settleImpact}
        loadImpact={() => store.getThreadArchiveImpact(thread.id)}
        onSettle={(options) => store.mutateInventory(thread, "settle", options)}
        returnFocusRef={rowLink}
      />
      <SnoozeDialog
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        onSnooze={(options) => store.mutateInventory(thread, "snooze", options)}
        onRemindNow={(wakeReminder) =>
          store.mutateInventory(thread, "remind", { wakeReminder })
        }
        returnFocusRef={rowLink}
      />
      {renameError && (
        <p className="thread-row-error" role="alert">
          {renameError}
        </p>
      )}
      {actionError && (
        <p className="thread-row-error" role="alert">
          {actionError}
        </p>
      )}
      {descendantPaging.canLoad && (
        <Button
          variant="ghost"
          size="xs"
          className="lineage-more flat-lineage-more"
          disabled={descendantPaging.loading}
          onClick={() =>
            void store.loadMoreDescendants(thread.id).catch(() => undefined)
          }
        >
          {descendantPaging.loading
            ? "Loading runs/forks…"
            : "Show all runs/forks"}
        </Button>
      )}
      {descendantPaging.error && (
        <p className="thread-row-error" role="alert">
          {descendantPaging.error}
        </p>
      )}
    </>
  );
  const content = stackFace ? stackFace.wrapContextMenu(row) : threadContent;
  const containerProps = {
    className: ["flat-list-item", containerClassName].filter(Boolean).join(" "),
    "data-testid": containerTestId,
    "data-thread-id": thread.id,
    "data-group-id": stackGroupId,
    "data-workspace-id": stackWorkspaceId,
    "data-representative-thread-id": representativeThreadId,
    "data-density": stackGroupId || stackWorkspaceId ? density : undefined,
    "data-environment-tint": environmentTintStyle ? "true" : undefined,
    style: environmentTintStyle,
    ...peekBindings,
  };
  const setContainerRef = (node: HTMLElement | null) => {
    listItem.current = node;
    if (typeof forwardedRef === "function") {
      forwardedRef(node);
    } else if (forwardedRef) {
      forwardedRef.current = node;
    }
  };
  return containerTag === "div" ? (
    <div ref={setContainerRef} {...containerProps}>
      {content}
    </div>
  ) : (
    <li ref={setContainerRef} {...containerProps}>
      {content}
    </li>
  );
}

const FlatRowItem = forwardRef<
  HTMLElement,
  Parameters<typeof FlatRowItemContent>[0]
>(FlatRowItemContent);

function LineageRows({
  nodes,
  state,
  store,
  threadRegistry,
  selectedThreadId,
  onSelectThread,
  onNavigate,
  grouped,
  compact = false,
  kind,
  showBackendBrand,
  locationLabelFor,
  taskSummaryFor,
  archiveDescendantCountFor,
  allowDescendantPaging,
  environmentTintStyleForWorkspace,
}: {
  readonly nodes: readonly SidebarLineageNode[];
  readonly state: ApplicationClientState;
  readonly store: ApplicationClientStore;
  readonly threadRegistry?: ThreadStoreRegistry;
  readonly selectedThreadId?: string;
  readonly onSelectThread?: SelectThread;
  readonly onNavigate: (options?: {
    readonly keepDrawerOpen?: boolean;
  }) => void;
  readonly grouped: boolean;
  readonly compact?: boolean;
  readonly kind?: "automations" | "snoozed" | "settled";
  readonly showBackendBrand: boolean;
  readonly locationLabelFor: (
    thread: NormalizedApplicationThreadSummary,
  ) => string | undefined;
  readonly taskSummaryFor: (
    threadId: string,
  ) => FlatThreadRowTaskSummary | undefined;
  readonly archiveDescendantCountFor: (threadId: string) => number;
  readonly allowDescendantPaging: boolean;
  readonly environmentTintStyleForWorkspace: EnvironmentTintStyleForWorkspace;
}): React.JSX.Element {
  const [expanded, setExpanded] = useSidebarDisclosures("lineage");
  const [showAll, setShowAll] = useState<Record<string, boolean>>({});
  return (
    <ul className="lineage-list">
      {nodes.map((node) => (
        <LineageRow
          key={node.thread.id}
          node={node}
          state={state}
          store={store}
          threadRegistry={threadRegistry}
          selectedThreadId={selectedThreadId}
          onSelectThread={onSelectThread}
          onNavigate={onNavigate}
          grouped={grouped}
          compact={compact}
          kind={kind}
          showBackendBrand={showBackendBrand}
          locationLabelFor={locationLabelFor}
          taskSummaryFor={taskSummaryFor}
          archiveDescendantCountFor={archiveDescendantCountFor}
          allowDescendantPaging={allowDescendantPaging}
          environmentTintStyleForWorkspace={environmentTintStyleForWorkspace}
          expanded={expanded}
          setExpanded={setExpanded}
          showAll={showAll}
          setShowAll={setShowAll}
        />
      ))}
    </ul>
  );
}

function LineageRow({
  node,
  state,
  store,
  threadRegistry,
  selectedThreadId,
  onSelectThread,
  onNavigate,
  grouped,
  compact,
  kind,
  showBackendBrand,
  locationLabelFor,
  taskSummaryFor,
  archiveDescendantCountFor,
  allowDescendantPaging,
  expanded,
  setExpanded,
  showAll,
  setShowAll,
  environmentTintStyleForWorkspace,
}: {
  readonly node: SidebarLineageNode;
  readonly state: ApplicationClientState;
  readonly store: ApplicationClientStore;
  readonly threadRegistry?: ThreadStoreRegistry;
  readonly selectedThreadId?: string;
  readonly onSelectThread?: SelectThread;
  readonly onNavigate: (options?: {
    readonly keepDrawerOpen?: boolean;
  }) => void;
  readonly grouped: boolean;
  readonly compact: boolean;
  readonly kind?: "automations" | "snoozed" | "settled";
  readonly showBackendBrand: boolean;
  readonly locationLabelFor: (
    thread: NormalizedApplicationThreadSummary,
  ) => string | undefined;
  readonly taskSummaryFor: (
    threadId: string,
  ) => FlatThreadRowTaskSummary | undefined;
  readonly archiveDescendantCountFor: (threadId: string) => number;
  readonly allowDescendantPaging: boolean;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly setExpanded: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  readonly showAll: Readonly<Record<string, boolean>>;
  readonly setShowAll: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  readonly environmentTintStyleForWorkspace: EnvironmentTintStyleForWorkspace;
}): React.JSX.Element {
  const childrenId = useId();
  const disclosure = useRef<HTMLButtonElement>(null);
  const childContainer = useRef<HTMLDivElement>(null);
  const searchPath = Boolean(state.search && subtreeHasMatch(node));
  const descendantPage = state.descendantPages[node.thread.id];
  const canLoad =
    grouped &&
    allowDescendantPaging &&
    (Boolean(descendantPage?.nextCursor) ||
      (!descendantPage?.loaded &&
        node.familyDescendantCount > node.loadedFamilyDescendantCount));
  const hasChildren = grouped && node.children.length > 0;
  const hasExpandableContent =
    hasChildren || canLoad || Boolean(descendantPage?.error);
  const open =
    hasExpandableContent &&
    (searchPath || (expanded[node.thread.id] ?? true));
  const sourceTitle = node.origin?.sourceThreadId
    ? (state.snapshot?.threads.find(
        ({ id }) => id === node.origin?.sourceThreadId,
      )?.title.text ??
      Object.values(state.descendantPages)
        .flatMap(({ descendants: page }) => page)
        .find(({ thread }) => thread.id === node.origin?.sourceThreadId)?.thread
        .title.text)
    : undefined;
  const visibleChildren = showAll[node.thread.id]
    ? node.children
    : node.children.slice(0, 20);
  const quickAction =
    kind === "snoozed"
      ? ("wake" as const)
      : node.thread.inventoryState === "settled"
        ? ("unsettle" as const)
        : ("settle" as const);
  const tintStyle = environmentTintStyleForWorkspace(node.thread.workspaceId);

  return (
    <li
      className="lineage-node"
      data-thread-id={node.thread.id}
      data-lineage-depth={node.depth}
      data-environment-tint={tintStyle ? "true" : undefined}
      style={
        {
          "--lineage-depth": Math.min(node.depth, 5),
          ...tintStyle,
        } as React.CSSProperties
      }
    >
      <div className="lineage-row-main">
        {hasExpandableContent ? (
          <button
            ref={disclosure}
            type="button"
            className="lineage-disclosure"
            aria-label={`${open ? "Collapse" : "Expand"} fork family for ${node.thread.title.text || "Untitled thread"}`}
            aria-expanded={open}
            aria-controls={childrenId}
            onClick={() => {
              if (
                open &&
                childContainer.current?.contains(document.activeElement)
              ) {
                disclosure.current?.focus();
              }
              setExpanded((current) => ({
                ...current,
                [node.thread.id]: !open,
              }));
            }}
          >
            {open ? (
              <ChevronDown aria-hidden="true" />
            ) : (
              <ChevronRight aria-hidden="true" />
            )}
          </button>
        ) : (
          <span className="lineage-disclosure-spacer" aria-hidden="true" />
        )}
        <ThreadRow
          thread={node.thread}
          store={store}
          threadRegistry={threadRegistry}
          selected={node.thread.id === selectedThreadId}
          selectedThreadId={selectedThreadId}
          onSelectThread={onSelectThread}
          onNavigate={onNavigate}
          compact={compact || node.depth > 0}
          kind={kind}
          showBackendBrand={showBackendBrand}
          locationLabel={locationLabelFor(node.thread)}
          taskSummary={taskSummaryFor(node.thread.id)}
          quickAction={quickAction}
          onQuickAction={
            quickAction
              ? async (candidate, options) =>
                  store.mutateInventory(candidate, quickAction, options)
              : undefined
          }
          origin={node.origin}
          showForkProvenance={node.depth === 0}
          sourceTitle={sourceTitle}
          placement={node.placement}
          aggregate={grouped && !open ? node.aggregate : undefined}
          familyDescendantCount={
            canLoad ? node.familyDescendantCount : node.aggregate.count
          }
          archiveDescendantCount={archiveDescendantCountFor(node.thread.id)}
          configurationCopyPending={state.pendingThreadConfigurationCopySourceIds.includes(
            node.thread.id,
          )}
        />
      </div>
      <div
        ref={childContainer}
        id={childrenId}
        className="lineage-children"
        hidden={!open}
      >
        {open && (
          <>
            <ul className="lineage-list">
              {visibleChildren.map((child) => (
                <LineageRow
                  key={child.thread.id}
                  node={child}
                  state={state}
                  store={store}
                  threadRegistry={threadRegistry}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={onSelectThread}
                  onNavigate={onNavigate}
                  grouped={grouped}
                  compact
                  kind={kind}
                  showBackendBrand={showBackendBrand}
                  locationLabelFor={locationLabelFor}
                  taskSummaryFor={taskSummaryFor}
                  archiveDescendantCountFor={archiveDescendantCountFor}
                  allowDescendantPaging={allowDescendantPaging}
                  environmentTintStyleForWorkspace={
                    environmentTintStyleForWorkspace
                  }
                  expanded={expanded}
                  setExpanded={setExpanded}
                  showAll={showAll}
                  setShowAll={setShowAll}
                />
              ))}
            </ul>
            {node.children.length > visibleChildren.length && (
              <Button
                variant="ghost"
                size="xs"
                className="lineage-more"
                onClick={() =>
                  setShowAll((current) => ({
                    ...current,
                    [node.thread.id]: true,
                  }))
                }
              >
                Show {node.children.length - visibleChildren.length} more forks
              </Button>
            )}
            {canLoad && (
              <Button
                variant="ghost"
                size="xs"
                className="lineage-more"
                disabled={descendantPage?.loading}
                onClick={() =>
                  void store
                    .loadMoreDescendants(node.thread.id)
                    .catch(() => undefined)
                }
              >
                {descendantPage?.loading
                  ? "Loading runs/forks…"
                  : "Show all runs/forks"}
              </Button>
            )}
            {descendantPage?.error && (
              <p className="thread-row-error" role="alert">
                {descendantPage.error}
              </p>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function subtreeHasMatch(node: SidebarLineageNode): boolean {
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.matchesSearch) return true;
    stack.push(...current.children);
  }
  return false;
}

function ThreadRow({
  thread,
  store,
  threadRegistry,
  selected,
  selectedThreadId,
  onSelectThread,
  onNavigate,
  compact = false,
  kind,
  showBackendBrand,
  locationLabel,
  quickAction,
  onQuickAction,
  origin,
  showForkProvenance,
  sourceTitle,
  placement,
  aggregate,
  familyDescendantCount,
  archiveDescendantCount,
  configurationCopyPending,
  taskSummary,
}: {
  thread: NormalizedApplicationThreadSummary;
  store: ApplicationClientStore;
  threadRegistry?: ThreadStoreRegistry;
  selected: boolean;
  selectedThreadId?: string;
  onSelectThread?: SelectThread;
  onNavigate: (options?: { readonly keepDrawerOpen?: boolean }) => void;
  compact?: boolean;
  kind?: "automations" | "snoozed" | "settled";
  showBackendBrand: boolean;
  locationLabel?: string;
  quickAction?: "wake" | "settle" | "unsettle";
  onQuickAction?: (
    thread: NormalizedApplicationThreadSummary,
    options?: { readonly expectedStashedPromptCount?: number },
  ) => Promise<void>;
  origin?: NormalizedThreadForkOrigin;
  showForkProvenance: boolean;
  sourceTitle?: string;
  placement?: NormalizedThreadLineagePlacement;
  aggregate?: DescendantAggregate;
  familyDescendantCount?: number;
  archiveDescendantCount: number;
  configurationCopyPending: boolean;
  taskSummary?: FlatThreadRowTaskSummary;
}): React.JSX.Element {
  const quickSwitchHint = useSidebarQuickSwitchHint(thread.id);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameError, setRenameError] = useState("");
  const renamePending = useRef(false);
  const cancelRename = useRef(false);
  const rowLink = useRef<HTMLButtonElement>(null);
  const inventoryActionPending = useRef(false);
  const [pinPending, setPinPending] = useState(false);
  const [pendingInventoryAction, setPendingInventoryAction] = useState<
    "quick" | "archive"
  >();
  const [quickActionError, setQuickActionError] = useState("");
  const [settleChoicesOpen, setSettleChoicesOpen] = useState(false);
  const [settleImpact, setSettleImpact] = useState<ThreadArchiveImpact>();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [archiveChoicesOpen, setArchiveChoicesOpen] = useState(false);
  const [archiveInitialImpact, setArchiveInitialImpact] = useState<ThreadArchiveImpact>();
  const [placementPending, setPlacementPending] = useState(false);
  const [placementError, setPlacementError] = useState("");
  const openArchiveChoices = (impact: ThreadArchiveImpact) => {
    setArchiveInitialImpact(impact);
    inventoryActionPending.current = false;
    setPendingInventoryAction(undefined);
    setArchiveChoicesOpen(true);
  };
  /**
   * The rename input replaces the row link, so keyboard commit/cancel would
   * otherwise leave focus on a removed node and drop the caret to <body>.
   * Set only on the keyboard paths — a blur-commit means the reader already
   * moved focus somewhere deliberate, and stealing it back would be wrong.
   */
  const restoreRowFocus = useRef(false);
  const automation = thread.automation ?? undefined;
  const unseen = thread.attention.unseenCompletion;
  const unseenOwnsGlyph = unseen && flatRowGlyphKind(thread) === "idle";
  const spinning =
    thread.runState === "running" ||
    thread.runState === "starting" ||
    thread.runState === "stopping";
  const showsRunIndicator =
    thread.runState !== "idle" &&
    thread.runState !== "waiting_for_input" &&
    thread.runState !== "waiting_for_approval" &&
    thread.runState !== "failed";
  const metaLabel =
    thread.inventoryState === "snoozed" && thread.snoozedUntil
      ? snoozeLabel(thread.snoozedUntil)
      : automation?.nextRunAt
        ? shortAutomationTime(automation.nextRunAt)
        : automation
          ? capitalize(automation.status)
          : shortRelativeTime(thread.lastActivityAt);
  const glyph = (
    <span className="row-glyph">
      {showsRunIndicator ? (
        <span
          className={`run-indicator ${spinning ? "spinning" : ""} ${thread.runState}`}
          data-testid="run-indicator"
          data-state={thread.runState}
          role="img"
          aria-label={capitalize(thread.runState.replaceAll("_", " "))}
          title={thread.runState}
        >
          {spinning && <LoaderCircle size={13} strokeWidth={2.4} />}
        </span>
      ) : unseenOwnsGlyph ? (
        <span
          className="run-indicator unseen"
          data-testid="thread-row-unseen-dot"
          role="img"
          aria-label="Finished while you were away"
          title="Finished while you were away"
        />
      ) : kind === "settled" ? (
        <Check size={13} strokeWidth={2.2} />
      ) : kind === "snoozed" || kind === "automations" ? (
        <Clock size={13} strokeWidth={2} />
      ) : null}
    </span>
  );
  const brandMark = showBackendBrand ? (
    <span
      className="row-brand"
      role="img"
      aria-label={thread.backend.label.text}
      title={thread.backend.label.text}
    >
      <BackendBrandIcon brand={thread.backend.brand} size={13} />
    </span>
  ) : null;
  const taskIndicator =
    taskSummary && taskSummary.openCount > 0 ? (
      <StatusChip chip="tasks" label={threadTaskSummaryLabel(taskSummary)}>
        <ListTodo size={14} strokeWidth={2} />
      </StatusChip>
    ) : undefined;
  const questionLabel = `${thread.pendingQuestionCount} unanswered question${thread.pendingQuestionCount === 1 ? "" : "s"}`;
  const questionIndicator = thread.pendingQuestionCount > 0 ? (
    <button
      type="button"
      className="flat-row-indicator flat-row-question-indicator"
      data-indicator="question"
      data-testid="thread-row-question-indicator"
      aria-label={questionLabel}
      title={questionLabel}
      onClick={(event) => {
        threadRegistry?.get(thread.id).requestQuestionInboxOpen();
        onSelectThread?.(
          thread.id,
          resolvePanelPresentation(getPanelPresentation(), event.shiftKey),
        );
        navigate(threadPath(thread.id));
        onNavigate();
      }}
    >
      <MessageCircleQuestion size={14} strokeWidth={1.9} aria-hidden="true" />
    </button>
  ) : undefined;
  const stashIndicator =
    thread.stashedPromptCount > 0 ? (
      <StatusChip
        chip="stashes"
        label={`${thread.stashedPromptCount} stashed prompt${thread.stashedPromptCount === 1 ? "" : "s"}`}
      >
        <ArchiveRestore size={14} strokeWidth={2} />
      </StatusChip>
    ) : undefined;
  const bookmarkIndicator =
    thread.turnBookmarkCount > 0 ? (
      <StatusChip
        chip="bookmarks"
        label={`${thread.turnBookmarkCount} bookmarked turn${thread.turnBookmarkCount === 1 ? "" : "s"}`}
      >
        <Bookmark size={14} strokeWidth={2} />
      </StatusChip>
    ) : undefined;
  const terminalIndicator =
    thread.terminalSummary.retainedCount > 0 ? (
      <StatusChip
        chip="terminals"
        label={`${thread.terminalSummary.runningCount} running terminal${thread.terminalSummary.runningCount === 1 ? "" : "s"}, ${thread.terminalSummary.retainedCount} retained`}
      >
        <TerminalIcon size={14} strokeWidth={2} />
      </StatusChip>
    ) : undefined;
  const beginRename = () => {
    cancelRename.current = false;
    setRenameTitle(thread.title.text);
    setRenameError("");
    setRenaming(true);
  };
  useEffect(() => {
    if (renaming || !restoreRowFocus.current) return;
    restoreRowFocus.current = false;
    rowLink.current?.focus();
  }, [renaming]);
  /**
   * Mirrors ThreadHeader's rename form contract (Enter/blur commit, Escape
   * cancels) but delivers through the application store, so it works for
   * threads that are not open. The summary exposes no rename capability, so
   * a rejection surfaces as a quiet row error and the title reverts.
   */
  const commitRename = () => {
    if (cancelRename.current) {
      cancelRename.current = false;
      return;
    }
    if (renamePending.current) return;
    const next = renameTitle.trim();
    if (!next || next === thread.title.text) {
      setRenaming(false);
      return;
    }
    renamePending.current = true;
    void store
      .renameThread(thread, next)
      .then(() => setRenaming(false))
      .catch((error: unknown) => {
        setRenaming(false);
        setRenameError(messageFrom(error));
      })
      .finally(() => {
        renamePending.current = false;
      });
  };
  const row = (
    <div
      className={`thread-row ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
      data-testid="thread-row"
      data-selected={selected ? "true" : "false"}
    >
      {renaming ? (
        <form
          className="thread-row-link thread-row-rename"
          onSubmit={(event) => {
            event.preventDefault();
            restoreRowFocus.current = true;
            commitRename();
          }}
        >
          {glyph}
          {brandMark}
          <label className="sr-only" htmlFor={`thread-row-title-${thread.id}`}>
            Thread title
          </label>
          <input
            id={`thread-row-title-${thread.id}`}
            data-testid="thread-row-rename"
            autoFocus
            maxLength={240}
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                cancelRename.current = true;
                restoreRowFocus.current = true;
                setRenaming(false);
              }
            }}
          />
        </form>
      ) : (
        <button
          ref={rowLink}
          className="thread-row-link"
          data-testid="thread-row-link"
          aria-current={selected ? "page" : undefined}
          aria-keyshortcuts={quickSwitchHint?.ariaKey}
          onClick={(event) => {
            onSelectThread?.(
              thread.id,
              resolvePanelPresentation(getPanelPresentation(), event.shiftKey),
            );
            navigate(threadPath(thread.id));
            onNavigate();
          }}
        >
          {glyph}
          {brandMark}
          <span className="thread-title">
            {thread.title.text || "Untitled thread"}
          </span>
          {locationLabel && (
            <span
              className="thread-row-location"
              data-testid="thread-row-location"
              title={locationLabel}
            >
              {locationLabel}
            </span>
          )}
          <span className="thread-badges">
            {thread.attention.queueFailure ||
            thread.attention.automationContext === "failed" ? (
              <StatusChip chip="attention" label="Attention">
                <CircleAlert size={14} strokeWidth={2} />
              </StatusChip>
            ) : null}
            {thread.attention.wake && (
              <StatusChip chip="woke" label="Woke">
                <AlarmClock size={14} strokeWidth={2} />
              </StatusChip>
            )}
            {thread.queuedInputCount > 0 && (
              <StatusChip
                chip="queued"
                label={`${thread.queuedInputCount} queued`}
              >
                <ListPlus size={14} strokeWidth={2} />
              </StatusChip>
            )}
            {thread.backingState === "unbound" && (
              <StatusChip chip="draft" label="Draft">
                <PencilLine size={14} strokeWidth={2} />
              </StatusChip>
            )}
            {thread.backingState === "creating" && (
              <StatusChip chip="starting" label="Starting">
                <LoaderCircle size={14} strokeWidth={2} />
              </StatusChip>
            )}
            {thread.backingState === "creation_unknown" && (
              <StatusChip chip="start-failed" label="Start failed">
                <TriangleAlert size={14} strokeWidth={2} />
              </StatusChip>
            )}
            {thread.runState === "waiting_for_input" ||
            thread.runState === "waiting_for_approval" ? (
              <StatusChip chip="needs-input" label="Needs input">
                <CircleHelp size={14} strokeWidth={2} />
              </StatusChip>
            ) : thread.runState === "failed" ? (
              <StatusChip chip="failed" label="Failed">
                <CircleX size={14} strokeWidth={2} />
              </StatusChip>
            ) : null}
            {aggregate &&
              (aggregate.count > 0 || (familyDescendantCount ?? 0) > 0) && (
                <DescendantStatus
                  aggregate={aggregate}
                  familyDescendantCount={
                    familyDescendantCount ?? aggregate.count
                  }
                />
              )}
          </span>
        </button>
      )}
      {/* Meta and row actions share one trailing slot: hover/keyboard-visible
          focus swaps timestamp/provenance for placement + lifecycle actions.
          Kept outside the nav button so action clicks never navigate. */}
      {!renaming && questionIndicator}
      {!renaming && (
        <div className="thread-row-trailing">
          <div className="thread-row-default-trailing">
            {(origin && showForkProvenance) ||
            taskIndicator ||
            stashIndicator ||
            bookmarkIndicator ||
            terminalIndicator ? (
              <span
                className="thread-row-indicators"
                data-testid="thread-row-indicators"
              >
                {origin && showForkProvenance && (
                  <ForkProvenanceButton
                    origin={origin}
                    sourceTitle={sourceTitle}
                    onNavigate={onNavigate}
                    className="thread-row-provenance"
                  />
                )}
                {taskIndicator}
                {stashIndicator}
                {bookmarkIndicator}
                {terminalIndicator}
              </span>
            ) : null}
            {/* `.thread-meta` is capped so a long absolute stamp cannot starve
                the title; the title attribute keeps a clipped value legible. */}
            <span
              className="thread-meta"
              data-shortcut={
                quickSwitchHint === undefined
                  ? undefined
                  : quickSwitchHint.confirmation
                    ? "confirmation"
                    : "true"
              }
              title={
                quickSwitchHint === undefined
                  ? metaLabel
                  : `Switch to ${thread.title.text || "Untitled thread"} with ${quickSwitchHint.label}`
              }
            >
              {quickSwitchHint?.label ?? metaLabel}
            </span>
          </div>
          <div className="thread-row-actions">
            {quickAction && (
              <button
                type="button"
                className={`thread-quick-action ${quickAction === "wake" ? "" : "thread-quick-action-icon"}`}
                aria-label={`${capitalize(quickAction)} ${thread.title.text}`}
                title={capitalize(quickAction)}
                onClick={() => {
                  if (!onQuickAction || inventoryActionPending.current) return;
                  inventoryActionPending.current = true;
                  setPendingInventoryAction("quick");
                  setQuickActionError("");
                  const mutation =
                    quickAction === "settle"
                      ? store
                          .getThreadArchiveImpact(thread.id)
                          .then((impact) => {
                            if (settleNeedsConfirmation(impact)) {
                              setSettleImpact(impact);
                              setSettleChoicesOpen(true);
                              return;
                            }
                            return onQuickAction(thread, {
                              expectedStashedPromptCount: 0,
                            });
                          })
                      : onQuickAction(thread);
                  void mutation
                    .catch((error: unknown) =>
                      setQuickActionError(messageFrom(error)),
                    )
                    .finally(() => {
                      inventoryActionPending.current = false;
                      setPendingInventoryAction(undefined);
                    });
                }}
                disabled={pendingInventoryAction !== undefined}
              >
                {quickAction === "wake" ? (
                  "Wake"
                ) : quickAction === "settle" ? (
                  <ArrowDownToDot size={15} strokeWidth={1.8} />
                ) : (
                  <ArrowUpFromDot size={15} strokeWidth={1.8} />
                )}
              </button>
            )}
            {thread.inventoryState !== "snoozed" && (
              <button
                type="button"
                className="thread-quick-action thread-quick-action-icon"
                aria-label={`Snooze ${thread.title.text}`}
                title="Snooze"
                disabled={pendingInventoryAction !== undefined}
                onClick={() => setSnoozeOpen(true)}
              >
                <Clock size={15} strokeWidth={1.8} />
              </button>
            )}
            <button
              type="button"
              className="thread-quick-action thread-quick-action-icon"
              aria-label={`${thread.pinned ? "Unpin" : "Pin"} ${thread.title.text || "Untitled thread"}`}
              aria-pressed={thread.pinned}
              title={thread.pinned ? "Unpin" : "Pin"}
              disabled={pinPending}
              onClick={() => {
                if (pinPending) return;
                setPinPending(true);
                setQuickActionError("");
                void store
                  .setThreadPinned(thread, !thread.pinned)
                  .catch((error: unknown) =>
                    setQuickActionError(messageFrom(error)),
                  )
                  .finally(() => setPinPending(false));
              }}
            >
              {thread.pinned ? (
                <PinOff size={15} strokeWidth={1.8} />
              ) : (
                <Pin size={15} strokeWidth={1.8} />
              )}
            </button>
            {placement && origin?.sourceThreadId && (
              <button
                type="button"
                className="thread-row-lineage-action"
                aria-label={
                  placement.mode === "nested_under_source"
                    ? `Show ${thread.title.text} as top-level`
                    : `Group ${thread.title.text} under its source`
                }
                title={
                  placement.mode === "nested_under_source"
                    ? "Show as top-level"
                    : "Group under source"
                }
                disabled={placementPending}
                onClick={() => {
                  setPlacementPending(true);
                  setPlacementError("");
                  void store
                    .updateLineagePlacement(
                      placement,
                      placement.mode === "nested_under_source"
                        ? "top_level"
                        : "nested_under_source",
                    )
                    .catch((error: unknown) =>
                      setPlacementError(messageFrom(error)),
                    )
                    .finally(() => setPlacementPending(false));
                }}
              >
                {placementPending ? (
                  <LoaderCircle size={14} aria-hidden="true" />
                ) : placement.mode === "nested_under_source" ? (
                  <ArrowUpWideNarrow size={14} aria-hidden="true" />
                ) : (
                  <ArrowDownWideNarrow size={14} aria-hidden="true" />
                )}
              </button>
            )}
            {archiveDescendantCount > 0 ? (
              <ArchiveDropdown
                thread={thread}
                store={store}
                descendantCount={archiveDescendantCount}
                directWhenNoChoices
                side="right"
                disabled={pendingInventoryAction !== undefined}
                onPendingChange={(pending) => {
                  inventoryActionPending.current = pending;
                  setPendingInventoryAction(pending ? "archive" : undefined);
                }}
                onArchived={(_choice, archivedThreadIds) => {
                  if (
                    selectedThreadId &&
                    archivedThreadIds.includes(selectedThreadId)
                  ) {
                    navigate("/");
                    onNavigate({ keepDrawerOpen: true });
                  }
                }}
              >
                <button
                  type="button"
                  className="thread-row-archive"
                  data-testid="thread-row-archive"
                  aria-label={`Archive ${thread.title.text || "Untitled thread"}`}
                  title="Archive"
                >
                  <Archive size={14} strokeWidth={1.8} />
                </button>
              </ArchiveDropdown>
            ) : (
              // No fork descendants: archive immediately, mirroring the flat
              // row's direct archive. Touch devices never see this button
              // (row actions are CSS-hidden for coarse pointers).
              <button
                type="button"
                className="thread-row-archive"
                data-testid="thread-row-archive"
                aria-label={`Archive ${thread.title.text || "Untitled thread"}`}
                title="Archive"
                disabled={pendingInventoryAction !== undefined}
                onClick={() => {
                  if (inventoryActionPending.current) return;
                  inventoryActionPending.current = true;
                  setPendingInventoryAction("archive");
                  void runThreadArchiveCheck({
                    thread, store, onChoices: openArchiveChoices,
                    onArchived: () => {
                      if (selected) {
                        navigate("/");
                        onNavigate({ keepDrawerOpen: true });
                      }
                    },
                  })
                    .finally(() => {
                      inventoryActionPending.current = false;
                      setPendingInventoryAction(undefined);
                    });
                }}
              >
                <Archive size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
  return (
    <>
      <ThreadContextMenu
        thread={thread}
        store={store}
        onNavigate={onNavigate}
        onRename={beginRename}
        disabled={renaming}
        onAction={(action) => {
          // Archiving the open thread leaves the workspace view, matching
          // the thread-actions menu's archive behavior.
          if (action === "archive" && selected) {
            navigate("/");
            onNavigate({ keepDrawerOpen: true });
          }
        }}
        onArchiveFamily={(archivedThreadIds) => {
          if (
            !selected &&
            selectedThreadId &&
            archivedThreadIds.includes(selectedThreadId)
          ) {
            navigate("/");
            onNavigate({ keepDrawerOpen: true });
          }
        }}
        returnFocusRef={rowLink}
        origin={origin}
        sourceTitle={sourceTitle}
        placement={placement}
        threadRegistry={threadRegistry}
        familyDescendantCount={archiveDescendantCount}
        configurationCopyPending={configurationCopyPending}
      >
        {row}
      </ThreadContextMenu>
      <ArchiveChoicesDialog
        open={archiveChoicesOpen}
        initialImpact={archiveInitialImpact}
        onOpenChange={setArchiveChoicesOpen}
        thread={thread}
        store={store}
        descendantCount={0}
        disabled={pendingInventoryAction !== undefined}
        onPendingChange={(pending) => {
          inventoryActionPending.current = pending;
          setPendingInventoryAction(pending ? "archive" : undefined);
        }}
        onArchived={() => {
          if (selected) {
            navigate("/");
            onNavigate({ keepDrawerOpen: true });
          }
        }}
        returnFocusRef={rowLink}
      />
      <SettleImpactDialog
        open={settleChoicesOpen}
        onOpenChange={setSettleChoicesOpen}
        impact={settleImpact}
        loadImpact={() => store.getThreadArchiveImpact(thread.id)}
        onSettle={(options) => store.mutateInventory(thread, "settle", options)}
        returnFocusRef={rowLink}
      />
      <SnoozeDialog
        open={snoozeOpen}
        onOpenChange={setSnoozeOpen}
        onSnooze={(options) => store.mutateInventory(thread, "snooze", options)}
        onRemindNow={(wakeReminder) =>
          store.mutateInventory(thread, "remind", { wakeReminder })
        }
        returnFocusRef={rowLink}
      />
      {renameError && (
        <p className="thread-row-error" role="alert">
          {renameError}
        </p>
      )}
      {quickActionError && (
        <p className="thread-row-error" role="alert">
          {quickActionError}
        </p>
      )}
      {placementError && (
        <p className="thread-row-error" role="alert">
          {placementError}
        </p>
      )}
    </>
  );
}

function DescendantStatus({
  aggregate,
  familyDescendantCount,
}: {
  aggregate: DescendantAggregate;
  familyDescendantCount: number;
}): React.JSX.Element {
  const partial = familyDescendantCount > aggregate.count;
  const statusScope = partial ? " among loaded grouped descendants" : "";
  const statuses = [
    {
      chip: "descendants",
      count: familyDescendantCount,
      label: partial
        ? `${familyDescendantCount} lineage descendants; state is shown for ${aggregate.count} loaded grouped descendants`
        : `${aggregate.count} descendants`,
      icon: <GitBranchIcon />,
    },
    aggregate.failed > 0
      ? {
          chip: "failed",
          count: aggregate.failed,
          label: `${aggregate.failed} descendants failed${statusScope}`,
          icon: <CircleX />,
        }
      : undefined,
    aggregate.needsInput > 0
      ? {
          chip: "needs-input",
          count: aggregate.needsInput,
          label: `${aggregate.needsInput} descendants need input${statusScope}`,
          icon: <CircleHelp />,
        }
      : undefined,
    aggregate.running > 0
      ? {
          chip: "running",
          count: aggregate.running,
          label: `${aggregate.running} descendants running${statusScope}`,
          icon: <LoaderCircle />,
        }
      : undefined,
    aggregate.done > 0
      ? {
          chip: "done",
          count: aggregate.done,
          label: `${aggregate.done} descendants done${statusScope}`,
          icon: <span className="status-chip-dot" />,
        }
      : undefined,
    aggregate.attention > 0
      ? {
          chip: "attention",
          count: aggregate.attention,
          label: `${aggregate.attention} descendants need attention${statusScope}`,
          icon: <CircleAlert />,
        }
      : undefined,
  ].filter((status): status is NonNullable<typeof status> => Boolean(status));
  return (
    <span className="descendant-status">
      {statuses.map((status) => (
        <StatusChip key={status.chip} chip={status.chip} label={status.label}>
          {status.icon}
          <span className="status-chip-count">{status.count}</span>
        </StatusChip>
      ))}
    </span>
  );
}

function GitBranchIcon(): React.JSX.Element {
  return <ListTree size={14} strokeWidth={2} />;
}

function threadTaskSummaryLabel(summary: FlatThreadRowTaskSummary): string {
  return `${summary.openCount} open task${summary.openCount === 1 ? "" : "s"}`;
}

function loadedScopedLineageFamilies(
  snapshotThreadIds: readonly string[],
  snapshotOrigins: readonly NormalizedThreadForkOrigin[],
  descendants: readonly NormalizedThreadDescendant[],
): Array<{ sourceThreadId: string; descendantCount: number }> {
  const scopedThreadIds = new Set([
    ...snapshotThreadIds,
    ...descendants.map(({ thread }) => thread.id),
  ]);
  const origins = new Map(
    snapshotOrigins.map((origin) => [origin.childThreadId, origin]),
  );
  for (const { origin } of descendants) {
    origins.set(origin.childThreadId, origin);
  }
  const counts = new Map<string, number>();
  for (const threadId of scopedThreadIds) {
    const seen = new Set([threadId]);
    let currentId = threadId;
    while (true) {
      const sourceId = origins.get(currentId)?.sourceThreadId;
      if (!sourceId || seen.has(sourceId) || !scopedThreadIds.has(sourceId)) {
        break;
      }
      counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
      seen.add(sourceId);
      currentId = sourceId;
    }
  }
  return [...counts].map(([sourceThreadId, descendantCount]) => ({
    sourceThreadId,
    descendantCount,
  }));
}

/**
 * Compact icon replacement for the old outline text pills. `role="img"` +
 * `aria-label` keeps the state in the row's accessible name; `title` gives
 * sighted users the word on hover; `data-chip` is the test contract.
 */
function StatusChip({
  chip,
  label,
  children,
}: {
  chip: string;
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <span
      className="status-chip"
      data-chip={chip}
      role="img"
      aria-label={label}
      title={label}
    >
      {children}
    </span>
  );
}

/**
 * Project-view root ordering within a workspace group, following the mode's
 * resolved sort axis. `activity` folds the root's own effective timestamp
 * (max of activity and state change) into the subtree's maxActivityAt so
 * inventory transitions — which bump only stateChangedAt — order correctly.
 * Untitled threads stay last under `alpha` regardless of direction.
 */
function compareProjectRoots(
  preferences: SidebarSortPreferences,
): (left: SidebarLineageNode, right: SidebarLineageNode) => number {
  const direction = preferences.direction === "asc" ? 1 : -1;
  switch (preferences.sortBy) {
    case "activity":
      return (left, right) =>
        direction * (projectRootActivity(left) - projectRootActivity(right)) ||
        left.thread.id.localeCompare(right.thread.id);
    case "stateChanged":
      return (left, right) =>
        direction *
          (parseTimestamp(left.thread.stateChangedAt) -
            parseTimestamp(right.thread.stateChangedAt)) ||
        left.thread.id.localeCompare(right.thread.id);
    case "alpha":
      return (left, right) => {
        const leftTitle = left.thread.title.text.trim().toLocaleLowerCase();
        const rightTitle = right.thread.title.text.trim().toLocaleLowerCase();
        if (leftTitle === "" || rightTitle === "") {
          if ((leftTitle === "") !== (rightTitle === "")) {
            return leftTitle === "" ? 1 : -1;
          }
          return left.thread.id.localeCompare(right.thread.id);
        }
        return (
          direction * leftTitle.localeCompare(rightTitle) ||
          left.thread.id.localeCompare(right.thread.id)
        );
      };
  }
}

function projectRootActivity(node: SidebarLineageNode): number {
  let latest = sidebarEffectiveTimestamp(node.thread);
  for (const child of node.children) {
    latest = Math.max(latest, projectRootActivity(child));
  }
  return latest;
}

function sortProjectNodes(
  nodes: readonly SidebarLineageNode[],
  compare: (left: SidebarLineageNode, right: SidebarLineageNode) => number,
): SidebarLineageNode[] {
  return nodes
    .map((node) => ({
      ...node,
      children: sortProjectNodes(node.children, compare),
    }))
    .sort(compare);
}

function flattenProjectNodes(
  nodes: readonly SidebarLineageNode[],
): NormalizedApplicationThreadSummary[] {
  const threads: NormalizedApplicationThreadSummary[] = [];
  const visit = (node: SidebarLineageNode) => {
    threads.push(node.thread);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return threads;
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * The Snoozed shelf keeps its pinned semantic order regardless of the sort
 * axis: ascending by wake, entries without a wake last, ties by id.
 */
function compareSnoozedRoots(
  left: SidebarLineageNode,
  right: SidebarLineageNode,
): number {
  const leftWake = sidebarWakeTimestamp(left.thread);
  const rightWake = sidebarWakeTimestamp(right.thread);
  if (leftWake === undefined && rightWake !== undefined) return 1;
  if (leftWake !== undefined && rightWake === undefined) return -1;
  if (
    leftWake !== undefined &&
    rightWake !== undefined &&
    leftWake !== rightWake
  ) {
    return leftWake - rightWake;
  }
  return left.thread.id.localeCompare(right.thread.id);
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
