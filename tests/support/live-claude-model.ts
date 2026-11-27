import type { ModelInfo, Query } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeQueryInput } from "../../src/server/backends/claude/claude-sdk-facade.js";

export const LIVE_CLAUDE_MODEL = "claude-haiku-5-5";
export const LIVE_CLAUDE_EFFORT = "low";

/** Raw catalogs may include a duplicate moving default in addition to the named row. */
export function assertLiveClaudeCatalog(models: readonly ModelInfo[]): void {
  const eligible = models.filter(model => model.value !== "default" &&
    (model.resolvedModel ?? model.value) === LIVE_CLAUDE_MODEL &&
    model.supportsEffort && model.supportedEffortLevels?.includes(LIVE_CLAUDE_EFFORT));
  if (eligible.length !== 1) throw new Error(`REAL_CLAUDE_BLOCKER: exactly one ${LIVE_CLAUDE_MODEL}/${LIVE_CLAUDE_EFFORT} catalog entry required`);
}

/** Guard the test's actual CLI launch, including fork/resume and later model controls. */
export function createLiveClaudeQuery(input: ClaudeQueryInput, create: (input: ClaudeQueryInput) => Query): Query {
  const options = input.options;
  const persistent = options.persistSession !== false;
  if (persistent && (options.model !== LIVE_CLAUDE_MODEL || options.effort !== LIVE_CLAUDE_EFFORT)) {
    throw new Error("REAL_CLAUDE_BLOCKER: authenticated prompts require Haiku 5.5 at low effort");
  }
  if (options.fallbackModel || typeof options.settings === "string") {
    throw new Error("REAL_CLAUDE_BLOCKER: unexpected live query fallback or settings file");
  }
  const query = create({ ...input, options: {
    ...options, model: LIVE_CLAUDE_MODEL, effort: LIVE_CLAUDE_EFFORT,
    // Keep the no-prompt catalog probe independent of the test model allowlist.
    ...(persistent ? { settingSources: [] } : {}),
    plugins: [], settings: { ...options.settings, disableAllHooks: true, fallbackModel: [],
      ...(persistent ? { availableModels: [LIVE_CLAUDE_MODEL] } : {}),
    },
    env: { ...options.env, ANTHROPIC_SMALL_FAST_MODEL: LIVE_CLAUDE_MODEL,
      CLAUDE_CODE_NO_MODEL_FALLBACK: "1", CLAUDE_CODE_DISABLE_REFUSAL_RETRY: "1",
      CLAUDE_CODE_DISABLE_MODEL_ACCESS_FALLBACK: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
  } });
  const originalSet = query.setModel.bind(query);
  query.setModel = model => {
    if (model !== LIVE_CLAUDE_MODEL) throw new Error("REAL_CLAUDE_BLOCKER: refusing model change");
    return originalSet(model);
  };
  const nativeIterator = query[Symbol.asyncIterator].bind(query);
  query[Symbol.asyncIterator] = async function* () {
    for await (const frame of { [Symbol.asyncIterator]: nativeIterator }) {
      if (frame.type === "system" && frame.subtype === "init" && frame.model !== LIVE_CLAUDE_MODEL) {
        throw new Error("REAL_CLAUDE_BLOCKER: Claude initialized a different model");
      }
      if (frame.type === "result" && Object.keys(frame.modelUsage).some(model => model !== LIVE_CLAUDE_MODEL)) {
        throw new Error("REAL_CLAUDE_BLOCKER: Claude reported usage on another model");
      }
      yield frame;
    }
  };
  return query;
}
