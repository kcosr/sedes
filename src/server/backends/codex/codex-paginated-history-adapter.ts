import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { BackendError } from "../contracts.js";
import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import {
  CODEX_C1_MAX_ITEMS_PER_TURN,
  CODEX_C1_MAX_THREAD_ITEMS_PAGE_ITEMS,
  CODEX_C1_MAX_TURNS_PAGE_ITEMS,
  codexThreadReadMethod,
  codexThreadItemsListMethod,
  codexThreadTurnsListMethod,
  type CodexThread,
  type CodexThreadItem,
  type CodexThreadResumeResponse,
  type CodexTurn,
} from "./codex-c1-protocol.js";
import {
  codexBackendTurnId,
  codexNativeHistoryVisibleTurnCount,
} from "./codex-history-projector.js";
import type { CodexSubmissionCorrelationScope } from "./codex-submission-correlation.js";
import { CODEX_HISTORY_TIMEOUT_MILLISECONDS } from "./codex-history-timeouts.js";

const CURRENT_HEAD_REFRESH_TIMEOUT_MILLISECONDS = 1_000;
const CURSOR_PREFIX = "codex-paginated-history:v1:";
const MAXIMUM_NORMALIZED_CURSOR_CHARACTERS = 512;
const RECENT_PROVIDER_CURSOR_WINDOW = 8;

type ProviderCursorState = {
  readonly mode: "paginated";
  readonly threadId: string;
  readonly generation: number;
  readonly sortDirection: "desc";
  readonly itemsView: "notLoaded";
  readonly providerCursor: string;
  readonly skip: number;
};

type PageSegment = {
  readonly providerCursor: string;
  readonly initialSkip: number;
  readonly nativeTurnIds: readonly string[];
  readonly visibleNativeTurnIds: readonly string[];
  readonly nextProviderCursor: string | null;
};

export type CodexPaginatedHistoryPageSource = {
  readonly syntheticNativeTurnIds: readonly string[];
  readonly segments: readonly PageSegment[];
};

export type CodexPaginatedNativePage = {
  readonly thread: CodexThread;
  readonly source: CodexPaginatedHistoryPageSource;
};

export type CodexPaginatedUserMessageEvidence = {
  readonly matched: boolean;
  readonly duplicate: boolean;
  readonly terminalTurn?: CodexTurn;
};

export type CodexPaginatedCompletedTurnEvidence = {
  readonly turn: CodexTurn;
};

export type CodexPaginatedTurnLocation =
  | { readonly status: "found"; readonly turn: CodexTurn }
  | { readonly status: "not_found" }
  | { readonly status: "search_limit_reached" };

export class CodexPaginatedHistoryAdapter {
  readonly #client: CodexSharedClientFacade;
  readonly #thread: CodexThread;
  readonly #generation: number;
  readonly #correlationScope: CodexSubmissionCorrelationScope;
  readonly #cursorKey = randomBytes(32);
  readonly #currentCursorAfterVisibleTurn = new Map<string, string>();
  #currentCursorBeforeSource: string | undefined;
  #currentSourceVisibleTurnIds: readonly string[] = [];

  constructor(input: {
    readonly client: CodexSharedClientFacade;
    readonly thread: CodexThread;
    readonly generation: number;
    readonly correlationScope: CodexSubmissionCorrelationScope;
  }) {
    if (
      input.thread.historyMode !== "paginated" ||
      input.thread.turns.length !== 0
    ) {
      throw protocolError(
        "Codex returned an invalid paginated thread shell.",
        "codex_paginated_thread_shell_invalid",
      );
    }
    this.#client = input.client;
    this.#thread = input.thread;
    this.#generation = input.generation;
    this.#correlationScope = input.correlationScope;
  }

