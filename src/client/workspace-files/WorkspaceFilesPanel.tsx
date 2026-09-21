import { NavigationScopeContext } from "../authentication/AuthenticationGate.js";
import { workspaceCompareStorage } from "./workspace-compare-storage.js";
import type { WorkspaceCompareNavigation } from "./workspace-compare-navigation.js";
import "./workspace-review-inspector.css";
import type { ContextExcerptStagingTarget } from "../context-excerpts/coordinator.js";
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Check,
  ChevronDown,
  Download,
  FilePenLine,
  FolderPlus,
  FolderTree,
  LoaderCircle,
  RefreshCw,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { prepareFileTreeInput } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import {
  WORKSPACE_FILE_DOWNLOAD_MAX_DURATION_MILLISECONDS,
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
  contextExcerptSchema,
  workspaceFileAbsolutePathSchema,
  type WorkspaceFileContentResult,
  type WorkspaceFileDirectoryPath,
  type WorkspaceFileRootDescriptor,
  type WorkspaceFileRootId,
  type WorkspaceFileSupplementalRootId,
} from "../../shared/index.js";
import { Button } from "../components/ui/button.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover.js";
import { ApiError, type ApiClient } from "../api/ApiClient.js";
import { useApplicationStore } from "../stores/ApplicationClientStore.js";
import {
  downloadWorkspaceFileInPackagedClient,
  supportsPackagedWorkspaceFileDownloads,
} from "../app/packaged-workspace-file-download.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog.js";
import { Input } from "../components/ui/input.js";
import { DirectoryPickerDialog } from "../components/DirectoryPickerDialog.js";
import { Textarea } from "../components/ui/textarea.js";
import type { WorkspacePanelContext } from "../workspace-panels/registry.js";
import { PierreFileViewer } from "./pierre-file-viewer.js";
import type { CapturedFileLineSelection } from "../context-excerpts/pierre-selection.js";
import type { PierreSelectionStageResult } from "../context-excerpts/PierreSelectionAction.js";
import { stageWorkspaceDiffContextExcerpt } from "../context-excerpts/workspace-diff-staging.js";
import { MarkdownSelectionSurface } from "./MarkdownSelectionSurface.js";
import {
  EMPTY_WORKSPACE_FILE_DOCUMENTS,
  sameWorkspaceFileAddress,
  workspaceFileDocumentIsDirty,
  workspaceFileDocumentKey,
  workspaceFileDocumentsReducer,
  type WorkspaceFileAddress,
  type WorkspaceFileDocumentState,
} from "./workspace-file-editor-state.js";
import { TREE_TRUNCATION_CSS } from "./tree-truncation-css.js";
import {
  collectExpandedDirectoryPaths,
  pruneWorkspaceFilesUiSnapshot,
  workspaceFilesUiStateCache,
  WORKSPACE_FILES_UI_STATE_VERSION,
  type WorkspaceFilesUiSnapshot,
  type WorkspaceFilesUiStateCache,
} from "./workspace-files-ui-state.js";
import {
  isWorkspaceFilesOpenIntent,
  type WorkspaceFileSourceLineSeek,
} from "./open-intent.js";
import {
  WorkspaceImagePreview,
  type WorkspaceImageViewState,
} from "./WorkspaceImagePreview.js";
import {
  WorkspaceCompareView,
  type WorkspaceCompareCapturedLineTarget,
  type WorkspaceCompareDataSource,
  type WorkspaceCompareReviewAnnotation,
  type WorkspaceCompareRefreshControl,
} from "./WorkspaceCompareView.js";
import type {
  WorkspaceDiffComparisonDescriptor,
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffFileId,
} from "../../shared/protocol/workspace-diffs.js";
import type {
  WorkspaceDiffReview,
  WorkspaceDiffReviewComment,
  WorkspaceDiffReviewCommentState,
  WorkspaceDiffReviewedFile,
} from "../../shared/protocol/workspace-diff-reviews.js";

const PAGE_SIZE = 5_000;
const MAXIMUM_LOADED_PATHS = 50_000;
const WORKSPACE_DIFF_COMMENT_STATE_LABELS = {
  draft: "Draft",
  published: "Published",
  resolved: "Resolved",
  outdated: "Outdated",
  unplaced: "Unplaced",
} as const satisfies Record<WorkspaceDiffReviewCommentState, string>;

export interface WorkspaceFilesApi {
  browseExecutionEnvironmentDirectories: ApiClient["browseExecutionEnvironmentDirectories"];
  listWorkspaceFileRoots: ApiClient["listWorkspaceFileRoots"];
  attachWorkspaceFileRoot: ApiClient["attachWorkspaceFileRoot"];
  removeWorkspaceFileRoot: ApiClient["removeWorkspaceFileRoot"];
  listWorkspaceFiles: ApiClient["listWorkspaceFiles"];
  listWorkspaceFileDirectory: ApiClient["listWorkspaceFileDirectory"];
  readWorkspaceFile: ApiClient["readWorkspaceFile"];
  prepareWorkspaceFileDownload: ApiClient["prepareWorkspaceFileDownload"];
  saveWorkspaceFile: ApiClient["saveWorkspaceFile"];
  listWorkspaceDiffRepositories: ApiClient["listWorkspaceDiffRepositories"];
  listWorkspaceDiffRefs: ApiClient["listWorkspaceDiffRefs"];
  createWorkspaceDiffComparison: ApiClient["createWorkspaceDiffComparison"];
  listWorkspaceDiffChangedFiles: ApiClient["listWorkspaceDiffChangedFiles"];
  readWorkspaceDiffPatch: ApiClient["readWorkspaceDiffPatch"];
  readWorkspaceDiffFileContent: ApiClient["readWorkspaceDiffFileContent"];
  listWorkspaceDiffReviews: ApiClient["listWorkspaceDiffReviews"];
  listWorkspaceDiffReviewHistory: ApiClient["listWorkspaceDiffReviewHistory"];
  openWorkspaceDiffReview: ApiClient["openWorkspaceDiffReview"];
  updateWorkspaceDiffReview: ApiClient["updateWorkspaceDiffReview"];
  listWorkspaceDiffReviewComments: ApiClient["listWorkspaceDiffReviewComments"];
  createWorkspaceDiffReviewComment: ApiClient["createWorkspaceDiffReviewComment"];
  updateWorkspaceDiffReviewComment: ApiClient["updateWorkspaceDiffReviewComment"];
  deleteWorkspaceDiffReviewComment: ApiClient["deleteWorkspaceDiffReviewComment"];
  listWorkspaceDiffReviewedFiles: ApiClient["listWorkspaceDiffReviewedFiles"];
  setWorkspaceDiffReviewedFile: ApiClient["setWorkspaceDiffReviewedFile"];
}

type WorkspaceFilesMode = "browse" | "compare";

interface FileListState {
  readonly paths: readonly string[];
  readonly loading: boolean;
  readonly scanTruncated: boolean;
  readonly loaded: boolean;
  readonly fullTreeLoaded: boolean;
  readonly loadedDirectories: ReadonlySet<string>;
  readonly loadingDirectories: ReadonlySet<string>;
  readonly error?: string;
}

interface OpenFileState {
  readonly loading: boolean;
  readonly error?: string;
  readonly file?: WorkspaceFileContentResult;
}

interface OpenTabsState {
  readonly files: readonly WorkspaceFileAddress[];
  readonly active?: WorkspaceFileAddress;
}

interface PendingWorkspaceFileSeek extends WorkspaceFileSourceLineSeek {
  readonly address: WorkspaceFileAddress;
}

interface WorkspaceFileDownloadTarget extends WorkspaceFileAddress {
  readonly revision: string;
}

interface WorkspaceFileDownloadState {
  readonly key: string;
  readonly phase: "idle" | "preparing" | "started";
  readonly error?: string;
}

interface TreeController {
  getExpandedPaths(): readonly string[];
}

type CompareCommentDraft =
  | {
      readonly mode: "create";
      readonly target: {
        readonly comparison: WorkspaceDiffComparisonDescriptor;
        readonly file: WorkspaceDiffChangedFileSummary;
        readonly range: {
          readonly start: number;
          readonly end: number;
          readonly side: "old" | "new";
        };
      };
      readonly body: string;
      readonly state: "draft" | "published";
    }
  | {
      readonly mode: "edit";
      readonly reviewId: string;
      readonly commentId: string;
      readonly body: string;
      readonly state: WorkspaceDiffReviewCommentState;
    };

const EMPTY_FILE_LIST: FileListState = {
  paths: [],
  loading: false,
  scanTruncated: false,
  loaded: false,
  fullTreeLoaded: false,
  loadedDirectories: new Set(),
  loadingDirectories: new Set(),
};

