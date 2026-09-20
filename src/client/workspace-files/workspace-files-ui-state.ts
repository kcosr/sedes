import type { WorkspaceFileAddress } from "./workspace-file-editor-state.js";
import { sameWorkspaceFileAddress } from "./workspace-file-editor-state.js";

export const WORKSPACE_FILES_UI_STATE_VERSION = 4;

export interface WorkspaceFilesUiTabsSnapshot {
  readonly files: readonly WorkspaceFileAddress[];
  readonly active?: WorkspaceFileAddress;
}
export interface WorkspaceFilesUiSnapshot {
  readonly version: typeof WORKSPACE_FILES_UI_STATE_VERSION;
  readonly tabs: WorkspaceFilesUiTabsSnapshot;
  readonly linkOnlyRootIds: readonly WorkspaceFileAddress["rootId"][];
  readonly activeRootId: WorkspaceFileAddress["rootId"];
  readonly treeOpen: boolean;
  readonly expandedPathsByRoot: Readonly<Record<string, readonly string[]>>;
}
export interface WorkspaceFilesUiStateCache {
  get(workspaceId: string): WorkspaceFilesUiSnapshot | undefined;
  set(workspaceId: string, snapshot: WorkspaceFilesUiSnapshot): void;
  delete(workspaceId: string): void;
  clear(): void;
}
export interface CreateWorkspaceFilesUiStateCacheOptions {
  readonly maxWorkspaces?: number;
  readonly maxTabs?: number;
}
const DEFAULT_MAX_WORKSPACES = 8;
const DEFAULT_MAX_TABS = 20;

export function createWorkspaceFilesUiStateCache(
  options: CreateWorkspaceFilesUiStateCacheOptions = {},
): WorkspaceFilesUiStateCache {
  const maxWorkspaces = options.maxWorkspaces ?? DEFAULT_MAX_WORKSPACES;
  const maxTabs = options.maxTabs ?? DEFAULT_MAX_TABS;
  const entries = new Map<string, WorkspaceFilesUiSnapshot>();
  return {
    get(workspaceId) {
      const current = entries.get(workspaceId);
      if (!current || current.version !== WORKSPACE_FILES_UI_STATE_VERSION) {
        entries.delete(workspaceId);
        return undefined;
      }
      entries.delete(workspaceId);
      entries.set(workspaceId, current);
      return current;
    },
    set(workspaceId, snapshot) {
      // Old bare-path snapshots are intentionally discarded rather than migrated.
      if (snapshot.version !== WORKSPACE_FILES_UI_STATE_VERSION) {
        entries.delete(workspaceId);
        return;
      }
      entries.delete(workspaceId);
      entries.set(workspaceId, {
        version: WORKSPACE_FILES_UI_STATE_VERSION,
        tabs: capTabs(snapshot.tabs, maxTabs),
        linkOnlyRootIds: [...snapshot.linkOnlyRootIds],
        activeRootId: snapshot.activeRootId,
        treeOpen: snapshot.treeOpen,
        expandedPathsByRoot: Object.fromEntries(
          Object.entries(snapshot.expandedPathsByRoot).map(
            ([rootId, paths]) => [rootId, [...paths]],
          ),
        ),
      });
      while (entries.size > maxWorkspaces) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    delete: (workspaceId) => {
      entries.delete(workspaceId);
    },
    clear: () => {
      entries.clear();
    },
  };
}
export const workspaceFilesUiStateCache = createWorkspaceFilesUiStateCache();

export function ancestorDirectoryPaths(path: string): string[] {
  const directories: string[] = [];
  let index = path.indexOf("/");
  while (index >= 0) {
    directories.push(path.slice(0, index + 1));
    index = path.indexOf("/", index + 1);
  }
  return directories;
}
export function collectExpandedDirectoryPaths(
  paths: readonly string[],
  isExpanded: (path: string) => boolean,
): string[] {
  const directories = new Set<string>();
  for (const path of paths)
    for (const directory of ancestorDirectoryPaths(path))
      directories.add(directory);
  return [...directories].filter(isExpanded);
}
export function directoryExistsInListing(
  directoryPath: string,
  paths: readonly string[],
): boolean {
  return paths.some((path) => path.startsWith(directoryPath));
}
export function pruneWorkspaceFilesUiSnapshot(
  snapshot: WorkspaceFilesUiSnapshot,
  listings: ReadonlyMap<WorkspaceFileAddress["rootId"], readonly string[]>,
  options?: {
    readonly retainFile?: (file: WorkspaceFileAddress) => boolean;
    readonly partialRootIds?: ReadonlySet<string>;
    readonly maxTabs?: number;
  },
): WorkspaceFilesUiSnapshot {
  const files = snapshot.tabs.files.filter((file) => {
    if (options?.partialRootIds?.has(file.rootId)) return true;
    return (
      listings.get(file.rootId)?.includes(file.path) === true ||
      options?.retainFile?.(file) === true
    );
  });
  const retainedActive =
    snapshot.tabs.active &&
    files.some((file) => sameWorkspaceFileAddress(file, snapshot.tabs.active));
  const prunedTabs = {
    files,
    ...(retainedActive ? { active: snapshot.tabs.active } : {}),
  };
  // The live panel must never silently discard an open (possibly dirty) tab.
  // Persistence remains bounded by createWorkspaceFilesUiStateCache.set().
  const tabs =
    options?.maxTabs === undefined
      ? normalizeTabs(prunedTabs)
      : capTabs(prunedTabs, options.maxTabs);
  const retainedRootIds = new Set(files.map((file) => file.rootId));
  const expandedPathsByRoot = Object.fromEntries(
    Object.entries(snapshot.expandedPathsByRoot).map(([rootId, expanded]) => [
      rootId,
      options?.partialRootIds?.has(rootId)
        ? [...expanded]
        : expanded.filter((path) =>
            directoryExistsInListing(
              path,
              listings.get(rootId as WorkspaceFileAddress["rootId"]) ?? [],
            ),
          ),
    ]),
  );
  const activeRootId = listings.has(snapshot.activeRootId)
    ? snapshot.activeRootId
    : (tabs.active?.rootId ?? listings.keys().next().value ?? "primary");
  return {
    version: WORKSPACE_FILES_UI_STATE_VERSION,
    tabs,
    linkOnlyRootIds: snapshot.linkOnlyRootIds.filter((rootId) =>
      retainedRootIds.has(rootId),
    ),
    activeRootId,
    treeOpen: tabs.files.length === 0 ? true : snapshot.treeOpen,
    expandedPathsByRoot,
  };
}
function normalizeTabs(
  tabs: WorkspaceFilesUiTabsSnapshot,
): WorkspaceFilesUiTabsSnapshot {
  const files = [...tabs.files];
  const active =
    tabs.active &&
    files.some((file) => sameWorkspaceFileAddress(file, tabs.active))
      ? tabs.active
      : files.at(-1);
  return active ? { files, active } : { files };
}
function capTabs(
  tabs: WorkspaceFilesUiTabsSnapshot,
  maxTabs: number,
): WorkspaceFilesUiTabsSnapshot {
  let files =
    tabs.files.length <= maxTabs ? [...tabs.files] : tabs.files.slice(-maxTabs);
  if (
    tabs.active &&
    !files.some((file) => sameWorkspaceFileAddress(file, tabs.active))
  ) {
    files = [...files.slice(1), tabs.active];
  }
  const active =
    tabs.active &&
    files.some((file) => sameWorkspaceFileAddress(file, tabs.active))
      ? tabs.active
      : files.at(-1);
  return active ? { files, active } : { files };
}
