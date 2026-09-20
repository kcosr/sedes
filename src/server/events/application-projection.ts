import {
  normalizedApplicationEventSchema,
  normalizedApplicationSnapshotSchema,
  type NormalizedApplicationSnapshot as Snapshot,
  type NormalizedApplicationEvent as Event,
} from "../../shared/protocol/application.js";
import { MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES } from "../../shared/protocol/payload.js";

export const MAXIMUM_APPLICATION_INCREMENTAL_REFERENCE_CHECKS = 64;
const COLLECTIONS = [
  "environments",
  "workspaces",
  "threads",
  "groups",
  "forkOrigins",
  "lineagePlacements",
  "lineageFamilies",
  "executionTargets",
  "advisories",
  "tasks",
] as const;
type Collection = (typeof COLLECTIONS)[number];
type Values = { [K in Collection]: Snapshot[K][number] };
type Value = Values[Collection];
type Entry = { value: Value; json: string; references: readonly string[] };
type Lookup = <K extends Collection>(
  collection: K,
  id: string,
) => Values[K] | undefined;
const key = (collection: Collection, id: string) => `${collection}\0${id}`;
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function referenceParts(reference: string): [Collection, string] {
  const separator = reference.indexOf("\0");
  return [
    reference.slice(0, separator) as Collection,
    reference.slice(separator + 1),
  ];
}
function idOf(collection: Collection, value: Value): string {
  if (collection === "forkOrigins" || collection === "lineagePlacements")
    return (value as Values["forkOrigins"]).childThreadId;
  if (collection === "lineageFamilies")
    return (value as Values["lineageFamilies"]).sourceThreadId;
  return (value as { id: string }).id;
}
function assert(
  condition: unknown,
  reason = "application_inventory_reference_invalid",
): asserts condition {
  if (!condition) throw new Error(reason);
}

/** Indexed, order-preserving inventory. Preparing an update never mutates installed state. */
export class ApplicationProjection {
  readonly #collections = new Map<Collection, Map<string, Entry>>();
  readonly #dependents = new Map<string, Set<string>>();
  readonly #lineageReferenceCounts = new Map<string, number>();
  #counts: Snapshot["counts"];
  readonly #defaultTarget: string | null;
  #bytes: number;
  #folds = 0;
  #changedBytes = 0;
  #firstFoldAt: number | undefined;
  #version = 0;

  constructor(raw: Snapshot) {
    const snapshot = freeze(normalizedApplicationSnapshotSchema.parse(raw));
    this.#counts = snapshot.counts;
    this.#defaultTarget = snapshot.defaultNewThreadTargetId;
    this.#bytes = bytes(snapshot);
    for (const collection of COLLECTIONS) {
      const entries = new Map<string, Entry>();
      this.#collections.set(collection, entries);
      for (const value of snapshot[collection]) {
        const id = idOf(collection, value);
        const entry = {
          value,
          json: JSON.stringify(value),
          references: this.#references(collection, value),
        };
        entries.set(id, entry);
        this.#index(key(collection, id), entry.references, true);
      }
    }
  }

