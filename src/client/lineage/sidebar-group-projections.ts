import type {
  NormalizedApplicationThreadSummary,
  NormalizedThreadGroup,
} from "../../shared/index.js";
import type {
  SidebarFlatGroup,
  SidebarStackBy,
} from "../app/sidebar-view-model.js";

export type SidebarStackEntry =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly thread: NormalizedApplicationThreadSummary;
    }
  | {
      readonly kind: "stack";
      readonly key: string;
      readonly stackBy: "group";
      readonly stackId: string;
      readonly label: string;
      readonly group: NormalizedThreadGroup;
      readonly representative: NormalizedApplicationThreadSummary;
      readonly members: readonly NormalizedApplicationThreadSummary[];
    }
  | {
      readonly kind: "stack";
      readonly key: string;
      readonly stackBy: "project";
      readonly stackId: string;
      readonly label: string;
      readonly representative: NormalizedApplicationThreadSummary;
      readonly members: readonly NormalizedApplicationThreadSummary[];
    };

export interface SidebarStackedGroup extends Omit<SidebarFlatGroup, "threads"> {
  /** Number of source threads in this organization bucket before stacking. */
  readonly threadCount: number;
  readonly entries: readonly SidebarStackEntry[];
}

export interface ProjectSidebarStacksInput {
  /** Already-organized buckets in their final visual order. */
  readonly groups: readonly SidebarFlatGroup[];
  readonly stackBy: SidebarStackBy;
  readonly threadGroups: readonly NormalizedThreadGroup[];
  readonly workspaceLabels: ReadonlyMap<string, string>;
}

type StackDefinition =
  | {
      readonly key: string;
      readonly stackBy: "group";
      readonly stackId: string;
      readonly label: string;
      readonly group: NormalizedThreadGroup;
    }
  | {
      readonly key: string;
      readonly stackBy: "project";
      readonly stackId: string;
      readonly label: string;
    };

/**
 * Collapses an already-filtered, grouped, and sorted stream without changing
 * its order. The first occurrence of an eligible stack becomes its stable
 * representative and anchors the stack in that occurrence's bucket. Later
 * members disappear from their original buckets but remain in roster order.
 */
export function projectSidebarStacks({
  groups,
  stackBy,
  threadGroups,
  workspaceLabels,
}: ProjectSidebarStacksInput): SidebarStackedGroup[] {
  const groupById = new Map(threadGroups.map((group) => [group.id, group]));
  const definitionsByThreadId = new Map<string, StackDefinition>();
  const membersByKey = new Map<string, NormalizedApplicationThreadSummary[]>();

  for (const bucket of groups) {
    for (const thread of bucket.threads) {
      const definition = stackDefinitionFor(
        thread,
        stackBy,
        groupById,
        workspaceLabels,
      );
      if (!definition) continue;
      definitionsByThreadId.set(thread.id, definition);
      const members = membersByKey.get(definition.key) ?? [];
      members.push(thread);
      membersByKey.set(definition.key, members);
    }
  }

  const emitted = new Set<string>();
  const projected: SidebarStackedGroup[] = [];
  for (const bucket of groups) {
    const entries: SidebarStackEntry[] = [];
    for (const thread of bucket.threads) {
      const definition = definitionsByThreadId.get(thread.id);
      const members = definition ? membersByKey.get(definition.key) : undefined;
      if (!definition || !members || members.length < 2) {
        entries.push({
          kind: "thread",
          key: `thread:${thread.id}`,
          thread,
        });
        continue;
      }
      if (emitted.has(definition.key)) continue;
      emitted.add(definition.key);
      if (definition.stackBy === "group") {
        entries.push({
          kind: "stack",
          key: definition.key,
          stackBy: "group",
          stackId: definition.stackId,
          label: definition.label,
          group: definition.group,
          representative: thread,
          members,
        });
      } else {
        entries.push({
          kind: "stack",
          key: definition.key,
          stackBy: "project",
          stackId: definition.stackId,
          label: definition.label,
          representative: thread,
          members,
        });
      }
    }
    if (entries.length === 0) continue;
    projected.push({
      key: bucket.key,
      label: bucket.label,
      kind: bucket.kind,
      futureTimes: bucket.futureTimes,
      threadCount: bucket.threads.length,
      entries,
    });
  }
  return projected;
}

function stackDefinitionFor(
  thread: NormalizedApplicationThreadSummary,
  stackBy: SidebarStackBy,
  groupById: ReadonlyMap<string, NormalizedThreadGroup>,
  workspaceLabels: ReadonlyMap<string, string>,
): StackDefinition | undefined {
  if (stackBy === "none") return undefined;
  if (stackBy === "group") {
    if (thread.groupId === null) return undefined;
    const group = groupById.get(thread.groupId);
    return group
      ? {
          key: `group:${group.id}`,
          stackBy,
          stackId: group.id,
          label: group.name,
          group,
        }
      : undefined;
  }
  const label = workspaceLabels.get(thread.workspaceId);
  return label
    ? {
        key: `project:${thread.workspaceId}`,
        stackBy,
        stackId: thread.workspaceId,
        label,
      }
    : undefined;
}
