import { describe, expect, it, vi } from "vitest";
import { ConversationProjector, projectedTurnForkCapability } from "../../src/server/conversations/conversation-projector.js";
import { pagePublicationItemId, prepareApplicationPublications, projectApplicationPublications as applyPreparedPublications, type ApplicationProjectionInput, type PagePublication } from "../../src/server/conversations/application-publication-projection.js";
import { projectConversationItemActivity } from "../../src/server/conversations/thread-activity-projection.js";
import { backendItemSchema, type BackendConversationSnapshot, type BackendItem } from "../../src/shared/protocol/backend.js";
import { conversationTurnSourceRevision, historyPageSchema, MAXIMUM_NORMALIZED_ITEMS_PER_TURN, MAXIMUM_NORMALIZED_TIMELINE_ITEMS, type ConversationItem, type ConversationTurn } from "../../src/shared/protocol/conversation.js";
import { MAXIMUM_MESSAGE_ITEM_BYTES, MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES, serializedUtf8Bytes } from "../../src/shared/protocol/payload.js";
import * as payload from "../../src/shared/protocol/payload.js";
import * as pageProjection from "../../src/server/conversations/application-publication-projection.js";
import { pageRevisionSchema } from "../../src/shared/protocol/pages.js";
import type { ImagePublication } from "../../src/server/conversations/application-publication-projection.js";

function projectApplicationPublications<T extends ApplicationProjectionInput>(timeline: T, publications: readonly PagePublication[], stableIds: ReadonlyMap<string, string>): T {
  return applyPreparedPublications(timeline, prepareApplicationPublications(publications), stableIds);
}

const source = (): BackendConversationSnapshot => ({
  orderedBackendTurnIds: ["native-turn"],
  turnsById: { "native-turn": { backendTurnId: "native-turn", status: "in_progress", orderedBackendItemIds: ["native-user"] } },
  itemsById: { "native-user": { backendItemId: "native-user", backendTurnId: "native-turn", semanticKind: "user_message",
    status: "completed", sourceOrder: 0, content: [{ kind: "text", text: { text: "Make a preview" } }] } },
  runState: "running", activeBackendTurnId: "native-turn",
});
const page = (revision = 1): PagePublication["page"] => ({
  pageId: "22222222-2222-4222-8222-222222222222", threadId: "thread", revision,
  title: "Example", viewport: { width: 390 }, createdAt: "2026-10-11T12:00:00.000Z",
  sha256: "a".repeat(64), byteSize: 123,
});
const historyContext = { branching: { availability: "unavailable" as const, reason: { text: "No forks" } }, sourceRunState: "running" as const };

function shownImage(anchor: ImagePublication["anchor"]): ImagePublication {
  return { anchor, invocationId: "shown-invocation", createdAt: "2026-10-11T12:00:00.001Z",
    image: { representation: "artifact", artifactId: "33333333-3333-4333-8333-333333333333", mimeType: "image/png",
      byteSize: 25, sha256: "b".repeat(64), fileName: { text: "image.png" }, alt: { text: "Results" } } };
}