  async bootstrap(
    resume: CodexThreadResumeResponse,
    signal: AbortSignal,
  ): Promise<CodexPaginatedNativePage> {
    return await this.#withAcquisitionDeadline(
      signal,
      async (bounded) => await this.#bootstrapWithinDeadline(resume, bounded),
    );
  }

  async #bootstrapWithinDeadline(
    resume: CodexThreadResumeResponse,
    signal: AbortSignal,
  ): Promise<CodexPaginatedNativePage> {
    if (
      resume.thread.id !== this.#thread.id ||
      resume.thread.historyMode !== "paginated" ||
      resume.thread.turns.length !== 0 ||
      resume.initialTurnsPage === null
    ) {
      throw protocolError(
        "Codex did not return the required paginated resume page.",
        "codex_paginated_initial_page_missing",
      );
    }
    const initial = resume.initialTurnsPage;
    const activeShell =
      this.#thread.status.type === "active" &&
      initial.data[0]?.status === "inProgress"
        ? initial.data[0]
        : undefined;
    if (this.#thread.status.type === "active" && !activeShell) {
      throw reconciliationError(
        "Codex paginated history changed while the active turn was resuming.",
      );
    }
    if (activeShell) {
      const durableHead = await this.#requestTurns(undefined, 1, signal);
      if (durableHead.data[0]?.id !== activeShell.id) {
        throw reconciliationError(
          "The active Codex turn is not yet available from durable paginated history.",
          "codex_paginated_active_overlay_unavailable",
        );
      }
      if (
        durableHead.backwardsCursor !== resume.turnsBackwardsCursor ||
        durableHead.data[0].status !== "inProgress"
      ) {
        throw reconciliationError(
          "Codex paginated history changed while the durable active turn was resuming.",
        );
      }
    }
    const syntheticNativeTurnIds: readonly string[] = [];
    const durableShells = initial.data;
    if (
      durableShells.length > 0 &&
      (resume.turnsBackwardsCursor === null ||
        initial.backwardsCursor !== resume.turnsBackwardsCursor)
    ) {
      throw reconciliationError(
        "Codex paginated history changed while its head cursor was resuming.",
        "codex_paginated_head_cursor_invalid",
      );
    }
    const firstSegment =
      durableShells.length === 0
        ? undefined
        : {
            providerCursor: resume.turnsBackwardsCursor!,
            initialSkip: 0,
            nativeTurnIds: durableShells.map(({ id }) => id),
            nextProviderCursor: initial.nextCursor,
          };
    const hydrated = await this.#hydrateTurnShells(
      initial.data,
      signal,
      resume.itemsBackwardsCursor,
    );
    const visible = this.#visibleTurns(hydrated);
    let page: CodexPaginatedNativePage = {
      thread: { ...this.#thread, turns: [...visible].reverse() },
      source: {
        syntheticNativeTurnIds,
        segments: firstSegment
          ? [
              {
                ...firstSegment,
                visibleNativeTurnIds: visible.map(({ id }) => id),
              },
            ]
          : [],
      },
    };
    if (initial.nextCursor !== null) {
      const older = await this.#loadFromState(
        {
          mode: "paginated",
          threadId: this.#thread.id,
          generation: this.#generation,
          sortDirection: "desc",
          itemsView: "notLoaded",
          providerCursor: initial.nextCursor,
          skip: 0,
        },
        Math.max(1, 10 - page.thread.turns.length),
        signal,
      );
      const currentSegments =
        older.thread.turns.length === 0 &&
        older.source.segments.at(-1)?.nextProviderCursor === null
          ? page.source.segments.map((segment, index, segments) =>
              index === segments.length - 1
                ? { ...segment, nextProviderCursor: null }
                : segment,
            )
          : page.source.segments;
      page = {
        thread: {
          ...page.thread,
          turns: older.thread.turns.concat(page.thread.turns),
        },
        source: {
          syntheticNativeTurnIds: [],
          segments: currentSegments.concat(older.source.segments),
        },
      };
    }
    return page;
  }

  async page(
    cursor: string,
    visibleLimit: number,
    signal?: AbortSignal,
  ): Promise<CodexPaginatedNativePage> {
    const state = this.#parseCursor(cursor);
    const callerSignal = signal ?? new AbortController().signal;
    callerSignal.throwIfAborted();
    return await this.#withAcquisitionDeadline(
      callerSignal,
      async (bounded) =>
        await this.#loadFromState(state, visibleLimit, bounded),
    );
  }

  async readDetachedHead(
    visibleLimit: number,
    signal: AbortSignal,
  ): Promise<CodexThread> {
    return await this.#withAcquisitionDeadline(
      signal,
      async (bounded) =>
        await this.#readDetachedHeadWithinDeadline(visibleLimit, bounded),
    );
  }

  async refreshCurrentHead(
    visibleLimit: number,
    signal: AbortSignal,
  ): Promise<CodexPaginatedNativePage> {
    return await this.#withAcquisitionDeadline(
      signal,
      async (bounded) =>
        await this.#refreshCurrentHeadWithinDeadline(visibleLimit, bounded),
      CURRENT_HEAD_REFRESH_TIMEOUT_MILLISECONDS,
    );
  }

  async #refreshCurrentHeadWithinDeadline(
    visibleLimit: number,
    signal: AbortSignal,
  ): Promise<CodexPaginatedNativePage> {
    let cursor: string | undefined;
    const newestFirst: CodexTurn[] = [];
    const segments: PageSegment[] = [];
    const seenCursors = new RecentCursorCycleDetector();
    let nativeHeadInProgress = false;
    let inspectedNativeHead = false;
    for (;;) {
      const response = await this.#requestTurns(
        cursor,
        Math.min(
          CODEX_C1_MAX_TURNS_PAGE_ITEMS,
          Math.max(1, visibleLimit - newestFirst.length),
        ),
        signal,
      );
      if (!inspectedNativeHead) {
        nativeHeadInProgress = response.data[0]?.status === "inProgress";
        inspectedNativeHead = true;
      }
      const seekingLookahead = newestFirst.length >= visibleLimit;
      const hydrated = seekingLookahead
        ? await this.#hydrateUntilFirstVisibleTurn(response.data, signal)
        : await this.#hydrateTurnShells(response.data, signal);
      const visible = this.#visibleTurns(hydrated);
      newestFirst.push(...visible);
      const providerCursor = cursor ?? response.backwardsCursor ?? undefined;
      if (response.data.length > 0 && !providerCursor) {
        throw reconciliationError(
          "Codex paginated head did not expose a stable cursor.",
          "codex_paginated_head_cursor_invalid",
        );
      }
      if (
        providerCursor &&
        (visible.length > 0 || response.nextCursor === null)
      ) {
        segments.push({
          providerCursor,
          initialSkip: 0,
          nativeTurnIds: response.data.map(({ id }) => id),
          visibleNativeTurnIds: visible.map(({ id }) => id),
          nextProviderCursor: response.nextCursor,
        });
      }
      if (
        nativeHeadInProgress ||
        newestFirst.length > visibleLimit ||
        response.nextCursor === null
      ) {
        let settledSegments: readonly PageSegment[] = segments;
        if (response.nextCursor === null) {
          const lastVisibleSegmentIndex = segments.findLastIndex(
            ({ visibleNativeTurnIds }) => visibleNativeTurnIds.length > 0,
          );
          if (
            lastVisibleSegmentIndex >= 0 &&
            segments
              .slice(lastVisibleSegmentIndex + 1)
              .every(
                ({ visibleNativeTurnIds }) => visibleNativeTurnIds.length === 0,
              )
          ) {
            settledSegments = segments
              .slice(0, lastVisibleSegmentIndex + 1)
              .map((segment, index) =>
                index === lastVisibleSegmentIndex
                  ? { ...segment, nextProviderCursor: null }
                  : segment,
              );
          }
        }
        return {
          thread: {
            ...this.#thread,
            status: nativeHeadInProgress
              ? { type: "active", activeFlags: [] }
              : { type: "idle" },
            turns: newestFirst.slice(0, visibleLimit).reverse(),
          },
          source: {
            syntheticNativeTurnIds: [],
            segments: settledSegments,
          },
        };
      }
      if (
        response.data.length === 0 ||
        response.nextCursor === cursor ||
        seenCursors.has(response.nextCursor)
      ) {
        throw protocolError(
          "Codex repeated a paginated turn cursor.",
          "codex_paginated_turn_cursor_no_progress",
        );
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
  }

  async findUserMessageByClientId(
    clientId: string,
    signal: AbortSignal,
  ): Promise<CodexPaginatedUserMessageEvidence> {
    return await this.findUserMessageByClientIds([clientId], signal);
  }

  async findUserMessageByClientIds(
    clientIds: readonly string[],
    signal: AbortSignal,
  ): Promise<CodexPaginatedUserMessageEvidence> {
    const expectedClientIds = new Set(clientIds);
    if (expectedClientIds.size !== clientIds.length || clientIds.length === 0) {
      throw new Error("codex_paginated_client_ids_invalid");
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      signal.throwIfAborted();
      const head = await this.#refreshCurrentHeadWithinDeadline(1, signal);
      const terminalTurn = head.thread.turns.at(-1);
      let cursor: string | undefined;
      let matched = false;
      let duplicate = false;
      let firstPageDigest: string | undefined;
      const seenCursors = new RecentCursorCycleDetector();
      const seenItemCoordinates = new Set<string>();
      for (;;) {
        const response = await this.#requestItems(cursor, signal);
        firstPageDigest ??= paginatedEvidenceDigest(response);
        for (const entry of response.data) {
          const coordinate = `${entry.turnId}\0${entry.item.id}`;
          if (seenItemCoordinates.has(coordinate)) {
            throw protocolError(
              "Codex repeated an item in paginated submission evidence.",
              "codex_paginated_item_duplicate",
            );
          }
          seenItemCoordinates.add(coordinate);
          if (
            entry.item.type === "userMessage" &&
            entry.item.clientId !== null &&
            expectedClientIds.has(entry.item.clientId)
          ) {
            if (matched) duplicate = true;
            matched = true;
          }
        }
        const next = response.nextCursor;
        if (next === null) break;
        if (
          response.data.length === 0 ||
          next === cursor ||
          seenCursors.has(next)
        ) {
          throw protocolError(
            "Codex repeated a paginated item cursor.",
            "codex_paginated_item_cursor_no_progress",
          );
        }
        seenCursors.add(next);
        cursor = next;
      }
      if (matched) {
        const settledHead = await this.#refreshCurrentHeadWithinDeadline(
          1,
          signal,
        );
        const settledFirstPage = await this.#requestItems(undefined, signal);
        if (
          paginatedEvidenceDigest(head) !==
            paginatedEvidenceDigest(settledHead) ||
          firstPageDigest !== paginatedEvidenceDigest(settledFirstPage)
        ) {
          continue;
        }
        return { matched, duplicate, terminalTurn };
      }
      const firstCut = await this.#readSubmissionAbsenceCut(signal);
      const secondCut = await this.#readSubmissionAbsenceCut(signal);
      if (
        paginatedEvidenceDigest(head) === firstCut.headDigest &&
        firstPageDigest === firstCut.firstPageDigest &&
        firstCut.digest === secondCut.digest
      ) {
        return { matched, duplicate, terminalTurn };
      }
    }
    throw reconciliationError(
      "Codex paginated submission evidence did not reach a stable head cut.",
      "codex_paginated_submission_not_quiet",
    );
  }

  async #readSubmissionAbsenceCut(signal: AbortSignal): Promise<{
    readonly digest: string;
    readonly headDigest: string;
    readonly firstPageDigest: string;
  }> {
    const metadata = await this.#requestMetadata(signal);
    if (
      metadata.status.type === "active" ||
      metadata.status.type === "systemError"
    ) {
      throw reconciliationError(
        "Codex submission absence is not authoritative while the thread is active or failed.",
        "codex_paginated_submission_absence_unsettled",
      );
    }
    const head = await this.#refreshCurrentHeadWithinDeadline(1, signal);
    const firstPage = await this.#requestItems(undefined, signal);
    const metadataDigest = paginatedEvidenceDigest(metadata);
    const headDigest = paginatedEvidenceDigest(head);
    const firstPageDigest = paginatedEvidenceDigest(firstPage);
    return {
      digest: paginatedEvidenceDigest({
        metadata: metadataDigest,
        head: headDigest,
        firstPage: firstPageDigest,
      }),
      headDigest,
      firstPageDigest,
    };
  }

  async findCompletedTurn(
    backendTurnId: string | undefined,
    signal: AbortSignal,
  ): Promise<CodexPaginatedCompletedTurnEvidence | undefined> {
    signal.throwIfAborted();
    let cursor: string | undefined;
    const seenCursors = new RecentCursorCycleDetector();
    for (;;) {
      const response = await this.#requestTurns(
        cursor,
        CODEX_C1_MAX_TURNS_PAGE_ITEMS,
        signal,
      );
      for (const shell of response.data) {
        if (
          backendTurnId !== undefined &&
          codexBackendTurnId(this.#thread.id, shell.id) !== backendTurnId
        ) {
          continue;
        }
        const [turn] = await this.#hydrateTurnShells([shell], signal);
        if (!turn) continue;
        const visible = this.#visibleTurns([turn]);
        if (visible.length === 0) continue;
        if (backendTurnId === undefined) {
          if (turn.status === "completed") return { turn };
          continue;
        }
        return turn.status === "completed" ? { turn } : undefined;
      }
      if (response.nextCursor === null) return undefined;
      if (
        response.data.length === 0 ||
        response.nextCursor === cursor ||
        seenCursors.has(response.nextCursor)
      ) {
        throw protocolError(
          "Codex repeated a paginated turn cursor.",
          "codex_paginated_turn_cursor_no_progress",
        );
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
  }

  async locateTurn(
    input: {
      readonly matchesBackendTurnId: (backendTurnId: string) => boolean;
      readonly maximumTurnCandidates: number;
    },
    signal: AbortSignal,
  ): Promise<CodexPaginatedTurnLocation> {
    signal.throwIfAborted();
    let cursor: string | undefined;
    let examined = 0;
    const seenCursors = new RecentCursorCycleDetector();
    for (;;) {
      const remaining = input.maximumTurnCandidates - examined;
      if (remaining <= 0) return { status: "search_limit_reached" };
      const response = await this.#requestTurns(
        cursor,
        Math.min(CODEX_C1_MAX_TURNS_PAGE_ITEMS, remaining),
        signal,
      );
      for (const shell of response.data) {
        examined += 1;
        if (
          !input.matchesBackendTurnId(
            codexBackendTurnId(this.#thread.id, shell.id),
          )
        ) {
          continue;
        }
        const [turn] = await this.#hydrateTurnShells([shell], signal);
        if (!turn || this.#visibleTurns([turn]).length === 0) {
          return { status: "not_found" };
        }
        return { status: "found", turn };
      }
      if (response.nextCursor === null) return { status: "not_found" };
      if (examined >= input.maximumTurnCandidates) {
        return { status: "search_limit_reached" };
      }
      if (
        response.data.length === 0 ||
        response.nextCursor === cursor ||
        seenCursors.has(response.nextCursor)
      ) {
        throw protocolError(
          "Codex repeated a paginated turn cursor.",
          "codex_paginated_turn_cursor_no_progress",
        );
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
  }

  async #readDetachedHeadWithinDeadline(
    visibleLimit: number,
    signal: AbortSignal,
  ): Promise<CodexThread> {
    switch (this.#thread.status.type) {
      case "idle":
      case "notLoaded":
        break;
      case "active":
        throw reconciliationError(
          "An active paginated Codex thread requires an attached subscription for a truthful snapshot.",
          "codex_paginated_detached_active",
        );
      case "systemError":
        throw reconciliationError(
          "Codex reported a system error while reading paginated history.",
          "codex_paginated_detached_system_error",
        );
    }
    let cursor: string | undefined;
    let thread: CodexThread = {
      ...this.#thread,
      status: { type: "idle" },
      turns: [],
    };
    const seenCursors = new RecentCursorCycleDetector();
    let hiddenPlateau = false;
    const seenTurnIds = new Set<string>();
    for (;;) {
      signal.throwIfAborted();
      const visibleCount = codexNativeHistoryVisibleTurnCount(
        thread,
        this.#correlationScope,
      );
      const response = await this.#requestTurns(
        cursor,
        hiddenPlateau
          ? CODEX_C1_MAX_TURNS_PAGE_ITEMS
          : Math.min(
              CODEX_C1_MAX_TURNS_PAGE_ITEMS,
              Math.max(1, visibleLimit - visibleCount),
            ),
        signal,
      );
      const hydrated = await this.#hydrateTurnShells(response.data, signal);
      const visible = this.#visibleTurns(hydrated);
      hiddenPlateau = visible.length === 0;
      for (const turn of visible) {
        if (seenTurnIds.has(turn.id)) {
          throw protocolError(
            "Codex repeated a turn across paginated history pages.",
            "codex_paginated_turn_duplicate",
          );
        }
        seenTurnIds.add(turn.id);
      }
      thread = {
        ...thread,
        turns: [...visible].reverse().concat(thread.turns),
      };
      if (
        codexNativeHistoryVisibleTurnCount(thread, this.#correlationScope) >=
          visibleLimit ||
        response.nextCursor === null
      ) {
        return thread;
      }
      if (
        response.data.length === 0 ||
        response.nextCursor === cursor ||
        seenCursors.has(response.nextCursor)
      ) {
        throw protocolError(
          "Codex repeated a paginated turn cursor.",
          "codex_paginated_turn_cursor_no_progress",
        );
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
  }

  cursorAfterProjection(
    page: CodexPaginatedNativePage,
    startNativeTurnIndex: number,
  ): string | undefined {
    if (
      !Number.isSafeInteger(startNativeTurnIndex) ||
      startNativeTurnIndex < 0 ||
      startNativeTurnIndex > page.thread.turns.length
    ) {
      throw protocolError(
        "Codex produced an invalid paginated projection boundary.",
        "codex_paginated_projection_boundary_invalid",
      );
    }
    return this.#cursorAfterNewestNativeTurns(
      page.source,
      page.thread.turns.length - startNativeTurnIndex,
    );
  }

  installCurrentBoundary(
    page: CodexPaginatedNativePage,
    startNativeTurnIndex: number,
    visibleNativeTurnIds: ReadonlySet<string>,
  ): void {
    const selectedNativeCount = page.thread.turns.length - startNativeTurnIndex;
    const sourceIds = page.source.syntheticNativeTurnIds.concat(
      page.source.segments.flatMap(
        ({ visibleNativeTurnIds }) => visibleNativeTurnIds,
      ),
    );
    const selectedSourceIds = sourceIds.slice(0, selectedNativeCount);
    this.#currentCursorAfterVisibleTurn.clear();
    this.#currentCursorBeforeSource = this.#cursorAfterNewestNativeTurns(
      page.source,
      0,
    );
    this.#currentSourceVisibleTurnIds = selectedSourceIds.filter(
      (nativeTurnId) => visibleNativeTurnIds.has(nativeTurnId),
    );
    for (const nativeTurnId of this.#currentSourceVisibleTurnIds) {
      const nativeCount = selectedSourceIds.indexOf(nativeTurnId) + 1;
      const cursor = this.#cursorAfterNewestNativeTurns(
        page.source,
        nativeCount,
      );
      if (cursor) this.#currentCursorAfterVisibleTurn.set(nativeTurnId, cursor);
    }
  }

  cursorAfterCurrentTurns(
    nativeTurnIds: ReadonlySet<string>,
  ): string | undefined {
    let lastRetainedSourceTurnId: string | undefined;
    let foundGap = false;
    for (const nativeTurnId of this.#currentSourceVisibleTurnIds) {
      if (nativeTurnIds.has(nativeTurnId)) {
        if (foundGap) {
          throw protocolError(
            "Codex current history no longer matches its paginated boundary.",
            "codex_paginated_current_window_invalid",
          );
        }
        lastRetainedSourceTurnId = nativeTurnId;
      } else {
        foundGap = true;
      }
    }
    if (lastRetainedSourceTurnId) {
      return this.#currentCursorAfterVisibleTurn.get(lastRetainedSourceTurnId);
    }
    if (
      this.#currentSourceVisibleTurnIds.some((nativeTurnId) =>
        nativeTurnIds.has(nativeTurnId),
      )
    ) {
      throw protocolError(
        "Codex current history no longer matches its paginated boundary.",
        "codex_paginated_current_window_invalid",
      );
    }
    return this.#currentCursorBeforeSource;
  }

  async #loadFromState(
    state: ProviderCursorState,
    visibleLimit: number,
    signal: AbortSignal,
  ): Promise<CodexPaginatedNativePage> {
    let providerCursor: string | null = state.providerCursor;
    let skip = state.skip;
    let page: CodexPaginatedNativePage = {
      thread: { ...this.#thread, status: { type: "idle" }, turns: [] },
      source: { syntheticNativeTurnIds: [], segments: [] },
    };
    const seenCursors = new RecentCursorCycleDetector();
    let hiddenPlateau = false;
    for (;;) {
      signal.throwIfAborted();
      if (providerCursor === null || seenCursors.has(providerCursor)) {
        if (providerCursor !== null) {
          throw protocolError(
            "Codex repeated a paginated turn cursor.",
            "codex_paginated_turn_cursor_no_progress",
          );
        }
        return page;
      }
      seenCursors.add(providerCursor);
      const requestedCursor: string = providerCursor;
      const requestedSkip = skip;
      const visibleCount = codexNativeHistoryVisibleTurnCount(
        page.thread,
        this.#correlationScope,
      );
      const response = await this.#requestTurns(
        requestedCursor,
        hiddenPlateau
          ? CODEX_C1_MAX_TURNS_PAGE_ITEMS
          : Math.min(
              CODEX_C1_MAX_TURNS_PAGE_ITEMS,
              Math.max(1, skip + visibleLimit - visibleCount),
            ),
        signal,
      );
      if (response.nextCursor === requestedCursor) {
        throw protocolError(
          "Codex repeated a paginated turn cursor.",
          "codex_paginated_turn_cursor_no_progress",
        );
      }
      if (response.data.length === 0 && response.nextCursor !== null) {
        throw protocolError(
          "Codex returned a paginated turn page that made no progress.",
          "codex_paginated_turn_cursor_no_progress",
        );
      }
      if (skip >= response.data.length) {
        skip -= response.data.length;
        providerCursor = response.nextCursor;
        if (
          response.data.length === 0 ||
          (providerCursor === null && skip > 0)
        ) {
          throw protocolError(
            "The Codex paginated history cursor no longer identifies a boundary.",
            "codex_paginated_turn_cursor_invalid",
          );
        }
        continue;
      }
      const shells = response.data.slice(skip);
      const hydrated = await this.#hydrateTurnShells(shells, signal);
      const visible = this.#visibleTurns(hydrated);
      hiddenPlateau = visible.length === 0;
      const duplicateIds = new Set(page.thread.turns.map(({ id }) => id));
      for (const turn of visible) {
        if (duplicateIds.has(turn.id)) {
          throw protocolError(
            "Codex repeated a turn across paginated history pages.",
            "codex_paginated_turn_duplicate",
          );
        }
        duplicateIds.add(turn.id);
      }
      page = {
        thread: {
          ...page.thread,
          turns: [...visible].reverse().concat(page.thread.turns),
        },
        source: {
          syntheticNativeTurnIds: [],
          segments:
            visible.length === 0 && response.nextCursor !== null
              ? page.source.segments
              : [
                  ...page.source.segments,
                  {
                    providerCursor: requestedCursor,
                    initialSkip: requestedSkip,
                    nativeTurnIds: shells.map(({ id }) => id),
                    visibleNativeTurnIds: visible.map(({ id }) => id),
                    nextProviderCursor: response.nextCursor,
                  },
                ],
        },
      };
      if (
        codexNativeHistoryVisibleTurnCount(
          page.thread,
          this.#correlationScope,
        ) >= visibleLimit ||
        response.nextCursor === null
      ) {
        return page;
      }
      providerCursor = response.nextCursor;
      skip = 0;
    }
  }

  async #requestTurns(
    cursor: string | undefined,
    limit: number,
    signal: AbortSignal,
  ) {
    const response = await this.#client.requestWithReceipt(
      codexThreadTurnsListMethod,
      {
        threadId: this.#thread.id,
        ...(cursor ? { cursor } : {}),
        limit,
        sortDirection: "desc",
        itemsView: "notLoaded",
      },
      { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal },
    );
    this.#assertGeneration(response.generation);
    if (response.result.data.length > limit) {
      throw protocolError(
        "Codex returned more paginated turns than requested.",
        "codex_paginated_turn_page_over_limit",
      );
    }
    return response.result;
  }

  async #requestItems(cursor: string | undefined, signal: AbortSignal) {
    const response = await this.#client.requestWithReceipt(
      codexThreadItemsListMethod,
      {
        threadId: this.#thread.id,
        ...(cursor ? { cursor } : {}),
        limit: CODEX_C1_MAX_THREAD_ITEMS_PAGE_ITEMS,
        sortDirection: "desc",
      },
      { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal },
    );
    this.#assertGeneration(response.generation);
    return response.result;
  }

  async #requestMetadata(signal: AbortSignal): Promise<CodexThread> {
    const response = await this.#client.requestWithReceipt(
      codexThreadReadMethod,
      { threadId: this.#thread.id, includeTurns: false },
      { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal },
    );
    this.#assertGeneration(response.generation);
    const thread = response.result.thread;
    if (
      thread.id !== this.#thread.id ||
      thread.historyMode !== "paginated" ||
      thread.turns.length !== 0
    ) {
      throw protocolError(
        "Codex changed paginated thread metadata during evidence acquisition.",
        "codex_history_mode_changed",
      );
    }
    return thread;
  }

  async #hydrateTurnShells(
    shells: readonly CodexTurn[],
    signal: AbortSignal,
    resumeBoundaryCursor?: string | null,
  ): Promise<CodexTurn[]> {
    signal.throwIfAborted();
    if (resumeBoundaryCursor === null) {
      return shells.map((shell) => ({
        ...shell,
        items: [],
        itemsView: "full",
      }));
    }
    const hydrated: CodexTurn[] = [];
    for (const shell of shells) {
      signal.throwIfAborted();
      const items: CodexThreadItem[] = [];
      const itemIds = new Set<string>();
      const seenCursors = new RecentCursorCycleDetector();
      // Codex item cursors are thread-scoped rollout ordinals; their provider
      // scope intentionally excludes the optional turnId filter. The resume
      // boundary is therefore valid for every shell while preventing any
      // concurrently persisted post-resume item from entering this snapshot.
      let cursor = resumeBoundaryCursor;
      const sortDirection = resumeBoundaryCursor === undefined ? "asc" : "desc";
      for (;;) {
        const response = await this.#client.requestWithReceipt(
          codexThreadItemsListMethod,
          {
            threadId: this.#thread.id,
            turnId: shell.id,
            ...(cursor ? { cursor } : {}),
            limit: CODEX_C1_MAX_THREAD_ITEMS_PAGE_ITEMS,
            sortDirection,
          },
          { timeoutMilliseconds: CODEX_HISTORY_TIMEOUT_MILLISECONDS, signal },
        );
        this.#assertGeneration(response.generation);
        for (const entry of response.result.data) {
          if (entry.turnId !== shell.id || itemIds.has(entry.item.id)) {
            throw protocolError(
              "Codex returned items outside the requested paginated turn.",
              "codex_paginated_item_filter_invalid",
            );
          }
          itemIds.add(entry.item.id);
          items.push(entry.item);
          if (items.length > CODEX_C1_MAX_ITEMS_PER_TURN) {
            throw protocolError(
              "A Codex paginated turn exceeded the supported item boundary.",
              "history_too_large",
              "unavailable",
            );
          }
        }
        const next = response.result.nextCursor;
        if (next === null) break;
        if (
          response.result.data.length === 0 ||
          next === cursor ||
          seenCursors.has(next)
        ) {
          throw protocolError(
            "Codex repeated a paginated item cursor.",
            "codex_paginated_item_cursor_no_progress",
          );
        }
        seenCursors.add(next);
        cursor = next;
      }
      hydrated.push({
        ...shell,
        items:
          resumeBoundaryCursor === undefined ? items : [...items].reverse(),
        itemsView: "full",
      });
    }
    return hydrated;
  }

  async #hydrateUntilFirstVisibleTurn(
    shells: readonly CodexTurn[],
    signal: AbortSignal,
  ): Promise<CodexTurn[]> {
    const hydrated: CodexTurn[] = [];
    for (const shell of shells) {
      const turn = (await this.#hydrateTurnShells([shell], signal))[0]!;
      hydrated.push(turn);
      if (this.#visibleTurns([turn]).length > 0) break;
    }
    return hydrated;
  }

  #visibleTurns(turns: readonly CodexTurn[]): CodexTurn[] {
    return turns.filter(
      (turn) =>
        codexNativeHistoryVisibleTurnCount(
          { ...this.#thread, turns: [turn] },
          this.#correlationScope,
        ) === 1,
    );
  }

  #cursorAfterNewestNativeTurns(
    source: CodexPaginatedHistoryPageSource,
    selectedCount: number,
  ): string | undefined {
    let remaining = selectedCount;
    if (remaining <= source.syntheticNativeTurnIds.length) {
      const firstSegment = source.segments[0];
      return firstSegment
        ? this.#issueCursor({
            mode: "paginated",
            threadId: this.#thread.id,
            generation: this.#generation,
            sortDirection: "desc",
            itemsView: "notLoaded",
            providerCursor: firstSegment.providerCursor,
            skip: firstSegment.initialSkip,
          })
        : undefined;
    }
    remaining -= source.syntheticNativeTurnIds.length;
    for (const segment of source.segments) {
      const visibleIds = new Set(segment.visibleNativeTurnIds);
      if (remaining === 0 && visibleIds.size === 0) {
        return segment.nextProviderCursor === null
          ? undefined
          : this.#issueCursor({
              mode: "paginated",
              threadId: this.#thread.id,
              generation: this.#generation,
              sortDirection: "desc",
              itemsView: "notLoaded",
              providerCursor: segment.nextProviderCursor,
              skip: 0,
            });
      }
      for (let index = 0; index < segment.nativeTurnIds.length; index += 1) {
        if (!visibleIds.has(segment.nativeTurnIds[index]!)) continue;
        if (remaining === 0) {
          return this.#issueCursor({
            mode: "paginated",
            threadId: this.#thread.id,
            generation: this.#generation,
            sortDirection: "desc",
            itemsView: "notLoaded",
            providerCursor: segment.providerCursor,
            skip: segment.initialSkip + index,
          });
        }
        remaining -= 1;
        if (remaining === 0) {
          const consumed = index + 1;
          const hasVisibleRemainder = segment.nativeTurnIds
            .slice(consumed)
            .some((nativeTurnId) => visibleIds.has(nativeTurnId));
          return consumed < segment.nativeTurnIds.length && hasVisibleRemainder
            ? this.#issueCursor({
                mode: "paginated",
                threadId: this.#thread.id,
                generation: this.#generation,
                sortDirection: "desc",
                itemsView: "notLoaded",
                providerCursor: segment.providerCursor,
                skip: segment.initialSkip + consumed,
              })
            : segment.nextProviderCursor === null
              ? undefined
              : this.#issueCursor({
                  mode: "paginated",
                  threadId: this.#thread.id,
                  generation: this.#generation,
                  sortDirection: "desc",
                  itemsView: "notLoaded",
                  providerCursor: segment.nextProviderCursor,
                  skip: 0,
                });
        }
      }
    }
    if (remaining !== 0) {
      throw protocolError(
        "Codex produced an invalid paginated cursor boundary.",
        "codex_paginated_projection_boundary_invalid",
      );
    }
    return undefined;
  }

  #issueCursor(state: ProviderCursorState): string {
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv(
      "aes-256-gcm",
      this.#cursorKey,
      initializationVector,
    );
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(state), "utf8"),
      cipher.final(),
    ]);
    const cursor = `${CURSOR_PREFIX}${Buffer.concat([
      initializationVector,
      cipher.getAuthTag(),
      encrypted,
    ]).toString("base64url")}`;
    if (cursor.length > MAXIMUM_NORMALIZED_CURSOR_CHARACTERS) {
      throw protocolError(
        "The Codex provider cursor is too large for normalized history paging.",
        "codex_paginated_cursor_too_large",
        "unavailable",
      );
    }
    return cursor;
  }

  #parseCursor(cursor: string): ProviderCursorState {
    let state: ProviderCursorState | undefined;
    try {
      if (!cursor.startsWith(CURSOR_PREFIX))
        throw new Error("cursor_prefix_invalid");
      const encoded = cursor.slice(CURSOR_PREFIX.length);
      const bytes = Buffer.from(encoded, "base64url");
      if (bytes.length < 29) throw new Error("cursor_payload_invalid");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#cursorKey,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      const decoded = Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
      const parsed = JSON.parse(decoded) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw new Error("cursor_state_invalid");
      }
      const keys = Object.keys(parsed).sort();
      if (
        JSON.stringify(keys) !==
        JSON.stringify([
          "generation",
          "itemsView",
          "mode",
          "providerCursor",
          "skip",
          "sortDirection",
          "threadId",
        ])
      ) {
        throw new Error("cursor_state_invalid");
      }
      state = parsed as ProviderCursorState;
    } catch {
      state = undefined;
    }
    if (
      !state ||
      state.mode !== "paginated" ||
      state.threadId !== this.#thread.id ||
      state.generation !== this.#generation ||
      state.sortDirection !== "desc" ||
      state.itemsView !== "notLoaded" ||
      !Number.isSafeInteger(state.skip) ||
      state.skip < 0
    ) {
      throw new BackendError({
        category: "rejected",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "The Codex paginated history cursor is invalid or stale.",
        backendCode: "codex_history_cursor_invalid",
      });
    }
    return state;
  }

  #assertGeneration(generation: number): void {
    const lifecycle = this.#client.lifecycleSnapshot();
    if (
      generation !== this.#generation ||
      lifecycle.state !== "ready" ||
      lifecycle.generation !== this.#generation
    ) {
      throw new BackendError({
        category: "unavailable",
        retryable: true,
        crossedSubmissionBoundary: false,
        safeMessage:
          "Codex paginated history must be reconciled with the current daemon generation.",
        backendCode: "codex_history_reconciliation_required",
      });
    }
  }

  async #withAcquisitionDeadline<Result>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Result>,
    timeoutMilliseconds = CODEX_HISTORY_TIMEOUT_MILLISECONDS,
  ): Promise<Result> {
    const deadlineController = new AbortController();
    const deadline = setTimeout(
      () =>
        deadlineController.abort(new Error("codex_paginated_history_deadline")),
      timeoutMilliseconds,
    );
    const deadlineSignal = deadlineController.signal;
    const signal = AbortSignal.any([callerSignal, deadlineSignal]);
    let rejectAborted!: (reason?: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const abort = () => rejectAborted(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      return await Promise.race([operation(signal), aborted]);
    } catch (error) {
      if (deadlineSignal.aborted && !callerSignal.aborted) {
        throw reconciliationError(
          "Codex paginated history did not complete within the request deadline.",
          "codex_paginated_history_deadline",
        );
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      clearTimeout(deadline);
    }
  }
}

class RecentCursorCycleDetector {
  readonly #recent: string[] = [];

  has(cursor: string): boolean {
    return this.#recent.includes(cursor);
  }

  add(cursor: string): void {
    this.#recent.push(cursor);
    if (this.#recent.length > RECENT_PROVIDER_CURSOR_WINDOW) {
      this.#recent.shift();
    }
  }
}

function paginatedEvidenceDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value), "utf8")
    .digest("base64url");
}

function protocolError(
  safeMessage: string,
  backendCode: string,
  category: BackendError["category"] = "incompatible_protocol",
): BackendError {
  return new BackendError({
    category,
    retryable: false,
    crossedSubmissionBoundary: false,
    safeMessage,
    backendCode,
  });
}

function reconciliationError(
  safeMessage: string,
  backendCode = "codex_history_reconciliation_required",
): BackendError {
  return new BackendError({
    category: "unavailable",
    retryable: true,
    crossedSubmissionBoundary: false,
    safeMessage,
    backendCode,
  });
}
