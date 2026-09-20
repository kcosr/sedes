import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
  NormalizedThreadDescendant,
  NormalizedThreadForkOrigin,
  NormalizedThreadLineagePlacement,
} from "../../shared/index.js";
import { createThreadSearchMatcher } from "./sidebar-search.js";

export type SidebarBucket =
  `workspace:${string}` | "automations" | "snoozed" | "settled" | "archived";

export interface DescendantAggregate {
  readonly count: number;
  readonly running: number;
  readonly needsInput: number;
  readonly done: number;
  readonly failed: number;
  readonly attention: number;
}

export interface SidebarLineageNode {
  readonly thread: NormalizedApplicationThreadSummary;
  readonly origin?: NormalizedThreadForkOrigin;
  readonly placement?: NormalizedThreadLineagePlacement;
  readonly parentId?: string;
  readonly children: readonly SidebarLineageNode[];
  readonly bucket: SidebarBucket;
  readonly depth: number;
  readonly maxActivityAt: string;
  readonly familyDescendantCount: number;
  readonly loadedFamilyDescendantCount: number;
  readonly aggregate: DescendantAggregate;
  readonly matchesSearch: boolean;
}

export interface SidebarLineageProjection {
  readonly roots: readonly SidebarLineageNode[];
  readonly rootsByBucket: ReadonlyMap<
    SidebarBucket,
    readonly SidebarLineageNode[]
  >;
  readonly nodesById: ReadonlyMap<string, SidebarLineageNode>;
  readonly matchingIds: ReadonlySet<string>;
}

type MutableNode = {
  thread: NormalizedApplicationThreadSummary;
  origin?: NormalizedThreadForkOrigin;
  placement?: NormalizedThreadLineagePlacement;
  parentId?: string;
  children: MutableNode[];
  bucket: SidebarBucket;
  depth: number;
  maxActivityAt: string;
  familyDescendantCount: number;
  loadedFamilyDescendantCount: number;
  aggregate: DescendantAggregate;
  matchesSearch: boolean;
};

const emptyAggregate = (): DescendantAggregate => ({
  count: 0,
  running: 0,
  needsInput: 0,
  done: 0,
  failed: 0,
  attention: 0,
});

