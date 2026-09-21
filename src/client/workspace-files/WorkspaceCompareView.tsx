import type { ContextExcerptStagingTarget } from "../context-excerpts/coordinator.js";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  CodeViewDiffItem,
  CodeViewItem,
  CodeViewLineSelection,
  DiffLineAnnotation,
  FileContents,
  FileDiffContentsLoader,
  FileDiffMetadata,
  SelectedLineRange,
} from "@pierre/diffs";
import { parsePatchFiles, DEFAULT_CODE_VIEW_FILE_METRICS } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  Check,
  Circle,
  FileText,
  ArrowUp,
  ArrowDown,
  PanelLeft,
  ChevronDown,
  LoaderCircle,
  RotateCw,
  X,
} from "lucide-react";
import type {
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffChangedFilesQuery,
  WorkspaceDiffChangedFilesResult,
  WorkspaceDiffComparisonCreateRequest,
  WorkspaceDiffComparisonCreateResult,
  WorkspaceDiffComparisonDescriptor,
  WorkspaceDiffFileContentRequest,
  WorkspaceDiffFileContentResult,
  WorkspaceDiffFileId,
  WorkspaceDiffFileRequest,
  WorkspaceDiffPatchResult,
  WorkspaceDiffRefCatalogResult,
  WorkspaceDiffRefCatalogQuery,
  WorkspaceDiffRepositoriesResult,
  WorkspaceDiffRepositoryDescriptor,
  WorkspaceDiffRepositoryId,
  WorkspaceDiffRevisionDescriptor,
  WorkspaceDiffRevisionSelection,
} from "../../shared/protocol/workspace-diffs.js";
import type { WorkspaceFileRootId } from "../../shared/protocol/workspace-files.js";
import {
  getResolvedAppearance,
  subscribeResolvedAppearance,
} from "../app/appearance.js";
import {
  captureUnifiedDiffLineSelection,
  type CapturedDiffLineSelection,
  type PierreSelectionFailureReason,
} from "../context-excerpts/pierre-selection.js";
import {
  PierreSelectionAction,
  type PierreSelectionStageResult,
} from "../context-excerpts/PierreSelectionAction.js";
import { boundedPierreLanguage } from "./pierre-language.js";
import {
  DEFAULT_WORKSPACE_COMPARE_PREFERENCES,
  defaultWorkspaceCompareSelections,
  effectiveWorkspaceComparePreferences,
  workspaceCompareFilePath,
  workspaceComparePresetSelections,
  workspaceCompareSelectionLabel,
  workspaceCompareSelectionKey,
  workspaceCompareSupportsMergeBase,
  type WorkspaceComparePreferences,
} from "./workspace-compare-state.js";
import { WorkspaceRevisionPicker } from "./WorkspaceRevisionPicker.js";
import { WorkspaceChangedFileNavigator } from "./WorkspaceChangedFileNavigator.js";
import {
  compareEndpointIntent,
  compareEndpointSelection,
  type WorkspaceCompareNavigation,
} from "./workspace-compare-navigation.js";
import "./workspace-compare.css";

const INITIAL_DIFF_BATCH_SIZE = 8;
const MAX_PATCH_REQUESTS = 3;
const MAX_QUEUED_PATCH_REQUESTS = 12;
const MAX_PATCH_CACHE_BYTES = 32 * 1024 * 1024;

