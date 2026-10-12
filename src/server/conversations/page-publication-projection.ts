import { pagePublicationAnchorSchema, pageRevisionSchema, type PagePublicationAnchor, type PageRevision } from "../../shared/protocol/pages.js";
import { MAXIMUM_NORMALIZED_ITEMS_PER_TURN, MAXIMUM_NORMALIZED_TIMELINE_ITEMS,
  pageItemSchema, type ConversationItem, type ConversationTurn, type PageItem } from "../../shared/protocol/conversation.js";
import { MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES, serializedUtf8Bytes } from "../../shared/protocol/payload.js";
import type { ProjectedConversationTimeline } from "./conversation-projector.js";

/** Only the scoped application repository may supply these records. Provider text is never a publication receipt. */
export interface PagePublication {
  readonly page: PageRevision;
  readonly invocationId: string;
  readonly anchor: PagePublicationAnchor;
}

export type PagePublicationResolver = (turnIds: readonly string[]) => readonly PagePublication[];

export type PageProjectionInput = Pick<ProjectedConversationTimeline, "orderedTurnIds" | "turnsById" | "itemsById">;

interface PreparedPagePublication {
  readonly id: string;
  readonly item: PageItem;
  readonly entryBytes: number;
  readonly referenceBytes: number;
}

export interface PreparedPagePublications {
  readonly count: number;
  readonly byTurn: ReadonlyMap<string, ReadonlyMap<string | undefined, readonly PreparedPagePublication[]>>;
}

export interface PageProjectionBaseline {
  readonly itemCount: number;
  readonly serializedBytes: number;
}

/** Fit only optional pages to the complete application snapshot's byte budget. */
export function fitPageItemsToSnapshot<T extends PageProjectionInput>(
  snapshot: T,
  knownBytes = serializedUtf8Bytes(snapshot),
  knownPages?: ReadonlyMap<string, PageItem>,
  knownItemCount?: number,
): { snapshot: T; serializedBytes: number; pageIds: ReadonlySet<string> } {
  const pages = knownPages ?? new Map(Object.entries(snapshot.itemsById).filter((entry): entry is [string, PageItem] => entry[1].kind === "page"));
  if (pages.size === 0) return { snapshot, serializedBytes: knownBytes, pageIds: new Set() };
  const sourceItemCount = knownItemCount ?? Object.keys(snapshot.itemsById).length;
  if (knownBytes <= MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES &&
      sourceItemCount <= MAXIMUM_NORMALIZED_TIMELINE_ITEMS) {
    const references = new Map<string, Set<string>>();
    let allReferenced = true;
    for (const [id, item] of pages) {
      let ids = references.get(item.turnId);
      if (!ids) {
        ids = new Set(snapshot.turnsById[item.turnId]?.orderedItemIds);
        references.set(item.turnId, ids);
      }
      if (!ids.has(id)) { allReferenced = false; break; }
    }
    if (allReferenced) return { snapshot, serializedBytes: knownBytes, pageIds: new Set(pages.keys()) };
  }
  const turnsById = { ...snapshot.turnsById };
  const itemsById = { ...snapshot.itemsById };
  let bytes = knownBytes;
  let itemCount = sourceItemCount;
  for (const [id, item] of pages) {
    bytes -= serializedUtf8Bytes({ [id]: item }) - 2 + (itemCount > 1 ? 1 : 0);
    delete itemsById[id];
    itemCount--;
  }
  for (const [turnId, turn] of Object.entries(turnsById)) {
    const orderedItemIds = turn.orderedItemIds.filter(id => !pages.has(id));
    const removed = turn.orderedItemIds.length - orderedItemIds.length;
    if (removed === 0) continue;
    const nativeTurn = { ...turn, revision: turn.revision - removed, orderedItemIds };
    bytes += serializedUtf8Bytes(nativeTurn) - serializedUtf8Bytes(turn);
    turnsById[turnId] = nativeTurn;
  }
  const pageIds = new Set<string>();
  for (const turnId of snapshot.orderedTurnIds) {
    const original = snapshot.turnsById[turnId]!;
    const nativeTurn = turnsById[turnId]!;
    const orderedItemIds: string[] = [];
    let added = 0;
    for (const id of original.orderedItemIds) {
      const page = pages.get(id);
      if (!page) { orderedItemIds.push(id); continue; }
      if (itemCount >= MAXIMUM_NORMALIZED_TIMELINE_ITEMS ||
          nativeTurn.orderedItemIds.length + added >= MAXIMUM_NORMALIZED_ITEMS_PER_TURN) continue;
      const revision = nativeTurn.revision + added + 1;
      const cost = serializedUtf8Bytes({ [id]: page }) - 2 + (itemCount > 0 ? 1 : 0) +
        serializedUtf8Bytes(id) + (nativeTurn.orderedItemIds.length + added > 0 ? 1 : 0) +
        String(revision).length - String(revision - 1).length;
      if (bytes + cost > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES) continue;
      bytes += cost;
      itemCount++;
      added++;
      itemsById[id] = page;
      pageIds.add(id);
      orderedItemIds.push(id);
    }
    if (added > 0) turnsById[turnId] = { ...nativeTurn, revision: nativeTurn.revision + added, orderedItemIds };
  }
  if (pageIds.size === pages.size) return { snapshot, serializedBytes: knownBytes, pageIds };
  return { snapshot: { ...snapshot, turnsById, itemsById }, serializedBytes: bytes, pageIds };
}