export function deriveSidebarLineage(input: {
  readonly snapshot: NormalizedApplicationSnapshot;
  readonly visibleThreads: readonly NormalizedApplicationThreadSummary[];
  readonly descendants?: readonly NormalizedThreadDescendant[];
  readonly grouped: boolean;
  readonly search: string;
}): SidebarLineageProjection {
  const threads = new Map(
    input.descendants?.map(({ thread }) => [thread.id, thread]) ?? [],
  );
  for (const thread of input.snapshot.threads) threads.set(thread.id, thread);
  const origins = new Map(
    input.descendants?.map(({ origin }) => [origin.childThreadId, origin]) ??
      [],
  );
  for (const origin of input.snapshot.forkOrigins) {
    origins.set(origin.childThreadId, origin);
  }
  const placements = new Map<string, NormalizedThreadLineagePlacement>();
  for (const placement of [
    ...(input.descendants?.map(({ placement }) => placement) ?? []),
    ...input.snapshot.lineagePlacements,
  ]) {
    const current = placements.get(placement.childThreadId);
    if (!current || placement.revision >= current.revision) {
      placements.set(placement.childThreadId, placement);
    }
  }
  const familyCounts = new Map(
    input.snapshot.lineageFamilies.map(
      ({ sourceThreadId, descendantCount }) => [
        sourceThreadId,
        descendantCount,
      ],
    ),
  );
  const loadedFamilyCounts = deriveLoadedFamilyCounts(threads, origins);
  const matchingIds = findSearchMatches(input.snapshot, threads, input.search);
  const visibleIds = new Set(input.visibleThreads.map(({ id }) => id));
  if (!input.search.trim()) {
    for (const id of threads.keys()) visibleIds.add(id);
  } else {
    includeSearchAncestors(
      visibleIds,
      matchingIds,
      origins,
      placements,
      threads,
    );
  }

  const parentByChild = new Map<string, string>();
  if (input.grouped) {
    for (const [childId, origin] of origins) {
      const child = threads.get(childId);
      const parent = origin.sourceThreadId
        ? threads.get(origin.sourceThreadId)
        : undefined;
      const placement = placements.get(childId);
      if (
        child &&
        parent &&
        placement?.mode === "nested_under_source" &&
        child.inventoryState === parent.inventoryState &&
        (ownBucket(child) === ownBucket(parent) ||
          (parent.automation !== null &&
            child.automation === null &&
            child.workspaceId === parent.workspaceId))
      ) {
        parentByChild.set(childId, parent.id);
      }
    }
    breakCycles(parentByChild);
  }

  const nodes = new Map<string, MutableNode>();
  for (const thread of threads.values()) {
    if (!visibleIds.has(thread.id)) continue;
    nodes.set(thread.id, {
      thread,
      ...(origins.get(thread.id) ? { origin: origins.get(thread.id)! } : {}),
      ...(placements.get(thread.id)
        ? { placement: placements.get(thread.id)! }
        : {}),
      children: [],
      bucket: ownBucket(thread),
      depth: 0,
      maxActivityAt: thread.lastActivityAt,
      familyDescendantCount: familyCounts.get(thread.id) ?? 0,
      loadedFamilyDescendantCount: loadedFamilyCounts.get(thread.id) ?? 0,
      aggregate: emptyAggregate(),
      matchesSearch: matchingIds.has(thread.id),
    });
  }
  for (const [childId, parentId] of parentByChild) {
    const child = nodes.get(childId);
    const parent = nodes.get(parentId);
    if (!child || !parent) continue;
    child.parentId = parentId;
    parent.children.push(child);
  }

  const roots = [...nodes.values()].filter(({ parentId }) => !parentId);
  const stack = roots.map((node) => ({
    node,
    depth: 0,
    bucket: ownBucket(node.thread),
  }));
  const order: MutableNode[] = [];
  while (stack.length > 0) {
    const current = stack.pop()!;
    current.node.depth = current.depth;
    current.node.bucket = current.bucket;
    order.push(current.node);
    for (const child of current.node.children) {
      stack.push({
        node: child,
        depth: current.depth + 1,
        bucket: current.bucket,
      });
    }
  }
  for (const node of order.reverse()) {
    node.children.sort(compareNodeActivity);
    let aggregate = emptyAggregate();
    for (const child of node.children) {
      aggregate = mergeAggregate(
        aggregate,
        mergeAggregate(ownAggregate(child.thread), child.aggregate),
      );
      if (child.maxActivityAt > node.maxActivityAt) {
        node.maxActivityAt = child.maxActivityAt;
      }
    }
    node.aggregate = aggregate;
  }
  roots.sort(compareNodeActivity);

  const rootsByBucket = new Map<SidebarBucket, SidebarLineageNode[]>();
  for (const root of roots) {
    const bucket = rootsByBucket.get(root.bucket) ?? [];
    bucket.push(root);
    rootsByBucket.set(root.bucket, bucket);
  }
  return {
    roots,
    rootsByBucket,
    nodesById: nodes,
    matchingIds,
  };
}

function findSearchMatches(
  snapshot: NormalizedApplicationSnapshot,
  threads: ReadonlyMap<string, NormalizedApplicationThreadSummary>,
  search: string,
): Set<string> {
  const matches = new Set<string>();
  if (!search.trim()) return matches;
  const matchesSearch = createThreadSearchMatcher(search, snapshot);
  for (const thread of threads.values()) {
    if (matchesSearch(thread)) matches.add(thread.id);
  }
  return matches;
}

function includeSearchAncestors(
  visibleIds: Set<string>,
  matchingIds: ReadonlySet<string>,
  origins: ReadonlyMap<string, NormalizedThreadForkOrigin>,
  placements: ReadonlyMap<string, NormalizedThreadLineagePlacement>,
  threads: ReadonlyMap<string, NormalizedApplicationThreadSummary>,
): void {
  for (const matchId of matchingIds) {
    visibleIds.add(matchId);
    const seen = new Set([matchId]);
    let currentId = matchId;
    while (true) {
      const origin = origins.get(currentId);
      if (placements.get(currentId)?.mode !== "nested_under_source") break;
      const sourceId = origin?.sourceThreadId;
      if (!sourceId || seen.has(sourceId) || !threads.has(sourceId)) break;
      visibleIds.add(sourceId);
      seen.add(sourceId);
      currentId = sourceId;
    }
  }
}