describe("application shown-image projection", () => {
  it.each(["pi", "codex", "claude", "grok", "opencode"])("joins retained images and pages to exact %s turn anchors, including reload", backendInstanceId => {
    const publications: Array<PagePublication | ImagePublication> = [];
    const projector = new ConversationProjector({ backendInstanceId, bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    const initial = projector.replace(source(), -1);
    const anchor = projector.captureApplicationPublicationAnchor()!;
    publications.push(shownImage(anchor), { page: page(), invocationId: "page-invocation", anchor });
    const events = projector.refreshApplicationPublications();
    expect(events.kind).toBe("events");
    const first = projector.timeline();
    const turn = first.turnsById[anchor.turnId]!;
    expect(turn.orderedItemIds.slice(-2)).toEqual([pagePublicationItemId(page()), "shown_image_33333333-3333-4333-8333-333333333333"]);
    expect(first.itemsById[turn.orderedItemIds.at(-1)!]).toMatchObject({ kind: "image", origin: { kind: "shown" },
      image: { representation: "artifact", alt: { text: "Results" } } });
    expect(projector.refreshApplicationPublications()).toEqual({ kind: "events", events: [] });
    const restored = new ConversationProjector({ backendInstanceId, bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    restored.replace(source(), -1);
    expect(restored.timeline().turnsById[anchor.turnId]!.orderedItemIds).toEqual(turn.orderedItemIds);
    expect(initial.activeTurnId).toBe(anchor.turnId);
    expect(conversationTurnSourceRevision(turn, first.itemsById)).toBe(initial.turnsById[anchor.turnId]!.revision);
  });

  it("omits images with missing anchors and fits them to the same bounded item budget as pages", () => {
    const near = denseTimeline(10);
    const turnId = near.orderedTurnIds.at(-1)!;
    const anchor = { turnId, afterItemId: near.turnsById[turnId]!.orderedItemIds.at(-1)! };
    const image = shownImage(anchor);
    const prepared = prepareApplicationPublications([image, { ...image, image: { ...image.image, artifactId: "44444444-4444-4444-8444-444444444444" }, invocationId: "missing", anchor: { turnId, afterItemId: "absent" } }]);
    const result = applyPreparedPublications(near, prepared, new Map(), { itemCount: MAXIMUM_NORMALIZED_TIMELINE_ITEMS - 1, serializedBytes: serializedUtf8Bytes(near) });
    expect(Object.keys(result.itemsById)).toHaveLength(11);
    expect(Object.values(result.itemsById).filter(item => item.kind === "image")).toHaveLength(1);
    const full = denseTimeline(MAXIMUM_NORMALIZED_TIMELINE_ITEMS);
    expect(applyPreparedPublications(full, prepared, new Map())).toBe(full);
  });
});

function denseTimeline(itemCount: number): { orderedTurnIds: string[]; turnsById: Record<string, ConversationTurn>; itemsById: Record<string, ConversationItem> } {
  const turnsById: Record<string, ConversationTurn> = {};
  const itemsById: Record<string, ConversationItem> = {};
  for (let index = 0; index < itemCount; index++) {
    const turnId = `turn-${Math.floor(index / MAXIMUM_NORMALIZED_ITEMS_PER_TURN)}`;
    const turn = turnsById[turnId] ??= { id: turnId, revision: 0, status: "in_progress", orderedItemIds: [] };
    const id = `item-${index}`;
    turn.orderedItemIds.push(id);
    itemsById[id] = { id, turnId, revision: 0, kind: "notice", status: "completed", tone: "info", text: { text: "Provider item" } };
  }
  return { orderedTurnIds: Object.keys(turnsById), turnsById, itemsById };
}

function publicationFor(timeline: ApplicationProjectionInput, revision = 1): PagePublication {
  const turnId = timeline.orderedTurnIds.at(-1)!;
  return { page: page(revision), invocationId: `invocation-${revision}`,
    anchor: { turnId, afterItemId: timeline.turnsById[turnId]!.orderedItemIds.at(-1)! } };
}

describe("application page publication projection", () => {
  it.each(["pi", "codex", "claude", "grok", "opencode"])("appends immutable revisions on %s without reading provider tool JSON", backendInstanceId => {
    const publications: PagePublication[] = [];
    const projector = new ConversationProjector({ backendInstanceId, bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    const initial = projector.replace(source(), -1);
    const anchor = projector.captureApplicationPublicationAnchor()!;
    publications.push({ page: page(), invocationId: "trusted-invocation-1", anchor });
    const update = projector.refreshApplicationPublications();
    expect(update).toMatchObject({ kind: "events", events: [
      { type: "item_upsert", item: { kind: "page", page: page() } },
      { type: "turn_upsert", turn: { orderedItemIds: [Object.keys(initial.itemsById)[0], pagePublicationItemId(page())] } },
    ] });
    publications.push({ page: page(2), invocationId: "trusted-invocation-2", anchor });
    projector.refreshApplicationPublications();
    const published = projector.timeline();
    expect(published.turnsById[anchor.turnId]!.orderedItemIds).toEqual([
      Object.keys(initial.itemsById)[0], pagePublicationItemId(page()), pagePublicationItemId(page(2)),
    ]);
    expect(published.itemsById[pagePublicationItemId(page())]).toMatchObject({ page: { revision: 1 } });
    expect(projector.refreshApplicationPublications()).toEqual({ kind: "events", events: [] });
    expect(projectConversationItemActivity(published.itemsById[pagePublicationItemId(page())]!, "summary"))
      .toEqual(published.itemsById[pagePublicationItemId(page())]);
    const { runState: _run, activeBackendTurnId: _active, ...history } = source();
    const historical = projector.projectHistoryPage(history, historyContext);
    expect(historical.itemsById).toEqual(published.itemsById);
    expect(projector.projectHistoryPage(history, historyContext)).toEqual(historical);
    expect(historical.forksByTurnId[anchor.turnId]?.expectedTurnRevision).toBe(0);
    expect(projector.sourceTurnRevision(anchor.turnId)).toBe(0);
    expect(projector.resolveCurrentTurn(anchor.turnId)?.turn.revision).toBe(0);
    expect(projector.resolveHistoryTurn(history, anchor.turnId)?.turn.revision).toBe(0);
    const restarted = new ConversationProjector({ backendInstanceId, bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    expect(restarted.replace(source(), -1).itemsById).toEqual(published.itemsById);
  });

  it("keeps a live provisional tool anchor at the same native item after a cold projection", () => {
    const publications: PagePublication[] = [];
    const projector = new ConversationProjector({ backendInstanceId: "pi", bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    projector.replace(source(), -1);
    const tool: BackendItem = { backendItemId: "native-tool", backendTurnId: "native-turn", semanticKind: "tool", sourceOrder: 1,
      status: "streaming", phase: "preflight_or_executing", toolName: { text: "sedes_page_publish" }, title: { text: "Publish page" }, category: "other" };
    projector.apply({ handleSequence: 0, event: { type: "item_started", item: tool } });
    const liveTool = projector.itemForBackendId(tool.backendItemId)!;
    const anchor = projector.captureApplicationPublicationAnchor()!;
    expect(anchor.afterItemId).not.toBe(liveTool.id);
    publications.push({ page: page(), invocationId: "trusted", anchor });
    projector.refreshApplicationPublications();
    expect(projector.timeline().turnsById[anchor.turnId]!.orderedItemIds.slice(-2))
      .toEqual([liveTool.id, pagePublicationItemId(page())]);
    const cold = source();
    cold.itemsById[tool.backendItemId] = tool;
    cold.turnsById[tool.backendTurnId]!.orderedBackendItemIds.push(tool.backendItemId);
    const rebuilt = projector.replace(cold, 0);
    expect(rebuilt.turnsById[anchor.turnId]!.orderedItemIds.slice(-2)).toEqual([anchor.afterItemId, pagePublicationItemId(page())]);
    expect(Object.values(rebuilt.itemsById).filter(item => item.kind === "page")).toHaveLength(1);
  });

  it("never renders provider-authored page descriptors or pages whose original anchor disappeared", () => {
    const publications: PagePublication[] = [];
    const projector = new ConversationProjector({ backendInstanceId: "codex", bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    const native = source();
    native.itemsById["native-user"] = { backendItemId: "native-user", backendTurnId: "native-turn", semanticKind: "assistant_message", status: "completed", sourceOrder: 0,
      markdown: { text: JSON.stringify({ page: page(), invocationId: "not-a-receipt" }) } };
    projector.replace(native, -1);
    expect(Object.values(projector.timeline().itemsById).some(item => item.kind === "page")).toBe(false);
    const anchor = projector.captureApplicationPublicationAnchor()!;
    publications.push({ page: page(), invocationId: "trusted", anchor: { ...anchor, afterItemId: "missing" } });
    publications.push({ page: page(2), invocationId: "trusted-2", anchor: { turnId: "other-thread-turn" } });
    expect(projector.refreshApplicationPublications()).toEqual({ kind: "events", events: [] });
    expect(Object.values(projector.timeline().itemsById).some(item => item.kind === "page")).toBe(false);
    expect(backendItemSchema.safeParse({ backendItemId: "spoof", backendTurnId: "native-turn", semanticKind: "page",
      status: "completed", sourceOrder: 1, page: page() }).success).toBe(false);
  });

  it("does not erase page occurrences on later native turn/item updates", () => {
    const publications: PagePublication[] = [];
    const projector = new ConversationProjector({ backendInstanceId: "codex", bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    projector.replace(source(), -1);
    const anchor = projector.captureApplicationPublicationAnchor()!;
    publications.push({ page: page(), invocationId: "trusted", anchor });
    projector.refreshApplicationPublications();
    const assistant: BackendItem = { backendItemId: "reply", backendTurnId: "native-turn", semanticKind: "assistant_message", sourceOrder: 1,
      status: "completed", markdown: { text: "Ready" } };
    const result = projector.apply({ handleSequence: 0, event: { type: "item_completed", item: assistant } });
    expect(result).toMatchObject({ kind: "events", events: [
      { type: "item_upsert" }, { type: "turn_upsert", turn: { orderedItemIds: [expect.any(String), pagePublicationItemId(page()), expect.any(String)] } },
    ] });
    expect(projector.timeline().turnsById[anchor.turnId]!.orderedItemIds).toHaveLength(3);
  });

  it("leaves pages in the library when provider items consume the per-turn capacity", () => {
    const full = denseTimeline(MAXIMUM_NORMALIZED_ITEMS_PER_TURN);
    expect(projectApplicationPublications(full, [publicationFor(full)], new Map())).toBe(full);
    const near = denseTimeline(MAXIMUM_NORMALIZED_ITEMS_PER_TURN - 1);
    const result = projectApplicationPublications(near, [publicationFor(near), publicationFor(near, 2)], new Map());
    expect(result.turnsById[near.orderedTurnIds[0]!]!.orderedItemIds).toHaveLength(MAXIMUM_NORMALIZED_ITEMS_PER_TURN);
    expect(result.itemsById[pagePublicationItemId(page())]).toBeDefined();
    expect(result.itemsById[pagePublicationItemId(page(2))]).toBeUndefined();
    expect(Object.entries(near.itemsById).every(([id, item]) => result.itemsById[id] === item)).toBe(true);
  });

  it("does not exceed the whole-timeline item ceiling or remove any native item", () => {
    const near = denseTimeline(MAXIMUM_NORMALIZED_TIMELINE_ITEMS - 1);
    const result = projectApplicationPublications(near, [publicationFor(near), publicationFor(near, 2)], new Map());
    expect(Object.keys(result.itemsById)).toHaveLength(MAXIMUM_NORMALIZED_TIMELINE_ITEMS);
    expect(result.itemsById[pagePublicationItemId(page())]).toBeDefined();
    expect(result.itemsById[pagePublicationItemId(page(2))]).toBeUndefined();
    const full = denseTimeline(MAXIMUM_NORMALIZED_TIMELINE_ITEMS);
    expect(projectApplicationPublications(full, [publicationFor(full)], new Map())).toBe(full);
    expect(Object.keys(near.itemsById)).toHaveLength(MAXIMUM_NORMALIZED_TIMELINE_ITEMS - 1);
  });

  it("preserves a native timeline near the serialized byte ceiling instead of overflowing it with page metadata", () => {
    const near = denseTimeline(3);
    for (const [id, item] of Object.entries(near.itemsById)) {
      near.itemsById[id] = { id, turnId: item.turnId, revision: 0, kind: "assistant_message", status: "completed", markdown: { text: "" } };
    }
    const overhead = serializedUtf8Bytes(near);
    const first = near.itemsById["item-0"];
    const second = near.itemsById["item-1"];
    const third = near.itemsById["item-2"];
    if (first?.kind !== "assistant_message" || second?.kind !== "assistant_message" || third?.kind !== "assistant_message") throw new Error("fixture");
    first.markdown.text = "a".repeat(MAXIMUM_MESSAGE_ITEM_BYTES - 512);
    second.markdown.text = "b".repeat(8 * 1_024 * 1_024);
    third.markdown.text = "c".repeat(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - overhead - first.markdown.text.length - second.markdown.text.length - 32);
    expect(serializedUtf8Bytes(near)).toBe(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - 32);
    expect(projectApplicationPublications(near, [publicationFor(near)], new Map())).toBe(near);
    third.markdown.text = third.markdown.text.slice(0, -2_000);
    const result = projectApplicationPublications(near, [publicationFor(near), publicationFor(near, 2)], new Map());
    expect(Object.values(result.itemsById).filter(item => item.kind === "page")).toHaveLength(2);
    expect(serializedUtf8Bytes(result)).toBeLessThanOrEqual(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES);
    expect(result.itemsById["item-0"]).toBe(first);
    expect(result.itemsById["item-1"]).toBe(second);
  });

  it("keeps source fork revisions fixed while admitting page metadata at the exact byte boundary", () => {
    const base = denseTimeline(3);
    for (const [id, item] of Object.entries(base.itemsById)) base.itemsById[id] = {
      id, turnId: item.turnId, revision: 0, kind: "assistant_message", status: "completed", markdown: { text: "" },
    };
    const turnId = base.orderedTurnIds[0]!;
    base.turnsById[turnId]!.revision = 9;
    const unavailable = { available: false as const, unavailableReason: { text: "No forks" } };
    const history = { ...base, forksByTurnId: { [turnId]: { ...unavailable, sourceTurnId: turnId, expectedTurnRevision: 9 } },
      forkSource: { selectedCompletedTurn: unavailable, latestProviderSnapshot: unavailable } };
    const publications = [publicationFor(base)];
    const finalize = (value: typeof history) => ({ ...value, forksByTurnId: { [turnId]: {
      ...value.forksByTurnId[turnId]!, expectedTurnRevision: conversationTurnSourceRevision(value.turnsById[turnId]!, value.itemsById),
    } } });
    const cost = serializedUtf8Bytes(finalize(projectApplicationPublications(history, publications, new Map()))) - serializedUtf8Bytes(history);
    const messages = Object.values(history.itemsById).filter(item => item.kind === "assistant_message");
    messages[0]!.markdown.text = "a".repeat(MAXIMUM_MESSAGE_ITEM_BYTES - 512);
    messages[1]!.markdown.text = "b".repeat(8 * 1_024 * 1_024);
    messages[2]!.markdown.text = "c".repeat(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - cost + 1 - serializedUtf8Bytes(history));
    // The presentation advances 9 -> 10 while fork authority remains at source revision 9.
    expect(projectApplicationPublications(history, publications, new Map())).toBe(history);
    messages[2]!.markdown.text = messages[2]!.markdown.text.slice(0, -1);
    const projected = finalize(projectApplicationPublications(history, publications, new Map()));
    expect(projected.turnsById[turnId]!.revision).toBe(10);
    expect(projected.forksByTurnId[turnId]!.expectedTurnRevision).toBe(9);
    expect(serializedUtf8Bytes(projected)).toBe(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES);
    expect(historyPageSchema.safeParse(projected).success).toBe(true);
  });

  it("resnapshots once when native growth consumes an already-visible page slot", () => {
    const native = source();
    const nativeTurn = native.turnsById["native-turn"]!;
    for (let index = 1; index < MAXIMUM_NORMALIZED_ITEMS_PER_TURN - 1; index++) {
      const id = `native-${index}`;
      nativeTurn.orderedBackendItemIds.push(id);
      native.itemsById[id] = { backendItemId: id, backendTurnId: "native-turn", semanticKind: "notice", sourceOrder: index,
        status: "completed", tone: "info", text: { text: "Native" } };
    }
    const publications: PagePublication[] = [];
    const projector = new ConversationProjector({ backendInstanceId: "codex", bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    projector.replace(native, -1);
    const anchor = projector.captureApplicationPublicationAnchor()!;
    publications.push({ page: page(), invocationId: "trusted", anchor });
    projector.refreshApplicationPublications();
    expect(projector.timeline().itemsById[pagePublicationItemId(page())]).toBeDefined();
    const previousGeneration = projector.generation;
    const item: BackendItem = { backendItemId: "native-final", backendTurnId: "native-turn", semanticKind: "notice",
      sourceOrder: MAXIMUM_NORMALIZED_ITEMS_PER_TURN - 1, status: "completed", tone: "info", text: { text: "Native final item" } };
    expect(projector.apply({ handleSequence: 0, event: { type: "item_completed", item } })).toEqual({
      kind: "resnapshot_required", reason: "page_overlay_capacity_changed",
    });
    native.itemsById[item.backendItemId] = item;
    nativeTurn.orderedBackendItemIds.push(item.backendItemId);
    const rebuilt = projector.replace(native, 0);
    expect(rebuilt.generation).not.toBe(previousGeneration);
    expect(rebuilt.turnsById[anchor.turnId]!.orderedItemIds).toHaveLength(MAXIMUM_NORMALIZED_ITEMS_PER_TURN);
    expect(rebuilt.itemsById[pagePublicationItemId(page())]).toBeUndefined();
    expect(Object.keys(rebuilt.itemsById)).toHaveLength(MAXIMUM_NORMALIZED_ITEMS_PER_TURN);
    expect(projector.refreshApplicationPublications()).toEqual({ kind: "events", events: [] });
    expect(projector.apply({ handleSequence: 1, event: { type: "run_state_changed", state: "running", activeBackendTurnId: "native-turn" } }))
      .toMatchObject({ kind: "events" });
    const { runState: _run, activeBackendTurnId: _active, ...history } = native;
    expect(projector.projectHistoryPage(history, historyContext).itemsById).toEqual(rebuilt.itemsById);
  });

  it("keeps source fork revisions equal when shared and targeted budgets show different pages", () => {
    const base = denseTimeline(3);
    base.orderedTurnIds = ["first-turn", "second-turn", "last-turn"];
    base.turnsById = {};
    for (const [index, id] of ["item-0", "item-1", "item-2"].entries()) {
      const turnId = base.orderedTurnIds[index]!;
      base.turnsById[turnId] = { id: turnId, revision: 0, status: "completed", endedBy: "agent_settled", orderedItemIds: [id] };
      base.itemsById[id] = { id, turnId, revision: 0, kind: "assistant_message", status: "completed", markdown: { text: "" } };
    }
    const messages = Object.values(base.itemsById).filter(item => item.kind === "assistant_message");
    messages[0]!.markdown.text = "a".repeat(MAXIMUM_MESSAGE_ITEM_BYTES - 512);
    messages[1]!.markdown.text = "b".repeat(8 * 1_024 * 1_024);
    messages[2]!.markdown.text = "c".repeat(MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - 32 - serializedUtf8Bytes(base));
    const publication = publicationFor(base);
    const shared = projectApplicationPublications(base, [publication], new Map());
    expect(shared).toBe(base);
    const targeted = projectApplicationPublications({ orderedTurnIds: ["last-turn"],
      turnsById: { "last-turn": base.turnsById["last-turn"]! }, itemsById: { "item-2": base.itemsById["item-2"]! } }, [publication], new Map());
    expect(targeted.turnsById["last-turn"]!.revision).toBe(1);
    for (const timeline of [shared, targeted]) {
      expect(projectedTurnForkCapability({ turn: timeline.turnsById["last-turn"]!, itemsById: timeline.itemsById,
        ...historyContext }).expectedTurnRevision).toBe(0);
    }
  });

  it.each([false, true])("uses cached page placement without copying the full timeline during streamed updates (page: %s)", withPage => {
    const native = source();
    const user = native.itemsById["native-user"];
    if (user?.semanticKind !== "user_message") throw new Error("fixture");
    user.content = [{ kind: "text", text: { text: "x".repeat(4 * 1_024 * 1_024) } }];
    const publications: PagePublication[] = [];
    const projector = new ConversationProjector({ backendInstanceId: "pi", bindingIdentity: "thread", resolveApplicationPublications: () => publications });
    projector.replace(native, -1);
    if (withPage) {
      publications.push({ page: page(), invocationId: "trusted", anchor: projector.captureApplicationPublicationAnchor()! });
      projector.refreshApplicationPublications();
    }
    projector.apply({ handleSequence: 0, event: { type: "item_started", item: {
      backendItemId: "streaming-answer", backendTurnId: "native-turn", semanticKind: "assistant_message", status: "streaming",
      sourceOrder: 1, markdown: { text: "answer" },
    } } });
    const bytes = vi.spyOn(payload, "serializedUtf8Bytes");
    const parsing = vi.spyOn(pageRevisionSchema, "parse");
    const placement = vi.spyOn(pageProjection, "projectApplicationPublications");
    const timeline = vi.spyOn(projector, "timeline");
    try {
      for (let index = 0; index < 100; index++) expect(Boolean(projector.timeline().itemsById[pagePublicationItemId(page())])).toBe(withPage);
      timeline.mockClear();
      for (let index = 1; index <= 10; index++) projector.apply({ handleSequence: index, event: {
        type: "item_updated",
        item: { backendItemId: "streaming-answer", backendTurnId: "native-turn", semanticKind: "assistant_message", status: "streaming",
          sourceOrder: 1, markdown: { text: "answer".repeat(index + 1) } },
      } });
      expect(parsing).not.toHaveBeenCalled();
      expect(placement).not.toHaveBeenCalled();
      expect(timeline).not.toHaveBeenCalled();
      expect(bytes.mock.calls.some(([value]) => value !== null && typeof value === "object" && "itemsById" in value)).toBe(false);
    } finally { bytes.mockRestore(); parsing.mockRestore(); placement.mockRestore(); timeline.mockRestore(); }
  });

  it("replaces the generation when a previously omitted page becomes visible during another turn's update", () => {
    let admit = false;
    const actual = pageProjection.projectApplicationPublications;
    const gate = vi.spyOn(pageProjection, "projectApplicationPublications").mockImplementation((timeline, publications, stable, baseline) =>
      admit ? actual(timeline, publications, stable, baseline) : timeline);
    try {
      const native = source();
      const publications: PagePublication[] = [];
      const projector = new ConversationProjector({ backendInstanceId: "pi", bindingIdentity: "thread", resolveApplicationPublications: () => publications });
      projector.replace(native, -1);
      const generation = projector.generation;
      const anchor = projector.captureApplicationPublicationAnchor()!;
      publications.push({ page: page(), invocationId: "trusted", anchor });
      expect(projector.refreshApplicationPublications()).toEqual({ kind: "events", events: [] });
      admit = true;
      const otherTurn = { backendTurnId: "other-turn", status: "completed" as const, endedBy: "agent_settled" as const, orderedBackendItemIds: [] };
      expect(projector.apply({ handleSequence: 0, event: { type: "turn_completed", turn: otherTurn } })).toEqual({
        kind: "resnapshot_required", reason: "page_overlay_capacity_changed",
      });
      native.orderedBackendTurnIds.push("other-turn");
      native.turnsById["other-turn"] = otherTurn;
      const rebuilt = projector.replace(native, 0);
      expect(rebuilt.generation).not.toBe(generation);
      expect(rebuilt.itemsById[pagePublicationItemId(page())]).toBeDefined();
      expect(rebuilt.turnsById[anchor.turnId]!.orderedItemIds).toContain(pagePublicationItemId(page()));
      expect(projector.refreshApplicationPublications()).toEqual({ kind: "events", events: [] });
    } finally { gate.mockRestore(); }
  });
});