export function WorkspaceFilesPanel({
  context,
  api = context.applicationStore.api,
  renderFile = (file) => <PierreFileViewer {...file} />,
  uiStateCache = workspaceFilesUiStateCache,
}: {
  readonly context: WorkspacePanelContext;
  readonly api?: WorkspaceFilesApi;
  readonly renderFile?: (file: {
    path: string;
    content: string;
    revision: string;
    editing: boolean;
    truncated: boolean;
    seek?: WorkspaceFileSourceLineSeek;
    onSeekHandled?: (sequence: number) => void;
    onChange: (content: string) => void;
    stagingTarget?: ContextExcerptStagingTarget;
    onAttachSelection?: (
      selection: CapturedFileLineSelection & { readonly note?: string },
      sendImmediately?: boolean,
    ) => PierreSelectionStageResult;
  }) => React.ReactNode;
  readonly uiStateCache?: WorkspaceFilesUiStateCache;
}): React.JSX.Element {
  const workspaceId = context.workspaceId;
  const navigationScope = useContext(NavigationScopeContext);
  const savedRootScopeKey = JSON.stringify([navigationScope, workspaceId]);
  const savedRootRequestRef = useRef({ key: savedRootScopeKey, rootId: workspaceCompareStorage.latest(navigationScope, workspaceId) });
  if (savedRootRequestRef.current.key !== savedRootScopeKey) {
    savedRootRequestRef.current = { key: savedRootScopeKey, rootId: workspaceCompareStorage.latest(navigationScope, workspaceId) };
  }
  const [dismissedRootRecovery, setDismissedRootRecovery] = useState<string>();
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  const filesVisible = context.visible && documentVisible;
  const filesVisibleRef = useRef(filesVisible);
  filesVisibleRef.current = filesVisible;
  useEffect(() => {
    const update = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  const applicationState = useApplicationStore(context.applicationStore);
  const applicationSnapshot = applicationState.snapshot;
  const currentThread = applicationSnapshot?.threads.find(
    ({ id }) => id === context.threadId,
  );
  const workspace = applicationSnapshot?.workspaces.find(
    ({ id }) => id === workspaceId,
  );
  const environments = applicationSnapshot?.environments ?? [];
  const workspaceEnvironment = environments.find(
    ({ id }) => id === workspace?.environmentId,
  );
  const sheet = context.presentation === "sheet";
  const sheetRef = useRef(sheet);
  sheetRef.current = sheet;
  const requestRefreshRef = useRef<() => void>(() => undefined);
  const pendingUiRestoreRef = useRef<
    ReturnType<WorkspaceFilesUiStateCache["get"]>
  >(workspaceId === undefined ? undefined : uiStateCache.get(workspaceId));
  const fileOpenIntentPresented = isWorkspaceFilesOpenIntent(context.intent);
  const initialFileOpenIntent =
    workspaceId !== undefined &&
    fileOpenIntentPresented &&
    context.intent.workspaceId === workspaceId;
  const linkOnlyRootIdsRef = useRef(
    new Set<WorkspaceFileRootId>([
      ...(pendingUiRestoreRef.current?.linkOnlyRootIds ?? []),
      ...(initialFileOpenIntent &&
      context.intent?.kind === "open-workspace-file" &&
      context.intent.rootVisibility === "link_only"
        ? [context.intent.rootId]
        : []),
    ]),
  );
  const fileOpenIntentRef = useRef(initialFileOpenIntent);
  fileOpenIntentRef.current = initialFileOpenIntent;
  const initialUiRestore = readPendingUiRestorePresentation(
    pendingUiRestoreRef.current,
    fileOpenIntentPresented,
  );

  const [roots, setRoots] = useState<readonly WorkspaceFileRootDescriptor[]>(
    [],
  );
  const [activeRootId, setActiveRootId] = useState<WorkspaceFileRootId>(
    currentThread?.preferredWorktree?.rootId ?? workspaceCompareStorage.latest(navigationScope, workspaceId) ?? "primary",
  );
  const [rootsLoading, setRootsLoading] = useState(true);
  const [rootsError, setRootsError] = useState<string>();
  const [filesByRoot, setFilesByRoot] = useState<
    ReadonlyMap<string, FileListState>
  >(new Map());
  const [tabs, setTabs] = useState<OpenTabsState>({ files: [] });
  const [openFiles, setOpenFiles] = useState<
    ReadonlyMap<string, OpenFileState>
  >(new Map());
  const [pendingSeek, setPendingSeek] = useState<
    PendingWorkspaceFileSeek | undefined
  >(() => sourceLineSeekForIntent(context.intent, workspaceId));
  const [documents, dispatchDocuments] = useReducer(
    workspaceFileDocumentsReducer,
    EMPTY_WORKSPACE_FILE_DOCUMENTS,
  );
  const [pendingClose, setPendingClose] = useState<WorkspaceFileAddress>();
  const [pendingRemove, setPendingRemove] =
    useState<WorkspaceFileRootDescriptor>();
  const [pendingRefreshReload, setPendingRefreshReload] =
    useState<WorkspaceFileAddress>();
  const [refreshingFileKey, setRefreshingFileKey] = useState<string>();
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [pendingDownload, setPendingDownload] =
    useState<WorkspaceFileDownloadTarget>();
  const [downloadState, setDownloadState] =
    useState<WorkspaceFileDownloadState>();
  const [attachDialogOpen, setAttachDialogOpen] = useState(false);
  const [attachPath, setAttachPath] = useState("");
  const [attachLabel, setAttachLabel] = useState("");
  const [attachError, setAttachError] = useState<string>();
  const [attaching, setAttaching] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [treeOpen, setTreeOpen] = useState(initialUiRestore.treeOpen);
  const [reviewInspectorMode, setReviewInspectorMode] = useState<"current" | "history">("current");
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false);
  const [compareRefreshControl, setCompareRefreshControl] = useState<
    (WorkspaceCompareRefreshControl & { scope: string }) | undefined
  >();
  const compareRefreshScope = JSON.stringify([navigationScope, workspaceId, activeRootId]);
  const registerCompareRefresh = useCallback(
    (control: WorkspaceCompareRefreshControl | undefined) => {
      setCompareRefreshControl(control ? { ...control, scope: compareRefreshScope } : undefined);
    },
    [compareRefreshScope],
  );
  const [mode, setMode] = useState<WorkspaceFilesMode>("browse");
  const [compareOpened, setCompareOpened] = useState(false);
  const [activeComparison, setActiveComparison] =
    useState<WorkspaceDiffComparisonDescriptor>();
  const [compareFiles, setCompareFiles] = useState<
    readonly WorkspaceDiffChangedFileSummary[]
  >([]);
  const [compareReviews, setCompareReviews] = useState<
    readonly WorkspaceDiffReview[]
  >([]);
  const [compareHistoryReviews, setCompareHistoryReviews] = useState<
    readonly WorkspaceDiffReview[]
  >([]);
  const [compareRepositoryHistoryCount, setCompareRepositoryHistoryCount] =
    useState(0);
  const [activeCompareReviewId, setActiveCompareReviewId] = useState<string>();
  const [compareComments, setCompareComments] = useState<
    readonly WorkspaceDiffReviewComment[]
  >([]);
  const [compareReviewedFiles, setCompareReviewedFiles] = useState<
    readonly WorkspaceDiffReviewedFile[]
  >([]);
  const [compareCurrentComments, setCompareCurrentComments] = useState<
    readonly WorkspaceDiffReviewComment[]
  >([]);
  const [compareCurrentReviewedFiles, setCompareCurrentReviewedFiles] =
    useState<readonly WorkspaceDiffReviewedFile[]>([]);
  const [compareReviewLoading, setCompareReviewLoading] = useState(false);
  const [compareReviewMutating, setCompareReviewMutating] = useState(false);
  const [compareReviewError, setCompareReviewError] = useState<string>();
  const [compareCommentDraft, setCompareCommentDraft] =
    useState<CompareCommentDraft>();
  const [compareCommentSaving, setCompareCommentSaving] = useState(false);
  const [compareDetailsOpen, setCompareDetailsOpen] = useState(false);
  const [compareReviewTitleDraft, setCompareReviewTitleDraft] = useState("");
  const [compareReviewSummaryDraft, setCompareReviewSummaryDraft] =
    useState("");
  const [compareReviewStateDraft, setCompareReviewStateDraft] = useState<
    "open" | "archived"
  >("open");
  const [awaitingUiRestore, setAwaitingUiRestore] = useState(
    initialUiRestore.awaitingUiRestore,
  );
  const [uiReconciled, setUiReconciled] = useState(false);
  const [restorePathHint, setRestorePathHint] = useState<string | undefined>(
    initialUiRestore.restorePathHint,
  );
  const fileTabPanelId = useId();
  const rootTabPanelId = useId();

  const activeFileAddress = tabs.active;
  const activeKey = activeFileAddress
    ? workspaceFileDocumentKey(activeFileAddress)
    : undefined;
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const activeAddressRef = useRef(activeFileAddress);
  activeAddressRef.current = activeFileAddress;
  const fileRefreshSequenceRef = useRef(0);
  const directoryControllersRef = useRef(new Map<string, AbortController>());
  const fullTreeControllersRef = useRef(new Map<string, AbortController>());
  const fileRefreshControllerRef = useRef<AbortController | undefined>(
    undefined,
  );
  const downloadControllerRef = useRef<AbortController | undefined>(undefined);
  const downloadFeedbackTimerRef = useRef<number | undefined>(undefined);
  const refreshingFileKeyRef = useRef<string | undefined>(undefined);
  const documentGenerationRef = useRef(0);
  const openFilesRef = useRef(openFiles);
  openFilesRef.current = openFiles;
  const treeOpenRef = useRef(treeOpen);
  treeOpenRef.current = treeOpen;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const filesByRootRef = useRef(filesByRoot);
  filesByRootRef.current = filesByRoot;
  const expandedPathsByRootRef = useRef<Record<string, readonly string[]>>(
    pendingUiRestoreRef.current?.expandedPathsByRoot ?? {},
  );
  const treeControllersRef = useRef(new Map<string, TreeController>());
  const treeToggleRef = useRef<HTMLButtonElement | null>(null);
  const treePanelRef = useRef<HTMLElement | null>(null);
  const filesBodyRef = useRef<HTMLDivElement | null>(null);
  const addFolderRef = useRef<HTMLButtonElement | null>(null);
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const rootTabListRef = useRef<HTMLDivElement | null>(null);
  const activeRootIdRef = useRef(activeRootId);
  activeRootIdRef.current = activeRootId;
  const appliedPreferredRootKeyRef = useRef<string | undefined>(undefined);
  const effectivePreferredRootId =
    currentThread?.preferredWorktree?.rootId ?? workspaceCompareStorage.latest(navigationScope, workspaceId) ?? null;
  const resolvedPreferredRootId = resolvePreferredRootId(
    roots,
    effectivePreferredRootId,
  );
  const visibleRootTabs = visibleWorkspaceFileRootTabs(
    roots,
    activeRootId,
    effectivePreferredRootId,
  );
  const activeCompareReviewIdRef = useRef(activeCompareReviewId);
  activeCompareReviewIdRef.current = activeCompareReviewId;
  const compareReviewIdentityKey =
    workspaceId && activeComparison
      ? [
          navigationScope ?? "",
          workspaceId,
          activeRootId,
          activeComparison.repositoryId,
          activeComparison.comparisonId,
          activeComparison.fingerprint,
        ].join("\u0000")
      : undefined;
  const compareReviewEpochRef = useRef({ identity: compareReviewIdentityKey, epoch: 0 });
  if (compareReviewEpochRef.current.identity !== compareReviewIdentityKey) {
    compareReviewEpochRef.current = { identity: compareReviewIdentityKey, epoch: compareReviewEpochRef.current.epoch + 1 };
  }
  const compareReviewContextKey = compareReviewIdentityKey === undefined
    ? undefined : `${compareReviewEpochRef.current.epoch}\0${compareReviewIdentityKey}`;
  const compareReviewContextKeyRef = useRef(compareReviewContextKey);
  compareReviewContextKeyRef.current = compareReviewContextKey;
  useEffect(() => {
    setReviewMenuOpen(false);
  }, [mode, compareReviewContextKey, context.visible]);
  const consumedIntentSequenceRef = useRef<number | undefined>(undefined);
  const recordedSeekIntentSequenceRef = useRef<number | undefined>(undefined);
  const pendingIntentAddressesRef = useRef(
    new Map<string, WorkspaceFileAddress>(),
  );
  const suppressedRootIdsRef = useRef(new Set<string>());
  const openingCompareReviewRef = useRef<
    | {
        readonly contextKey: string;
        readonly promise: Promise<WorkspaceDiffReview | undefined>;
      }
    | undefined
  >(undefined);
  const imageViewsRef = useRef(
    new Map<
      string,
      { readonly revision: string; readonly state: WorkspaceImageViewState }
    >(),
  );

  useEffect(() => {
    if (
      openingCompareReviewRef.current?.contextKey !== compareReviewContextKey
    ) {
      openingCompareReviewRef.current = undefined;
    }
  }, [compareReviewContextKey]);

  useEffect(() => {
    if (!treeOpen) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        treePanelRef.current?.contains(target) ||
        treeToggleRef.current?.contains(target)
      ) {
        return;
      }
      setTreeOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [treeOpen]);

  useEffect(() => {
    if (!treeOpen) return;
    const tree = treePanelRef.current;
    const trigger = treeToggleRef.current;
    const body = filesBodyRef.current;
    if (!tree || !trigger || !body) return;
    const alignTreeToTrigger = () => {
      const triggerBounds = trigger.getBoundingClientRect();
      const bodyBounds = body.getBoundingClientRect();
      tree.style.setProperty(
        "--workspace-files-tree-anchor-left",
        `${Math.max(0, triggerBounds.left - bodyBounds.left)}px`,
      );
    };
    alignTreeToTrigger();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(alignTreeToTrigger);
    observer?.observe(body);
    observer?.observe(trigger);
    window.addEventListener("resize", alignTreeToTrigger);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", alignTreeToTrigger);
    };
  }, [treeOpen]);

  const activateRoot = useCallback((rootId: WorkspaceFileRootId) => {
    const currentRootId = activeRootIdRef.current;
    if (currentRootId === rootId) return;
    const expanded = treeControllersRef.current
      .get(currentRootId)
      ?.getExpandedPaths();
    if (expanded) {
      expandedPathsByRootRef.current = {
        ...expandedPathsByRootRef.current,
        [currentRootId]: expanded,
      };
    }
    activeRootIdRef.current = rootId;
    setActiveComparison(undefined);
    setActiveRootId(rootId);
  }, []);

  useEffect(() => {
    if (rootsLoading || roots.length === 0) return;
    const preferenceKey = `${context.threadId ?? ""}\0${effectivePreferredRootId ?? "primary"}`;
    if (appliedPreferredRootKeyRef.current !== preferenceKey) {
      appliedPreferredRootKeyRef.current = preferenceKey;
      activateRoot(resolvedPreferredRootId);
      return;
    }
    if (!roots.some((root) => root.rootId === activeRootIdRef.current)) {
      activateRoot("primary");
    }
  }, [
    activateRoot,
    context.threadId,
    effectivePreferredRootId,
    resolvedPreferredRootId,
    roots,
    rootsLoading,
  ]);

  const registerTreeController = useCallback(
    (rootId: WorkspaceFileRootId, controller?: TreeController) => {
      const previous = treeControllersRef.current.get(rootId);
      if (controller) {
        treeControllersRef.current.set(rootId, controller);
        return;
      }
      if (previous) {
        expandedPathsByRootRef.current = {
          ...expandedPathsByRootRef.current,
          [rootId]: previous.getExpandedPaths(),
        };
      }
      treeControllersRef.current.delete(rootId);
    },
    [],
  );

  const openTab = useCallback(
    (
      address: WorkspaceFileAddress,
      options: { readonly hideTree?: boolean } = {},
    ) => {
      // Link-only roots authorize the opened document but are deliberately
      // absent from the browser topology. Keep the visible tree on its listed
      // root so reopening it never produces a blank, unlabelled root surface.
      if (!linkOnlyRootIdsRef.current.has(address.rootId)) {
        activateRoot(address.rootId);
      }
      setTabs((current) => {
        const existing = current.files.find((file) =>
          sameWorkspaceFileAddress(file, address),
        );
        if (existing) {
          return sameWorkspaceFileAddress(current.active, existing)
            ? current
            : { ...current, active: existing };
        }
        return { files: [...current.files, address], active: address };
      });
      if (sheetRef.current || options.hideTree) setTreeOpen(false);
    },
    [activateRoot],
  );

  useLayoutEffect(() => {
    const intent = context.intent;
    if (
      workspaceId &&
      isWorkspaceFilesOpenIntent(intent) &&
      intent.workspaceId === workspaceId
    ) {
      setMode("browse");
      setTreeOpen(false);
    }
  }, [context.intent, workspaceId]);

  useEffect(() => {
    if (uiReconciled && pendingUiRestoreRef.current === undefined) return;
    if (rootsLoading || (roots.length === 0 && !rootsError)) return;
    if (roots.length === 0) {
      // A failed topology request means the root set is unknown, not empty.
      // Leave the cached snapshot pending for a later successful refresh, but
      // stop presenting its loading surface so the actionable error is visible.
      setAwaitingUiRestore(false);
      setRestorePathHint(undefined);
      if (modeRef.current === "browse") setTreeOpen(true);
      return;
    }
    const listings = new Map<WorkspaceFileRootId, readonly string[]>();
    const partialRootIds = new Set<string>();
    for (const root of roots) {
      const listing = filesByRoot.get(root.rootId);
      listings.set(root.rootId, listing?.paths ?? []);
      if (
        root.availability === "unavailable" ||
        !listing?.loaded ||
        listing.scanTruncated
      ) {
        partialRootIds.add(root.rootId);
      }
    }
    for (const rootId of linkOnlyRootIdsRef.current) {
      partialRootIds.add(rootId);
    }
    const pending = pendingUiRestoreRef.current;
    if (pending && roots.some((root) => filesByRoot.get(root.rootId)?.loading))
      return;
    const liveSource: WorkspaceFilesUiSnapshot = {
      version: WORKSPACE_FILES_UI_STATE_VERSION,
      tabs: tabsRef.current,
      linkOnlyRootIds: [...linkOnlyRootIdsRef.current],
      activeRootId: activeRootIdRef.current,
      treeOpen: treeOpenRef.current,
      expandedPathsByRoot: expandedPathsByRootRef.current,
    };
    const baseSource = pending
      ? {
          ...pending,
          tabs: mergeOpenTabs(pending.tabs, tabsRef.current),
          linkOnlyRootIds: [
            ...new Set([
              ...pending.linkOnlyRootIds,
              ...linkOnlyRootIdsRef.current,
            ]),
          ],
          expandedPathsByRoot: {
            ...pending.expandedPathsByRoot,
            ...expandedPathsByRootRef.current,
          },
        }
      : liveSource;
    const openIntent =
      isWorkspaceFilesOpenIntent(context.intent) &&
      context.intent.workspaceId === workspaceId
        ? { rootId: context.intent.rootId, path: context.intent.path }
        : undefined;
    const intentAddresses = [...pendingIntentAddressesRef.current.values()];
    if (
      openIntent &&
      !intentAddresses.some((address) =>
        sameWorkspaceFileAddress(address, openIntent),
      )
    ) {
      intentAddresses.push(openIntent);
    }
    const filesWithIntents = [...baseSource.tabs.files];
    for (const address of intentAddresses) {
      if (
        !filesWithIntents.some((file) =>
          sameWorkspaceFileAddress(file, address),
        )
      ) {
        filesWithIntents.push(address);
      }
    }
    const existingOpenIntent = openIntent
      ? filesWithIntents.find((file) =>
          sameWorkspaceFileAddress(file, openIntent),
        )
      : undefined;
    const source =
      intentAddresses.length > 0
        ? {
            ...baseSource,
            treeOpen: false,
            tabs: {
              files: filesWithIntents,
              active: existingOpenIntent ?? baseSource.tabs.active,
            },
          }
        : baseSource;
    const pruned = pruneWorkspaceFilesUiSnapshot(source, listings, {
      partialRootIds,
      retainFile: (file) => {
        if (sameWorkspaceFileAddress(file, openIntent)) return true;
        if (
          pendingIntentAddressesRef.current.has(workspaceFileDocumentKey(file))
        )
          return true;
        if (pending) return partialRootIds.has(file.rootId);
        return workspaceFileDocumentIsDirty(
          documentsRef.current.get(workspaceFileDocumentKey(file)),
        );
      },
    });
    pendingUiRestoreRef.current = undefined;
    pendingIntentAddressesRef.current.clear();
    setUiReconciled(true);
    setAwaitingUiRestore(false);
    setRestorePathHint(undefined);
    expandedPathsByRootRef.current = pruned.expandedPathsByRoot;
    linkOnlyRootIdsRef.current = new Set(pruned.linkOnlyRootIds);
    const restoredRoot = roots.find(
      (root) => root.rootId === pruned.tabs.active?.rootId,
    );
    const explicitRootId =
      intentAddresses.length > 0 || restoredRoot?.kind === "supplemental"
        ? restoredRoot?.rootId
        : undefined;
    activateRoot(explicitRootId ?? resolvedPreferredRootId);
    const removed = tabsRef.current.files.filter(
      (file) =>
        !pruned.tabs.files.some((retained) =>
          sameWorkspaceFileAddress(file, retained),
        ),
    );
    for (const file of removed) {
      dispatchDocuments({ type: "closed", ...file });
    }
    if (removed.length > 0) {
      const removedKeys = new Set(removed.map(workspaceFileDocumentKey));
      for (const key of removedKeys) imageViewsRef.current.delete(key);
      setOpenFiles((current) => {
        if (![...removedKeys].some((key) => current.has(key))) return current;
        const next = new Map(current);
        for (const key of removedKeys) next.delete(key);
        return next;
      });
    }
    setTabs((current) =>
      sameTabs(current, pruned.tabs) ? current : pruned.tabs,
    );
    setTreeOpen((current) => {
      if (pruned.tabs.files.length === 0) return modeRef.current === "browse";
      if (intentAddresses.length > 0) return false;
      return pending ? pruned.treeOpen : current;
    });
  }, [
    activateRoot,
    context.intent,
    filesByRoot,
    roots,
    rootsError,
    rootsLoading,
    resolvedPreferredRootId,
    uiReconciled,
    workspaceId,
  ]);

  useEffect(() => {
    const pending =
      workspaceId === undefined ? undefined : uiStateCache.get(workspaceId);
    const restoredPresentation = readPendingUiRestorePresentation(
      pending,
      fileOpenIntentRef.current,
    );
    pendingUiRestoreRef.current = pending;
    // The previous workspace effect has already captured its live expansion
    // state. Forget those controllers before the old tree's delayed unmount
    // can write into the newly selected workspace's expansion cache.
    treeControllersRef.current.clear();
    expandedPathsByRootRef.current = pending?.expandedPathsByRoot ?? {};
    linkOnlyRootIdsRef.current = new Set(pending?.linkOnlyRootIds ?? []);
    const restoredRootId =
      pending?.activeRootId ?? pending?.tabs.active?.rootId ?? workspaceCompareStorage.latest(navigationScope, workspaceId) ?? "primary";
    activeRootIdRef.current = restoredRootId;
    setActiveRootId(restoredRootId);
    setRoots([]);
    setRootsLoading(workspaceId !== undefined);
    setRootsError(undefined);
    setFilesByRoot(new Map());
    setTabs({ files: [] });
    setOpenFiles(new Map());
    setPendingClose(undefined);
    setPendingRemove(undefined);
    setPendingRefreshReload(undefined);
    fileRefreshControllerRef.current?.abort();
    for (const pending of directoryControllersRef.current.values())
      pending.abort();
    directoryControllersRef.current.clear();
    for (const pending of fullTreeControllersRef.current.values())
      pending.abort();
    fullTreeControllersRef.current.clear();
    fileRefreshControllerRef.current = undefined;
    refreshingFileKeyRef.current = undefined;
    setRefreshingFileKey(undefined);
    fileRefreshSequenceRef.current += 1;
    suppressedRootIdsRef.current.clear();
    imageViewsRef.current.clear();
    consumedIntentSequenceRef.current = undefined;
    recordedSeekIntentSequenceRef.current = undefined;
    setPendingSeek(undefined);
    pendingIntentAddressesRef.current.clear();
    setConflictDialogOpen(false);
    setMode("browse");
    setCompareOpened(false);
    setActiveComparison(undefined);
    setCompareFiles([]);
    setCompareReviews([]);
    setCompareRepositoryHistoryCount(0);
    setActiveCompareReviewId(undefined);
    setCompareComments([]);
    setCompareReviewedFiles([]);
    setCompareReviewLoading(false);
    setCompareReviewMutating(false);
    setCompareReviewError(undefined);
    setCompareCommentSaving(false);
    setAwaitingUiRestore(restoredPresentation.awaitingUiRestore);
    setUiReconciled(false);
    setRestorePathHint(restoredPresentation.restorePathHint);
    setTreeOpen(restoredPresentation.treeOpen);
    dispatchDocuments({ type: "reset" });
    if (!workspaceId) {
      requestRefreshRef.current = () => undefined;
      return;
    }

    const controller = new AbortController();
    const snapshotWorkspaceId = workspaceId;
    let running = false;
    let queued = false;

    const requestRefresh = (): void => {
      if (
        controller.signal.aborted ||
        !filesVisibleRef.current ||
        document.visibilityState === "hidden"
      ) return;
      if (running) {
        queued = true;
        return;
      }
      void runRefresh();
    };

    const runRefresh = async (): Promise<void> => {
      running = true;
      setRootsLoading(true);
      const rootsResponse = await Promise.resolve(
        api.listWorkspaceFileRoots(workspaceId, controller.signal),
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ status: "rejected" as const, reason }),
      );
      if (controller.signal.aborted) return;
      const listedRootDescriptors =
        rootsResponse.status === "fulfilled"
          ? rootsResponse.value.roots
          : undefined;
      if (listedRootDescriptors) {
        for (const rootId of suppressedRootIdsRef.current) {
          if (!listedRootDescriptors.some((root) => root.rootId === rootId)) {
            suppressedRootIdsRef.current.delete(rootId);
          }
        }
      }
      // A topology response may have started before a root deletion and
      // arrived after it. Never let that stale descriptor launch a dependent
      // listing request against a root whose removal is already in flight or
      // committed; retain the fence until a later topology read confirms the
      // root is absent.
      const rootDescriptors = listedRootDescriptors?.filter(
        (root) => !suppressedRootIdsRef.current.has(root.rootId),
      );
      if (rootDescriptors) {
        setRoots(rootDescriptors);
        setRootsError(undefined);
        setFilesByRoot((current) => {
          const next = new Map<string, FileListState>();
          for (const root of rootDescriptors) {
            if (root.availability === "unavailable") {
              next.set(root.rootId, {
                ...EMPTY_FILE_LIST,
                error: diagnosticFor(root.diagnosticCode),
              });
              continue;
            }
            next.set(root.rootId, current.get(root.rootId) ?? EMPTY_FILE_LIST);
          }
          return sameFileListMap(current, next) ? current : next;
        });
      } else if (rootsResponse.status === "rejected") {
        setRootsError(messageFor(rootsResponse.reason));
      }
      running = false;
      if (controller.signal.aborted) return;
      setRootsLoading(false);
      if (queued) {
        queued = false;
        requestRefresh();
      }
    };

    requestRefreshRef.current = requestRefresh;
    return () => {
      if (pendingUiRestoreRef.current === undefined) {
        const expandedPathsByRoot = captureExpandedPaths(
          treeControllersRef.current,
          expandedPathsByRootRef.current,
        );
        const tabs = tabsRef.current;
        if (
          tabs.files.length === 0 &&
          activeRootIdRef.current === "primary" &&
          Object.values(expandedPathsByRoot).every(
            (paths) => paths.length === 0,
          )
        ) {
          uiStateCache.delete(snapshotWorkspaceId);
        } else {
          uiStateCache.set(snapshotWorkspaceId, {
            version: WORKSPACE_FILES_UI_STATE_VERSION,
            tabs,
            linkOnlyRootIds: [
              ...new Set(
                tabs.files
                  .map((file) => file.rootId)
                  .filter((rootId) => linkOnlyRootIdsRef.current.has(rootId)),
              ),
            ],
            activeRootId: activeRootIdRef.current,
            treeOpen: treeOpenRef.current,
            expandedPathsByRoot,
          });
        }
      }
      controller.abort();
      fileRefreshControllerRef.current?.abort();
      fileRefreshSequenceRef.current += 1;
      if (requestRefreshRef.current === requestRefresh)
        requestRefreshRef.current = () => undefined;
    };
  }, [api, uiStateCache, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !filesVisible) return;
    // Refresh topology on return without subscribing to filesystem events.
    // The workspace effect above retains editor state across visibility changes.
    requestRefreshRef.current();
  }, [api, filesVisible, uiStateCache, workspaceId]);

  useEffect(() => {
    const intent = context.intent;
    if (
      !workspaceId ||
      !isWorkspaceFilesOpenIntent(intent) ||
      intent.workspaceId !== workspaceId
    )
      return;
    if (intent.rootVisibility === "link_only") {
      linkOnlyRootIdsRef.current.add(intent.rootId);
    }
    const address = { rootId: intent.rootId, path: intent.path };
    if (recordedSeekIntentSequenceRef.current !== intent.sequence) {
      recordedSeekIntentSequenceRef.current = intent.sequence;
      setPendingSeek(
        intent.target.kind === "source_line"
          ? {
              address,
              sequence: intent.sequence,
              lineNumber: intent.target.lineNumber,
            }
          : undefined,
      );
    }
    pendingIntentAddressesRef.current.set(
      workspaceFileDocumentKey(address),
      address,
    );
    openTab(address, { hideTree: true });
    if (consumedIntentSequenceRef.current !== intent.sequence) {
      consumedIntentSequenceRef.current = intent.sequence;
      context.host.consumeIntent(intent.sequence);
    }
  }, [context.host, context.intent, openTab, tabs.files, workspaceId]);

  const loadDirectory = useCallback(
    async (
      rootId: WorkspaceFileRootId,
      directory: WorkspaceFileDirectoryPath,
      options: { readonly force?: boolean } = {},
    ) => {
      if (!workspaceId) return;
      const key = `${rootId}\0${directory}`;
      const current = filesByRootRef.current.get(rootId);
      if (
        current?.fullTreeLoaded ||
        (!options.force && current?.loadedDirectories.has(directory)) ||
        directoryControllersRef.current.has(key)
      ) {
        return;
      }
      const controller = new AbortController();
      directoryControllersRef.current.set(key, controller);
      setFilesByRoot((state) =>
        updateFileList(state, rootId, (listing) => ({
          ...listing,
          loading: true,
          loadingDirectories: new Set(listing.loadingDirectories).add(
            directory,
          ),
          error: undefined,
        })),
      );
      try {
        const result = await loadDirectoryPaths(
          api,
          workspaceId,
          rootId,
          directory,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setFilesByRoot((state) =>
          updateFileList(state, rootId, (listing) => ({
            ...listing,
            paths: mergeDirectoryPaths(
              listing.paths,
              directory,
              result.paths,
              options.force === true,
            ),
            loading: false,
            loaded: true,
            scanTruncated: listing.scanTruncated || result.scanTruncated,
            loadedDirectories: new Set(listing.loadedDirectories).add(
              directory,
            ),
            loadingDirectories: withoutSetEntry(
              listing.loadingDirectories,
              directory,
            ),
            error: undefined,
          })),
        );
      } catch (error) {
        if (controller.signal.aborted) return;
        const directoryWasRemoved =
          directory !== "" && error instanceof ApiError && error.status === 404;
        setFilesByRoot((state) =>
          updateFileList(state, rootId, (listing) => ({
            ...listing,
            loading: false,
            ...(directoryWasRemoved
              ? {
                  paths: withoutDirectoryPathSubtree(listing.paths, directory),
                  loadedDirectories: withoutDirectorySubtree(
                    listing.loadedDirectories,
                    directory,
                  ),
                }
              : {}),
            loadingDirectories: withoutSetEntry(
              listing.loadingDirectories,
              directory,
            ),
            error: directoryWasRemoved ? undefined : messageFor(error),
          })),
        );
      } finally {
        if (directoryControllersRef.current.get(key) === controller)
          directoryControllersRef.current.delete(key);
      }
    },
    [api, workspaceId],
  );

  const loadFullTree = useCallback(
    async (rootId: WorkspaceFileRootId) => {
      if (!workspaceId) return;
      const pending = fullTreeControllersRef.current.get(rootId);
      if (pending) {
        pending.abort();
        fullTreeControllersRef.current.delete(rootId);
        setFilesByRoot((state) =>
          updateFileList(state, rootId, (listing) => ({
            ...listing,
            loading: false,
          })),
        );
        return;
      }
      const directoryKeyPrefix = `${rootId}\0`;
      for (const [
        key,
        directoryController,
      ] of directoryControllersRef.current) {
        if (!key.startsWith(directoryKeyPrefix)) continue;
        directoryController.abort();
        directoryControllersRef.current.delete(key);
      }
      const controller = new AbortController();
      fullTreeControllersRef.current.set(rootId, controller);
      setFilesByRoot((state) =>
        updateFileList(state, rootId, (listing) => ({
          ...listing,
          loading: true,
          error: undefined,
        })),
      );
      try {
        const result = await loadAllPaths(
          api,
          workspaceId,
          rootId,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        setFilesByRoot((state) =>
          updateFileList(state, rootId, (listing) => ({
            ...listing,
            paths: result.paths,
            loading: false,
            loaded: true,
            fullTreeLoaded: true,
            scanTruncated: result.scanTruncated,
            loadedDirectories: new Set([""]),
            loadingDirectories: new Set(),
            error: undefined,
          })),
        );
        setUiReconciled(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        setFilesByRoot((state) =>
          updateFileList(state, rootId, (listing) => ({
            ...listing,
            loading: false,
            error: messageFor(error),
          })),
        );
      } finally {
        if (fullTreeControllersRef.current.get(rootId) === controller)
          fullTreeControllersRef.current.delete(rootId);
      }
    },
    [api, workspaceId],
  );

  useEffect(() => {
    if (!filesVisible || !treeOpen) return;
    const root = roots.find((candidate) => candidate.rootId === activeRootId);
    if (!root || root.availability === "unavailable") return;
    void loadDirectory(root.rootId, "");
  }, [activeRootId, filesVisible, loadDirectory, roots, treeOpen]);

  useEffect(() => {
    context.host.setSubtitle(context.workspaceLabel);
    return () => context.host.setSubtitle(undefined);
  }, [context.host, context.workspaceLabel]);

  const anyDirty = useMemo(
    () => [...documents.values()].some(workspaceFileDocumentIsDirty),
    [documents],
  );
  useEffect(() => {
    context.host.setDirty(anyDirty);
    return () => context.host.setDirty(false);
  }, [anyDirty, context.host]);
  const anySaving = useMemo(
    () =>
      [...documents.values()].some(
        (document) => document.saveState === "saving",
      ),
    [documents],
  );
  useEffect(() => {
    context.host.setBusy(anySaving || attaching || removing);
    return () => context.host.setBusy(false);
  }, [anySaving, attaching, context.host, removing]);
  useEffect(() => {
    setConflictDialogOpen(false);
    setPendingRefreshReload(undefined);
  }, [activeKey]);
  useEffect(() => {
    downloadControllerRef.current?.abort();
    downloadControllerRef.current = undefined;
    if (downloadFeedbackTimerRef.current !== undefined) {
      window.clearTimeout(downloadFeedbackTimerRef.current);
      downloadFeedbackTimerRef.current = undefined;
    }
    setPendingDownload(undefined);
    setDownloadState(undefined);
    return () => {
      downloadControllerRef.current?.abort();
      if (downloadFeedbackTimerRef.current !== undefined) {
        window.clearTimeout(downloadFeedbackTimerRef.current);
        downloadFeedbackTimerRef.current = undefined;
      }
    };
  }, [activeKey, workspaceId]);

  useEffect(() => {
    if (!filesVisible || !workspaceId || !activeFileAddress) return;
    const key = workspaceFileDocumentKey(activeFileAddress);
    const existing = openFilesRef.current.get(key);
    if (existing && !existing.loading && existing.file) return;
    const controller = new AbortController();
    setOpenFiles((current) => new Map(current).set(key, { loading: true }));
    void api
      .readWorkspaceFile(
        workspaceId,
        activeFileAddress.rootId,
        activeFileAddress.path,
        controller.signal,
      )
      .then(
        (next) => {
          if (controller.signal.aborted) return;
          setOpenFiles((current) =>
            new Map(current).set(key, { loading: false, file: next }),
          );
          if (
            next.availability === "available" &&
            next.contentKind === "text"
          ) {
            dispatchDocuments({
              type: "loaded",
              rootId: next.rootId,
              path: next.path,
              generation: ++documentGenerationRef.current,
              revision: next.revision,
              content: next.content,
              editable: next.editable,
              truncated: next.truncation !== undefined,
            });
          }
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          setOpenFiles((current) =>
            new Map(current).set(key, {
              loading: false,
              error: messageFor(error),
            }),
          );
        },
      );
    return () => controller.abort();
  }, [activeFileAddress, api, filesVisible, workspaceId]);

  const completeSave = useCallback(
    async (
      address: WorkspaceFileAddress,
      generation: number,
      expectedRevision: string,
      content: string,
    ) => {
      if (!workspaceId) return;
      dispatchDocuments({ type: "save_started", ...address, generation });
      setConflictDialogOpen(false);
      try {
        const result = await api.saveWorkspaceFile(workspaceId, {
          ...address,
          content,
          expectedRevision,
        });
        if (result.availability === "unavailable") {
          dispatchDocuments({
            type: "save_failed",
            ...address,
            generation,
            message: "File editing is unavailable for this folder.",
          });
          return;
        }
        dispatchDocuments({
          type: "save_succeeded",
          ...address,
          generation,
          revision: result.revision,
          savedContent: content,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          error.code === "workspace_file_write_outcome_unknown"
        ) {
          try {
            const latest = await api.readWorkspaceFile(
              workspaceId,
              address.rootId,
              address.path,
            );
            if (
              documentsRef.current.get(workspaceFileDocumentKey(address))
                ?.generation !== generation
            ) {
              return;
            }
            if (!isEditableTextFile(latest)) {
              dispatchDocuments({
                type: "save_failed",
                ...address,
                generation,
                message:
                  "The save outcome could not be confirmed, and the remote file cannot currently be reconciled.",
              });
              return;
            }
            if (latest.content === content) {
              setOpenFiles((current) =>
                new Map(current).set(workspaceFileDocumentKey(address), {
                  loading: false,
                  file: latest,
                }),
              );
              dispatchDocuments({
                type: "save_succeeded",
                ...address,
                generation,
                revision: latest.revision,
                savedContent: content,
              });
              return;
            }
            dispatchDocuments({
              type: "save_conflicted",
              ...address,
              generation,
            });
            if (sameWorkspaceFileAddress(activeAddressRef.current, address)) {
              setConflictDialogOpen(true);
            }
          } catch {
            dispatchDocuments({
              type: "save_failed",
              ...address,
              generation,
              message:
                "The save outcome could not be confirmed. Your changes remain unsaved; reconnect and reload before retrying.",
            });
          }
          return;
        }
        if (
          error instanceof ApiError &&
          error.code === "workspace_file_revision_conflict"
        ) {
          dispatchDocuments({
            type: "save_conflicted",
            ...address,
            generation,
          });
          if (
            sameWorkspaceFileAddress(activeAddressRef.current, address) &&
            documentsRef.current.get(workspaceFileDocumentKey(address))
              ?.generation === generation
          ) {
            setConflictDialogOpen(true);
          }
          return;
        }
        dispatchDocuments({
          type: "save_failed",
          ...address,
          generation,
          message: messageFor(error),
        });
      }
    },
    [api, workspaceId],
  );

  const save = useCallback(() => {
    const address = activeAddressRef.current;
    const document = address
      ? documentsRef.current.get(workspaceFileDocumentKey(address))
      : undefined;
    if (
      !address ||
      !document ||
      !workspaceFileDocumentIsDirty(document) ||
      document.saveState === "saving"
    )
      return;
    void completeSave(
      address,
      document.generation,
      document.revision,
      document.content,
    );
  }, [completeSave]);

  const downloadFile = useCallback(
    async (target: WorkspaceFileDownloadTarget) => {
      if (!workspaceId) return;
      downloadControllerRef.current?.abort();
      const controller = new AbortController();
      downloadControllerRef.current = controller;
      const key = workspaceFileDocumentKey(target);
      setPendingDownload(undefined);
      if (downloadFeedbackTimerRef.current !== undefined) {
        window.clearTimeout(downloadFeedbackTimerRef.current);
        downloadFeedbackTimerRef.current = undefined;
      }
      setDownloadState({ key, phase: "preparing" });
      try {
        const prepared = await api.prepareWorkspaceFileDownload(workspaceId, {
          rootId: target.rootId,
          path: target.path,
          expectedRevision: target.revision,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const suggestedFileName = fileDisplayName(target.path);
        if (supportsPackagedWorkspaceFileDownloads()) {
          await downloadWorkspaceFileInPackagedClient({
            serverOrigin: prepared.serverOrigin,
            url: prepared.url,
            suggestedFileName,
            expectedContentDisposition: prepared.contentDisposition,
            expectedContentLength: prepared.contentLength,
            expectedRevision: prepared.revision,
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            setDownloadState({ key, phase: "idle" });
          }
        } else {
          setDownloadState({ key, phase: "started" });
          startBrowserWorkspaceFileDownload(prepared.url, (message) => {
            if (downloadFeedbackTimerRef.current !== undefined) {
              window.clearTimeout(downloadFeedbackTimerRef.current);
              downloadFeedbackTimerRef.current = undefined;
            }
            setDownloadState((current) =>
              current?.key === key
                ? { key, phase: "idle", error: message }
                : current,
            );
          });
          downloadFeedbackTimerRef.current = window.setTimeout(() => {
            downloadFeedbackTimerRef.current = undefined;
            setDownloadState((current) =>
              current?.key === key && current.phase === "started"
                ? { key, phase: "idle" }
                : current,
            );
          }, 1_500);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setDownloadState({ key, phase: "idle", error: messageFor(error) });
      } finally {
        if (downloadControllerRef.current === controller) {
          downloadControllerRef.current = undefined;
        }
      }
    },
    [api, workspaceId],
  );

  const requestDownload = useCallback(
    (
      target: WorkspaceFileDownloadTarget,
      document?: WorkspaceFileDocumentState,
    ) => {
      if (document?.saveState === "saving") return;
      if (workspaceFileDocumentIsDirty(document)) {
        setPendingDownload(target);
        return;
      }
      void downloadFile(target);
    },
    [downloadFile],
  );

  const reload = useCallback(async () => {
    const address = activeAddressRef.current;
    const key = address ? workspaceFileDocumentKey(address) : undefined;
    const generation = key
      ? documentsRef.current.get(key)?.generation
      : undefined;
    if (!workspaceId || !address || !key || generation === undefined) return;
    setConflictDialogOpen(false);
    try {
      const latest = await api.readWorkspaceFile(
        workspaceId,
        address.rootId,
        address.path,
      );
      if (documentsRef.current.get(key)?.generation !== generation) return;
      if (isEditableTextFile(latest)) {
        setOpenFiles((current) =>
          new Map(current).set(key, { loading: false, file: latest }),
        );
        dispatchDocuments({
          type: "loaded",
          rootId: latest.rootId,
          path: latest.path,
          generation: ++documentGenerationRef.current,
          revision: latest.revision,
          content: latest.content,
          editable: latest.editable,
          truncated: latest.truncation !== undefined,
        });
      } else {
        dispatchDocuments({
          type: "save_failed",
          ...address,
          generation,
          message: latestFileCannotBeEditedMessage(latest),
        });
      }
    } catch (error) {
      dispatchDocuments({
        type: "save_failed",
        ...address,
        generation,
        message: messageFor(error),
      });
    }
  }, [api, workspaceId]);

  const refreshOpenFile = useCallback(
    async (address: WorkspaceFileAddress): Promise<void> => {
      if (!workspaceId || refreshingFileKeyRef.current !== undefined) return;
      const key = workspaceFileDocumentKey(address);
      const document = documentsRef.current.get(key);
      const openFile = openFilesRef.current.get(key);
      if (document?.saveState === "saving") return;

      const sequence = ++fileRefreshSequenceRef.current;
      const controller = new AbortController();
      fileRefreshControllerRef.current = controller;
      refreshingFileKeyRef.current = key;
      setRefreshingFileKey(key);
      setPendingRefreshReload(undefined);
      try {
        const latest = await api.readWorkspaceFile(
          workspaceId,
          address.rootId,
          address.path,
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          fileRefreshSequenceRef.current !== sequence ||
          refreshingFileKeyRef.current !== key ||
          !tabsRef.current.files.some((file) =>
            sameWorkspaceFileAddress(file, address),
          ) ||
          openFilesRef.current.get(key) !== openFile ||
          !sameDocumentReloadSnapshot(documentsRef.current.get(key), document)
        ) {
          return;
        }

        setOpenFiles((current) =>
          new Map(current).set(key, { loading: false, file: latest }),
        );
        if (
          latest.availability === "available" &&
          latest.contentKind === "text"
        ) {
          dispatchDocuments({
            type: "loaded",
            rootId: latest.rootId,
            path: latest.path,
            generation: ++documentGenerationRef.current,
            revision: latest.revision,
            content: latest.content,
            editable: latest.editable,
            truncated: latest.truncation !== undefined,
          });
          if (
            document?.editing &&
            latest.editable &&
            latest.truncation === undefined
          ) {
            dispatchDocuments({
              type: "set_editing",
              rootId: latest.rootId,
              path: latest.path,
              editing: true,
            });
          }
        } else if (document) {
          dispatchDocuments({ type: "closed", ...address });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const currentDocument = documentsRef.current.get(key);
        if (!sameDocumentReloadSnapshot(currentDocument, document)) return;
        if (document) {
          dispatchDocuments({
            type: "save_failed",
            ...address,
            generation: document.generation,
            message: messageFor(error),
          });
        } else {
          setOpenFiles((current) => {
            if (current.get(key) !== openFile) return current;
            return new Map(current).set(key, {
              loading: false,
              error: messageFor(error),
            });
          });
        }
      } finally {
        if (
          fileRefreshSequenceRef.current === sequence &&
          refreshingFileKeyRef.current === key
        ) {
          fileRefreshControllerRef.current = undefined;
          refreshingFileKeyRef.current = undefined;
          setRefreshingFileKey(undefined);
        }
      }
    },
    [api, workspaceId],
  );

  const refreshWorkspaceFiles = useCallback(() => {
    const address = activeAddressRef.current;
    const document = address
      ? documentsRef.current.get(workspaceFileDocumentKey(address))
      : undefined;
    if (refreshingFileKeyRef.current !== undefined) return;

    requestRefreshRef.current();
    const rootId = activeRootIdRef.current;
    const listing = filesByRootRef.current.get(rootId);
    if (listing?.fullTreeLoaded) {
      void loadFullTree(rootId);
    } else {
      for (const directory of listing?.loadedDirectories ?? []) {
        void loadDirectory(rootId, directory as WorkspaceFileDirectoryPath, {
          force: true,
        });
      }
    }
    if (modeRef.current !== "browse" || !address) return;
    if (document?.saveState === "saving") return;
    if (workspaceFileDocumentIsDirty(document)) {
      setPendingRefreshReload(address);
      return;
    }
    void refreshOpenFile(address);
  }, [loadDirectory, loadFullTree, refreshOpenFile]);

  const overwrite = useCallback(async () => {
    const address = activeAddressRef.current;
    const key = address ? workspaceFileDocumentKey(address) : undefined;
    const document = key ? documentsRef.current.get(key) : undefined;
    if (!workspaceId || !address || !key || !document) return;
    const generation = document.generation;
    const retainedDraft = document.content;
    dispatchDocuments({ type: "save_started", ...address, generation });
    setConflictDialogOpen(false);
    try {
      const latest = await api.readWorkspaceFile(
        workspaceId,
        address.rootId,
        address.path,
      );
      if (documentsRef.current.get(key)?.generation !== generation) return;
      if (!isEditableTextFile(latest)) {
        dispatchDocuments({
          type: "save_failed",
          ...address,
          generation,
          message: latestFileCannotBeEditedMessage(latest),
        });
        return;
      }
      await completeSave(address, generation, latest.revision, retainedDraft);
    } catch (error) {
      dispatchDocuments({
        type: "save_failed",
        ...address,
        generation,
        message: messageFor(error),
      });
    }
  }, [api, completeSave, workspaceId]);

  const removeTab = useCallback(
    (address: WorkspaceFileAddress, restoreFocus = false) => {
      const key = workspaceFileDocumentKey(address);
      const current = tabsRef.current;
      const index = current.files.findIndex((candidate) =>
        sameWorkspaceFileAddress(candidate, address),
      );
      const remaining = current.files.filter(
        (candidate) => !sameWorkspaceFileAddress(candidate, address),
      );
      const nextActive = sameWorkspaceFileAddress(current.active, address)
        ? remaining[Math.min(index, remaining.length - 1)]
        : current.active;
      dispatchDocuments({ type: "closed", ...address });
      imageViewsRef.current.delete(key);
      setOpenFiles((open) => {
        if (!open.has(key)) return open;
        const next = new Map(open);
        next.delete(key);
        return next;
      });
      setTabs(
        nextActive === undefined
          ? { files: remaining }
          : { files: remaining, active: nextActive },
      );
      if (restoreFocus) {
        requestAnimationFrame(() => {
          const nextKey = nextActive
            ? workspaceFileDocumentKey(nextActive)
            : undefined;
          const nextTab = [
            ...(tabListRef.current?.querySelectorAll<HTMLElement>(
              '[role="tab"]',
            ) ?? []),
          ].find((element) => element.dataset.workspaceFileKey === nextKey);
          const fallback = treeToggleRef.current?.disabled
            ? addFolderRef.current
            : treeToggleRef.current;
          (nextTab ?? fallback)?.focus();
        });
      }
    },
    [],
  );

  const closeTab = useCallback(
    (address: WorkspaceFileAddress) => {
      if (
        workspaceFileDocumentIsDirty(
          documentsRef.current.get(workspaceFileDocumentKey(address)),
        )
      ) {
        setPendingClose(address);
        return;
      }
      removeTab(address, true);
    },
    [removeTab],
  );

  useEffect(() => {
    if (
      tabs.files.length === 0 &&
      !awaitingUiRestore &&
      !fileOpenIntentPresented
    ) {
      setTreeOpen(true);
    }
  }, [awaitingUiRestore, fileOpenIntentPresented, tabs.files.length]);

  const submitAttach = useCallback(async () => {
    if (!workspaceId || !attachPath.trim()) return;
    const normalizedPath = normalizeAttachPath(attachPath);
    const parsedPath =
      workspaceFileAbsolutePathSchema.safeParse(normalizedPath);
    if (!parsedPath.success) {
      setAttachError(
        "Enter an absolute normalized POSIX path without empty, . or .. segments.",
      );
      return;
    }
    setAttaching(true);
    setAttachError(undefined);
    try {
      const attached = await api.attachWorkspaceFileRoot(workspaceId, {
        mutationId: crypto.randomUUID(),
        path: parsedPath.data,
        ...(attachLabel.trim() ? { displayLabel: attachLabel.trim() } : {}),
      });
      activateRoot(attached.root.rootId);
      setAttachDialogOpen(false);
      setAttachPath("");
      setAttachLabel("");
      requestRefreshRef.current();
    } catch (error) {
      setAttachError(messageFor(error));
    } finally {
      setAttaching(false);
    }
  }, [activateRoot, api, attachLabel, attachPath, workspaceId]);

  const requestRemoveRoot = useCallback((root: WorkspaceFileRootDescriptor) => {
    setPendingRemove(root);
  }, []);

  const confirmRemoveRoot = useCallback(async () => {
    if (!workspaceId || !pendingRemove || pendingRemove.rootId === "primary")
      return;
    const rootId = pendingRemove.rootId as WorkspaceFileSupplementalRootId;
    setRemoving(true);
    suppressedRootIdsRef.current.add(rootId);
    try {
      await api.removeWorkspaceFileRoot(workspaceId, rootId, {
        mutationId: crypto.randomUUID(),
        expectedRevision: pendingRemove.revision,
      });
      const removedFiles = tabsRef.current.files.filter(
        (file) => file.rootId === rootId,
      );
      for (const file of removedFiles) {
        dispatchDocuments({ type: "closed", ...file });
      }
      const removedKeys = new Set(
        removedFiles.map((file) => workspaceFileDocumentKey(file)),
      );
      for (const key of removedKeys) imageViewsRef.current.delete(key);
      setOpenFiles((current) => {
        if (removedKeys.size === 0) return current;
        const next = new Map(current);
        for (const key of removedKeys) next.delete(key);
        return next;
      });
      setTabs((current) => {
        const activeIndex = current.active
          ? current.files.findIndex((file) =>
              sameWorkspaceFileAddress(file, current.active),
            )
          : -1;
        const remaining = current.files.filter(
          (file) => file.rootId !== rootId,
        );
        const nextActive =
          current.active?.rootId === rootId
            ? remaining[
                Math.max(0, Math.min(activeIndex, remaining.length - 1))
              ]
            : current.active;
        return nextActive === undefined
          ? { files: remaining }
          : { files: remaining, active: nextActive };
      });
      setPendingRemove(undefined);
      requestRefreshRef.current();
    } catch (error) {
      suppressedRootIdsRef.current.delete(rootId);
      setRootsError(messageFor(error));
      setPendingRemove(undefined);
      requestRefreshRef.current();
    } finally {
      setRemoving(false);
    }
  }, [api, pendingRemove, workspaceId]);

  const compareDataSource = useMemo<WorkspaceCompareDataSource | undefined>(
    () =>
      workspaceId
        ? {
            listRepositories: (rootId, signal) =>
              api.listWorkspaceDiffRepositories(workspaceId, rootId, signal),
            listRevisions: (repositoryId, signal, query) =>
              api.listWorkspaceDiffRefs(
                workspaceId,
                activeRootId,
                { repositoryId, pageSize: 200, ...query },
                signal,
              ),
            createComparison: (request, signal) =>
              api.createWorkspaceDiffComparison(
                workspaceId,
                activeRootId,
                request,
                signal,
              ),
            listChangedFiles: (query, signal) =>
              api.listWorkspaceDiffChangedFiles(
                workspaceId,
                activeRootId,
                query,
                signal,
              ),
            loadPatch: (request, signal) =>
              api.readWorkspaceDiffPatch(
                workspaceId,
                activeRootId,
                request,
                signal,
              ),
            loadFileContent: (request, signal) =>
              api.readWorkspaceDiffFileContent(
                workspaceId,
                activeRootId,
                request,
                signal,
              ),
          }
        : undefined,
    [activeRootId, api, workspaceId],
  );

  const attachCompareSelection = useCallback(
    (
      target: WorkspaceCompareCapturedLineTarget & {
        readonly note?: string;
      },
      sendImmediately?: boolean,
    ): PierreSelectionStageResult => {
      if (!workspaceId) {
        return { ok: false, reason: "No workspace is available." };
      }
      const current = activeComparison;
      const sourceStatus =
        !current ||
        current.comparisonId !== target.comparison.comparisonId ||
        current.fingerprint !== target.comparison.fingerprint
          ? ({ status: "stale" } as const)
          : ({
              status: "available",
              comparisonId: current.comparisonId,
              comparisonFingerprint: current.fingerprint,
              fileId: target.file.fileId,
            } as const);
      return stageWorkspaceDiffContextExcerpt({
        target: context.contextExcerpts,
        sourceStatus,
        sendImmediately,
        candidate: {
          excerpt: target.captured.excerpt,
          ...(target.note ? { note: target.note } : {}),
          source: {
            kind: "workspace_diff",
            workspaceId,
            rootId: activeRootId,
            comparisonId: target.comparison.comparisonId,
            comparisonFingerprint: target.comparison.fingerprint,
            fileId: target.file.fileId,
            ...(target.file.oldPath ? { oldPath: target.file.oldPath } : {}),
            ...(target.file.newPath ? { newPath: target.file.newPath } : {}),
          },
          locator: {
            kind: "diff_line_range",
            start: target.captured.start,
            end: target.captured.end,
          },
        },
      });
    },
    [activeComparison, activeRootId, context.contextExcerpts, workspaceId],
  );

  const compareReviewOptions = useMemo(() => {
    const seen = new Set<string>();
    const next: WorkspaceDiffReview[] = [];
    for (const review of [...compareReviews, ...compareHistoryReviews]) {
      if (seen.has(review.id)) continue;
      seen.add(review.id);
      next.push(review);
    }
    return next;
  }, [compareHistoryReviews, compareReviews]);

  const currentCompareReview = useMemo(
    () => preferredWorkspaceDiffReview(compareReviews),
    [compareReviews],
  );

  const activeCompareReview = useMemo(
    () =>
      activeCompareReviewId
        ? compareReviewOptions.find(
            (review) => review.id === activeCompareReviewId,
          )
        : undefined,
    [activeCompareReviewId, compareReviewOptions],
  );

  useEffect(() => {
    setCompareReviewTitleDraft(activeCompareReview?.title ?? "");
    setCompareReviewSummaryDraft(activeCompareReview?.summary ?? "");
    setCompareReviewStateDraft(activeCompareReview?.state ?? "open");
  }, [activeCompareReview]);

  const loadedReviewContextRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    loadedReviewContextRef.current = undefined;
    setCompareReviewMutating(false);
    setCompareCommentSaving(false);
    if (!activeComparison) {
      openingCompareReviewRef.current = undefined;
      setCompareFiles([]);
      setCompareReviews([]);
      setCompareHistoryReviews([]);
      setCompareRepositoryHistoryCount(0);
      setActiveCompareReviewId(undefined);
      setCompareComments([]);
      setCompareReviewedFiles([]);
      setCompareCurrentComments([]);
      setCompareCurrentReviewedFiles([]);
      setCompareReviewError(undefined);
      setCompareReviewLoading(false);
      setCompareReviewMutating(false);
      setCompareCommentSaving(false);
      setCompareDetailsOpen(false);
      return;
    }
    if (!workspaceId) return;
    let cancelled = false;
    setCompareReviewLoading(true);
    setCompareReviewError(undefined);
    void Promise.all([
      api.listWorkspaceDiffReviews(workspaceId, activeRootId, {
        comparisonId: activeComparison.comparisonId,
        fingerprint: activeComparison.fingerprint,
      }),
      api.listWorkspaceDiffReviewHistory(workspaceId, activeRootId, {
        repositoryId: activeComparison.repositoryId,
      }),
    ])
      .then(([exact, history]) => {
        if (cancelled) return;
        loadedReviewContextRef.current = compareReviewContextKeyRef.current;
        const exactReviews = exact.reviews;
        setCompareReviews(exactReviews);
        setCompareHistoryReviews(history.reviews);
        setCompareRepositoryHistoryCount(history.reviews.length);
        setActiveCompareReviewId((current) =>
          [...exactReviews, ...history.reviews].some(
            (review) => review.id === current,
          )
            ? current
            : ([...exactReviews, ...history.reviews].find(review => review.id === workspaceCompareStorage.get(navigationScope, workspaceId, activeRootId)?.selectedReviewId)?.id ??
              preferredWorkspaceDiffReview(exactReviews)?.id ??
              preferredWorkspaceDiffReview(history.reviews)?.id),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCompareReviews([]);
        setCompareHistoryReviews([]);
        setCompareRepositoryHistoryCount(0);
        setActiveCompareReviewId(undefined);
        setCompareComments([]);
        setCompareReviewedFiles([]);
        setCompareCurrentComments([]);
        setCompareCurrentReviewedFiles([]);
        setCompareReviewError(messageFor(error));
      })
      .finally(() => {
        if (!cancelled) setCompareReviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeComparison, activeRootId, api, workspaceId, navigationScope]);

  useEffect(() => {
    if (!activeCompareReviewId || loadedReviewContextRef.current !== compareReviewContextKeyRef.current) return;
    const saved = workspaceCompareStorage.get(navigationScope, workspaceId, activeRootId);
    workspaceCompareStorage.set(navigationScope, workspaceId, activeRootId, { ...saved, mode: modeRef.current, selectedReviewId: activeCompareReviewId });
  }, [activeCompareReviewId, navigationScope, workspaceId, activeRootId]);

  useEffect(() => {
    if (!activeCompareReviewId) {
      setCompareComments([]);
      setCompareReviewedFiles([]);
      return;
    }
    let cancelled = false;
    setCompareComments([]);
    setCompareReviewedFiles([]);
    setCompareReviewLoading(true);
    setCompareReviewError(undefined);
    void Promise.all([
      api.listWorkspaceDiffReviewComments(activeCompareReviewId),
      api.listWorkspaceDiffReviewedFiles(activeCompareReviewId),
    ])
      .then(([comments, reviewed]) => {
        if (cancelled) return;
        setCompareComments(comments.comments);
        setCompareReviewedFiles(reviewed.files);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCompareComments([]);
        setCompareReviewedFiles([]);
        setCompareReviewError(messageFor(error));
      })
      .finally(() => {
        if (!cancelled) setCompareReviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeCompareReviewId, api]);

  const currentInlineReviewIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (currentInlineReviewIdRef.current !== currentCompareReview?.id) {
      setCompareCurrentComments([]);
      setCompareCurrentReviewedFiles([]);
    }
    currentInlineReviewIdRef.current = currentCompareReview?.id;
    if (!currentCompareReview) return;
    let cancelled = false;
    void Promise.all([
      api.listWorkspaceDiffReviewComments(currentCompareReview.id),
      api.listWorkspaceDiffReviewedFiles(currentCompareReview.id),
    ])
      .then(([comments, reviewed]) => {
        if (cancelled) return;
        setCompareCurrentComments(comments.comments);
        setCompareCurrentReviewedFiles(reviewed.files);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setCompareCurrentComments([]);
        setCompareCurrentReviewedFiles([]);
        setCompareReviewError(messageFor(error));
      });
    return () => {
      cancelled = true;
    };
  }, [api, currentCompareReview]);

  const ensureCurrentCompareReview = useCallback(async () => {
    if (currentCompareReview) return currentCompareReview;
    if (!workspaceId || !activeComparison || !compareReviewContextKey) {
      return undefined;
    }
    if (
      openingCompareReviewRef.current?.contextKey === compareReviewContextKey
    ) {
      return openingCompareReviewRef.current.promise;
    }
    const requestContextKey = compareReviewContextKey;
    const next = api
      .openWorkspaceDiffReview(workspaceId, activeRootId, {
        comparisonId: activeComparison.comparisonId,
        fingerprint: activeComparison.fingerprint,
        mutationId: crypto.randomUUID(),
        title: workspaceDiffReviewTitle(activeComparison, compareFiles),
      })
      .then((review) => {
        if (compareReviewContextKeyRef.current !== requestContextKey) {
          return undefined;
        }
        setCompareReviews([review]);
        setCompareHistoryReviews((current) =>
          current.some((item) => item.id === review.id)
            ? current
            : [review, ...current],
        );
        setCompareRepositoryHistoryCount((current) => Math.max(current, 1));
        setActiveCompareReviewId(review.id);
        setCompareReviewError(undefined);
        return review;
      })
      .catch((error: unknown) => {
        if (compareReviewContextKeyRef.current !== requestContextKey) {
          return undefined;
        }
        throw error;
      })
      .finally(() => {
        if (
          openingCompareReviewRef.current?.contextKey === requestContextKey &&
          openingCompareReviewRef.current.promise === next
        ) {
          openingCompareReviewRef.current = undefined;
        }
      });
    openingCompareReviewRef.current = {
      contextKey: requestContextKey,
      promise: next,
    };
    return next;
  }, [
    activeComparison,
    activeRootId,
    api,
    compareFiles,
    compareReviewContextKey,
    currentCompareReview,
    workspaceId,
  ]);

  const compareAnnotations = useMemo(
    () =>
      deriveWorkspaceDiffReviewAnnotations(
        compareCurrentComments,
        compareFiles,
      ),
    [compareCurrentComments, compareFiles],
  );
  const compareCurrentAnnotationById = useMemo(
    () =>
      new Map(compareCurrentComments.map((comment) => [comment.id, comment])),
    [compareCurrentComments],
  );
  const compareReviewedFileIds = useMemo(
    () =>
      deriveWorkspaceDiffReviewedFileIds(
        compareCurrentReviewedFiles,
        compareFiles,
      ),
    [compareCurrentReviewedFiles, compareFiles],
  );
  const compareCurrentReviewedFileByPath = useMemo(
    () =>
      new Map(
        compareCurrentReviewedFiles.map(
          (file) => [file.filePath, file] as const,
        ),
      ),
    [compareCurrentReviewedFiles],
  );

  const openCompareCommentDraft = useCallback(
    (target: {
      readonly comparison: WorkspaceDiffComparisonDescriptor;
      readonly file: WorkspaceDiffChangedFileSummary;
      readonly range: {
        readonly start: number;
        readonly end: number;
        readonly side: "old" | "new";
      };
    }) => {
      setCompareCommentDraft({
        mode: "create",
        target,
        body: "",
        state: "published",
      });
      setCompareReviewError(undefined);
    },
    [],
  );

  const startCompareReview = useCallback(async () => {
    const requestContextKey = compareReviewContextKeyRef.current;
    setCompareReviewMutating(true);
    setCompareReviewError(undefined);
    try {
      await ensureCurrentCompareReview();
    } catch (error) {
      if (compareReviewContextKeyRef.current !== requestContextKey) return;
      setCompareReviewError(messageFor(error));
    } finally {
      if (compareReviewContextKeyRef.current === requestContextKey) setCompareReviewMutating(false);
    }
  }, [ensureCurrentCompareReview]);

  const saveCompareReviewDetails = useCallback(async () => {
    if (!activeCompareReview) return;
    const requestContextKey = compareReviewContextKeyRef.current;
    setCompareReviewMutating(true);
    setCompareReviewError(undefined);
    try {
      const review = await api.updateWorkspaceDiffReview(
        activeCompareReview.id,
        {
          title: compareReviewTitleDraft,
          summary: compareReviewSummaryDraft,
          state: compareReviewStateDraft,
          expectedRevision: activeCompareReview.revision,
          mutationId: crypto.randomUUID(),
        },
      );
      if (compareReviewContextKeyRef.current !== requestContextKey) return;
      setCompareReviews((current) =>
        current.map((item) => (item.id === review.id ? review : item)),
      );
      setCompareHistoryReviews((current) =>
        current.map((item) => (item.id === review.id ? review : item)),
      );
    } catch (error) {
      if (compareReviewContextKeyRef.current !== requestContextKey) return;
      setCompareReviewError(messageFor(error));
    } finally {
      if (compareReviewContextKeyRef.current === requestContextKey) setCompareReviewMutating(false);
    }
  }, [
    activeCompareReview,
    api,
    compareReviewStateDraft,
    compareReviewSummaryDraft,
    compareReviewTitleDraft,
  ]);

  const editCompareComment = useCallback(
    (comment: WorkspaceDiffReviewComment) => {
      setCompareCommentDraft({
        mode: "edit",
        reviewId: comment.reviewId,
        commentId: comment.id,
        body: comment.body,
        state: comment.state,
      });
      setCompareDetailsOpen(false);
      setCompareReviewError(undefined);
    },
    [],
  );

  const updateCompareCommentState = useCallback(
    async (
      comment: WorkspaceDiffReviewComment,
      state: WorkspaceDiffReviewCommentState,
    ) => {
      if (!activeCompareReview) return;
      const requestContextKey = compareReviewContextKeyRef.current;
      setCompareReviewMutating(true);
      setCompareReviewError(undefined);
      try {
        const result = await api.updateWorkspaceDiffReviewComment(
          activeCompareReview.id,
          comment.id,
          {
            body: comment.body,
            state,
            expectedReviewRevision: activeCompareReview.revision,
            expectedCommentRevision: comment.revision,
            mutationId: crypto.randomUUID(),
          },
        );
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareHistoryReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareComments((current) =>
          current.map((item) =>
            item.id === result.comment.id ? result.comment : item,
          ),
        );
        if (activeCompareReview.id === currentInlineReviewIdRef.current) {
          setCompareCurrentComments((current) =>
            current.map((item) =>
              item.id === result.comment.id ? result.comment : item,
            ),
          );
        }
      } catch (error) {
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviewError(messageFor(error));
      } finally {
        if (compareReviewContextKeyRef.current === requestContextKey) setCompareReviewMutating(false);
      }
    },
    [activeCompareReview, api, currentCompareReview],
  );

  const toggleCompareReviewState = useCallback(async () => {
    if (!activeCompareReview) return;
    const requestContextKey = compareReviewContextKeyRef.current;
    setCompareReviewMutating(true);
    setCompareReviewError(undefined);
    try {
      const review = await api.updateWorkspaceDiffReview(
        activeCompareReview.id,
        {
          title: activeCompareReview.title,
          summary: activeCompareReview.summary,
          state: activeCompareReview.state === "open" ? "archived" : "open",
          expectedRevision: activeCompareReview.revision,
          mutationId: crypto.randomUUID(),
        },
      );
      if (compareReviewContextKeyRef.current !== requestContextKey) return;
      setCompareReviews((current) =>
        current.map((item) => (item.id === review.id ? review : item)),
      );
      setCompareHistoryReviews((current) =>
        current.map((item) => (item.id === review.id ? review : item)),
      );
    } catch (error) {
      if (compareReviewContextKeyRef.current !== requestContextKey) return;
      setCompareReviewError(messageFor(error));
    } finally {
      if (compareReviewContextKeyRef.current === requestContextKey) setCompareReviewMutating(false);
    }
  }, [activeCompareReview, api]);

  const submitCompareComment = useCallback(async () => {
    const draft = compareCommentDraft;
    if (!draft || !workspaceId) return;
    const body = draft.body.trim();
    if (!body) {
      setCompareReviewError("Enter a comment before saving it.");
      return;
    }
    const requestContextKey = compareReviewContextKeyRef.current;
    setCompareCommentSaving(true);
    setCompareReviewError(undefined);
    try {
      if (draft.mode === "create") {
        if (draft.target.comparison.comparisonId !== activeComparison?.comparisonId ||
            draft.target.comparison.fingerprint !== activeComparison.fingerprint) {
          setCompareReviewError("This comparison changed. Copy your draft before selecting new lines.");
          return;
        }
        const review = await ensureCurrentCompareReview();
        if (!review || compareReviewContextKeyRef.current !== requestContextKey) return;
        const result = await api.createWorkspaceDiffReviewComment(
          workspaceId,
          activeRootId,
          review.id,
          {
            comparisonId: draft.target.comparison.comparisonId,
            fingerprint: draft.target.comparison.fingerprint,
            fileId: draft.target.file.fileId,
            side: draft.target.range.side,
            startLine: Math.min(
              draft.target.range.start,
              draft.target.range.end,
            ),
            endLine: Math.max(draft.target.range.start, draft.target.range.end),
            body,
            state: draft.state,
            expectedReviewRevision: review.revision,
            mutationId: crypto.randomUUID(),
          },
        );
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareHistoryReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareComments((current) => activeCompareReviewIdRef.current === review.id ? [...current, result.comment] : [result.comment]);
        if (review.id === currentInlineReviewIdRef.current) {
          setCompareCurrentComments((current) => [...current, result.comment]);
        }
        setActiveCompareReviewId(result.review.id);
      } else {
        const comment =
          compareComments.find(
            (candidate) => candidate.id === draft.commentId,
          ) ?? compareCurrentAnnotationById.get(draft.commentId);
        const review =
          activeCompareReview?.id === draft.reviewId
            ? activeCompareReview
            : compareReviewOptions.find(
                (candidate) => candidate.id === draft.reviewId,
              );
        if (!comment || !review) return;
        const result = await api.updateWorkspaceDiffReviewComment(
          review.id,
          comment.id,
          {
            body,
            state: draft.state,
            expectedReviewRevision: review.revision,
            expectedCommentRevision: comment.revision,
            mutationId: crypto.randomUUID(),
          },
        );
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareHistoryReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareComments((current) =>
          current.map((item) =>
            item.id === result.comment.id ? result.comment : item,
          ),
        );
        if (review.id === currentInlineReviewIdRef.current) {
          setCompareCurrentComments((current) =>
            current.map((item) =>
              item.id === result.comment.id ? result.comment : item,
            ),
          );
        }
      }
      setCompareCommentDraft((current) => current === draft ? undefined : current);
    } catch (error) {
      if (compareReviewContextKeyRef.current !== requestContextKey) return;
      setCompareReviewError(messageFor(error));
    } finally {
      if (compareReviewContextKeyRef.current === requestContextKey) setCompareCommentSaving(false);
    }
  }, [
    activeComparison,
    activeCompareReview,
    activeRootId,
    api,
    compareComments,
    compareCommentDraft,
    compareCurrentAnnotationById,
    compareReviewOptions,
    currentCompareReview,
    ensureCurrentCompareReview,
    workspaceId,
  ]);

  const deleteCompareAnnotation = useCallback(
    async (annotation: WorkspaceCompareReviewAnnotation) => {
      const comment = compareCurrentAnnotationById.get(annotation.annotationId);
      if (!comment || !currentCompareReview) return;
      const requestContextKey = compareReviewContextKeyRef.current;
      setCompareReviewMutating(true);
      setCompareReviewError(undefined);
      try {
        const result = await api.deleteWorkspaceDiffReviewComment(
          currentCompareReview.id,
          comment.id,
          {
            expectedReviewRevision: currentCompareReview.revision,
            expectedCommentRevision: comment.revision,
            mutationId: crypto.randomUUID(),
          },
        );
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareHistoryReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareComments((current) =>
          activeCompareReviewIdRef.current === currentCompareReview.id
            ? current.filter((item) => item.id !== comment.id)
            : current,
        );
        setCompareCurrentComments((current) =>
          current.filter((item) => item.id !== comment.id),
        );
      } catch (error) {
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviewError(messageFor(error));
      } finally {
        if (compareReviewContextKeyRef.current === requestContextKey) setCompareReviewMutating(false);
      }
    },
    [api, compareCurrentAnnotationById, currentCompareReview],
  );

  const deleteCompareComment = useCallback(
    async (
      review: WorkspaceDiffReview,
      comment: WorkspaceDiffReviewComment,
    ) => {
      const requestContextKey = compareReviewContextKeyRef.current;
      setCompareReviewMutating(true);
      setCompareReviewError(undefined);
      try {
        const result = await api.deleteWorkspaceDiffReviewComment(
          review.id,
          comment.id,
          {
            expectedReviewRevision: review.revision,
            expectedCommentRevision: comment.revision,
            mutationId: crypto.randomUUID(),
          },
        );
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareHistoryReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareComments((current) =>
          activeCompareReviewIdRef.current === review.id
            ? current.filter((item) => item.id !== comment.id)
            : current,
        );
        if (currentCompareReview?.id === review.id) {
          setCompareCurrentComments((current) =>
            current.filter((item) => item.id !== comment.id),
          );
        }
      } catch (error) {
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviewError(messageFor(error));
      } finally {
        if (compareReviewContextKeyRef.current === requestContextKey) setCompareReviewMutating(false);
      }
    },
    [api, currentCompareReview],
  );

  const setCompareReviewed = useCallback(
    async (fileId: WorkspaceDiffFileId, reviewed: boolean) => {
      if (!workspaceId || !activeComparison) return;
      const file = compareFiles.find(
        (candidate) => candidate.fileId === fileId,
      );
      if (!file) return;
      const requestContextKey = compareReviewContextKeyRef.current;
      setCompareReviewMutating(true);
      setCompareReviewError(undefined);
      try {
        const review = await ensureCurrentCompareReview();
        if (!review || compareReviewContextKeyRef.current !== requestContextKey) return;
        const filePath = file.newPath ?? file.oldPath;
        if (!filePath) {
          setCompareReviewError("That changed file cannot be marked reviewed.");
          return;
        }
        const result = await api.setWorkspaceDiffReviewedFile(
          workspaceId,
          activeRootId,
          review.id,
          {
            comparisonId: activeComparison.comparisonId,
            fingerprint: activeComparison.fingerprint,
            fileId,
            reviewed,
            expectedReviewRevision: review.revision,
            expectedFileRevision:
              compareCurrentReviewedFileByPath.get(filePath)?.revision ?? null,
            mutationId: crypto.randomUUID(),
          },
        );
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareHistoryReviews((current) =>
          current.map((item) =>
            item.id === result.review.id ? result.review : item,
          ),
        );
        setCompareReviewedFiles((current) => {
          if (activeCompareReviewIdRef.current !== review.id) return current;
          const next = current.filter(
            (item) => item.fileIdentity !== result.file.fileIdentity,
          );
          return [...next, result.file];
        });
        if (review.id === currentInlineReviewIdRef.current) {
          setCompareCurrentReviewedFiles((current) => {
            const next = current.filter(
              (item) => item.fileIdentity !== result.file.fileIdentity,
            );
            return [...next, result.file];
          });
        }
      } catch (error) {
        if (compareReviewContextKeyRef.current !== requestContextKey) return;
        setCompareReviewError(messageFor(error));
      } finally {
        if (compareReviewContextKeyRef.current === requestContextKey) setCompareReviewMutating(false);
      }
    },
    [
      activeComparison,
      activeRootId,
      api,
      compareFiles,
      compareCurrentReviewedFileByPath,
      currentCompareReview,
      ensureCurrentCompareReview,
      workspaceId,
    ],
  );

  const selectMode = useCallback((next: WorkspaceFilesMode) => {
    const previous = workspaceCompareStorage.get(navigationScope, workspaceId, activeRootId);
    workspaceCompareStorage.set(navigationScope, workspaceId, activeRootId, { ...previous, mode: next });
    setMode(next);
    if (next === "compare") {
      setCompareOpened(true);
      return;
    }
    if (tabsRef.current.files.length === 0) setTreeOpen(true);
  }, [navigationScope, workspaceId, activeRootId]);

  useEffect(() => {
    const saved = workspaceCompareStorage.get(navigationScope, workspaceId, activeRootId);
    if (!fileOpenIntentRef.current && saved?.mode === "compare") {
      setMode("compare");
      setCompareOpened(true);
    }
  }, [navigationScope, workspaceId, activeRootId]);
  const navigationPendingRef = useRef<{ scope: string | undefined; workspaceId: string | undefined; rootId: string; navigation: WorkspaceCompareNavigation } | undefined>(undefined);
  const navigationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const flushCompareNavigation = useCallback(() => {
    clearTimeout(navigationTimerRef.current);
    const pending = navigationPendingRef.current;
    if (!pending) return;
    navigationPendingRef.current = undefined;
    const previous = workspaceCompareStorage.get(pending.scope, pending.workspaceId, pending.rootId);
    workspaceCompareStorage.set(pending.scope, pending.workspaceId, pending.rootId, { ...previous, mode: previous?.mode ?? "compare", navigation: pending.navigation });
  }, []);
  useEffect(() => {
    const hide = () => { if (document.visibilityState === "hidden") flushCompareNavigation(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", flushCompareNavigation);
    return () => {
      flushCompareNavigation();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", flushCompareNavigation);
    };
  }, [flushCompareNavigation, navigationScope, workspaceId, activeRootId]);
  useEffect(() => { flushCompareNavigation(); }, [mode, context.visible, flushCompareNavigation]);
  const saveCompareNavigation = useCallback((navigation: WorkspaceCompareNavigation) => {
    // Flush the old scope before replacing a pending record.
    const pending = navigationPendingRef.current;
    if (pending && (pending.workspaceId !== workspaceId || pending.rootId !== activeRootId || pending.scope !== navigationScope)) flushCompareNavigation();
    navigationPendingRef.current = { scope: navigationScope, workspaceId, rootId: activeRootId, navigation };
    clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = setTimeout(flushCompareNavigation, 200);
  }, [navigationScope, workspaceId, activeRootId, flushCompareNavigation]);

  const focusTab = (index: number) => {
    const files = tabsRef.current.files;
    if (files.length === 0) return;
    const normalized = (index + files.length) % files.length;
    const next = files[normalized];
    if (!next) return;
    openTab(next);
    requestAnimationFrame(() => {
      const nodes = tabListRef.current?.querySelectorAll('[role="tab"]');
      const target = nodes?.[normalized];
      if (target instanceof HTMLElement) target.focus();
    });
  };

  const focusRootTab = (index: number) => {
    if (visibleRootTabs.length === 0) return;
    const normalized =
      (index + visibleRootTabs.length) % visibleRootTabs.length;
    const next = visibleRootTabs[normalized];
    if (!next) return;
    activateRoot(next.rootId);
    requestAnimationFrame(() => {
      const nodes = rootTabListRef.current?.querySelectorAll('[role="tab"]');
      const target = nodes?.[normalized];
      if (target instanceof HTMLElement) target.focus();
    });
  };

  const handleSeekHandled = useCallback((sequence: number) => {
    setPendingSeek((current) =>
      current?.sequence === sequence ? undefined : current,
    );
  }, []);

  if (!workspaceId)
    return (
      <PanelMessage
        icon={<AlertCircle size={18} />}
        text="No workspace is available."
      />
    );

  const activeEntry = activeKey ? openFiles.get(activeKey) : undefined;
  const activeFile = activeEntry?.file;
  const activeImageView =
    activeKey &&
    activeFile?.availability === "available" &&
    activeFile.contentKind === "image" &&
    activeFile.previewState === "available"
      ? imageViewsRef.current.get(activeKey)
      : undefined;
  const activeDocument = activeKey ? documents.get(activeKey) : undefined;
  const activeSeek =
    pendingSeek &&
    sameWorkspaceFileAddress(pendingSeek.address, activeFileAddress)
      ? {
          sequence: pendingSeek.sequence,
          lineNumber: pendingSeek.lineNumber,
        }
      : undefined;
  const activeDirty = workspaceFileDocumentIsDirty(activeDocument);
  const activeDownloadTarget: WorkspaceFileDownloadTarget | undefined =
    activeFile?.availability === "available"
      ? {
          rootId: activeFile.rootId,
          path: activeFile.path,
          revision:
            activeFile.contentKind === "text" && activeDocument
              ? activeDocument.revision
              : activeFile.revision,
        }
      : undefined;
  const activeDownloadKey = activeDownloadTarget
    ? workspaceFileDocumentKey(activeDownloadTarget)
    : undefined;
  const activeDownloadState =
    downloadState && downloadState.key === activeDownloadKey
      ? downloadState
      : undefined;
  const activeDownloadPhase = activeDownloadState?.phase ?? "idle";
  const activeDownloadBusy = activeDownloadPhase !== "idle";
  const activeDownloadError = activeDownloadState?.error;
  const activeDownloadAction = activeDownloadTarget ? (
    <Button
      aria-busy={activeDownloadBusy || undefined}
      aria-label={
        activeDownloadPhase === "preparing"
          ? `Preparing download for saved file ${activeDownloadTarget.path}`
          : activeDownloadPhase === "started"
            ? `Downloading saved file ${activeDownloadTarget.path}`
            : `Download saved file ${activeDownloadTarget.path}`
      }
      disabled={activeDocument?.saveState === "saving" || activeDownloadBusy}
      onClick={() => requestDownload(activeDownloadTarget, activeDocument)}
      size="icon-sm"
      title={
        activeDownloadPhase === "preparing"
          ? "Preparing download…"
          : activeDownloadPhase === "started"
            ? "Downloading saved file…"
            : "Download saved file"
      }
      variant="ghost"
    >
      {activeDownloadBusy ? (
        <LoaderCircle className="animate-spin" aria-hidden="true" />
      ) : (
        <Download aria-hidden="true" />
      )}
    </Button>
  ) : null;
  const showFileSurface = tabs.files.length > 0 || awaitingUiRestore;
  const fileTabPanelVisible = showFileSurface;
  const loading =
    rootsLoading ||
    [...filesByRoot.values()].some((listing) => listing.loading);
  const refreshLoading = loading || refreshingFileKey !== undefined;
  const activePath = activeFileAddress?.path;
  const selectedRoot =
    roots.find((root) => root.rootId === activeRootId) ?? roots[0];
  const selectedListing = selectedRoot
    ? (filesByRoot.get(selectedRoot.rootId) ?? EMPTY_FILE_LIST)
    : EMPTY_FILE_LIST;
  const compareReviewedCount = compareCurrentReviewedFiles.filter(
    (file) => file.reviewed,
  ).length;
  const compareCommentCount = compareCurrentComments.length;
  const showReviewInspector = (view: "current" | "history") => {
    setReviewInspectorMode(view);
    setActiveCompareReviewId(view === "current" ? currentCompareReview?.id :
      (compareHistoryReviews.find((review) => review.id === activeCompareReviewId && review.id !== currentCompareReview?.id)?.id ?? compareHistoryReviews.find((review) => review.id !== currentCompareReview?.id)?.id));
    setCompareDetailsOpen(true);
  };
  const compareReviewControls = (
    <Popover open={reviewMenuOpen} onOpenChange={setReviewMenuOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="workspace-compare-toolbar-button"
          aria-label="Review controls"
          disabled={!activeComparison}
        >
          Review
          {currentCompareReview && (
            <span
              className="workspace-compare-review-badge"
              title={`${compareReviewedCount} of ${compareFiles.length} files reviewed`}
            >
              {compareReviewedCount}/{compareFiles.length}
            </span>
          )}
          <ChevronDown aria-hidden="true" size={13} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="workspace-files-review-menu"
        aria-label="Review options"
      >
        {currentCompareReview ? (
          <p>{compareReviewedCount} of {compareFiles.length} reviewed</p>
        ) : (
          <p>Start a review to save comments and reviewed files.</p>
        )}
        {!currentCompareReview && (
          <Button
            variant="ghost"
            size="sm"
            disabled={!activeComparison || compareReviewLoading || compareReviewMutating || compareCommentSaving}
            onClick={() => {
              setReviewMenuOpen(false);
              void startCompareReview();
            }}
          >
            Start review
          </Button>
        )}
        {currentCompareReview && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setReviewMenuOpen(false);
              showReviewInspector("current");
            }}
          >
            Comments ({compareCommentCount})
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={compareRepositoryHistoryCount === 0}
          onClick={() => {
            setReviewMenuOpen(false);
            showReviewInspector("history");
          }}
        >
          History
        </Button>
      </PopoverContent>
    </Popover>
  );
  const activeCompareRefresh = compareRefreshControl?.scope === compareRefreshScope
    ? compareRefreshControl : undefined;
  const refreshDisabled = mode === "compare"
    ? !activeCompareRefresh || activeCompareRefresh.disabled : refreshLoading;
  const refreshLabel = mode === "compare" ? "Refresh comparison" : "Refresh workspace files";

  return (
    <section
      className="workspace-files-panel"
      aria-label="Workspace files"
      onWheel={(event) => event.stopPropagation()}
      onTouchMove={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === "Escape" && treeOpen) {
          event.preventDefault();
          setTreeOpen(false);
          treeToggleRef.current?.focus();
          return;
        }
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          if (!activeDocument) return;
          event.preventDefault();
          if (activeDirty && activeDocument.saveState !== "saving") save();
        }
      }}
    >
      {!rootsLoading && !rootsError && savedRootRequestRef.current.rootId &&
        !roots.some(root => root.rootId === savedRootRequestRef.current.rootId) &&
        dismissedRootRecovery !== savedRootScopeKey && (
          <div className="workspace-compare-restore-notice" role="status">
            <span>The previously selected Files root is unavailable. Choose an available root.</span>
            <button type="button" aria-label="Dismiss root recovery notice" onClick={() => setDismissedRootRecovery(savedRootScopeKey)}><X size={14} /></button>
          </div>
        )}
      {createPortal(
        <div className="workspace-files-toolbar-actions">
          <div
            className="workspace-files-mode-switcher"
            role="tablist"
            aria-label="Files view"
          >
            <button
              type="button"
              role="tab"
              aria-selected={mode === "browse"}
              className={mode === "browse" ? "is-active" : undefined}
              onClick={() => selectMode("browse")}
            >
              Browse
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "compare"}
              className={mode === "compare" ? "is-active" : undefined}
              onClick={() => selectMode("compare")}
            >
              Changes
            </button>
          </div>
          <Button
            ref={treeToggleRef}
            variant={treeOpen ? "secondary" : "ghost"}
            size="icon-sm"
            aria-label="Toggle file browser"
            title="Toggle file browser"
            aria-expanded={treeOpen}
            onClick={() => setTreeOpen((open) => !open)}
          >
            <FolderTree size={15} />
          </Button>
          <Button
            ref={addFolderRef}
            variant="ghost"
            size="icon-sm"
            aria-label="Add folder to Files"
            title="Add folder to Files"
            onClick={() => {
              setAttachError(undefined);
              setAttachDialogOpen(true);
            }}
          >
            <FolderPlus size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={refreshLabel}
            title={refreshLabel}
            onClick={mode === "compare" ? activeCompareRefresh?.refresh : refreshWorkspaceFiles}
            disabled={refreshDisabled}
          >
            <RefreshCw
              size={15}
              className={mode === "browse" && refreshLoading ? "workspace-files-spin" : undefined}
            />
          </Button>
        </div>,
        context.chromeActionsTarget,
      )}
      {tabs.files.length > 0 && (
        <div
          ref={tabListRef}
          className="workspace-files-tabs"
          role="tablist"
          aria-label="Open files"
          hidden={mode !== "browse"}
          onKeyDown={(event) => {
            if (
              !(event.target instanceof HTMLElement) ||
              event.target.getAttribute("role") !== "tab"
            )
              return;
            const index = tabs.files.findIndex((file) =>
              sameWorkspaceFileAddress(file, activeFileAddress),
            );
            if (event.key === "ArrowLeft") {
              event.preventDefault();
              focusTab(index - 1);
            } else if (event.key === "ArrowRight") {
              event.preventDefault();
              focusTab(index + 1);
            } else if (event.key === "Home") {
              event.preventDefault();
              focusTab(0);
            } else if (event.key === "End") {
              event.preventDefault();
              focusTab(tabs.files.length - 1);
            }
          }}
        >
          {tabs.files.map((file) => {
            const key = workspaceFileDocumentKey(file);
            const active = sameWorkspaceFileAddress(file, activeFileAddress);
            const dirty = workspaceFileDocumentIsDirty(documents.get(key));
            const root = roots.find(
              (candidate) => candidate.rootId === file.rootId,
            );
            const title = tabTitle(
              file,
              root,
              linkOnlyRootIdsRef.current.has(file.rootId),
            );
            return (
              <div
                key={key}
                role="tab"
                id={`${fileTabPanelId}-tab-${tabs.files.indexOf(file)}`}
                aria-controls={fileTabPanelVisible ? fileTabPanelId : undefined}
                aria-selected={active}
                data-workspace-file-key={key}
                tabIndex={active ? 0 : -1}
                className={
                  active
                    ? "workspace-files-tab workspace-files-tab-active"
                    : "workspace-files-tab"
                }
                title={title}
                onClick={() => openTab(file)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openTab(file);
                  }
                }}
              >
                <span className="workspace-files-tab-label">
                  {fileDisplayName(file.path)}
                </span>
                {dirty && (
                  <span
                    className="workspace-files-tab-dirty"
                    role="img"
                    aria-label="Unsaved changes"
                  />
                )}
                <button
                  type="button"
                  className="workspace-files-tab-close"
                  aria-label={`Close ${title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    closeTab(file);
                  }}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div ref={filesBodyRef} className="workspace-files-body">
        <aside
          ref={treePanelRef}
          className={
            treeOpen
              ? "workspace-files-tree workspace-files-tree-open"
              : "workspace-files-tree"
          }
          aria-label="File browser"
        >
          {rootsError && roots.length === 0 ? (
            <PanelMessage icon={<AlertCircle size={18} />} text={rootsError} />
          ) : selectedRoot ? (
            <>
              <div className="workspace-files-root-switcher">
                <div
                  ref={rootTabListRef}
                  className="workspace-files-root-tabs"
                  role="tablist"
                  aria-label="File roots"
                  onKeyDown={(event) => {
                    if (
                      !(event.target instanceof HTMLElement) ||
                      event.target.getAttribute("role") !== "tab"
                    )
                      return;
                    const index = visibleRootTabs.findIndex(
                      (root) => root.rootId === selectedRoot.rootId,
                    );
                    if (event.key === "ArrowLeft") {
                      event.preventDefault();
                      focusRootTab(index - 1);
                    } else if (event.key === "ArrowRight") {
                      event.preventDefault();
                      focusRootTab(index + 1);
                    } else if (event.key === "Home") {
                      event.preventDefault();
                      focusRootTab(0);
                    } else if (event.key === "End") {
                      event.preventDefault();
                      focusRootTab(visibleRootTabs.length - 1);
                    }
                  }}
                >
                  {visibleRootTabs.map((root, rootIndex) => {
                    const active = root.rootId === selectedRoot.rootId;
                    return (
                      <button
                        type="button"
                        role="tab"
                        id={`${rootTabPanelId}-tab-${rootIndex}`}
                        aria-controls={rootTabPanelId}
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        className={
                          active
                            ? "workspace-files-root-tab workspace-files-root-tab-active"
                            : "workspace-files-root-tab"
                        }
                        title={root.displayLabel}
                        key={root.rootId}
                        onClick={() => activateRoot(root.rootId)}
                      >
                        {root.availability === "unavailable" && (
                          <AlertCircle size={12} aria-hidden="true" />
                        )}
                        <span>{root.displayLabel}</span>
                        {root.availability === "unavailable" && (
                          <span className="sr-only"> (unavailable)</span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {selectedRoot.kind === "supplemental" && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove folder ${selectedRoot.displayLabel}`}
                    onClick={() => requestRemoveRoot(selectedRoot)}
                  >
                    <Trash2 size={13} />
                  </Button>
                )}
              </div>
              <section
                className="workspace-files-root"
                key={selectedRoot.rootId}
                role="tabpanel"
                id={rootTabPanelId}
                aria-labelledby={`${rootTabPanelId}-tab-${visibleRootTabs.indexOf(
                  selectedRoot,
                )}`}
              >
                {selectedRoot.availability === "unavailable" ? (
                  <PanelMessage
                    icon={<AlertCircle size={16} />}
                    text={diagnosticFor(selectedRoot.diagnosticCode)}
                  />
                ) : selectedListing.error && !selectedListing.loaded ? (
                  <PanelMessage
                    icon={<AlertCircle size={16} />}
                    text={selectedListing.error}
                  />
                ) : (
                  <RootFileTree
                    key={`${selectedRoot.rootId}:${selectedListing.fullTreeLoaded}`}
                    rootId={selectedRoot.rootId}
                    paths={selectedListing.paths}
                    searchEnabled={selectedListing.fullTreeLoaded}
                    initialExpandedPaths={
                      expandedPathsByRootRef.current[selectedRoot.rootId] ?? []
                    }
                    onOpen={(address) => {
                      selectMode("browse");
                      openTab(address, { hideTree: true });
                    }}
                    onExpand={(directory) =>
                      void loadDirectory(selectedRoot.rootId, directory)
                    }
                    register={registerTreeController}
                  />
                )}
                <div className="workspace-files-tree-load-all">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={
                      selectedListing.fullTreeLoaded && !selectedListing.loading
                    }
                    onClick={() => void loadFullTree(selectedRoot.rootId)}
                  >
                    {fullTreeControllersRef.current.has(selectedRoot.rootId)
                      ? "Cancel full scan"
                      : selectedListing.fullTreeLoaded
                        ? selectedListing.scanTruncated
                          ? "Partial tree loaded"
                          : "Full tree loaded"
                        : "Load full tree to search"}
                  </Button>
                  {selectedListing.scanTruncated && (
                    <p className="workspace-files-tree-truncation">
                      Full scan reached its path limit; some files aren&apos;t
                      shown.
                    </p>
                  )}
                </div>
                {selectedListing.error && selectedListing.loaded && (
                  <p className="workspace-files-save-error" role="alert">
                    {selectedListing.error}
                  </p>
                )}
              </section>
            </>
          ) : null}
          {rootsError && roots.length > 0 && (
            <p className="workspace-files-save-error" role="alert">
              {rootsError}
            </p>
          )}
        </aside>
        {fileTabPanelVisible && (
          <main
            className="workspace-files-viewer"
            role="tabpanel"
            id={fileTabPanelId}
            hidden={mode !== "browse"}
            aria-labelledby={
              activeFileAddress
                ? `${fileTabPanelId}-tab-${tabs.files.findIndex((file) =>
                    sameWorkspaceFileAddress(file, activeFileAddress),
                  )}`
                : undefined
            }
          >
            {!activeFileAddress || !activeEntry || activeEntry.loading ? (
              <PanelMessage
                text={`Loading ${activePath ?? restorePathHint ?? "file"}…`}
              />
            ) : activeEntry.error ? (
              <PanelMessage
                icon={<AlertCircle size={18} />}
                text={activeEntry.error}
              />
            ) : activeFile?.availability === "unavailable" ? (
              <PanelMessage text="File viewing is unavailable for this folder." />
            ) : activeFile?.availability === "available" &&
              activeFile.contentKind === "binary" ? (
              <div className="workspace-files-editor-shell">
                <header className="workspace-files-editor-toolbar">
                  <span title={activeFile.path}>{activeFile.path}</span>
                  <div>{activeDownloadAction}</div>
                </header>
                {activeDownloadError && (
                  <p className="workspace-files-save-error" role="alert">
                    {activeDownloadError}
                  </p>
                )}
                <div className="workspace-files-editor-surface">
                  <PanelMessage text="Binary files cannot be displayed." />
                </div>
              </div>
            ) : activeFile?.availability === "available" &&
              activeFile.contentKind === "image" ? (
              activeFile.previewState === "available" ? (
                <div className="workspace-files-download-preview-shell">
                  {activeDownloadError && (
                    <p className="workspace-files-save-error" role="alert">
                      {activeDownloadError}
                    </p>
                  )}
                  <WorkspaceImagePreview
                    key={`${activeFile.rootId}:${activeFile.path}:${activeFile.revision}`}
                    initialViewState={
                      activeImageView?.revision === activeFile.revision
                        ? activeImageView.state
                        : undefined
                    }
                    onViewStateChange={(state) => {
                      if (!activeKey) return;
                      imageViewsRef.current.set(activeKey, {
                        revision: activeFile.revision,
                        state,
                      });
                    }}
                    path={activeFile.path}
                    source={`data:${activeFile.mediaType};${activeFile.contentEncoding},${activeFile.content}`}
                    toolbarActions={activeDownloadAction}
                  />
                </div>
              ) : (
                <div className="workspace-files-editor-shell">
                  <header className="workspace-files-editor-toolbar">
                    <span title={activeFile.path}>{activeFile.path}</span>
                    <div>{activeDownloadAction}</div>
                  </header>
                  {activeDownloadError && (
                    <p className="workspace-files-save-error" role="alert">
                      {activeDownloadError}
                    </p>
                  )}
                  <div className="workspace-files-image-preview">
                    <PanelMessage
                      text={`Image is larger than the preview limit (${WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES / (1_024 * 1_024)} MiB).`}
                    />
                  </div>
                </div>
              )
            ) : activeFile?.availability === "available" && activeDocument ? (
              <div className="workspace-files-editor-shell">
                <header className="workspace-files-editor-toolbar">
                  <span title={activeDocument.path}>{activeDocument.path}</span>
                  <div>
                    {activeDownloadAction}
                    <Button
                      variant={activeDocument.editing ? "secondary" : "ghost"}
                      size="icon-sm"
                      aria-label={activeDocument.editing ? "Done" : "Edit"}
                      title={
                        activeDocument.editing ? "Finish editing" : "Edit file"
                      }
                      disabled={
                        !activeDocument.editable || activeDocument.truncated
                      }
                      onClick={() =>
                        dispatchDocuments({
                          type: "set_editing",
                          rootId: activeDocument.rootId,
                          path: activeDocument.path,
                          editing: !activeDocument.editing,
                        })
                      }
                    >
                      {activeDocument.editing ? (
                        <Check aria-hidden="true" />
                      ) : (
                        <FilePenLine aria-hidden="true" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-busy={
                        activeDocument.saveState === "saving" || undefined
                      }
                      aria-label="Save"
                      title={
                        activeDocument.saveState === "saving"
                          ? "Saving file…"
                          : "Save file"
                      }
                      disabled={
                        !activeDirty || activeDocument.saveState === "saving"
                      }
                      onClick={save}
                    >
                      {activeDocument.saveState === "saving" ? (
                        <LoaderCircle
                          className="animate-spin"
                          aria-hidden="true"
                        />
                      ) : (
                        <Save aria-hidden="true" />
                      )}
                    </Button>
                  </div>
                </header>
                {activeFile.truncation && (
                  <p className="workspace-files-boundary-note workspace-files-content-note">
                    Showing the first{" "}
                    {activeFile.truncation.retainedBytes.toLocaleString()}{" "}
                    bytes.
                  </p>
                )}
                {activeDownloadError && (
                  <p className="workspace-files-save-error" role="alert">
                    {activeDownloadError}
                  </p>
                )}
                {activeDocument.saveState === "error" &&
                  activeDocument.saveError && (
                    <p className="workspace-files-save-error" role="alert">
                      {activeDocument.saveError}
                    </p>
                  )}
                {activeDocument.saveState === "conflict" &&
                  !conflictDialogOpen && (
                    <button
                      type="button"
                      className="workspace-files-conflict-callout"
                      onClick={() => setConflictDialogOpen(true)}
                    >
                      File changed on disk. Resolve conflict.
                    </button>
                  )}
                <div className="workspace-files-editor-surface">
                  {isMarkdownPath(activeDocument.path) &&
                  !activeDocument.editing ? (
                    <MarkdownSelectionSurface
                      stagingTarget={context.contextExcerpts}
                      markdown={activeDocument.content}
                      onSeekHandled={handleSeekHandled}
                      seek={activeSeek}
                      source={{
                        kind: "workspace_file",
                        rootId: activeDocument.rootId,
                        path: activeDocument.path,
                        revision: activeDocument.revision,
                      }}
                      visible={context.visible}
                      truncated={activeDocument.truncated}
                      workspaceId={workspaceId}
                    />
                  ) : (
                    renderFile({
                      path: activeDocument.path,
                      content: activeDocument.content,
                      revision: activeDocument.revision,
                      editing: activeDocument.editing,
                      truncated: activeDocument.truncated,
                      seek: activeSeek,
                      onSeekHandled: handleSeekHandled,
                      ...(context.contextExcerpts &&
                      context.contextExcerpts.workspaceId === workspaceId
                        ? {
                            stagingTarget: context.contextExcerpts,
                            onAttachSelection: (selection, sendImmediately) => {
                              const candidate = contextExcerptSchema.safeParse({
                                id: globalThis.crypto.randomUUID(),
                                excerpt: selection.excerpt,
                                ...(selection.note
                                  ? { note: selection.note }
                                  : {}),
                                source: {
                                  kind: "workspace_file",
                                  rootId: activeDocument.rootId,
                                  path: activeDocument.path,
                                  revision: activeDocument.revision,
                                },
                                locator: {
                                  kind: "line_range",
                                  startLine: selection.startLine,
                                  endLine: selection.endLine,
                                },
                              });
                              if (!candidate.success) {
                                return {
                                  ok: false as const,
                                  reason:
                                    candidate.error.issues[0]?.message ??
                                    "That line selection cannot be attached.",
                                };
                              }
                              return sendImmediately
                                ? context.contextExcerpts!.attachAndSubmit(
                                    candidate.data,
                                  )
                                : context.contextExcerpts!.stage(
                                    candidate.data,
                                  );
                            },
                          }
                        : {}),
                      onChange: (content) =>
                        dispatchDocuments({
                          type: "changed",
                          rootId: activeDocument.rootId,
                          path: activeDocument.path,
                          content,
                        }),
                    })
                  )}
                </div>
              </div>
            ) : (
              <PanelMessage text={`Loading ${activePath ?? "file"}…`} />
            )}
          </main>
        )}
        {compareOpened && compareDataSource && (
          <div
            className="workspace-files-compare-surface"
            hidden={mode !== "compare"}
          >
            {anyDirty && (
              <p className="workspace-files-compare-dirty-note" role="note">
                Unsaved Browse drafts are excluded from this comparison.
              </p>
            )}
            {compareReviewError && (
              <p className="workspace-files-save-error" role="alert">
                {compareReviewError}
              </p>
            )}
            <WorkspaceCompareView
              key={JSON.stringify([navigationScope, workspaceId, activeRootId])}
              initialNavigation={workspaceCompareStorage.get(navigationScope, workspaceId, activeRootId)?.navigation}
              onNavigationChange={saveCompareNavigation}
              stagingTarget={context.contextExcerpts}
              rootId={activeRootId}
              onOpenFile={(path) => {
                openTab({ rootId: activeRootId, path }, { hideTree: true });
                selectMode("browse");
              }}
              dataSource={compareDataSource}
              visible={context.visible && mode === "compare"}
              reviewControls={compareReviewControls}
              onRefreshControlChange={registerCompareRefresh}
              annotations={compareAnnotations}
              reviewedFileIds={compareReviewedFileIds}
              onCreateAnnotation={(target) => {
                const range = normalizeWorkspaceDiffReviewRange(target.range);
                if (!range) {
                  setCompareReviewError(
                    "Select displayed lines from one diff side to leave a comment.",
                  );
                  return;
                }
                openCompareCommentDraft({
                  comparison: target.comparison,
                  file: target.file,
                  range,
                });
              }}
              onDeleteAnnotation={(annotation) =>
                void deleteCompareAnnotation(annotation)
              }
              onReviewedChange={(fileId, reviewed) =>
                void setCompareReviewed(fileId, reviewed)
              }
              onSelectAnnotation={(annotation) => {
                const comment = compareCurrentAnnotationById.get(
                  annotation.annotationId,
                );
                if (!comment) return;
                if (
                  currentCompareReview &&
                  activeCompareReview?.id !== currentCompareReview.id
                ) {
                  setCompareComments(compareCurrentComments);
                  setCompareReviewedFiles(compareCurrentReviewedFiles);
                  setActiveCompareReviewId(currentCompareReview.id);
                }
                editCompareComment(comment);
              }}
              onComparisonChange={(comparison) => {
                setCompareReviews([]);
                setCompareCurrentComments([]);
                setCompareCurrentReviewedFiles([]);
                setActiveComparison(comparison);
              }}
              onFilesChange={setCompareFiles}
              onAttachSelection={attachCompareSelection}
            />
          </div>
        )}
      </div>

      <Dialog
        open={context.visible && (compareCommentDraft !== undefined)}
        onOpenChange={(open) => {
          if (!compareCommentSaving && !open) setCompareCommentDraft(undefined);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {compareCommentDraft?.mode === "edit"
                ? "Edit review comment"
                : "Add review comment"}
            </DialogTitle>
            <DialogDescription>
              {compareCommentDraft?.mode === "edit"
                ? "Update the saved review comment state or body."
                : "This comment stays attached to the current comparison review."}
            </DialogDescription>
          </DialogHeader>
          <label className="workspace-files-compare-comment-field">
            Comment
            <Textarea
              aria-label="Workspace diff review comment"
              disabled={compareCommentSaving}
              value={compareCommentDraft?.body ?? ""}
              onChange={(event) =>
                setCompareCommentDraft((current) =>
                  current ? { ...current, body: event.target.value } : current,
                )
              }
              rows={5}
            />
          </label>
          <label className="workspace-files-compare-comment-field">
            State
            <select
              aria-label="Workspace diff review comment state"
              disabled={compareCommentSaving}
              value={compareCommentDraft?.state ?? "published"}
              onChange={(event) =>
                setCompareCommentDraft((current) =>
                  current?.mode === "edit"
                    ? {
                        ...current,
                        state: event.target
                          .value as WorkspaceDiffReviewCommentState,
                      }
                    : current?.mode === "create"
                      ? {
                          ...current,
                          state: event.target.value as "draft" | "published",
                        }
                      : current,
                )
              }
            >
              {compareCommentDraft?.mode === "edit" ? (
                <>
                  <option value="draft">Draft</option>
                  <option value="published">Published</option>
                  <option value="resolved">Resolved</option>
                  <option value="outdated">Outdated</option>
                  <option value="unplaced">Unplaced</option>
                </>
              ) : (
                <>
                  <option value="published">Published</option>
                  <option value="draft">Draft</option>
                </>
              )}
            </select>
          </label>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={compareCommentSaving}
              onClick={() => setCompareCommentDraft(undefined)}
            >
              Cancel
            </Button>
            <Button
              disabled={compareCommentSaving}
              onClick={() => void submitCompareComment()}
            >
              Save comment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={context.visible && (compareDetailsOpen)}
        onOpenChange={(open) => {
          if (!compareReviewMutating) setCompareDetailsOpen(open);
        }}
      >
        <DialogContent
          showCloseButton={false}
          placement="side"
          className="workspace-files-compare-details-dialog"
        >
          <DialogHeader>
            <DialogTitle>
              Review
            </DialogTitle>
            <DialogDescription>
              Edit review details, inspect repository history state, and manage
              saved comments.
            </DialogDescription>
          </DialogHeader>
          <div className="workspace-files-mode-switcher" aria-label="Review view">
            <button type="button" className={reviewInspectorMode === "current" ? "is-active" : undefined}
              onClick={() => showReviewInspector("current")}>Current review</button>
            <button type="button" className={reviewInspectorMode === "history" ? "is-active" : undefined}
              onClick={() => showReviewInspector("history")}>History</button>
          </div>
          {reviewInspectorMode === "history" && <>
            <p className="workspace-files-review-history-note">Historical comments belong to their original comparison. Selecting a review does not restore an old working tree.</p>
            <label className="workspace-files-compare-review-picker">Historical review
              <select aria-label="Historical workspace diff review" value={activeCompareReviewId ?? ""}
                onChange={(event) => setActiveCompareReviewId(event.target.value || undefined)}>
                <option value="">Select a historical review</option>
                {compareHistoryReviews.filter((review) => review.id !== currentCompareReview?.id).map((review) =>
                  <option key={review.id} value={review.id}>{review.title || "Workspace review"} · {review.updatedAt}</option>)}
              </select>
            </label>
          </>}
          {activeCompareReview && <Button variant="ghost" size="sm" disabled={compareReviewMutating || compareCommentSaving}
            onClick={() => void toggleCompareReviewState()}>{activeCompareReview.state === "open" ? "Archive" : "Reopen"}</Button>}
          {activeCompareReview ? (
            <div className="workspace-files-compare-details-body">
              <label className="workspace-files-compare-comment-field">
                Title
                <Input
                  aria-label="Workspace diff review title"
                  value={compareReviewTitleDraft}
                  onChange={(event) =>
                    setCompareReviewTitleDraft(event.target.value)
                  }
                />
              </label>
              <label className="workspace-files-compare-comment-field">
                Summary
                <Textarea
                  aria-label="Workspace diff review summary"
                  value={compareReviewSummaryDraft}
                  onChange={(event) =>
                    setCompareReviewSummaryDraft(event.target.value)
                  }
                  rows={4}
                />
              </label>
              <label className="workspace-files-compare-comment-field">
                State
                <select
                  aria-label="Workspace diff review state"
                  value={compareReviewStateDraft}
                  onChange={(event) =>
                    setCompareReviewStateDraft(
                      event.target.value as "open" | "archived",
                    )
                  }
                >
                  <option value="open">Open</option>
                  <option value="archived">Archived</option>
                </select>
              </label>
              <div className="workspace-files-compare-details-meta">
                <span>
                  {activeCompareReview.id === currentInlineReviewIdRef.current
                    ? "Current review"
                    : "Repository history"}
                </span>
                <span>{compareComments.length} comments</span>
                <span>
                  {compareReviewedFiles.filter((file) => file.reviewed).length}{" "}
                  reviewed
                </span>
              </div>
              <div className="workspace-files-compare-details-list">
                {compareComments.map((comment) => (
                  <article
                    key={comment.id}
                    className="workspace-files-compare-comment-card"
                  >
                    <header>
                      <div>
                        <strong>
                          {WORKSPACE_DIFF_COMMENT_STATE_LABELS[comment.state]}
                        </strong>
                        <span>
                          {comment.newPath ?? comment.oldPath ?? "File"} ·{" "}
                          {comment.startLine}
                          {comment.startLine === comment.endLine
                            ? ""
                            : `–${comment.endLine}`}
                        </span>
                      </div>
                      <div className="workspace-files-compare-comment-actions">
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() => editCompareComment(comment)}
                        >
                          Edit
                        </Button>
                        {comment.state !== "published" && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() =>
                              void updateCompareCommentState(
                                comment,
                                "published",
                              )
                            }
                          >
                            Publish
                          </Button>
                        )}
                        {comment.state !== "resolved" && (
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() =>
                              void updateCompareCommentState(
                                comment,
                                "resolved",
                              )
                            }
                          >
                            Resolve
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="xs"
                          onClick={() =>
                            activeCompareReview
                              ? void deleteCompareComment(
                                  activeCompareReview,
                                  comment,
                                )
                              : undefined
                          }
                        >
                          Delete
                        </Button>
                      </div>
                    </header>
                    <p>{comment.body}</p>
                  </article>
                ))}
                {compareComments.length === 0 && (
                  <p className="workspace-files-boundary-note">
                    No saved comments for this review yet.
                  </p>
                )}
              </div>
              <div className="workspace-files-compare-details-list">
                {compareReviewedFiles.map((file) => (
                  <div
                    key={file.fileIdentity}
                    className="workspace-files-compare-reviewed-row"
                  >
                    <span>{file.filePath}</span>
                    <span>{file.reviewed ? "Reviewed" : "Needs review"}</span>
                  </div>
                ))}
                {compareReviewedFiles.length === 0 && (
                  <p className="workspace-files-boundary-note">
                    No reviewed-file markers for this review yet.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <p className="workspace-files-boundary-note">
              Select a review to inspect its details.
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={compareReviewMutating}
              onClick={() => setCompareDetailsOpen(false)}
            >
              Close
            </Button>
            <Button
              disabled={!activeCompareReview || compareReviewMutating}
              onClick={() => void saveCompareReviewDetails()}
            >
              Save review
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DirectoryPickerDialog
        open={context.visible && (attachDialogOpen)}
        onOpenChange={(open) => {
          if (!attaching) setAttachDialogOpen(open);
        }}
        title="Add folder to Files"
        description="Attach an allowed absolute folder path to this workspace."
        environments={environments}
        environmentId={workspaceEnvironment?.id ?? ""}
        onEnvironmentChange={() => undefined}
        environmentLocked
        path={attachPath}
        onPathChange={setAttachPath}
        pathAriaLabel="Absolute folder path"
        api={api}
        submitLabel="Add folder"
        submitting={attaching}
        submitError={attachError}
        onSubmit={submitAttach}
      >
        <label>
          Display label (optional)
          <Input
            aria-label="Folder display label"
            value={attachLabel}
            onChange={(event) => setAttachLabel(event.target.value)}
          />
        </label>
      </DirectoryPickerDialog>
      <Dialog
        open={context.visible && (pendingDownload !== undefined)}
        onOpenChange={(open) => {
          if (!open) setPendingDownload(undefined);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Download saved version?</DialogTitle>
            <DialogDescription>
              {pendingDownload?.path ?? "This file"} has unsaved changes. The
              download will contain the version currently saved on disk, not
              your draft.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDownload(undefined)}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                const target = pendingDownload;
                if (target) void downloadFile(target);
              }}
            >
              Download saved version
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={context.visible && (pendingClose !== undefined)}
        onOpenChange={(open) => {
          if (!open) setPendingClose(undefined);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              Closing {pendingClose?.path ?? "this file"} will discard its
              unsaved changes.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingClose(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const next = pendingClose;
                setPendingClose(undefined);
                if (next) removeTab(next, true);
              }}
            >
              Discard and close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={context.visible && (pendingRemove !== undefined)}
        onOpenChange={(open) => {
          if (!open && !removing) setPendingRemove(undefined);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove folder from Files?</DialogTitle>
            <DialogDescription>
              {pendingRemove &&
              tabs.files.some(
                (file) =>
                  file.rootId === pendingRemove.rootId &&
                  workspaceFileDocumentIsDirty(
                    documents.get(workspaceFileDocumentKey(file)),
                  ),
              )
                ? `Removing ${pendingRemove.displayLabel} will discard unsaved changes in its open files.`
                : `Remove ${pendingRemove?.displayLabel ?? "this folder"} from this workspace? Files on disk are not deleted.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={removing}
              onClick={() => setPendingRemove(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={removing}
              onClick={() => void confirmRemoveRoot()}
            >
              Remove folder
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={context.visible && (conflictDialogOpen)} onOpenChange={setConflictDialogOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>File changed on disk</DialogTitle>
            <DialogDescription>
              Another process changed this file after it was opened. Your draft
              has not been lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConflictDialogOpen(false)}
            >
              Keep editing
            </Button>
            <Button variant="outline" onClick={() => void reload()}>
              Reload
            </Button>
            <Button variant="destructive" onClick={() => void overwrite()}>
              Overwrite
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog
        open={context.visible && (pendingRefreshReload !== undefined)}
        onOpenChange={(open) => {
          if (!open) setPendingRefreshReload(undefined);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reload file from disk?</DialogTitle>
            <DialogDescription>
              This file has unsaved changes. Discard them and reload the latest
              contents from disk?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingRefreshReload(undefined)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingRefreshReload) {
                  void refreshOpenFile(pendingRefreshReload);
                }
              }}
            >
              Discard and reload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function sameDocumentReloadSnapshot(
  current: WorkspaceFileDocumentState | undefined,
  snapshot: WorkspaceFileDocumentState | undefined,
): boolean {
  return (
    current === snapshot ||
    (current !== undefined &&
      snapshot !== undefined &&
      current.generation === snapshot.generation &&
      current.revision === snapshot.revision &&
      current.baseContent === snapshot.baseContent &&
      current.content === snapshot.content &&
      current.editing === snapshot.editing &&
      current.saveState === snapshot.saveState)
  );
}

function sourceLineSeekForIntent(
  intent: unknown,
  workspaceId: string | undefined,
): PendingWorkspaceFileSeek | undefined {
  if (
    !workspaceId ||
    !isWorkspaceFilesOpenIntent(intent) ||
    intent.workspaceId !== workspaceId ||
    intent.target.kind !== "source_line"
  ) {
    return undefined;
  }
  return {
    address: { rootId: intent.rootId, path: intent.path },
    sequence: intent.sequence,
    lineNumber: intent.target.lineNumber,
  };
}

function RootFileTree({
  rootId,
  paths,
  searchEnabled,
  initialExpandedPaths,
  onOpen,
  onExpand,
  register,
}: {
  readonly rootId: WorkspaceFileRootId;
  readonly paths: readonly string[];
  readonly searchEnabled: boolean;
  readonly initialExpandedPaths: readonly string[];
  readonly onOpen: (address: WorkspaceFileAddress) => void;
  readonly onExpand: (directory: WorkspaceFileDirectoryPath) => void;
  readonly register: (
    rootId: WorkspaceFileRootId,
    controller?: TreeController,
  ) => void;
}) {
  const pathsRef = useRef<readonly string[]>([]);
  const expandedRef = useRef<readonly string[]>(initialExpandedPaths);
  const selectRef = useRef<(paths: readonly string[]) => void>(() => undefined);
  selectRef.current = (selected) => {
    const path = [...selected]
      .reverse()
      .find((candidate) => !candidate.endsWith("/"));
    if (path) onOpen({ rootId, path });
  };
  const { model } = useFileTree({
    paths: [],
    density: "compact",
    initialExpansion: 0,
    search: searchEnabled,
    searchBlurBehavior: "retain",
    onSelectionChange: (selected) => selectRef.current(selected),
    unsafeCSS: TREE_TRUNCATION_CSS,
  });
  const modelRef = useRef(model);
  modelRef.current = model;
  useEffect(() => {
    const live = collectExpandedDirectoryPaths(pathsRef.current, (directory) =>
      isDirectoryExpanded(modelRef.current, directory),
    );
    const preferred =
      pathsRef.current.length > 0
        ? live
        : live.length > 0
          ? live
          : expandedRef.current;
    const expanded =
      paths.length === 0
        ? preferred
        : preferred.filter((directory) =>
            paths.some((path) => path.startsWith(directory)),
          );
    expandedRef.current = expanded;
    pathsRef.current = paths;
    modelRef.current.resetPaths({
      preparedInput: prepareFileTreeInput(paths),
      ...(expanded.length > 0 ? { initialExpandedPaths: expanded } : {}),
    });
  }, [paths]);
  useEffect(() => {
    const loadExpandedDirectories = () => {
      for (const path of pathsRef.current) {
        if (!path.endsWith("/") || !isDirectoryExpanded(model, path)) continue;
        onExpand(path.slice(0, -1) as WorkspaceFileDirectoryPath);
      }
    };
    loadExpandedDirectories();
    return model.subscribe(loadExpandedDirectories);
  }, [model, onExpand]);
  useEffect(() => {
    register(rootId, {
      getExpandedPaths: () =>
        collectExpandedDirectoryPaths(pathsRef.current, (directory) =>
          isDirectoryExpanded(modelRef.current, directory),
        ),
    });
    return () => register(rootId);
  }, [register, rootId]);
  return <FileTree model={model} className="workspace-files-tree-host" />;
}

function PanelMessage({
  icon,
  text,
}: {
  readonly icon?: React.ReactNode;
  readonly text: string;
}) {
  return (
    <div className="workspace-files-message">
      {icon}
      <span>{text}</span>
    </div>
  );
}

async function loadAllPaths(
  api: WorkspaceFilesApi,
  workspaceId: string,
  rootId: WorkspaceFileRootId,
  signal: AbortSignal,
) {
  const paths: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let scanTruncated = false;
  do {
    const page = await api.listWorkspaceFiles(workspaceId, {
      rootId,
      ...(cursor ? { cursor } : {}),
      pageSize: PAGE_SIZE,
      signal,
    });
    if (page.availability === "unavailable")
      throw new Error(diagnosticFor(page.diagnosticCode));
    const remaining = MAXIMUM_LOADED_PATHS - paths.length;
    paths.push(...page.entries.slice(0, remaining));
    scanTruncated ||= page.scanTruncated;
    if (
      page.entries.length > remaining ||
      paths.length >= MAXIMUM_LOADED_PATHS
    ) {
      scanTruncated = scanTruncated || page.nextCursor !== undefined;
      break;
    }
    const nextCursor = page.nextCursor;
    if (nextCursor && seenCursors.has(nextCursor))
      throw new Error("Workspace file listing returned a repeated cursor.");
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor && !signal.aborted);
  return { paths, scanTruncated };
}

async function loadDirectoryPaths(
  api: WorkspaceFilesApi,
  workspaceId: string,
  rootId: WorkspaceFileRootId,
  directory: WorkspaceFileDirectoryPath,
  signal: AbortSignal,
) {
  const paths: string[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let scanTruncated = false;
  do {
    const page = await api.listWorkspaceFileDirectory(workspaceId, {
      rootId,
      directory,
      ...(cursor ? { cursor } : {}),
      pageSize: PAGE_SIZE,
      signal,
    });
    if (page.availability === "unavailable")
      throw new Error(diagnosticFor(page.diagnosticCode));
    paths.push(
      ...page.entries.map((entry) =>
        entry.kind === "directory" ? `${entry.path}/` : entry.path,
      ),
    );
    scanTruncated ||= page.scanTruncated;
    const nextCursor = page.nextCursor;
    if (nextCursor && seenCursors.has(nextCursor))
      throw new Error(
        "Workspace directory listing returned a repeated cursor.",
      );
    if (nextCursor) seenCursors.add(nextCursor);
    cursor = nextCursor;
  } while (cursor && !signal.aborted);
  return { paths, scanTruncated };
}

function updateFileList(
  state: ReadonlyMap<string, FileListState>,
  rootId: WorkspaceFileRootId,
  update: (listing: FileListState) => FileListState,
): ReadonlyMap<string, FileListState> {
  const next = new Map(state);
  next.set(rootId, update(state.get(rootId) ?? EMPTY_FILE_LIST));
  return next;
}

function withoutSetEntry(
  values: ReadonlySet<string>,
  entry: string,
): ReadonlySet<string> {
  if (!values.has(entry)) return values;
  const next = new Set(values);
  next.delete(entry);
  return next;
}

function withoutDirectorySubtree(
  values: ReadonlySet<string>,
  directory: WorkspaceFileDirectoryPath,
): ReadonlySet<string> {
  const prefix = `${directory}/`;
  const next = new Set(
    [...values].filter(
      (candidate) => candidate !== directory && !candidate.startsWith(prefix),
    ),
  );
  return next.size === values.size ? values : next;
}

function withoutDirectoryPathSubtree(
  paths: readonly string[],
  directory: WorkspaceFileDirectoryPath,
): readonly string[] {
  const prefix = `${directory}/`;
  return paths.filter((candidate) => !candidate.startsWith(prefix));
}

function mergeDirectoryPaths(
  existing: readonly string[],
  directory: WorkspaceFileDirectoryPath,
  incoming: readonly string[],
  replace: boolean,
): readonly string[] {
  const prefix = directory ? `${directory}/` : "";
  const incomingChildren = new Set(
    incoming.map((path) => path.slice(prefix.length).replace(/\/$/u, "")),
  );
  const retained = replace
    ? existing.filter((path) => {
        if (!path.startsWith(prefix)) return true;
        const remainder = path.slice(prefix.length);
        const child = remainder.split("/", 1)[0];
        return child !== undefined && incomingChildren.has(child);
      })
    : existing;
  return [...new Set([...retained, ...incoming])].sort((left, right) =>
    left.localeCompare(right),
  );
}

function captureExpandedPaths(
  controllers: ReadonlyMap<string, TreeController>,
  fallback: Readonly<Record<string, readonly string[]>>,
) {
  const result: Record<string, readonly string[]> = { ...fallback };
  for (const [rootId, controller] of controllers)
    result[rootId] = controller.getExpandedPaths();
  return result;
}

function fileDisplayName(path: string): string {
  return path.split("/").at(-1) ?? path;
}
function tabTitle(
  file: WorkspaceFileAddress,
  root?: WorkspaceFileRootDescriptor,
  linkOnly = false,
): string {
  if (file.rootId === "primary") return file.path;
  if (linkOnly) return `${file.path} (linked file)`;
  return `${root?.displayLabel ?? file.rootId}: ${file.path}`;
}
function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}
function sameFileListMap(
  left: ReadonlyMap<string, FileListState>,
  right: ReadonlyMap<string, FileListState>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [rootId, listing] of right) {
    if (left.get(rootId) !== listing) return false;
  }
  return true;
}
function mergeOpenTabs(
  restored: OpenTabsState,
  live: OpenTabsState,
): OpenTabsState {
  const files = [...restored.files];
  for (const file of live.files) {
    if (!files.some((candidate) => sameWorkspaceFileAddress(candidate, file))) {
      files.push(file);
    }
  }
  const active = live.active ?? restored.active ?? files.at(-1);
  return active ? { files, active } : { files };
}
function normalizeAttachPath(path: string): string {
  const trimmed = path.trim();
  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/u, "");
}
function sameAddressList(
  a: readonly WorkspaceFileAddress[],
  b: readonly WorkspaceFileAddress[],
): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((file, index) => sameWorkspaceFileAddress(file, b[index])))
  );
}
function sameTabs(a: OpenTabsState, b: OpenTabsState): boolean {
  return (
    sameWorkspaceFileAddress(a.active, b.active) &&
    sameAddressList(a.files, b.files)
  );
}
function readPendingUiRestorePresentation(
  pending: ReturnType<WorkspaceFilesUiStateCache["get"]>,
  fileOpenIntent = false,
) {
  const pendingHasFiles = (pending?.tabs.files.length ?? 0) > 0;
  if (!pendingHasFiles)
    return {
      awaitingUiRestore: false,
      treeOpen: !fileOpenIntent,
      restorePathHint: undefined,
    };
  return {
    awaitingUiRestore: true,
    treeOpen: false,
    restorePathHint:
      pending?.tabs.active?.path ?? pending?.tabs.files.at(-1)?.path,
  };
}
function isDirectoryExpanded(
  model: { getItem(path: string): { isDirectory(): boolean } | null },
  directoryPath: string,
): boolean {
  const item = model.getItem(directoryPath);
  if (!item || !item.isDirectory()) return false;
  return "isExpanded" in item && typeof item.isExpanded === "function"
    ? item.isExpanded()
    : false;
}
function isEditableTextFile(
  file: WorkspaceFileContentResult,
): file is WorkspaceFileContentResult & {
  availability: "available";
  contentKind: "text";
  editable: true;
  truncation?: undefined;
} {
  return (
    file.availability === "available" &&
    file.contentKind === "text" &&
    file.editable &&
    file.truncation === undefined
  );
}
function latestFileCannotBeEditedMessage(
  file: WorkspaceFileContentResult,
): string {
  if (file.availability === "unavailable")
    return "File editing is unavailable for this folder.";
  if (file.contentKind === "binary")
    return "The latest file contents are binary.";
  if (file.contentKind === "image")
    return "The latest file contents are an image.";
  if (file.truncation)
    return "The latest file contents exceed the editable size limit.";
  return "The latest file contents are not editable.";
}
function preferredWorkspaceDiffReview(
  reviews: readonly WorkspaceDiffReview[],
): WorkspaceDiffReview | undefined {
  return (
    reviews.find((review) => review.state === "open") ??
    [...reviews].sort((left, right) => right.updatedAt - left.updatedAt)[0]
  );
}
function workspaceDiffReviewTitle(
  comparison: WorkspaceDiffComparisonDescriptor,
  files: readonly WorkspaceDiffChangedFileSummary[],
): string {
  const primary = files[0];
  if (files.length === 1 && primary) {
    return `Review ${primary.newPath ?? primary.oldPath ?? "change"}`;
  }
  return `Review ${comparison.repositoryId.slice(0, 8)} · ${files.length} files`;
}
function normalizeWorkspaceDiffReviewRange(range: {
  readonly start: number;
  readonly end: number;
  readonly side?: "old" | "new" | "deletions" | "additions";
  readonly endSide?: "old" | "new" | "deletions" | "additions";
}):
  | {
      readonly start: number;
      readonly end: number;
      readonly side: "old" | "new";
    }
  | undefined {
  const side = normalizeWorkspaceDiffSelectionSide(range.side);
  const endSide = normalizeWorkspaceDiffSelectionSide(
    range.endSide ?? range.side,
  );
  if (!side || !endSide || endSide !== side) return undefined;
  return {
    start: Math.min(range.start, range.end),
    end: Math.max(range.start, range.end),
    side,
  };
}
function normalizeWorkspaceDiffSelectionSide(
  side: "old" | "new" | "deletions" | "additions" | undefined,
): "old" | "new" | undefined {
  if (side === "old" || side === "deletions") return "old";
  if (side === "new" || side === "additions") return "new";
  return undefined;
}
function deriveWorkspaceDiffReviewAnnotations(
  comments: readonly WorkspaceDiffReviewComment[],
  files: readonly WorkspaceDiffChangedFileSummary[],
): readonly WorkspaceCompareReviewAnnotation[] {
  return comments.flatMap((comment) => {
    const file = matchWorkspaceDiffFileFromPaths(
      files,
      comment.oldPath,
      comment.newPath,
    );
    if (!file) return [];
    return [
      {
        annotationId: comment.id,
        fileId: file.fileId,
        side: comment.side === "old" ? "deletions" : "additions",
        lineNumber: comment.startLine,
        body: comment.body,
        authorLabel:
          comment.state === "resolved"
            ? "Resolved comment"
            : comment.state === "draft"
              ? "Draft comment"
              : "Comment",
        placement:
          comment.state === "outdated"
            ? "outdated"
            : comment.state === "unplaced"
              ? "unplaced"
              : "current",
      },
    ];
  });
}
function deriveWorkspaceDiffReviewedFileIds(
  reviewedFiles: readonly WorkspaceDiffReviewedFile[],
  files: readonly WorkspaceDiffChangedFileSummary[],
): ReadonlySet<WorkspaceDiffFileId> {
  const ids = new Set<WorkspaceDiffFileId>();
  for (const reviewed of reviewedFiles) {
    if (!reviewed.reviewed) continue;
    const file = files.find(
      (candidate) =>
        candidate.newPath === reviewed.filePath ||
        candidate.oldPath === reviewed.filePath,
    );
    if (file) ids.add(file.fileId);
  }
  return ids;
}
function matchWorkspaceDiffFileFromPaths(
  files: readonly WorkspaceDiffChangedFileSummary[],
  oldPath: string | null,
  newPath: string | null,
): WorkspaceDiffChangedFileSummary | undefined {
  return (
    files.find(
      (file) => file.oldPath === oldPath && file.newPath === newPath,
    ) ??
    files.find(
      (file) =>
        (newPath !== null && file.newPath === newPath) ||
        (oldPath !== null && file.oldPath === oldPath),
    )
  );
}
function diagnosticFor(code: string): string {
  switch (code) {
    case "workspace_files_unsupported":
      return "File browsing is unavailable for this workspace.";
    case "workspace_files_sidecar_unavailable":
      return "Remote file browsing is temporarily unavailable.";
    case "workspace_file_root_unavailable":
      return "This folder is no longer available.";
    case "workspace_unavailable":
      return "This workspace is unavailable.";
    default:
      return `Folder unavailable (${code}).`;
  }
}
function messageFor(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Workspace files could not be loaded.";
}

function resolvePreferredRootId(
  roots: readonly WorkspaceFileRootDescriptor[],
  preferredRootId: string | null,
): WorkspaceFileRootId {
  if (preferredRootId) {
    const preferred = roots.find(
      (root) =>
        root.rootId === preferredRootId &&
        root.kind === "linked_worktree" &&
        root.availability === "available",
    );
    if (preferred) return preferred.rootId;
  }
  return roots.find((root) => root.kind === "primary")?.rootId ?? "primary";
}

function visibleWorkspaceFileRootTabs(
  roots: readonly WorkspaceFileRootDescriptor[],
  activeRootId: WorkspaceFileRootId,
  preferredRootId: string | null,
): readonly WorkspaceFileRootDescriptor[] {
  const preferredWorktree = preferredRootId
    ? roots.find(
        (root) =>
          root.kind === "linked_worktree" &&
          root.rootId === preferredRootId &&
          root.availability === "available",
      )
    : undefined;
  return roots.flatMap((root) => {
    if (root.kind === "primary" && preferredWorktree) {
      return [preferredWorktree];
    }
    if (root.rootId === preferredWorktree?.rootId) return [];
    if (
      root.kind === "linked_worktree" &&
      root.rootId !== activeRootId &&
      root.rootId !== preferredRootId
    ) {
      return [];
    }
    return [root];
  });
}

const WORKSPACE_FILE_DOWNLOAD_FRAME_CLEANUP_GRACE_MILLISECONDS = 5 * 60 * 1_000;

function startBrowserWorkspaceFileDownload(
  url: string,
  onFailure: (message: string) => void,
): void {
  const frame = document.createElement("iframe");
  frame.className = "workspace-file-download-frame";
  frame.hidden = true;
  frame.setAttribute("aria-hidden", "true");
  const cleanupTimer = window.setTimeout(
    () => frame.remove(),
    WORKSPACE_FILE_DOWNLOAD_MAX_DURATION_MILLISECONDS +
      WORKSPACE_FILE_DOWNLOAD_FRAME_CLEANUP_GRACE_MILLISECONDS,
  );
  frame.addEventListener("load", () => {
    const failure = browserWorkspaceFileDownloadFailure(frame, url);
    if (!failure) return;
    window.clearTimeout(cleanupTimer);
    frame.remove();
    onFailure(failure);
  });
  frame.src = url;
  document.body.append(frame);
}

function browserWorkspaceFileDownloadFailure(
  frame: HTMLIFrameElement,
  expectedUrl: string,
): string | undefined {
  try {
    const loadedUrl = frame.contentWindow?.location.href;
    const absoluteExpectedUrl = new URL(expectedUrl, window.location.href).href;
    if (!loadedUrl || loadedUrl === "about:blank") return undefined;
    if (loadedUrl !== absoluteExpectedUrl) {
      return "The file download was redirected unexpectedly.";
    }
    const body = frame.contentDocument?.body?.textContent?.trim();
    if (body) {
      try {
        const parsed = JSON.parse(body) as unknown;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "error" in parsed &&
          typeof parsed.error === "object" &&
          parsed.error !== null &&
          "message" in parsed.error &&
          typeof parsed.error.message === "string" &&
          parsed.error.message.trim()
        ) {
          if (
            "code" in parsed.error &&
            parsed.error.code === "workspace_file_revision_conflict"
          ) {
            return "The file changed on disk. Refresh it before downloading.";
          }
          if (
            "code" in parsed.error &&
            parsed.error.code === "workspace_file_download_too_large"
          ) {
            return "This file is larger than the download limit.";
          }
          return parsed.error.message.trim();
        }
      } catch {
        // The route should return a normalized JSON error. Keep malformed
        // documents private and present a stable fallback instead.
      }
    }
    return "The file could not be downloaded. Refresh it and try again.";
  } catch {
    // A response-level frame policy can make even a same-origin error
    // document opaque. The navigation still failed to become an attachment,
    // so report the failure without guessing at its private body.
    return "The file could not be downloaded. Refresh it and try again.";
  }
}