  get counts(): Snapshot["counts"] {
    return this.#counts;
  }
  get serializedBytes(): number {
    return this.#bytes;
  }
  get<K extends Collection>(collection: K, id: string): Values[K] | undefined {
    return this.#collections.get(collection)!.get(id)?.value as
      | Values[K]
      | undefined;
  }
  referencesThread(id: string): boolean {
    // Only lineage prevents removal; Tasks may reference an omitted thread.
    return this.#lineageReferenceCounts.has(id);
  }
  auditDue(now = performance.now()): boolean {
    return (
      this.#folds >= 1_024 ||
      this.#changedBytes >= 8 * 1_024 * 1_024 ||
      (this.#firstFoldAt !== undefined && now - this.#firstFoldAt >= 60_000)
    );
  }
  get auditDeadline(): number | undefined {
    return this.#firstFoldAt === undefined
      ? undefined
      : this.#firstFoldAt + 60_000;
  }

  materialize(): Snapshot {
    const fields = Object.fromEntries(
      COLLECTIONS.map((collection) => [
        collection,
        [...this.#collections.get(collection)!.values()].map(
          (entry) => entry.value,
        ),
      ]),
    );
    const snapshot = normalizedApplicationSnapshotSchema.parse({
      ...fields,
      counts: this.#counts,
      defaultNewThreadTargetId: this.#defaultTarget,
    });
    assert(
      bytes(snapshot) === this.#bytes,
      "application_projection_byte_ledger_mismatch",
    );
    // Independent reconstruction audits the reverse-reference index as well.
    const expected = new Map<string, Set<string>>();
    const expectedLineage = new Map<string, number>();
    for (const collection of COLLECTIONS)
      for (const [id, entry] of this.#collections.get(collection)!) {
        assert(
          JSON.stringify(entry.value) === entry.json,
          "application_projection_value_mutated",
        );
        for (const reference of this.#references(collection, entry.value)) {
          let set = expected.get(reference);
          if (!set) expected.set(reference, (set = new Set()));
          set.add(key(collection, id));
          const [target, targetId] = referenceParts(reference);
          if (target === "threads" && collection !== "tasks")
            expectedLineage.set(
              targetId,
              (expectedLineage.get(targetId) ?? 0) + 1,
            );
        }
      }
    assert(
      expected.size === this.#dependents.size,
      "application_projection_index_mismatch",
    );
    for (const [reference, set] of expected) {
      const actual = this.#dependents.get(reference);
      assert(
        actual?.size === set.size &&
          [...set].every((value) => actual.has(value)),
        "application_projection_index_mismatch",
      );
    }
    assert(
      expectedLineage.size === this.#lineageReferenceCounts.size &&
        [...expectedLineage].every(
          ([id, count]) => this.#lineageReferenceCounts.get(id) === count,
        ),
      "application_projection_index_mismatch",
    );
    this.#folds = 0;
    this.#changedBytes = 0;
    this.#firstFoldAt = undefined;
    return freeze(snapshot);
  }

  prepare(rawEvent: Exclude<Event, { type: "snapshot" }>): () => void {
    // Own a validated, immutable delta. Callers and live-event subscribers
    // cannot subsequently mutate the entity stored in this projection.
    const event = freeze(normalizedApplicationEventSchema.parse(rawEvent));
    assert(
      event.type !== "snapshot",
      "application_projection_snapshot_requires_replacement",
    );
    const version = this.#version;
    let collection: Collection | undefined;
    let id = "";
    let value: Value | undefined;
    let counts = this.#counts;
    switch (event.type) {
      case "workpad_changed":
        break;
      case "inventory_counts_changed":
        counts = event.counts;
        break;
      case "environment_upsert":
        collection = "environments";
        value = event.environment;
        id = value.id;
        break;
      case "environment_remove":
        collection = "environments";
        id = event.environmentId;
        break;
      case "workspace_upsert":
        collection = "workspaces";
        value = event.workspace;
        id = value.id;
        break;
      case "workspace_remove":
        collection = "workspaces";
        id = event.workspaceId;
        break;
      case "thread_upsert":
        collection = "threads";
        value = event.thread;
        id = value.id;
        counts = event.counts;
        break;
      case "thread_remove":
        collection = "threads";
        id = event.threadId;
        counts = event.counts;
        break;
      case "task_upsert":
        collection = "tasks";
        value = event.task;
        id = value.id;
        break;
      case "task_remove":
        collection = "tasks";
        id = event.taskId;
        break;
      default: {
        const exhaustive: never = event;
        throw new Error(`application_projection_event_unknown:${exhaustive}`);
      }
    }
    const entries = collection ? this.#collections.get(collection)! : undefined;
    const prior = entries?.get(id);
    const json = value ? JSON.stringify(value) : undefined;
    const changed = json !== prior?.json;
    if (collection === "threads" && prior && value) {
      const old = prior.value as Values["threads"];
      const next = value as Values["threads"];
      for (const field of [
        "inventoryRevision",
        "pinRevision",
        "preferredWorktreeRevision",
        "groupAssignmentRevision",
        "threadRevision",
        "bookmarkRevision",
      ] as const)
        assert(
          next[field] >= old[field],
          "application_thread_revision_regressed",
        );
    }
    if (collection === "tasks" && prior && value)
      assert(
        (value as Values["tasks"]).revision >=
          (prior.value as Values["tasks"]).revision,
        "application_task_revision_regressed",
      );
    if (entries && value && !prior)
      assert(
        entries.size < (collection === "environments" ? 256 : 10_000),
        "application_projection_collection_limit",
      );
    const lookup: Lookup = <K extends Collection>(name: K, entityId: string) =>
      name === collection && entityId === id
        ? (value as Values[K] | undefined)
        : this.get(name, entityId);
    if (collection && changed) {
      if (value) this.#validate(collection, value, lookup);
      if (!value) {
        // A removed thread may remain a Task's durable owner. All other
        // references to removed inventory entities require a replacement.
        assert(
          collection === "threads"
            ? !this.referencesThread(id)
            : !this.#dependents.has(key(collection, id)),
        );
      }
      // Display and activity changes do not affect another entity's proof.
      // Inspect adjacency only when a referent disappears or its association
      // changes; high-fanout threads can still receive ordinary live updates.
      const affectsDependents =
        value &&
        (!prior ||
          (collection === "threads" &&
            (prior.value as Values["threads"]).workspaceId !==
              (value as Values["threads"]).workspaceId) ||
          (collection === "workspaces" &&
            (prior.value as Values["workspaces"]).environmentId !==
              (value as Values["workspaces"]).environmentId));
      const affected = affectsDependents
        ? this.#dependents.get(key(collection, id))
        : undefined;
      assert(
        !affected ||
          affected.size <= MAXIMUM_APPLICATION_INCREMENTAL_REFERENCE_CHECKS,
        "application_projection_reference_budget",
      );
      for (const reference of affected ?? []) {
        const [name, entityId] = referenceParts(reference);
        this.#validate(name, this.get(name, entityId)!, lookup);
      }
    }
    const countsChanged =
      JSON.stringify(counts) !== JSON.stringify(this.#counts);
    const oldBytes = prior ? Buffer.byteLength(prior.json, "utf8") : 0;
    const newBytes = json ? Buffer.byteLength(json, "utf8") : 0;
    const oldCountBytes = bytes(this.#counts);
    const newCountBytes = bytes(counts);
    const countsExamined = "counts" in event;
    let nextBytes =
      this.#bytes + newBytes - oldBytes + newCountBytes - oldCountBytes;
    if (entries && !prior && value && entries.size > 0) nextBytes++;
    if (entries && prior && !value && entries.size > 1) nextBytes--;
    assert(
      nextBytes <= MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
      "application_projection_snapshot_limit",
    );
    const references =
      collection && value ? this.#references(collection, value) : [];
    return () => {
      assert(
        version === this.#version,
        "application_projection_prepared_update_stale",
      );
      if (collection && entries && changed) {
        const ownKey = key(collection, id);
        if (prior) this.#index(ownKey, prior.references, false);
        if (value && json !== undefined) {
          entries.set(id, { value, json, references });
          this.#index(ownKey, references, true);
        } else entries.delete(id);
      }
      this.#counts = counts;
      this.#bytes = nextBytes;
      this.#version++;
      if (changed || countsChanged) {
        this.#folds++;
        this.#changedBytes +=
          oldBytes +
          newBytes +
          (countsExamined ? oldCountBytes + newCountBytes : 0);
        this.#firstFoldAt ??= performance.now();
      }
    };
  }

  #index(own: string, references: readonly string[], add: boolean): void {
    for (const reference of references) {
      const [target, id] = referenceParts(reference);
      if (target === "threads" && !own.startsWith("tasks\0")) {
        const count =
          (this.#lineageReferenceCounts.get(id) ?? 0) + (add ? 1 : -1);
        if (count === 0) this.#lineageReferenceCounts.delete(id);
        else this.#lineageReferenceCounts.set(id, count);
      }
      if (add) {
        let set = this.#dependents.get(reference);
        if (!set) this.#dependents.set(reference, (set = new Set()));
        set.add(own);
      } else {
        const set = this.#dependents.get(reference);
        set?.delete(own);
        if (set?.size === 0) this.#dependents.delete(reference);
      }
    }
  }
  #references(collection: Collection, raw: Value): string[] {
    switch (collection) {
      case "workspaces":
        return [
          key("environments", (raw as Values["workspaces"]).environmentId),
        ];
      case "executionTargets":
        return [
          key(
            "environments",
            (raw as Values["executionTargets"]).environmentId,
          ),
        ];
      case "threads": {
        const value = raw as Values["threads"];
        return [
          key("workspaces", value.workspaceId),
          key("executionTargets", value.targetId),
          ...(value.groupId ? [key("groups", value.groupId)] : []),
        ];
      }
      case "tasks": {
        const value = raw as Values["tasks"];
        return [
          ...(value.associatedWorkspaceId
            ? [key("workspaces", value.associatedWorkspaceId)]
            : []),
          ...(value.scope.kind === "thread"
            ? [key("threads", value.scope.threadId)]
            : []),
        ];
      }
      case "forkOrigins": {
        const value = raw as Values["forkOrigins"];
        return [
          key("threads", value.childThreadId),
          ...(value.sourceThreadId
            ? [key("threads", value.sourceThreadId)]
            : []),
        ];
      }
      case "lineagePlacements":
        return [
          key(
            "forkOrigins",
            (raw as Values["lineagePlacements"]).childThreadId,
          ),
        ];
      case "lineageFamilies":
        return [
          key("threads", (raw as Values["lineageFamilies"]).sourceThreadId),
        ];
      default:
        return [];
    }
  }
  #validate(collection: Collection, raw: Value, get: Lookup): void {
    for (const reference of this.#references(collection, raw)) {
      const [name, id] = referenceParts(reference);
      if (collection === "tasks" && name === "threads") continue;
      assert(get(name, id));
    }
    if (collection === "threads") {
      const value = raw as Values["threads"];
      const workspace = get("workspaces", value.workspaceId)!;
      const target = get("executionTargets", value.targetId)!;
      assert(
        workspace.environmentId === target.environmentId &&
          value.backend.brand === target.backend.brand &&
          value.backend.label.text === target.backend.label.text,
      );
    }
    if (collection === "tasks") {
      const value = raw as Values["tasks"];
      if (value.scope.kind === "thread") {
        const thread = get("threads", value.scope.threadId);
        assert(!thread || value.associatedWorkspaceId === thread.workspaceId);
      }
    }
  }
}