function breakCycles(parentByChild: Map<string, string>): void {
  const checked = new Set<string>();
  for (const start of parentByChild.keys()) {
    if (checked.has(start)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = start;
    while (current && !checked.has(current)) {
      const cycleAt = positions.get(current);
      if (cycleAt !== undefined) {
        for (const member of path.slice(cycleAt)) parentByChild.delete(member);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = parentByChild.get(current);
    }
    for (const id of path) checked.add(id);
  }
}

function deriveLoadedFamilyCounts(
  threads: ReadonlyMap<string, NormalizedApplicationThreadSummary>,
  origins: ReadonlyMap<string, NormalizedThreadForkOrigin>,
): ReadonlyMap<string, number> {
  const parentByChild = new Map<string, string>();
  for (const [childId, origin] of origins) {
    if (
      origin.sourceThreadId &&
      threads.has(childId) &&
      threads.has(origin.sourceThreadId)
    ) {
      parentByChild.set(childId, origin.sourceThreadId);
    }
  }
  breakCycles(parentByChild);
  const remainingChildren = new Map<string, number>();
  const descendantCounts = new Map<string, number>();
  for (const threadId of threads.keys()) {
    remainingChildren.set(threadId, 0);
    descendantCounts.set(threadId, 0);
  }
  for (const parentId of parentByChild.values()) {
    remainingChildren.set(parentId, (remainingChildren.get(parentId) ?? 0) + 1);
  }
  const queue = [...remainingChildren]
    .filter(([, count]) => count === 0)
    .map(([threadId]) => threadId);
  while (queue.length > 0) {
    const childId = queue.pop()!;
    const parentId = parentByChild.get(childId);
    if (!parentId) continue;
    descendantCounts.set(
      parentId,
      (descendantCounts.get(parentId) ?? 0) +
        1 +
        (descendantCounts.get(childId) ?? 0),
    );
    const remaining = (remainingChildren.get(parentId) ?? 1) - 1;
    remainingChildren.set(parentId, remaining);
    if (remaining === 0) queue.push(parentId);
  }
  return descendantCounts;
}

function ownBucket(thread: NormalizedApplicationThreadSummary): SidebarBucket {
  if (thread.inventoryState === "active") {
    return thread.automation
      ? "automations"
      : `workspace:${thread.workspaceId}`;
  }
  return thread.inventoryState;
}

function ownAggregate(
  thread: NormalizedApplicationThreadSummary,
): DescendantAggregate {
  const running = ["starting", "running", "stopping"].includes(thread.runState);
  const needsInput = ["waiting_for_input", "waiting_for_approval"].includes(
    thread.runState,
  );
  const failed =
    thread.runState === "failed" ||
    thread.backingState === "creation_unknown" ||
    thread.attention.queueFailure ||
    thread.attention.automationContext === "failed";
  const attention =
    thread.pendingQuestionCount > 0 ||
    thread.attention.wake ||
    thread.attention.queueFailure ||
    thread.attention.automationContext !== null;
  return {
    count: 1,
    running: running ? 1 : 0,
    needsInput: needsInput ? 1 : 0,
    done: thread.attention.unseenCompletion ? 1 : 0,
    failed: failed ? 1 : 0,
    attention: attention ? 1 : 0,
  };
}

function mergeAggregate(
  left: DescendantAggregate,
  right: DescendantAggregate,
): DescendantAggregate {
  return {
    count: left.count + right.count,
    running: left.running + right.running,
    needsInput: left.needsInput + right.needsInput,
    done: left.done + right.done,
    failed: left.failed + right.failed,
    attention: left.attention + right.attention,
  };
}

function compareNodeActivity(left: MutableNode, right: MutableNode): number {
  return (
    right.maxActivityAt.localeCompare(left.maxActivityAt) ||
    left.thread.id.localeCompare(right.thread.id)
  );
}