export interface WorkspaceCompareDataSource {
  readonly listRepositories: (
    rootId: WorkspaceFileRootId,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDiffRepositoriesResult>;
  readonly listRevisions: (
    repositoryId: WorkspaceDiffRepositoryId,
    signal?: AbortSignal,
    query?: Partial<Omit<WorkspaceDiffRefCatalogQuery, "repositoryId">>,
  ) => Promise<WorkspaceDiffRefCatalogResult>;
  readonly createComparison: (
    request: WorkspaceDiffComparisonCreateRequest,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDiffComparisonCreateResult>;
  readonly listChangedFiles: (
    query: WorkspaceDiffChangedFilesQuery,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDiffChangedFilesResult>;
  readonly loadPatch: (
    request: WorkspaceDiffFileRequest,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDiffPatchResult>;
  readonly loadFileContent: (
    request: WorkspaceDiffFileContentRequest,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDiffFileContentResult>;
}

export interface WorkspaceCompareReviewAnnotation {
  readonly annotationId: string;
  readonly fileId?: WorkspaceDiffFileId;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly side: "deletions" | "additions";
  readonly lineNumber: number;
  readonly body: string;
  readonly authorLabel?: string;
  readonly placement?: "current" | "outdated" | "unplaced";
}

export interface WorkspaceCompareLineTarget {
  readonly comparison: WorkspaceDiffComparisonDescriptor;
  readonly file: WorkspaceDiffChangedFileSummary;
  readonly range: SelectedLineRange;
}

export interface WorkspaceCompareCapturedLineTarget
  extends WorkspaceCompareLineTarget {
  readonly captured: CapturedDiffLineSelection;
}

export interface WorkspaceCompareViewProps {
  readonly rootId: WorkspaceFileRootId;
  readonly initialNavigation?: WorkspaceCompareNavigation;
  readonly onNavigationChange?: (
    navigation: WorkspaceCompareNavigation,
  ) => void;
  readonly onOpenFile?: (path: string) => void;
  readonly dataSource: WorkspaceCompareDataSource;
  readonly visible?: boolean;
  readonly reviewControls?: ReactNode;
  readonly annotations?: readonly WorkspaceCompareReviewAnnotation[];
  readonly reviewedFileIds?: ReadonlySet<WorkspaceDiffFileId>;
  readonly onCreateAnnotation?: (target: WorkspaceCompareLineTarget) => void;
  readonly onSelectAnnotation?: (
    annotation: WorkspaceCompareReviewAnnotation,
  ) => void;
  readonly onDeleteAnnotation?: (
    annotation: WorkspaceCompareReviewAnnotation,
  ) => void;
  readonly onReviewedChange?: (
    fileId: WorkspaceDiffFileId,
    reviewed: boolean,
  ) => void;
  readonly onComparisonChange?: (
    comparison: WorkspaceDiffComparisonDescriptor | undefined,
  ) => void;
  readonly onFilesChange?: (
    files: readonly WorkspaceDiffChangedFileSummary[],
  ) => void;
  readonly onSelectedLinesChange?: (
    target: WorkspaceCompareCapturedLineTarget | undefined,
  ) => void;
  readonly stagingTarget?: ContextExcerptStagingTarget;
  readonly onAttachSelection?: (
    target: WorkspaceCompareCapturedLineTarget & { readonly note?: string },
    sendImmediately?: boolean,
  ) => PierreSelectionStageResult;
}

type PendingWorkspaceCompareSelection =
  | {
      readonly ok: true;
      readonly target: WorkspaceCompareCapturedLineTarget;
    }
  | { readonly ok: false; readonly reason: PierreSelectionFailureReason };

type PatchLoad =
  | { readonly status: "loading" }
  | {
      readonly status: "loaded";
      readonly item: CodeViewDiffItem<WorkspaceCompareReviewAnnotation>;
      readonly bytes: number;
    }
  | {
      readonly status: "binary" | "too_large" | "unavailable" | "invalid";
      readonly detail?: string;
    };

export function WorkspaceCompareView({
  rootId,
  initialNavigation,
  onNavigationChange,
  onOpenFile,
  dataSource,
  visible = true,
  reviewControls,
  annotations = [],
  reviewedFileIds = EMPTY_REVIEWED_FILES,
  onCreateAnnotation,
  onSelectAnnotation,
  onDeleteAnnotation,
  onReviewedChange,
  onComparisonChange,
  onFilesChange,
  onSelectedLinesChange,
  onAttachSelection,
  stagingTarget,
}: WorkspaceCompareViewProps): React.JSX.Element {
  const restoreRef = useRef(initialNavigation);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const navigationCallbackRef = useRef(onNavigationChange);
  navigationCallbackRef.current = onNavigationChange;
  const returnLocationsRef = useRef(
    new Map(
      (initialNavigation?.returnLocations ?? []).map((anchor) => [
        JSON.stringify([anchor.oldPath, anchor.newPath, anchor.changeKind]),
        anchor,
      ]),
    ),
  );
  const rememberAnchor = (
    anchor: NonNullable<WorkspaceCompareNavigation["file"]>,
  ) => {
    const key = JSON.stringify([
      anchor.oldPath,
      anchor.newPath,
      anchor.changeKind,
    ]);
    returnLocationsRef.current.delete(key);
    returnLocationsRef.current.set(key, anchor);
    while (returnLocationsRef.current.size > 32)
      returnLocationsRef.current.delete(
        returnLocationsRef.current.keys().next().value!,
      );
  };
  const currentFileRef = useRef<WorkspaceDiffFileId | undefined>(undefined);
  const anchorRef = useRef<WorkspaceCompareNavigation["file"]>(undefined);
  const [currentFileId, setCurrentFileId] = useState<WorkspaceDiffFileId>();
  const [navigatorWidth, setNavigatorWidth] = useState(
    initialNavigation?.navigatorWidth ?? 260,
  );
  const [collapsedDirectories, setCollapsedDirectories] = useState<
    readonly string[]
  >(initialNavigation?.collapsedDirectories ?? []);
  const [restoreNotice, setRestoreNotice] = useState<string>();
  const patchSlotsRef = useRef(0);
  const patchWaitersRef = useRef<
    Array<{ fileId: WorkspaceDiffFileId; resume: (proceed: boolean) => void }>
  >([]);
  const prefetchRef = useRef<(index: number) => void>(() => undefined);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const settingsToggleRef = useRef<HTMLButtonElement>(null);
  const settingsBodyRef = useRef<HTMLDivElement>(null);
  const settingsId = useId();
  const codeViewRef =
    useRef<CodeViewHandle<WorkspaceCompareReviewAnnotation> | null>(null);
  const activeComparisonRef = useRef<
    WorkspaceDiffComparisonDescriptor | undefined
  >(undefined);
  const changedFilesRef = useRef<readonly WorkspaceDiffChangedFileSummary[]>(
    [],
  );
  const fileByMetadataRef = useRef(
    new WeakMap<FileDiffMetadata, WorkspaceDiffChangedFileSummary>(),
  );
  const patchesRef = useRef<ReadonlyMap<WorkspaceDiffFileId, PatchLoad>>(
    new Map(),
  );
  const requestGenerationRef = useRef(0);
  const liveRepositoryRef = useRef<
    WorkspaceDiffRepositoryDescriptor | undefined
  >(undefined);
  const comparisonAbortRef = useRef<AbortController | undefined>(undefined);
  const fileLoadAbortControllersRef = useRef(new Set<AbortController>());
  const onComparisonChangeRef = useRef(onComparisonChange);
  onComparisonChangeRef.current = onComparisonChange;

  const abortComparisonWork = useCallback(() => {
    requestGenerationRef.current++;
    activeComparisonRef.current = undefined;
    historyAbortRef.current?.abort();
    comparisonAbortRef.current?.abort();
    comparisonAbortRef.current = undefined;
    for (const controller of fileLoadAbortControllersRef.current)
      controller.abort();
    fileLoadAbortControllersRef.current.clear();
    for (const waiting of patchWaitersRef.current.splice(0))
      waiting.resume(false);
  }, []);
  const replacePatches = useCallback(
    (next: ReadonlyMap<WorkspaceDiffFileId, PatchLoad>) => {
      patchesRef.current = next;
      setPatches(next);
    },
    [],
  );
  const updatePatches = useCallback(
    (
      updater: (
        current: ReadonlyMap<WorkspaceDiffFileId, PatchLoad>,
      ) => ReadonlyMap<WorkspaceDiffFileId, PatchLoad>,
    ) => {
      const next = updater(patchesRef.current);
      patchesRef.current = next;
      setPatches(next);
    },
    [],
  );

  const [themeType, setThemeType] = useState(getResolvedAppearance);
  const [narrow, setNarrow] = useState(false);
  const [surfaceWidth, setSurfaceWidth] = useState(0);
  const [surfaceHeight, setSurfaceHeight] = useState(0);
  const [settingsExpanded, setSettingsExpanded] = useState(true);
  const [repositories, setRepositories] = useState<
    readonly WorkspaceDiffRepositoryDescriptor[]
  >([]);
  const [repositoryId, setRepositoryId] = useState<WorkspaceDiffRepositoryId>();
  const [historyScope, setHistoryScope] = useState("head");
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [revisionsTruncated, setRevisionsTruncated] = useState(false);
  const [revisions, setRevisions] = useState<
    readonly WorkspaceDiffRevisionDescriptor[]
  >([]);
  const [base, setBase] = useState<WorkspaceDiffRevisionSelection>();
  const [head, setHead] = useState<WorkspaceDiffRevisionSelection>({
    kind: "working_tree",
  });
  const [mode, setMode] =
    useState<WorkspaceDiffComparisonCreateRequest["mode"]>("direct");
  const [preferences, setPreferences] = useState<WorkspaceComparePreferences>(
    initialNavigation?.preferences ?? DEFAULT_WORKSPACE_COMPARE_PREFERENCES,
  );
  const [comparison, setComparison] =
    useState<WorkspaceDiffComparisonDescriptor>();
  const [changedFiles, setChangedFiles] = useState<
    readonly WorkspaceDiffChangedFileSummary[]
  >([]);
  const [filesTruncated, setFilesTruncated] = useState(false);
  const [patches, setPatches] = useState<
    ReadonlyMap<WorkspaceDiffFileId, PatchLoad>
  >(new Map());
  const [selectedLines, setSelectedLines] =
    useState<CodeViewLineSelection | null>(null);
  const [pendingSelection, setPendingSelection] =
    useState<PendingWorkspaceCompareSelection>();
  const [navigatorOpen, setNavigatorOpen] = useState(false);
  const [filter, setFilter] = useState(initialNavigation?.filter ?? "");
  const [busy, setBusy] = useState<
    "repositories" | "revisions" | "comparison" | "idle"
  >("repositories");
  const [notice, setNotice] = useState<string>();
  const [pendingScrollFileId, setPendingScrollFileId] =
    useState<WorkspaceDiffFileId>();
  const preserveEndpointModeRef = useRef(false);
  const historyAbortRef = useRef<AbortController | undefined>(undefined);
  const drawerRef = useRef<HTMLDivElement>(null);
  const previousEndpointKeyRef = useRef<string | undefined>(undefined);

  useEffect(() => subscribeResolvedAppearance(setThemeType), []);
  useEffect(() => {
    if (visible) return;
    setPendingSelection(undefined);
    setSelectedLines(null);
    onSelectedLinesChange?.(undefined);
  }, [onSelectedLinesChange, visible]);
  useEffect(() => {
    onFilesChange?.(changedFiles);
  }, [changedFiles, onFilesChange]);
  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const update = () => {
      setNarrow(element.clientWidth < 720);
      setSurfaceWidth(element.clientWidth);
      setSurfaceHeight(element.clientHeight);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const endpointKey = `${base ? workspaceCompareSelectionKey(base) : ""}|${head ? workspaceCompareSelectionKey(head) : ""}`;
    const previousKey = previousEndpointKeyRef.current;
    previousEndpointKeyRef.current = endpointKey;
    if (previousKey === undefined || previousKey === endpointKey) return;
    if (restoreRef.current) return;
    if (preserveEndpointModeRef.current) {
      preserveEndpointModeRef.current = false;
      return;
    }
    setMode(
      workspaceCompareSupportsMergeBase(base, head) ? "merge_base" : "direct",
    );
  }, [base, head]);

  useEffect(() => {
    abortComparisonWork();
    const controller = new AbortController();
    const generation = ++requestGenerationRef.current;
    setBusy("repositories");
    setNotice(undefined);
    setRepositories([]);
    liveRepositoryRef.current = undefined;
    setRepositoryId(undefined);
    setRevisions([]);
    setComparison(undefined);
    onComparisonChangeRef.current?.(undefined);
    activeComparisonRef.current = undefined;
    setChangedFiles([]);
    setFilesTruncated(false);
    replacePatches(new Map());
    setSelectedLines(null);
    setPendingSelection(undefined);
    setSettingsExpanded(true);
    onSelectedLinesChange?.(undefined);
    void dataSource
      .listRepositories(rootId, controller.signal)
      .then((result) => {
        if (generation !== requestGenerationRef.current) return;
        if (result.status === "unavailable") {
          setNotice(
            diagnosticMessage(
              "Comparison is unavailable",
              result.diagnosticCode,
            ),
          );
          return;
        }
        setRepositories(result.repositories);
        const saved = restoreRef.current?.repository;
        const matching = saved
          ? result.repositories.find(
              (repo) => repo.repositoryKey === saved.repositoryKey,
            )
          : result.repositories[0];
        setRepositoryId(matching?.repositoryId);
        if (saved && !matching)
          setNotice(
            "The saved repository is no longer available. Choose a repository to continue.",
          );
        if (result.repositories.length === 0)
          setNotice("No Git repository was found for this Files root.");
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          generation === requestGenerationRef.current
        )
          setNotice(errorMessage("Could not discover repositories", error));
      })
      .finally(() => {
        if (generation === requestGenerationRef.current && !repositoryId)
          setBusy("idle");
      });
    return () => {
      controller.abort();
      abortComparisonWork();
    };
  }, [
    abortComparisonWork,
    dataSource,
    onSelectedLinesChange,
    replacePatches,
    rootId,
  ]);

  useEffect(() => {
    if (!repositoryId) return;
    liveRepositoryRef.current = repositories.find(
      (repository) => repository.repositoryId === repositoryId,
    );
    abortComparisonWork();
    const controller = new AbortController();
    const generation = ++requestGenerationRef.current;
    setBusy("revisions");
    setNotice(undefined);
    setRevisions([]);
    setComparison(undefined);
    onComparisonChangeRef.current?.(undefined);
    activeComparisonRef.current = undefined;
    setChangedFiles([]);
    setFilesTruncated(false);
    replacePatches(new Map());
    setSelectedLines(null);
    setPendingSelection(undefined);
    onSelectedLinesChange?.(undefined);
    void dataSource
      .listRevisions(repositoryId, controller.signal)
      .then(async (result) => {
        if (generation !== requestGenerationRef.current) return;
        if (result.status === "unavailable") {
          setNotice(
            diagnosticMessage(
              "Revisions are unavailable",
              result.diagnosticCode,
            ),
          );
          return;
        }
        let catalog = [...result.revisions];
        const savedIntent = restoreRef.current;
        if (savedIntent)
          for (const intent of [savedIntent.base, savedIntent.head]) {
            if (compareEndpointSelection(intent, catalog)) continue;
            const query =
              intent.kind === "commit"
                ? { resolveCommit: intent.commitHash }
                : intent.kind === "ref"
                  ? {
                      resolveRef: `refs/${intent.refKind === "local_branch" ? "heads" : intent.refKind === "remote_branch" ? "remotes" : "tags"}/${intent.label}`,
                    }
                  : undefined;
            if (!query) continue;
            const resolved = await dataSource.listRevisions(
              repositoryId,
              controller.signal,
              query,
            );
            if (generation !== requestGenerationRef.current) return;
            if (resolved.status === "available")
              catalog = [
                ...catalog,
                ...resolved.revisions.filter(
                  (entry) =>
                    !catalog.some(
                      (known) => known.revisionId === entry.revisionId,
                    ),
                ),
              ];
          }
        setRevisions(catalog);
        setRevisionsTruncated(result.truncated);
        const defaults = defaultWorkspaceCompareSelections(
          catalog,
          repositories.find((repo) => repo.repositoryId === repositoryId)?.head
            ?.commitHash,
        );
        const saved = restoreRef.current;
        const restoredBase = saved
          ? compareEndpointSelection(saved.base, catalog)
          : defaults.base;
        const restoredHead = saved
          ? compareEndpointSelection(saved.head, catalog)
          : defaults.head;
        setBase(restoredBase);
        setHead(restoredHead ?? { kind: "working_tree" });
        if (saved && (!restoredBase || !restoredHead))
          setNotice(
            "A saved revision is no longer available. Select the comparison endpoints again.",
          );
        if (saved) setMode(saved.mode);
        if (!defaults.base)
          setNotice("This repository has no revision available as a base.");
      })
      .catch((error: unknown) => {
        if (
          !controller.signal.aborted &&
          generation === requestGenerationRef.current
        )
          setNotice(errorMessage("Could not load revisions", error));
      })
      .finally(() => {
        if (generation === requestGenerationRef.current) setBusy("idle");
      });
    return () => {
      controller.abort();
      abortComparisonWork();
    };
  }, [
    abortComparisonWork,
    dataSource,
    onSelectedLinesChange,
    replacePatches,
    repositoryId,
  ]);

  const loadComparison = useCallback(async () => {
    if (!repositoryId || !base) return;
    const previousFile = anchorRef.current;
    const previousFingerprint = activeComparisonRef.current?.fingerprint;
    abortComparisonWork();
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    comparisonAbortRef.current = controller;
    setBusy("comparison");
    setNotice(undefined);
    setRestoreNotice(undefined);
    setComparison(undefined);
    onComparisonChangeRef.current?.(undefined);
    activeComparisonRef.current = undefined;
    setChangedFiles([]);
    changedFilesRef.current = [];
    setFilesTruncated(false);
    replacePatches(new Map());
    setSelectedLines(null);
    setPendingSelection(undefined);
    onSelectedLinesChange?.(undefined);
    try {
      const selectedRepository = repositories.find(
        (repository) => repository.repositoryId === repositoryId,
      );
      const baseIntent = compareEndpointIntent(base, revisions);
      const headIntent = compareEndpointIntent(head, revisions);
      if (!selectedRepository || !baseIntent || !headIntent)
        throw new Error("Select both comparison sources again.");
      const discovered = await dataSource.listRepositories(
        rootId,
        controller.signal,
      );
      if (generation !== requestGenerationRef.current) return;
      if (discovered.status !== "available")
        throw new Error(
          "The repository is temporarily unavailable. Refresh when the connection returns.",
        );
      const freshRepository = discovered.repositories.find(
        (repository) =>
          repository.repositoryKey === selectedRepository.repositoryKey,
      );
      if (!freshRepository)
        throw new Error(
          "The selected repository is no longer available. Choose another Files root or repository.",
        );
      const freshCatalog = await dataSource.listRevisions(
        freshRepository.repositoryId,
        controller.signal,
      );
      if (generation !== requestGenerationRef.current) return;
      if (freshCatalog.status !== "available")
        throw new Error(
          "Revisions are unavailable. Refresh when the connection returns.",
        );
      let nextRevisions = [...freshCatalog.revisions];
      const intents = [baseIntent, headIntent];
      const isEndpointRevision = (revision: WorkspaceDiffRevisionDescriptor) =>
        intents.some((intent) =>
          intent.kind === "commit"
            ? revision.kind === "commit" &&
              revision.commitHash === intent.commitHash
            : intent.kind === "ref" &&
              revision.kind === intent.refKind &&
              revision.label === intent.label,
        );
      for (const intent of intents) {
        const query =
          intent.kind === "ref"
            ? {
                resolveRef: `refs/${intent.refKind === "local_branch" ? "heads" : intent.refKind === "remote_branch" ? "remotes" : "tags"}/${intent.label}`,
              }
            : intent.kind === "commit" &&
                !compareEndpointSelection(intent, nextRevisions)
              ? { resolveCommit: intent.commitHash }
              : undefined;
        if (!query) continue;
        const catalog = await dataSource.listRevisions(
          freshRepository.repositoryId,
          controller.signal,
          query,
        );
        if (generation !== requestGenerationRef.current) return;
        if (
          catalog.status !== "available" ||
          !compareEndpointSelection(intent, catalog.revisions)
        )
          throw new Error(
            "A comparison revision is no longer available. Select the endpoints again.",
          );
        nextRevisions = [
          ...catalog.revisions,
          ...nextRevisions.filter(
            (entry) =>
              isEndpointRevision(entry) &&
              !catalog.revisions.some(
                (next) =>
                  next.revisionId === entry.revisionId ||
                  (entry.kind !== "commit" &&
                    next.kind === entry.kind &&
                    next.label === entry.label),
              ),
          ),
        ];
      }
      const nextBase = compareEndpointSelection(baseIntent, nextRevisions);
      const nextHead = compareEndpointSelection(headIntent, nextRevisions);
      if (!nextBase || !nextHead)
        throw new Error(
          "A comparison revision is no longer available. Select the endpoints again.",
        );
      liveRepositoryRef.current = freshRepository;
      preserveEndpointModeRef.current =
        workspaceCompareSelectionKey(nextBase) !==
          workspaceCompareSelectionKey(base) ||
        workspaceCompareSelectionKey(nextHead) !==
          workspaceCompareSelectionKey(head);
      setBase(nextBase);
      setHead(nextHead);
      setRevisions(nextRevisions);
      setHistoryScope((scope) => {
        if (!scope.startsWith("revision:")) return scope;
        const previous = revisions.find(
          (revision) => `revision:${revision.revisionId}` === scope,
        );
        const current =
          previous &&
          nextRevisions.find(
            (revision) =>
              revision.kind === previous.kind &&
              revision.label === previous.label,
          );
        return current ? `revision:${current.revisionId}` : "head";
      });
      const result = await dataSource.createComparison(
        {
          repositoryId: freshRepository.repositoryId,
          mode: workspaceCompareSupportsMergeBase(nextBase, nextHead)
            ? mode
            : "direct",
          base: nextBase,
          head: nextHead,
        },
        controller.signal,
      );
      if (generation !== requestGenerationRef.current) return;
      if (result.status === "unavailable") {
        setNotice(
          diagnosticMessage(
            "Could not create comparison",
            result.diagnosticCode,
          ),
        );
        return;
      }
      const nextComparison = result.comparison;
      setComparison(nextComparison);
      onComparisonChangeRef.current?.(nextComparison);
      activeComparisonRef.current = nextComparison;
      let after: WorkspaceDiffFileId | undefined;
      const accumulated: WorkspaceDiffChangedFileSummary[] = [];
      let truncated = false;
      const seenCursors = new Set<string>();
      const seenFiles = new Set<string>();
      do {
        const page = await dataSource.listChangedFiles(
          {
            comparisonId: nextComparison.comparisonId,
            fingerprint: nextComparison.fingerprint,
            ...(after ? { after } : {}),
            pageSize: 200,
          },
          controller.signal,
        );
        if (generation !== requestGenerationRef.current) return;
        if (page.status === "stale") {
          activeComparisonRef.current = undefined;
          onComparisonChangeRef.current?.(undefined);
          setNotice(
            "The working tree changed while this comparison was loading. Refresh to compare the current state.",
          );
          return;
        }
        if (page.status === "unavailable") {
          setNotice(
            diagnosticMessage(
              "Changed files are unavailable",
              page.diagnosticCode,
            ),
          );
          return;
        }
        accumulated.push(
          ...page.files.filter((file) => {
            if (seenFiles.has(file.fileId)) return false;
            seenFiles.add(file.fileId);
            return true;
          }),
        );
        setChangedFiles([...accumulated]);
        changedFilesRef.current = [...accumulated];
        truncated ||= page.truncated;
        after = page.nextCursor;
        if (after && seenCursors.has(after))
          throw new Error("Changed files returned a repeated cursor.");
        if (after) seenCursors.add(after);
      } while (after);
      setFilesTruncated(truncated);
      const saved = restoreRef.current;
      const target = previousFile ?? saved?.file;
      if (
        nextComparison.fingerprint !==
        (previousFingerprint ?? saved?.fingerprint)
      )
        returnLocationsRef.current.clear();
      const targetFile =
        target &&
        accumulated.find(
          (file) =>
            file.oldPath === target.oldPath &&
            file.newPath === target.newPath &&
            file.changeKind === target.changeKind,
        );
      if (targetFile) {
        const exact =
          nextComparison.fingerprint ===
          (previousFingerprint ?? saved?.fingerprint);
        anchorRef.current = {
          oldPath: targetFile.oldPath,
          newPath: targetFile.newPath,
          changeKind: targetFile.changeKind,
          ...(exact
            ? { line: target?.line, side: target?.side, offset: target?.offset }
            : {}),
        };
        currentFileRef.current = targetFile.fileId;
        setCurrentFileId(targetFile.fileId);
        setPendingScrollFileId(targetFile.fileId);
        if (!exact)
          setRestoreNotice(
            "The comparison changed. Returned to the file header.",
          );
      } else {
        if (target)
          setRestoreNotice(
            "The previously viewed file is no longer in this comparison.",
          );
        const first = accumulated[0];
        anchorRef.current = first
          ? {
              oldPath: first.oldPath,
              newPath: first.newPath,
              changeKind: first.changeKind,
            }
          : undefined;
        currentFileRef.current = first?.fileId;
        setCurrentFileId(first?.fileId);
        setPendingScrollFileId(undefined);
      }
      restoreRef.current = undefined;
      if (accumulated.length === 0)
        setNotice("No changed files in this comparison.");
    } catch (error: unknown) {
      if (
        !controller.signal.aborted &&
        generation === requestGenerationRef.current
      )
        setNotice(errorMessage("Could not load comparison", error));
    } finally {
      if (comparisonAbortRef.current === controller)
        comparisonAbortRef.current = undefined;
      if (generation === requestGenerationRef.current) setBusy("idle");
    }
  }, [
    abortComparisonWork,
    base,
    dataSource,
    head,
    mode,
    onSelectedLinesChange,
    replacePatches,
    repositoryId,
    repositories,
    rootId,
    revisions,
  ]);

  const ensurePatch = useCallback(
    async (
      file: WorkspaceDiffChangedFileSummary,
      options: { readonly force?: boolean; readonly priority?: boolean } = {},
    ): Promise<boolean> => {
      const active = activeComparisonRef.current;
      if (!active) return false;
      const existing = patchesRef.current.get(file.fileId);
      if (existing?.status === "loaded") return true;
      if (existing?.status === "loading") {
        if (options.priority) {
          const index = patchWaitersRef.current.findIndex(
            (entry) => entry.fileId === file.fileId,
          );
          if (index > 0) {
            const [entry] = patchWaitersRef.current.splice(index, 1);
            patchWaitersRef.current.unshift(entry!);
          }
        }
        return false;
      }
      if (existing && !options.force) return false;
      updatePatches((current) =>
        new Map(current).set(file.fileId, { status: "loading" }),
      );
      const generation = requestGenerationRef.current;
      while (patchSlotsRef.current >= MAX_PATCH_REQUESTS) {
        if (generation !== requestGenerationRef.current) return false;
        const proceed = await new Promise<boolean>((resume) => {
          if (patchWaitersRef.current.length >= MAX_QUEUED_PATCH_REQUESTS) {
            if (!options.priority) {
              resume(false);
              return;
            }
            patchWaitersRef.current.pop()?.resume(false);
          }
          const entry = { fileId: file.fileId, resume };
          if (options.priority) patchWaitersRef.current.unshift(entry);
          else patchWaitersRef.current.push(entry);
        });
        if (!proceed) {
          if (generation === requestGenerationRef.current)
            updatePatches((current) => {
              const next = new Map(current);
              next.delete(file.fileId);
              return next;
            });
          return false;
        }
      }
      if (
        generation !== requestGenerationRef.current ||
        activeComparisonRef.current?.comparisonId !== active.comparisonId
      )
        return false;
      if (
        (!visibleRef.current || document.visibilityState === "hidden") &&
        !options.priority
      ) {
        updatePatches((current) => {
          const next = new Map(current);
          next.delete(file.fileId);
          return next;
        });
        return false;
      }
      patchSlotsRef.current++;
      const controller = new AbortController();
      fileLoadAbortControllersRef.current.add(controller);
      try {
        const result = await dataSource.loadPatch(
          {
            comparisonId: active.comparisonId,
            fingerprint: active.fingerprint,
            fileId: file.fileId,
          },
          controller.signal,
        );
        if (
          generation !== requestGenerationRef.current ||
          activeComparisonRef.current?.comparisonId !== active.comparisonId
        )
          return false;
        if (result.status === "stale") {
          activeComparisonRef.current = undefined;
          onComparisonChangeRef.current?.(undefined);
          setNotice(
            "The comparison is stale because the working tree changed. Refresh it before continuing review.",
          );
          updatePatches((current) =>
            new Map(current).set(file.fileId, { status: "unavailable" }),
          );
          return false;
        }
        if (result.status !== "available") {
          const load: PatchLoad =
            result.status === "binary"
              ? { status: "binary" }
              : result.status === "too_large"
                ? { status: "too_large" }
                : { status: "unavailable", detail: result.diagnosticCode };
          updatePatches((current) => new Map(current).set(file.fileId, load));
          return false;
        }
        const fileDiff = parseFilePatch(result.patch, file, active.fingerprint);
        if (!fileDiff) {
          updatePatches((current) =>
            new Map(current).set(file.fileId, { status: "invalid" }),
          );
          return false;
        }
        fileByMetadataRef.current.set(fileDiff, file);
        const item: CodeViewDiffItem<WorkspaceCompareReviewAnnotation> = {
          id: file.fileId,
          type: "diff",
          fileDiff,
        };
        updatePatches((current) =>
          new Map(current).set(file.fileId, {
            status: "loaded",
            item,
            bytes: result.patch.length * 2,
          }),
        );
        return true;
      } catch (error: unknown) {
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        )
          return false;
        updatePatches((current) =>
          new Map(current).set(file.fileId, {
            status: "unavailable",
            detail: error instanceof Error ? error.message : undefined,
          }),
        );
        return false;
      } finally {
        patchSlotsRef.current--;
        patchWaitersRef.current.shift()?.resume(true);
        fileLoadAbortControllersRef.current.delete(controller);
      }
    },
    [dataSource, updatePatches, visible],
  );

  prefetchRef.current = (index: number) => {
    if (!visible || document.visibilityState === "hidden") return;
    const files = changedFilesRef.current;
    for (const file of files.slice(
      Math.max(0, index),
      index + INITIAL_DIFF_BATCH_SIZE,
    ))
      void ensurePatch(file);
  };
  useEffect(() => {
    if (!visible) return;
    const saved = restoreRef.current?.file;
    const index = saved
      ? changedFiles.findIndex(
          (file) =>
            file.oldPath === saved.oldPath && file.newPath === saved.newPath,
        )
      : changedFiles.findIndex(
          (file) =>
            file.fileId === (pendingScrollFileId ?? currentFileRef.current),
        );
    if (saved && index < 0) return;
    prefetchRef.current(Math.max(0, index));
  }, [changedFiles, visible, pendingScrollFileId]);
  useEffect(() => {
    const resume = () =>
      prefetchRef.current(
        Math.max(
          0,
          changedFilesRef.current.findIndex(
            (file) => file.fileId === currentFileRef.current,
          ),
        ),
      );
    document.addEventListener("visibilitychange", resume);
    return () => document.removeEventListener("visibilitychange", resume);
  }, []);
  useEffect(() => {
    let bytes = 0;
    for (const load of patches.values())
      if (load.status === "loaded") bytes += load.bytes;
    if (bytes <= MAX_PATCH_CACHE_BYTES) return;
    const currentIndex = changedFiles.findIndex(
      (file) => file.fileId === currentFileRef.current,
    );
    const protectedIds = new Set(
      changedFiles
        .slice(
          Math.max(0, currentIndex - 3),
          currentIndex + INITIAL_DIFF_BATCH_SIZE,
        )
        .map((file) => file.fileId),
    );
    if (pendingScrollFileId) protectedIds.add(pendingScrollFileId);
    if (selectedLines)
      protectedIds.add(selectedLines.id as WorkspaceDiffFileId);
    const next = new Map(patches);
    for (const [id, load] of next) {
      if (bytes <= MAX_PATCH_CACHE_BYTES) break;
      if (load.status === "loaded" && !protectedIds.has(id)) {
        next.delete(id);
        bytes -= load.bytes;
      }
    }
    if (next.size !== patches.size) replacePatches(next);
  }, [
    patches,
    changedFiles,
    pendingScrollFileId,
    selectedLines,
    replacePatches,
  ]);

  const splitFeasible =
    !narrow &&
    surfaceWidth - Math.min(navigatorWidth, surfaceWidth * 0.45) >= 600;
  const effectivePreferences = effectiveWorkspaceComparePreferences(
    preferences,
    !splitFeasible,
  );

  const annotationsByFile = useMemo(
    () => groupAnnotations(annotations, changedFiles),
    [annotations, changedFiles],
  );
  const items = useMemo<
    readonly CodeViewItem<WorkspaceCompareReviewAnnotation>[]
  >(
    () =>
      changedFiles.flatMap<CodeViewItem<WorkspaceCompareReviewAnnotation>>(
        (file) => {
          const load = patches.get(file.fileId);
          if (load?.status !== "loaded")
            return [
              {
                id: file.fileId,
                type: "file" as const,
                collapsed: true,
                file: {
                  name: workspaceCompareFilePath(file),
                  contents: "",
                  lang: "text" as const,
                  cacheKey: `status:${comparison?.fingerprint}:${file.fileId}`,
                },
                version: load?.status === "loading" ? 1 : load ? 2 : 0,
              },
            ];
          const fileAnnotations = (
            annotationsByFile.get(file.fileId) ?? []
          ).map(
            (
              annotation,
            ): DiffLineAnnotation<WorkspaceCompareReviewAnnotation> => ({
              side: annotation.side,
              lineNumber: annotation.lineNumber,
              metadata: annotation,
            }),
          );
          return [
            {
              ...load.item,
              annotations: fileAnnotations,
              version: annotationVersion(fileAnnotations),
            },
          ];
        },
      ),
    [annotationsByFile, changedFiles, patches, comparison?.fingerprint],
  );

  // A viewport can hold more than the initial prefetch window (for example,
  // many pure renames). Demand visible entries after the renderer has measured
  // the new layout, even when there is no scrollbar to trigger onScroll.
  useEffect(() => {
    if (
      !visible ||
      document.visibilityState === "hidden" ||
      pendingScrollFileId ||
      restoreRef.current
    )
      return;
    const generation = requestGenerationRef.current;
    let secondFrame: number | undefined;
    const firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (
          !visibleRef.current ||
          document.visibilityState === "hidden" ||
          generation !== requestGenerationRef.current ||
          !activeComparisonRef.current
        )
          return;
        const viewer = codeViewRef.current?.getInstance?.();
        if (!viewer) return;
        const top = viewer.getScrollTop();
        const bottom = top + viewer.getHeight();
        let room =
          MAX_PATCH_REQUESTS +
          MAX_QUEUED_PATCH_REQUESTS -
          patchSlotsRef.current -
          patchWaitersRef.current.length;
        for (const item of viewer.getRenderedItems()) {
          if (room <= 0) break;
          const itemTop = viewer.getTopForItem(item.id);
          if (
            itemTop === undefined ||
            itemTop < top - 200 ||
            itemTop > bottom + 120
          )
            continue;
          const file = changedFilesRef.current.find(
            (candidate) => candidate.fileId === item.id,
          );
          if (!file || patchesRef.current.has(file.fileId)) continue;
          room--;
          void ensurePatch(file);
        }
      });
    });
    return () => {
      cancelAnimationFrame(firstFrame);
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
    };
  }, [
    items,
    visible,
    pendingScrollFileId,
    surfaceWidth,
    surfaceHeight,
    ensurePatch,
  ]);

  useEffect(() => {
    if (
      !pendingScrollFileId ||
      !items.some((item) => item.id === pendingScrollFileId)
    )
      return;
    const timer = globalThis.setTimeout(() => {
      const load = patchesRef.current.get(pendingScrollFileId);
      const anchor = anchorRef.current;
      if (load?.status === "loading" || !load) return;
      codeViewRef.current?.scrollTo(
        anchor?.line && load.status === "loaded"
          ? {
              type: "line",
              id: pendingScrollFileId,
              lineNumber: anchor.line,
              side: anchor.side,
              offset: anchor.offset,
              align: "start",
              behavior: "instant",
            }
          : {
              type: "item",
              id: pendingScrollFileId,
              align: "start",
              behavior: "instant",
            },
      );
      currentFileRef.current = pendingScrollFileId;
      setCurrentFileId(pendingScrollFileId);
      setPendingScrollFileId(undefined);
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [items, pendingScrollFileId]);

  const loadDiffFiles = useMemo<FileDiffContentsLoader>(
    () => async (fileDiff) => {
      const active = activeComparisonRef.current;
      const file = fileByMetadataRef.current.get(fileDiff);
      const currentPatch = file && patchesRef.current.get(file.fileId);
      if (
        !active ||
        !file ||
        currentPatch?.status !== "loaded" ||
        currentPatch.item.fileDiff !== fileDiff
      )
        throw new Error(
          "This diff no longer belongs to the active comparison.",
        );
      const generation = requestGenerationRef.current;
      const controller = new AbortController();
      fileLoadAbortControllersRef.current.add(controller);
      const loadSide = async (
        side: "old" | "new",
      ): Promise<FileContents | null> => {
        const result = await dataSource.loadFileContent(
          {
            comparisonId: active.comparisonId,
            fingerprint: active.fingerprint,
            fileId: file.fileId,
            side,
          },
          controller.signal,
        );
        if (result.status === "absent") return null;
        if (result.status !== "available")
          throw new Error(fileContentFailure(result));
        return {
          name: result.path,
          contents: result.content,
          lang: boundedPierreLanguage(result.path),
          cacheKey: `${active.fingerprint}:${file.fileId}:${side}:${result.revision}`,
        };
      };
      try {
        const [oldFile, newFile] = await Promise.all([
          loadSide("old"),
          loadSide("new"),
        ]);
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current ||
          activeComparisonRef.current?.comparisonId !== active.comparisonId
        )
          throw new Error("The comparison changed while loading context.");
        if (oldFile && newFile) return { oldFile, newFile };
        if (!oldFile && newFile && fileDiff.type === "rename-pure")
          return { oldFile: null, newFile };
        throw new Error(
          "Full file content is not available for both sides of this diff.",
        );
      } finally {
        fileLoadAbortControllersRef.current.delete(controller);
      }
    },
    [dataSource],
  );

  const navigateToFile = useCallback(
    async (file: WorkspaceDiffChangedFileSummary) => {
      setNavigatorOpen(false);
      if (anchorRef.current) rememberAnchor(anchorRef.current);
      anchorRef.current = returnLocationsRef.current.get(
        JSON.stringify([file.oldPath, file.newPath, file.changeKind]),
      ) ?? {
        oldPath: file.oldPath,
        newPath: file.newPath,
        changeKind: file.changeKind,
      };
      currentFileRef.current = file.fileId;
      setCurrentFileId(file.fileId);
      setPendingScrollFileId(file.fileId);
      if (!patchesRef.current.has(file.fileId))
        await ensurePatch(file, { priority: true });
    },
    [ensurePatch],
  );

  const handleSelection = useCallback(
    (
      range: SelectedLineRange | null,
      item: CodeViewItem<WorkspaceCompareReviewAnnotation> | undefined,
    ) => {
      if (!item) {
        onSelectedLinesChange?.(undefined);
        setPendingSelection(undefined);
        return;
      }
      const active = activeComparisonRef.current;
      const file = changedFilesRef.current.find(
        (candidate) => candidate.fileId === item.id,
      );
      const currentPatch = file && patchesRef.current.get(file.fileId);
      if (
        !active ||
        !file ||
        !range ||
        item.type !== "diff" ||
        currentPatch?.status !== "loaded" ||
        currentPatch.item.fileDiff !== item.fileDiff
      ) {
        onSelectedLinesChange?.(undefined);
        setPendingSelection(undefined);
        return;
      }
      const captured = captureUnifiedDiffLineSelection(item.fileDiff, range);
      if (!captured.ok) {
        onSelectedLinesChange?.(undefined);
        if (onAttachSelection)
          setPendingSelection({ ok: false, reason: captured.reason });
        return;
      }
      const target = {
        comparison: active,
        file,
        range,
        captured: captured.value,
      };
      onSelectedLinesChange?.(target);
      if (onAttachSelection) setPendingSelection({ ok: true, target });
    },
    [onAttachSelection, onSelectedLinesChange],
  );

  const commentCounts = useMemo(
    () =>
      new Map(
        [...annotationsByFile].map(([id, entries]) => [id, entries.length]),
      ),
    [annotationsByFile],
  );
  const emitNavigation = useCallback(() => {
    const repo = repositories.find(
      (item) => item.repositoryId === repositoryId,
    );
    const baseIntent = compareEndpointIntent(base, revisions);
    const headIntent = compareEndpointIntent(head, revisions);
    if (!repo || !baseIntent || !headIntent || restoreRef.current) return;
    navigationCallbackRef.current?.({
      repository: {
        repositoryKey: repo.repositoryKey,
        displayName: repo.displayName,
        pathPrefix: repo.pathPrefix,
      },
      base: baseIntent,
      head: headIntent,
      mode,
      fingerprint: comparison?.fingerprint,
      file: anchorRef.current,
      returnLocations: [...returnLocationsRef.current.values()],
      filter,
      navigatorWidth,
      collapsedDirectories,
      preferences,
    });
  }, [
    repositories,
    repositoryId,
    base,
    head,
    revisions,
    mode,
    comparison?.fingerprint,
    filter,
    navigatorWidth,
    collapsedDirectories,
    preferences,
  ]);
  const emitNavigationRef = useRef(emitNavigation);
  emitNavigationRef.current = emitNavigation;
  useEffect(() => {
    emitNavigation();
  }, [emitNavigation, currentFileId]);
  useEffect(() => {
    const flush = () => emitNavigationRef.current();
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      window.removeEventListener("pagehide", flush);
    };
  }, []);
  const onDiffScroll = useCallback(
    (
      top: number,
      viewer: NonNullable<
        ReturnType<
          CodeViewHandle<WorkspaceCompareReviewAnnotation>["getInstance"]
        >
      >,
    ) => {
      const rendered = viewer.getRenderedItems();
      const current =
        [...rendered]
          .reverse()
          .find(
            (item) => (viewer.getTopForItem(item.id) ?? Infinity) <= top + 2,
          ) ?? rendered[0];
      if (!current || pendingScrollFileId) return;
      const file = changedFilesRef.current.find(
        (candidate) => candidate.fileId === current.id,
      );
      if (!file) return;
      const itemTop = viewer.getTopForItem(current.id) ?? top;
      const stickyOffset = DEFAULT_CODE_VIEW_FILE_METRICS.diffHeaderHeight;
      const anchor =
        itemTop < top
          ? current.instance.getNumericScrollAnchor(
              top - itemTop + stickyOffset,
            )
          : undefined;
      anchorRef.current = {
        oldPath: file.oldPath,
        newPath: file.newPath,
        changeKind: file.changeKind,
        ...(anchor
          ? {
              line: anchor.lineNumber,
              side: anchor.side,
              offset: anchor.top - (top - itemTop) - stickyOffset,
            }
          : { offset: 0 }),
      };
      rememberAnchor(anchorRef.current);
      currentFileRef.current = file.fileId;
      setCurrentFileId(file.fileId);
      emitNavigationRef.current();
      prefetchRef.current(changedFilesRef.current.indexOf(file));
    },
    [pendingScrollFileId],
  );
  const currentIndex = changedFiles.findIndex(
    (file) => file.fileId === currentFileId,
  );
  const navigator = (
    <WorkspaceChangedFileNavigator
      files={changedFiles}
      currentFileId={currentFileId}
      reviewedFileIds={reviewedFileIds}
      commentCounts={commentCounts}
      filter={filter}
      onFilterChange={setFilter}
      collapsedDirectories={collapsedDirectories}
      onCollapsedDirectoriesChange={setCollapsedDirectories}
      onNavigate={(file) => void navigateToFile(file)}
      onClose={narrow ? () => setNavigatorOpen(false) : undefined}
      loading={busy === "comparison"}
      truncated={filesTruncated}
    />
  );
  const settingsSummary = `${workspaceCompareSelectionLabel(base, revisions)} → ${workspaceCompareSelectionLabel(head, revisions)}`;
  const mergeBaseAllowed = workspaceCompareSupportsMergeBase(base, head);
  useEffect(() => {
    if (!narrow || !comparison) return;
    if (
      settingsBodyRef.current?.contains(
        settingsBodyRef.current.ownerDocument.activeElement,
      )
    ) {
      settingsToggleRef.current?.focus();
    }
    setSettingsExpanded(false);
  }, [comparison, narrow]);
  const changeHistoryScope = async (scope: string) => {
    if (!repositoryId) return;
    historyAbortRef.current?.abort();
    const controller = new AbortController();
    historyAbortRef.current = controller;
    setHistoryScope(scope);
    setRevisionsLoading(true);
    const generation = requestGenerationRef.current;
    try {
      const result = await dataSource.listRevisions(
        liveRepositoryRef.current?.repositoryId ?? repositoryId,
        controller.signal,
        {
          history: scope as NonNullable<
            WorkspaceDiffRefCatalogQuery["history"]
          >,
        },
      );
      if (
        generation !== requestGenerationRef.current ||
        historyAbortRef.current !== controller
      )
        return;
      if (result.status === "available") {
        setRevisions((current) => [
          ...result.revisions,
          ...current.filter(
            (entry) =>
              ((base?.kind === "revision" &&
                entry.revisionId === base.revisionId) ||
                (head.kind === "revision" &&
                  entry.revisionId === head.revisionId)) &&
              !result.revisions.some(
                (next) => next.revisionId === entry.revisionId,
              ),
          ),
        ]);
        setRevisionsTruncated(result.truncated);
      } else setRestoreNotice("Commit history could not be loaded.");
    } catch (error) {
      if (
        !controller.signal.aborted &&
        generation === requestGenerationRef.current &&
        historyAbortRef.current === controller
      )
        setRestoreNotice(
          errorMessage("Commit history could not be loaded", error),
        );
    } finally {
      if (historyAbortRef.current === controller) setRevisionsLoading(false);
    }
  };
  const restoredComparisonStartedRef = useRef(false);
  useEffect(() => {
    if (
      !restoreRef.current ||
      restoredComparisonStartedRef.current ||
      busy !== "idle" ||
      !base ||
      !compareEndpointSelection(restoreRef.current.head, revisions)
    )
      return;
    restoredComparisonStartedRef.current = true;
    void loadComparison();
  }, [busy, base, revisions, loadComparison]);
  const changeBase = (selection: WorkspaceDiffRevisionSelection) => {
    restoreRef.current = undefined;
    preserveEndpointModeRef.current = false;
    setBase(selection);
  };
  const changeHead = (selection: WorkspaceDiffRevisionSelection) => {
    restoreRef.current = undefined;
    preserveEndpointModeRef.current = false;
    setHead(selection);
  };
  useEffect(() => {
    if (!narrow || !navigatorOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const drawer = drawerRef.current;
    drawer?.querySelector<HTMLInputElement>("input")?.focus();
    return () => previous?.focus();
  }, [narrow, navigatorOpen]);
  const initialLoading =
    (busy === "repositories" || busy === "revisions") &&
    repositories.length === 0;

  return (
    <section
      className="workspace-compare"
      ref={surfaceRef}
      aria-label="Compare workspace files"
    >
      <div className="workspace-compare-settings">
        <button
          ref={settingsToggleRef}
          type="button"
          className="workspace-compare-settings-toggle"
          aria-expanded={settingsExpanded}
          aria-controls={settingsId}
          onClick={() => setSettingsExpanded((current) => !current)}
        >
          <span className="workspace-compare-settings-heading">
            <strong>Comparison and review</strong>
            <span>{settingsSummary}</span>
          </span>
          <ChevronDown aria-hidden="true" />
        </button>
        <div
          ref={settingsBodyRef}
          id={settingsId}
          className="workspace-compare-settings-body"
          hidden={!settingsExpanded}
        >
          {(repositories.length > 1 ||
            (!repositoryId && repositories.length > 0)) && (
            <label className="workspace-compare-repository">
              Repository
              <select
                aria-label="Repository"
                value={repositoryId ?? ""}
                onChange={(event) => {
                  restoreRef.current = undefined;
                  anchorRef.current = undefined;
                  returnLocationsRef.current.clear();
                  setRepositoryId(
                    event.target.value as WorkspaceDiffRepositoryId,
                  );
                }}
              >
                {!repositoryId && <option value="">Choose a repository</option>}
                {repositories.map((repository) => (
                  <option
                    key={repository.repositoryId}
                    value={repository.repositoryId}
                  >
                    {repository.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="workspace-compare-presets">
            {(["uncommitted", "staged", "branches"] as const).map((preset) => (
              <button
                type="button"
                key={preset}
                onClick={() => {
                  const next = workspaceComparePresetSelections(
                    preset,
                    revisions,
                    repositories.find(
                      (repo) => repo.repositoryId === repositoryId,
                    )?.head?.commitHash,
                  );
                  setBase(next.base);
                  setHead(next.head);
                  setMode(next.mode);
                }}
              >
                {preset === "uncommitted"
                  ? "Uncommitted"
                  : preset === "staged"
                    ? "Staged"
                    : "Branches"}
              </button>
            ))}
            <button
              type="button"
              disabled={!base}
              onClick={() => {
                if (base) {
                  setHead(base);
                  setBase(head);
                }
              }}
            >
              Swap sides
            </button>
          </div>
          <div className="workspace-compare-controls">
            <WorkspaceRevisionPicker
              label="Base"
              selection={base}
              revisions={revisions}
              historyScope={historyScope}
              onHistoryScopeChange={(scope) => void changeHistoryScope(scope)}
              loading={revisionsLoading}
              truncated={revisionsTruncated}
              onChange={changeBase}
            />
            <span className="workspace-compare-arrow" aria-hidden="true">
              →
            </span>
            <WorkspaceRevisionPicker
              label="Compare"
              selection={head}
              revisions={revisions}
              historyScope={historyScope}
              onHistoryScopeChange={(scope) => void changeHistoryScope(scope)}
              loading={revisionsLoading}
              truncated={revisionsTruncated}
              onChange={changeHead}
            />
            <label className="workspace-compare-strategy">
              <span>Strategy</span>
              <select
                aria-label="Comparison strategy"
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="direct">Differences between sources</option>
                <option value="merge_base" disabled={!mergeBaseAllowed}>
                  Changes introduced by compare branch
                </option>
              </select>
            </label>
            <button
              className="workspace-compare-primary"
              type="button"
              onClick={() => void loadComparison()}
              disabled={!base || !repositoryId || busy !== "idle"}
            >
              {busy === "comparison" ? (
                <LoaderCircle
                  className="workspace-compare-spin"
                  aria-hidden="true"
                />
              ) : (
                <RotateCw aria-hidden="true" />
              )}
              Compare
            </button>
          </div>
        </div>
      </div>

      <div className="workspace-compare-toolbar">
        <div className="workspace-compare-summary">
          <strong>
            {comparison
              ? `${changedFiles.length} changed ${changedFiles.length === 1 ? "file" : "files"}`
              : "Changed files"}
          </strong>
          {filesTruncated && (
            <span className="workspace-compare-warning">Result truncated</span>
          )}
        </div>
        <div
          className="workspace-compare-view-options"
          aria-label="Diff view options"
        >
          <button
            type="button"
            className={
              effectivePreferences.diffStyle === "unified" ? "is-active" : ""
            }
            aria-pressed={effectivePreferences.diffStyle === "unified"}
            onClick={() =>
              setPreferences((current) => ({
                ...current,
                diffStyle: "unified",
              }))
            }
          >
            Unified
          </button>
          <button
            type="button"
            className={
              effectivePreferences.diffStyle === "split" ? "is-active" : ""
            }
            aria-pressed={effectivePreferences.diffStyle === "split"}
            onClick={() =>
              setPreferences((current) => ({ ...current, diffStyle: "split" }))
            }
            disabled={!splitFeasible}
            title={
              !splitFeasible
                ? "Split view is unavailable at this width"
                : undefined
            }
          >
            Split
          </button>
          <button
            type="button"
            className={
              effectivePreferences.overflow === "wrap" ? "is-active" : ""
            }
            aria-pressed={effectivePreferences.overflow === "wrap"}
            onClick={() =>
              setPreferences((current) => ({
                ...current,
                overflow: current.overflow === "wrap" ? "scroll" : "wrap",
              }))
            }
          >
            Wrap
          </button>
          {comparison && (
            <button
              type="button"
              aria-label="Refresh comparison"
              title="Refresh comparison"
              disabled={busy !== "idle" || !base}
              onClick={() => void loadComparison()}
            >
              <RotateCw />
            </button>
          )}
          {narrow && (
            <button
              type="button"
              aria-label="Changed files"
              aria-expanded={navigatorOpen}
              onClick={() => setNavigatorOpen((open) => !open)}
            >
              <PanelLeft />
              Files
            </button>
          )}
          <button
            type="button"
            aria-label="Previous changed file"
            disabled={currentIndex <= 0}
            onClick={() => void navigateToFile(changedFiles[currentIndex - 1]!)}
          >
            <ArrowUp />
          </button>
          <button
            type="button"
            aria-label="Next changed file"
            disabled={
              !changedFiles.length || currentIndex >= changedFiles.length - 1
            }
            onClick={() => void navigateToFile(changedFiles[currentIndex + 1]!)}
          >
            <ArrowDown />
          </button>
        </div>
      </div>

      {restoreNotice && (
        <div className="workspace-compare-restore-notice" role="status">
          {restoreNotice}
          <button
            type="button"
            onClick={() => setRestoreNotice(undefined)}
            aria-label="Dismiss navigation notice"
          >
            <X />
          </button>
        </div>
      )}
      {reviewControls}
      <div className="workspace-compare-workspace">
        {!narrow && (
          <div
            className="workspace-compare-sidebar-slot"
            style={{ width: navigatorWidth }}
          >
            {navigator}
            <div
              role="separator"
              tabIndex={0}
              aria-label="Resize changed file navigator"
              aria-orientation="vertical"
              aria-valuemin={180}
              aria-valuemax={480}
              aria-valuenow={navigatorWidth}
              className="workspace-compare-sidebar-resize"
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  setNavigatorWidth((width) =>
                    Math.max(
                      180,
                      Math.min(
                        480,
                        width + (event.key === "ArrowRight" ? 16 : -16),
                      ),
                    ),
                  );
                }
              }}
              onPointerDown={(event) => {
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                  const left =
                    surfaceRef.current?.getBoundingClientRect().left ?? 0;
                  setNavigatorWidth(
                    Math.max(180, Math.min(480, event.clientX - left)),
                  );
                }
              }}
            />
          </div>
        )}
        {narrow && navigatorOpen && (
          <div
            ref={drawerRef}
            className="workspace-compare-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Changed files"
            onKeyDown={(event) => {
              if (event.key === "Escape") setNavigatorOpen(false);
              if (event.key === "Tab") {
                const targets = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>(
                    'input,button,[tabindex="0"]',
                  ),
                ];
                const index = targets.indexOf(
                  document.activeElement as HTMLElement,
                );
                if (event.shiftKey && index <= 0) {
                  event.preventDefault();
                  targets.at(-1)?.focus();
                } else if (!event.shiftKey && index === targets.length - 1) {
                  event.preventDefault();
                  targets[0]?.focus();
                }
              }
            }}
          >
            <button
              className="workspace-compare-drawer-backdrop"
              aria-label="Close changed file drawer"
              onClick={() => setNavigatorOpen(false)}
            />
            {navigator}
          </div>
        )}
        <div className="workspace-compare-body">
          {initialLoading && (
            <CompareState
              icon={<LoaderCircle className="workspace-compare-spin" />}
              title="Finding repositories…"
            />
          )}
          {!initialLoading && notice && (
            <CompareState
              title={notice}
              action={
                comparison ? (
                  <button type="button" onClick={() => void loadComparison()}>
                    Refresh comparison
                  </button>
                ) : undefined
              }
            />
          )}
          {!initialLoading && !notice && !comparison && (
            <CompareState title="Choose two sources, then start a comparison." />
          )}
          {comparison && changedFiles.length > 0 && (
            <CodeView<WorkspaceCompareReviewAnnotation>
              ref={codeViewRef}
              containerRef={scrollContainerRef}
              onScroll={onDiffScroll}
              renderCustomHeader={(item) => {
                const file = changedFiles.find(
                  (candidate) => candidate.fileId === item.id,
                );
                if (!file) return null;
                const load = patches.get(file.fileId);
                const label =
                  load?.status === "binary"
                    ? "Binary file — no text diff"
                    : load?.status === "too_large"
                      ? "Diff exceeds the size limit"
                      : load?.status === "invalid"
                        ? "Patch could not be displayed"
                        : load?.status === "unavailable"
                          ? "Diff unavailable"
                          : load?.status === "loading"
                            ? "Loading diff…"
                            : "Diff loads as you scroll";
                return (
                  <div
                    className={
                      item.type === "diff"
                        ? "workspace-compare-file-header"
                        : "workspace-compare-status-card"
                    }
                  >
                    <strong
                      title={
                        file.oldPath &&
                        file.newPath &&
                        file.oldPath !== file.newPath
                          ? `${file.oldPath} → ${file.newPath}`
                          : workspaceCompareFilePath(file)
                      }
                    >
                      {workspaceCompareFilePath(file)}
                    </strong>
                    {item.type === "diff" && <FileStats file={file} />}
                    {item.type !== "diff" && (
                      <span
                        className="workspace-compare-status-label"
                        title={label}
                      >
                        <span className="workspace-compare-status-full">
                          {label}
                        </span>
                        <span className="workspace-compare-status-short">
                          {load?.status === "binary"
                            ? "Binary"
                            : load?.status === "too_large"
                              ? "Too large"
                              : load?.status === "unavailable" ||
                                  load?.status === "invalid"
                                ? "Unavailable"
                                : load?.status === "loading"
                                  ? "Loading…"
                                  : "Pending"}
                        </span>
                      </span>
                    )}
                    {file.newPath && onOpenFile && (
                      <button
                        type="button"
                        className="workspace-compare-header-action"
                        aria-label="Open file"
                        title="Open file"
                        onClick={() => onOpenFile(file.newPath!)}
                      >
                        <span className="workspace-compare-header-action-icon">
                          <FileText aria-hidden="true" />
                        </span>
                        <span className="workspace-compare-header-action-label">
                          Open file
                        </span>
                      </button>
                    )}
                    {onReviewedChange && load && load.status !== "loading" && (
                      <button
                        type="button"
                        className={`workspace-compare-header-action workspace-compare-reviewed ${reviewedFileIds.has(file.fileId) ? "is-reviewed" : ""}`}
                        aria-label={
                          reviewedFileIds.has(file.fileId)
                            ? "Reviewed"
                            : "Mark reviewed"
                        }
                        title={
                          reviewedFileIds.has(file.fileId)
                            ? "Reviewed"
                            : "Mark reviewed"
                        }
                        aria-pressed={reviewedFileIds.has(file.fileId)}
                        onClick={() =>
                          onReviewedChange(
                            file.fileId,
                            !reviewedFileIds.has(file.fileId),
                          )
                        }
                      >
                        <span className="workspace-compare-header-action-icon">
                          {reviewedFileIds.has(file.fileId) ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <Circle aria-hidden="true" />
                          )}
                        </span>
                        <span className="workspace-compare-header-action-label">
                          {reviewedFileIds.has(file.fileId)
                            ? "Reviewed"
                            : "Mark reviewed"}
                        </span>
                      </button>
                    )}
                    {(load?.status === "unavailable" ||
                      load?.status === "invalid") && (
                      <button
                        type="button"
                        className="workspace-compare-header-action"
                        aria-label="Retry"
                        title="Retry diff"
                        onClick={() =>
                          void ensurePatch(file, {
                            force: true,
                            priority: true,
                          })
                        }
                      >
                        <span className="workspace-compare-header-action-icon">
                          <RotateCw aria-hidden="true" />
                        </span>
                        <span className="workspace-compare-header-action-label">
                          Retry
                        </span>
                      </button>
                    )}
                  </div>
                );
              }}
              className="workspace-compare-code-view"
              items={items}
              options={{
                themeType,
                diffStyle: effectivePreferences.diffStyle,
                overflow: effectivePreferences.overflow,
                stickyHeaders: true,
                enableLineSelection: true,
                enableGutterUtility: onCreateAnnotation !== undefined,
                lineHoverHighlight: "number",
                loadDiffFiles,
                onLineSelectionEnd(range, context) {
                  handleSelection(range, context.item);
                },
                onGutterUtilityClick(range, context) {
                  if (!context.item || context.item.type !== "diff") return;
                  const active = activeComparisonRef.current;
                  const file = changedFilesRef.current.find(
                    (candidate) => candidate.fileId === context.item.id,
                  );
                  const currentPatch =
                    file && patchesRef.current.get(file.fileId);
                  if (
                    active &&
                    file &&
                    currentPatch?.status === "loaded" &&
                    currentPatch.item.fileDiff === context.item.fileDiff
                  )
                    onCreateAnnotation?.({ comparison: active, file, range });
                },
              }}
              selectedLines={selectedLines}
              onSelectedLinesChange={setSelectedLines}
              renderAnnotation={(annotation) => (
                <div
                  className={`workspace-compare-annotation is-${annotation.metadata.placement ?? "current"}`}
                >
                  <div>
                    <strong>
                      {annotation.metadata.authorLabel ?? "Comment"}
                    </strong>
                    {annotation.metadata.placement === "outdated" && (
                      <span>Outdated</span>
                    )}
                  </div>
                  <p>{annotation.metadata.body}</p>
                  {onDeleteAnnotation && (
                    <button
                      type="button"
                      onClick={() => onDeleteAnnotation(annotation.metadata)}
                    >
                      Delete
                    </button>
                  )}
                  {onSelectAnnotation && (
                    <button
                      type="button"
                      onClick={() => onSelectAnnotation(annotation.metadata)}
                    >
                      Open
                    </button>
                  )}
                </div>
              )}
              style={{ height: "100%", overflow: "auto" }}
            />
          )}
        </div>
      </div>
      {visible && pendingSelection && onAttachSelection && (
        <PierreSelectionAction
          stagingTarget={stagingTarget}
          copyText={
            pendingSelection.ok
              ? pendingSelection.target.captured.excerpt
              : undefined
          }
          key={workspaceCompareSelectionActionKey(pendingSelection)}
          label={workspaceCompareSelectionActionLabel(pendingSelection)}
          initialError={
            pendingSelection.ok
              ? undefined
              : workspaceCompareSelectionFailureMessage(pendingSelection.reason)
          }
          onCancel={() => {
            setPendingSelection(undefined);
            setSelectedLines(null);
            onSelectedLinesChange?.(undefined);
          }}
          onCopySuccess={() => {
            setPendingSelection(undefined);
            setSelectedLines(null);
            onSelectedLinesChange?.(undefined);
          }}
          onStage={(note, sendImmediately) => {
            if (!pendingSelection.ok) return;
            const target = {
              ...pendingSelection.target,
              ...(note ? { note } : {}),
            };
            const result = sendImmediately
              ? onAttachSelection(target, true)
              : onAttachSelection(target);
            if (!result || result.ok) {
              setPendingSelection(undefined);
              setSelectedLines(null);
              onSelectedLinesChange?.(undefined);
            }
            return result;
          }}
          owner={surfaceRef.current}
        />
      )}
    </section>
  );
}

function workspaceCompareSelectionActionKey(
  selection: PendingWorkspaceCompareSelection,
): string {
  return selection.ok
    ? `${selection.target.comparison.fingerprint}:${selection.target.file.fileId}:${selection.target.captured.start.side}:${selection.target.captured.start.line}:${selection.target.captured.end.side}:${selection.target.captured.end.line}`
    : `invalid:${selection.reason}`;
}

function workspaceCompareSelectionActionLabel(
  selection: PendingWorkspaceCompareSelection,
): string {
  if (!selection.ok) return "selected diff lines";
  const { start, end } = selection.target.captured;
  return start.side === end.side && start.line === end.line
    ? `diff line ${start.line}`
    : `diff lines ${start.line}–${end.line}`;
}

function workspaceCompareSelectionFailureMessage(
  reason: PierreSelectionFailureReason,
): string {
  return {
    invalid_range: "Select complete displayed diff lines.",
    empty_excerpt: "The selected diff lines are empty.",
    excerpt_too_large: "The selected diff lines are too large to attach.",
    unresolved_diff_range:
      "Those lines are not available in the displayed diff.",
    cross_hunk_range: "Select diff lines within one displayed hunk.",
  }[reason];
}

function FileStats({
  file,
}: {
  readonly file: WorkspaceDiffChangedFileSummary;
}): React.JSX.Element {
  if (file.binary)
    return <span className="workspace-compare-stats">Binary</span>;
  return (
    <span className="workspace-compare-stats">
      {file.additions !== undefined && (
        <span className="is-addition">+{file.additions}</span>
      )}
      {file.deletions !== undefined && (
        <span className="is-deletion">−{file.deletions}</span>
      )}
    </span>
  );
}

function CompareState({
  icon,
  title,
  action,
}: {
  readonly icon?: React.ReactNode;
  readonly title: string;
  readonly action?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="workspace-compare-state" role="status">
      {icon}
      <p>{title}</p>
      {action}
    </div>
  );
}

function parseFilePatch(
  patch: string,
  file: WorkspaceDiffChangedFileSummary,
  fingerprint: string,
): FileDiffMetadata | undefined {
  try {
    const parsed = parsePatchFiles(patch, `${fingerprint}:${file.fileId}`);
    const candidates = parsed.flatMap((entry) => entry.files);
    const expectedPaths = new Set(
      [file.oldPath, file.newPath].filter(
        (path): path is string => path !== undefined,
      ),
    );
    return (
      candidates.find(
        (candidate) =>
          expectedPaths.has(candidate.name) ||
          (candidate.prevName !== undefined &&
            expectedPaths.has(candidate.prevName)),
      ) ?? candidates[0]
    );
  } catch {
    return undefined;
  }
}

function groupAnnotations(
  annotations: readonly WorkspaceCompareReviewAnnotation[],
  files: readonly WorkspaceDiffChangedFileSummary[],
): ReadonlyMap<
  WorkspaceDiffFileId,
  readonly WorkspaceCompareReviewAnnotation[]
> {
  const grouped = new Map<
    WorkspaceDiffFileId,
    WorkspaceCompareReviewAnnotation[]
  >();
  for (const annotation of annotations) {
    const fileId =
      annotation.fileId ??
      files.find(
        (file) =>
          file.oldPath === annotation.oldPath &&
          file.newPath === annotation.newPath,
      )?.fileId;
    if (!fileId) continue;
    const current = grouped.get(fileId) ?? [];
    current.push(annotation);
    grouped.set(fileId, current);
  }
  return grouped;
}

function annotationVersion(
  annotations: readonly DiffLineAnnotation<WorkspaceCompareReviewAnnotation>[],
): number {
  let hash = 17;
  for (const annotation of annotations) {
    for (const character of annotation.metadata.annotationId)
      hash = (hash * 31 + character.charCodeAt(0)) | 0;
    hash = (hash * 31 + annotation.lineNumber) | 0;
  }
  return hash;
}

function diagnosticMessage(prefix: string, code: string): string {
  return `${prefix} (${code}).`;
}

function errorMessage(prefix: string, error: unknown): string {
  return `${prefix}: ${error instanceof Error ? error.message : "unexpected error"}.`;
}

function fileContentFailure(
  result: Exclude<
    WorkspaceDiffFileContentResult,
    { status: "available" | "absent" }
  >,
): string {
  if (result.status === "too_large")
    return `Full file is larger than the ${result.maximumBytes}-byte review limit.`;
  if (result.status === "binary")
    return "Binary file content cannot be expanded.";
  if (result.status === "stale") return "The comparison became stale.";
  return `Full file content is unavailable (${result.diagnosticCode}).`;
}

const EMPTY_REVIEWED_FILES: ReadonlySet<WorkspaceDiffFileId> = new Set();
