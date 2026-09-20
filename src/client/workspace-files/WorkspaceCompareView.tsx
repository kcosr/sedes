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
import { parsePatchFiles } from "@pierre/diffs";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import {
  Check,
  ChevronDown,
  Files,
  LoaderCircle,
  RotateCw,
  Search,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.js";
import { boundedPierreLanguage } from "./pierre-language.js";
import {
  DEFAULT_WORKSPACE_COMPARE_PREFERENCES,
  defaultWorkspaceCompareSelections,
  effectiveWorkspaceComparePreferences,
  filterWorkspaceCompareFiles,
  workspaceCompareChangeLabel,
  workspaceCompareFilePath,
  workspaceCompareSelectionFromKey,
  workspaceCompareSelectionKey,
  workspaceCompareSupportsMergeBase,
  type WorkspaceComparePreferences,
} from "./workspace-compare-state.js";
import "./workspace-compare.css";

const INITIAL_DIFF_BATCH_SIZE = 8;
const NEXT_DIFF_BATCH_SIZE = 12;

export interface WorkspaceCompareDataSource {
  readonly listRepositories: (
    rootId: WorkspaceFileRootId,
    signal?: AbortSignal,
  ) => Promise<WorkspaceDiffRepositoriesResult>;
  readonly listRevisions: (
    repositoryId: WorkspaceDiffRepositoryId,
    signal?: AbortSignal,
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

export interface WorkspaceCompareCapturedLineTarget extends WorkspaceCompareLineTarget {
  readonly captured: CapturedDiffLineSelection;
}

export interface WorkspaceCompareViewProps {
  readonly rootId: WorkspaceFileRootId;
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
    }
  | {
      readonly status: "binary" | "too_large" | "unavailable" | "invalid";
      readonly detail?: string;
    };

export function WorkspaceCompareView({
  rootId,
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
  const comparisonAbortRef = useRef<AbortController | undefined>(undefined);
  const fileLoadAbortControllersRef = useRef(new Set<AbortController>());
  const onComparisonChangeRef = useRef(onComparisonChange);
  onComparisonChangeRef.current = onComparisonChange;

  const abortComparisonWork = useCallback(() => {
    comparisonAbortRef.current?.abort();
    comparisonAbortRef.current = undefined;
    for (const controller of fileLoadAbortControllersRef.current)
      controller.abort();
    fileLoadAbortControllersRef.current.clear();
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
  const [settingsExpanded, setSettingsExpanded] = useState(true);
  const [repositories, setRepositories] = useState<
    readonly WorkspaceDiffRepositoryDescriptor[]
  >([]);
  const [repositoryId, setRepositoryId] = useState<WorkspaceDiffRepositoryId>();
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
    DEFAULT_WORKSPACE_COMPARE_PREFERENCES,
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
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<
    "repositories" | "revisions" | "comparison" | "idle"
  >("repositories");
  const [notice, setNotice] = useState<string>();
  const [pendingScrollFileId, setPendingScrollFileId] =
    useState<WorkspaceDiffFileId>();
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
    const update = () => setNarrow(element.clientWidth < 720);
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
        setRepositoryId(result.repositories[0]?.repositoryId);
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
      .then((result) => {
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
        setRevisions(result.revisions);
        const defaults = defaultWorkspaceCompareSelections(result.revisions);
        setBase(defaults.base);
        setHead(defaults.head);
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
    abortComparisonWork();
    const generation = ++requestGenerationRef.current;
    const controller = new AbortController();
    comparisonAbortRef.current = controller;
    setBusy("comparison");
    setNotice(undefined);
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
      const result = await dataSource.createComparison(
        {
          repositoryId,
          mode: workspaceCompareSupportsMergeBase(base, head) ? mode : "direct",
          base,
          head,
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
        accumulated.push(...page.files);
        setChangedFiles([...accumulated]);
        changedFilesRef.current = [...accumulated];
        truncated ||= page.truncated;
        after = page.nextCursor;
      } while (after);
      setFilesTruncated(truncated);
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
  ]);

  const ensurePatch = useCallback(
    async (
      file: WorkspaceDiffChangedFileSummary,
      options: { readonly force?: boolean } = {},
    ): Promise<boolean> => {
      const active = activeComparisonRef.current;
      if (!active) return false;
      const existing = patchesRef.current.get(file.fileId);
      if (existing?.status === "loaded") return true;
      if (existing?.status === "loading") return false;
      if (existing && !options.force) return false;
      updatePatches((current) =>
        new Map(current).set(file.fileId, { status: "loading" }),
      );
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
        if (activeComparisonRef.current?.comparisonId !== active.comparisonId)
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
          new Map(current).set(file.fileId, { status: "loaded", item }),
        );
        return true;
      } catch (error: unknown) {
        if (controller.signal.aborted) return false;
        updatePatches((current) =>
          new Map(current).set(file.fileId, {
            status: "unavailable",
            detail: error instanceof Error ? error.message : undefined,
          }),
        );
        return false;
      } finally {
        fileLoadAbortControllersRef.current.delete(controller);
      }
    },
    [dataSource, updatePatches],
  );

  useEffect(() => {
    for (const file of changedFiles.slice(0, INITIAL_DIFF_BATCH_SIZE))
      void ensurePatch(file);
  }, [changedFiles, ensurePatch]);

  const effectivePreferences = effectiveWorkspaceComparePreferences(
    preferences,
    narrow,
  );
  const unattemptedFiles = useMemo(
    () => changedFiles.filter((file) => !patches.has(file.fileId)),
    [changedFiles, patches],
  );
  const annotationsByFile = useMemo(
    () => groupAnnotations(annotations, changedFiles),
    [annotations, changedFiles],
  );
  const items = useMemo<
    readonly CodeViewItem<WorkspaceCompareReviewAnnotation>[]
  >(
    () =>
      changedFiles.flatMap((file) => {
        const load = patches.get(file.fileId);
        if (load?.status !== "loaded") return [];
        const fileAnnotations = (annotationsByFile.get(file.fileId) ?? []).map(
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
      }),
    [annotationsByFile, changedFiles, patches],
  );

  useEffect(() => {
    if (
      !pendingScrollFileId ||
      !items.some((item) => item.id === pendingScrollFileId)
    )
      return;
    const timer = globalThis.setTimeout(() => {
      codeViewRef.current?.scrollTo({
        type: "line",
        id: pendingScrollFileId,
        lineNumber: 1,
        align: "start",
        behavior: "smooth-auto",
      });
      setPendingScrollFileId(undefined);
    }, 0);
    return () => globalThis.clearTimeout(timer);
  }, [items, pendingScrollFileId]);

  const loadDiffFiles = useMemo<FileDiffContentsLoader>(
    () => async (fileDiff) => {
      const active = activeComparisonRef.current;
      const file = fileByMetadataRef.current.get(fileDiff);
      if (!active || !file)
        throw new Error(
          "This diff no longer belongs to the active comparison.",
        );
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
      setPendingScrollFileId(file.fileId);
      if (!patchesRef.current.has(file.fileId)) await ensurePatch(file);
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
      if (!active || !file || !range || item.type !== "diff") {
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

  const loadedCount = items.length;
  const filteredFiles = filterWorkspaceCompareFiles(changedFiles, filter);
  const settingsSummary = `${workspaceCompareSelectionLabel(base, revisions)} → ${workspaceCompareSelectionLabel(head, revisions)}`;
  const mergeBaseAllowed = workspaceCompareSupportsMergeBase(base, head);
  useEffect(() => {
    setMode((current) => {
      if (!mergeBaseAllowed)
        return current === "merge_base" ? "direct" : current;
      return current === "direct" ? "merge_base" : current;
    });
  }, [mergeBaseAllowed]);
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
  const changeBase = (selection: WorkspaceDiffRevisionSelection) => {
    setBase(selection);
  };
  const changeHead = (selection: WorkspaceDiffRevisionSelection) => {
    setHead(selection);
  };
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
          {reviewControls}
          <div className="workspace-compare-controls">
            <RevisionSelect
              label="Base"
              selection={base}
              revisions={revisions}
              onChange={changeBase}
            />
            <span className="workspace-compare-arrow" aria-hidden="true">
              →
            </span>
            <RevisionSelect
              label="Compare"
              selection={head}
              revisions={revisions}
              onChange={changeHead}
            />
            <label className="workspace-compare-strategy">
              <span>Strategy</span>
              <select
                aria-label="Comparison strategy"
                value={mode}
                onChange={(event) => setMode(event.target.value as typeof mode)}
              >
                <option value="direct">Direct</option>
                <option value="merge_base" disabled={!mergeBaseAllowed}>
                  Merge base
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
            disabled={narrow}
            title={
              narrow ? "Split view is unavailable at this width" : undefined
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
          <div className="workspace-compare-files-anchor">
            <Popover open={navigatorOpen} onOpenChange={setNavigatorOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="workspace-compare-files-button"
                  aria-expanded={navigatorOpen}
                >
                  <Files aria-hidden="true" /> Files{" "}
                  <ChevronDown aria-hidden="true" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="workspace-compare-navigator"
                role="dialog"
                aria-label="Changed files"
                align="end"
                side="bottom"
                sideOffset={8}
              >
                <div className="workspace-compare-navigator-search">
                  <Search aria-hidden="true" />
                  <input
                    autoFocus
                    aria-label="Filter changed files"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder="Filter changed files"
                  />
                  <button
                    type="button"
                    aria-label="Close changed files"
                    onClick={() => setNavigatorOpen(false)}
                  >
                    <X aria-hidden="true" />
                  </button>
                </div>
                <div className="workspace-compare-file-list">
                  {filteredFiles.map((file) => {
                    const load = patches.get(file.fileId);
                    return (
                      <button
                        type="button"
                        key={file.fileId}
                        onClick={() => void navigateToFile(file)}
                      >
                        <ChangeBadge file={file} />
                        <span className="workspace-compare-file-path">
                          {workspaceCompareFilePath(file)}
                        </span>
                        <FileStats file={file} />
                        {load?.status === "loading" && (
                          <LoaderCircle
                            className="workspace-compare-spin"
                            aria-label="Loading diff"
                          />
                        )}
                        {reviewedFileIds.has(file.fileId) && (
                          <Check
                            className="workspace-compare-reviewed-icon"
                            aria-label="Reviewed"
                          />
                        )}
                      </button>
                    );
                  })}
                  {filteredFiles.length === 0 && (
                    <p>No changed files match this filter.</p>
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </div>

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
                if (active && file)
                  onCreateAnnotation?.({ comparison: active, file, range });
              },
            }}
            selectedLines={selectedLines}
            onSelectedLinesChange={setSelectedLines}
            renderHeaderMetadata={(item) => {
              const file = changedFiles.find(
                (candidate) => candidate.fileId === item.id,
              );
              return file ? <FileStats file={file} /> : null;
            }}
            renderHeaderFilenameSuffix={(item) => {
              const file = changedFiles.find(
                (candidate) => candidate.fileId === item.id,
              );
              if (!file || !onReviewedChange) return null;
              const reviewed = reviewedFileIds.has(file.fileId);
              return (
                <button
                  type="button"
                  className={`workspace-compare-reviewed ${reviewed ? "is-reviewed" : ""}`}
                  onClick={() => onReviewedChange(file.fileId, !reviewed)}
                >
                  {reviewed && <Check aria-hidden="true" />}
                  {reviewed ? "Reviewed" : "Mark reviewed"}
                </button>
              );
            }}
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
        {comparison && unattemptedFiles.length > 0 && (
          <button
            type="button"
            className="workspace-compare-load-more"
            onClick={() => {
              const unloaded = unattemptedFiles.slice(0, NEXT_DIFF_BATCH_SIZE);
              for (const file of unloaded) void ensurePatch(file);
            }}
          >
            Load more diffs ({loadedCount} of {changedFiles.length})
          </button>
        )}
        {comparison &&
          changedFiles.some((file) => {
            const status = patches.get(file.fileId)?.status;
            return status && status !== "loaded" && status !== "loading";
          }) && (
            <PatchNotices
              files={changedFiles}
              patches={patches}
              onRetry={(file) => ensurePatch(file, { force: true })}
            />
          )}
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

function workspaceCompareSelectionLabel(
  selection: WorkspaceDiffRevisionSelection | undefined,
  revisions: readonly WorkspaceDiffRevisionDescriptor[],
): string {
  if (!selection) return "Select a revision";
  if (selection.kind === "index") return "Index";
  if (selection.kind === "working_tree") return "Working tree";
  const revision = revisions.find(
    (candidate) => candidate.revisionId === selection.revisionId,
  );
  return revision ? `${revision.label} · ${revision.shortHash}` : "Revision";
}

function RevisionSelect({
  label,
  selection,
  revisions,
  onChange,
}: {
  readonly label: string;
  readonly selection?: WorkspaceDiffRevisionSelection;
  readonly revisions: readonly WorkspaceDiffRevisionDescriptor[];
  readonly onChange: (selection: WorkspaceDiffRevisionSelection) => void;
}): React.JSX.Element {
  return (
    <label>
      <span>{label}</span>
      <select
        aria-label={`${label} revision`}
        value={selection ? workspaceCompareSelectionKey(selection) : ""}
        onChange={(event) => {
          const next = workspaceCompareSelectionFromKey(
            event.target.value,
            revisions,
          );
          if (next) onChange(next);
        }}
      >
        {!selection && <option value="">Select a revision</option>}
        {revisions.map((revision) => (
          <option
            key={revision.revisionId}
            value={workspaceCompareSelectionKey({
              kind: "revision",
              revisionId: revision.revisionId,
            })}
          >
            {revision.label} · {revision.shortHash}
          </option>
        ))}
        <option value="index">Index (staged)</option>
        <option value="working_tree">Working tree</option>
      </select>
    </label>
  );
}

function ChangeBadge({
  file,
}: {
  readonly file: WorkspaceDiffChangedFileSummary;
}): React.JSX.Element {
  return (
    <span
      className={`workspace-compare-change is-${file.changeKind}`}
      title={workspaceCompareChangeLabel(file.changeKind)}
    >
      {workspaceCompareChangeLabel(file.changeKind).slice(0, 1)}
    </span>
  );
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

function PatchNotices({
  files,
  patches,
  onRetry,
}: {
  readonly files: readonly WorkspaceDiffChangedFileSummary[];
  readonly patches: ReadonlyMap<WorkspaceDiffFileId, PatchLoad>;
  readonly onRetry: (file: WorkspaceDiffChangedFileSummary) => Promise<boolean>;
}): React.JSX.Element {
  const unavailable = files.filter((file) => {
    const status = patches.get(file.fileId)?.status;
    return status && status !== "loaded" && status !== "loading";
  });
  return (
    <div
      className="workspace-compare-patch-notices"
      aria-label="Diffs that could not be displayed"
    >
      {unavailable.map((file) => {
        const load = patches.get(file.fileId)!;
        const message =
          load.status === "binary"
            ? "Binary file"
            : load.status === "too_large"
              ? "Patch is too large"
              : load.status === "invalid"
                ? "Patch could not be parsed"
                : "Patch is unavailable";
        return (
          <div key={file.fileId}>
            <span>{workspaceCompareFilePath(file)}</span>
            <span>{message}</span>
            {load.status === "unavailable" && (
              <button type="button" onClick={() => void onRetry(file)}>
                Retry
              </button>
            )}
          </div>
        );
      })}
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