export function pagePublicationItemId(page: PageRevision): string {
  return `page_${page.pageId}_${page.revision}`;
}

/** Parse durable metadata once per repository read, never once per streamed token. */
export function preparePagePublications(publications: readonly PagePublication[]): PreparedPagePublications {
  const byTurn = new Map<string, Map<string | undefined, PreparedPagePublication[]>>();
  const seen = new Set<string>();
  for (const publication of publications) {
    const anchor = pagePublicationAnchorSchema.parse(publication.anchor);
    const page = pageRevisionSchema.parse(publication.page);
    const id = pagePublicationItemId(page);
    if (seen.has(id)) continue;
    seen.add(id);
    const item = pageItemSchema.parse({ id, turnId: anchor.turnId, kind: "page", status: "completed", revision: 0,
      completedAt: page.createdAt, page });
    const byAnchor = byTurn.get(anchor.turnId) ?? new Map<string | undefined, PreparedPagePublication[]>();
    const siblings = byAnchor.get(anchor.afterItemId) ?? [];
    siblings.push({ id, item, entryBytes: serializedUtf8Bytes({ [id]: item }) - 2, referenceBytes: serializedUtf8Bytes(id) });
    byAnchor.set(anchor.afterItemId, siblings);
    byTurn.set(anchor.turnId, byAnchor);
  }
  return { count: seen.size, byTurn };
}

/** Join application documents to provider-owned turns without creating a second transcript. */
export function projectPagePublications<T extends PageProjectionInput>(
  timeline: T,
  publications: PreparedPagePublications,
  stableItemIds: ReadonlyMap<string, string>,
  baseline?: PageProjectionBaseline,
): T {
  if (publications.count === 0) return timeline;
  let itemCount = baseline?.itemCount ?? Object.keys(timeline.itemsById).length;
  if (itemCount >= MAXIMUM_NORMALIZED_TIMELINE_ITEMS) return timeline;
  let serializedBytes = baseline?.serializedBytes ?? serializedUtf8Bytes(timeline);
  if (serializedBytes >= MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES) return timeline;
  const turnsById: Record<string, ConversationTurn> = { ...timeline.turnsById };
  const itemsById: Record<string, ConversationItem> = { ...timeline.itemsById };
  let totalAdded = 0;
  for (const [turnId, byAnchor] of publications.byTurn) {
    const turn = turnsById[turnId];
    if (!turn) continue;
    if (turn.orderedItemIds.length >= MAXIMUM_NORMALIZED_ITEMS_PER_TURN) continue;
    const orderedItemIds: string[] = [];
    let added = 0;
    const append = (afterItemId: string | undefined) => {
      for (const publication of byAnchor.get(afterItemId) ?? []) {
        if (itemCount >= MAXIMUM_NORMALIZED_TIMELINE_ITEMS ||
            turn.orderedItemIds.length + added >= MAXIMUM_NORMALIZED_ITEMS_PER_TURN) break;
        const { id, item } = publication;
        if (itemsById[id]) continue;
        const nextRevision = turn.revision + added + 1;
        if (!Number.isSafeInteger(nextRevision)) continue;
        const revisionBytes = String(nextRevision).length - String(nextRevision - 1).length;
        // Fork authority retains the source revision; only presentation advances.
        const additionalBytes = publication.entryBytes + (itemCount > 0 ? 1 : 0) +
          publication.referenceBytes + (turn.orderedItemIds.length + added > 0 ? 1 : 0) + revisionBytes;
        if (serializedBytes + additionalBytes > MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES) continue;
        serializedBytes += additionalBytes;
        itemsById[id] = item;
        orderedItemIds.push(id);
        added++;
        totalAdded++;
        itemCount++;
      }
    };
    append(undefined);
    for (const itemId of turn.orderedItemIds) {
      orderedItemIds.push(itemId);
      append(stableItemIds.get(itemId) ?? itemId);
    }
    // Missing anchors (compaction, changed native branch) stay in the document library;
    // never reattach them to a guessed turn/item or another thread.
    if (added > 0) turnsById[turnId] = { ...turn, orderedItemIds, revision: turn.revision + added };
  }
  return totalAdded > 0 ? { ...timeline, turnsById, itemsById } : timeline;
}
