import type { CodexSharedClientFacade } from "./codex-client-facade.js";
import {
  CODEX_C2_MAX_CATALOG_ITEMS,
  codexExperimentalFeatureListMethod,
  type CodexExperimentalFeatureListResponse,
} from "./codex-c2-protocol.js";

const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const MAXIMUM_FEATURE_PAGES = 32;
const MAXIMUM_CURSOR_BYTES = 4_096;
const FAST_MODE_FEATURE_NAME = "fast_mode";
const ULTRAFAST_MODE_FEATURE_NAME = "ultrafast_mode";

/** Stateless native discovery shared by server sessions and execution-host TUI checks. */
export async function readCodexSpeedEnablement(input: {
  readonly nativeThreadId: string;
  readonly connectionGeneration: number;
  readonly client: CodexSharedClientFacade;
  readonly signal?: AbortSignal;
}): Promise<{ fastEnabled: boolean; ultrafastEnabled: boolean }> {
  let cursor: string | null = null;
  const names = new Set<string>();
  const cursors = new Set<string>();
  let fastModeEnabled: boolean | undefined;
  let ultrafastModeEnabled: boolean | undefined;
  for (let page = 0; page < MAXIMUM_FEATURE_PAGES; page += 1) {
    const response: {
      readonly generation: number;
      readonly result: CodexExperimentalFeatureListResponse;
    } = await input.client.requestWithReceipt(
      codexExperimentalFeatureListMethod,
      {
        threadId: input.nativeThreadId,
        limit: CODEX_C2_MAX_CATALOG_ITEMS,
        ...(cursor ? { cursor } : {}),
      },
      {
        timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
        ...(input.signal ? { signal: input.signal } : {}),
      },
    );
    const lifecycle = input.client.lifecycleSnapshot();
    if (
      response.generation !== input.connectionGeneration ||
      lifecycle.state !== "ready" ||
      lifecycle.generation !== input.connectionGeneration
    ) {
      throw new Error("codex_fast_mode_generation_changed");
    }
    for (const feature of response.result.data) {
      if (names.has(feature.name)) {
        throw new Error("codex_feature_catalog_duplicate");
      }
      names.add(feature.name);
      if (
        feature.name === FAST_MODE_FEATURE_NAME ||
        feature.name === ULTRAFAST_MODE_FEATURE_NAME
      ) {
        if (feature.stage !== "stable") {
          throw new Error("codex_fast_mode_stage_invalid");
        }
        if (feature.name === FAST_MODE_FEATURE_NAME) {
          fastModeEnabled = feature.enabled;
        } else {
          ultrafastModeEnabled = feature.enabled;
        }
      }
    }
    cursor = response.result.nextCursor;
    if (cursor === null) {
      return {
        fastEnabled: fastModeEnabled ?? false,
        ultrafastEnabled: ultrafastModeEnabled ?? false,
      };
    }
    if (
      cursor.length === 0 ||
      Buffer.byteLength(cursor, "utf8") > MAXIMUM_CURSOR_BYTES ||
      cursors.has(cursor)
    ) {
      throw new Error("codex_feature_catalog_cursor_invalid");
    }
    cursors.add(cursor);
  }
  throw new Error("codex_feature_catalog_page_limit_exceeded");
}
