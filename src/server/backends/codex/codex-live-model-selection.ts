import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import {
  CODEX_C2_MAX_CATALOG_ITEMS,
  codexModelListMethod,
} from "./codex-c2-protocol.js";

const MAXIMUM_MODEL_CATALOG_PAGES = 32;
const MAXIMUM_CURSOR_BYTES = 16 * 1_024;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;

/**
 * Rechecks one exact model/effort tuple against the uncached live daemon
 * catalog. Managed TUI launch uses this immediately before preparing the
 * process endpoint so a stale presentation catalog cannot authorize a spawn.
 */
export async function assertCodexLiveModelSelection(input: {
  readonly client: CodexSharedClientFacade;
  readonly expectedGeneration: number;
  readonly model: string;
  readonly reasoningEffort: string;
  readonly signal: AbortSignal;
}): Promise<void> {
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let itemCount = 0;
  for (let page = 0; page < MAXIMUM_MODEL_CATALOG_PAGES; page += 1) {
    const remaining = CODEX_C2_MAX_CATALOG_ITEMS - itemCount;
    if (remaining <= 0) break;
    const response = await input.client.requestWithReceipt(
      codexModelListMethod,
      {
        ...(cursor ? { cursor } : {}),
        limit: remaining,
        includeHidden: false,
      },
      {
        timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
        signal: input.signal,
      },
    );
    assertGeneration(input.client, input.expectedGeneration, response.generation);
    itemCount += response.result.data.length;
    if (itemCount > CODEX_C2_MAX_CATALOG_ITEMS) break;
    if (
      response.result.data.some(
        (candidate) =>
          !candidate.hidden &&
          candidate.id === input.model &&
          candidate.inputModalities.includes("text") &&
          candidate.supportedReasoningEfforts.some(
            ({ reasoningEffort }) =>
              reasoningEffort === input.reasoningEffort,
          ),
      )
    ) {
      assertGeneration(
        input.client,
        input.expectedGeneration,
        response.generation,
      );
      return;
    }
    const nextCursor = response.result.nextCursor;
    if (nextCursor === null) break;
    if (
      nextCursor.length === 0 ||
      Buffer.byteLength(nextCursor, "utf8") > MAXIMUM_CURSOR_BYTES ||
      cursors.has(nextCursor)
    ) {
      break;
    }
    cursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new Error("codex_tui_live_model_selection_unavailable");
}

function assertGeneration(
  client: CodexSharedClientFacade,
  expected: number,
  received: number,
): void {
  const lifecycle = client.lifecycleSnapshot();
  if (
    received !== expected ||
    lifecycle.state !== "ready" ||
    lifecycle.generation !== expected
  ) {
    throw new Error("codex_tui_live_model_catalog_generation_changed");
  }
}
