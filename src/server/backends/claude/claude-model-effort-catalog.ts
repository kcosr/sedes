import type { BackendModelDescriptor } from "../contracts.js";

interface ModelEffortSelection {
  readonly supported: ReadonlySet<string>;
  readonly defaultEffort?: string;
}

const MAXIMUM_CACHED_THREAD_CATALOGS = 1_024;

/**
 * Retains the exact catalog tuple that the normalized presentation validated
 * immediately before a local model-setting mutation is persisted.
 */
export class ClaudeModelEffortCatalog {
  readonly #byThreadTarget = new Map<
    string,
    ReadonlyMap<string, ModelEffortSelection>
  >();

  replace(
    applicationThreadId: string,
    connectionProfileId: string,
    models: readonly BackendModelDescriptor[],
  ): void {
    const selections = new Map<string, ModelEffortSelection>();
    for (const model of models.slice(0, 512)) {
      if (model.provider !== connectionProfileId) continue;
      const efforts = model.supportedReasoningEfforts ?? [];
      const defaultEffort = model.defaultReasoningEffort;
      selections.set(model.id, {
        supported: new Set(efforts),
        ...(defaultEffort && efforts.includes(defaultEffort)
          ? { defaultEffort }
          : {}),
      });
    }
    const key = `${connectionProfileId}\0${applicationThreadId}`;
    this.#byThreadTarget.delete(key);
    this.#byThreadTarget.set(key, selections);
    while (this.#byThreadTarget.size > MAXIMUM_CACHED_THREAD_CATALOGS) {
      const oldest = this.#byThreadTarget.keys().next().value as
        string | undefined;
      if (oldest === undefined) break;
      this.#byThreadTarget.delete(oldest);
    }
  }

  resolve(
    applicationThreadId: string,
    connectionProfileId: string,
    modelId: string,
    currentEffort: string | null,
  ): string | null | undefined {
    const selection = this.#byThreadTarget
      .get(`${connectionProfileId}\0${applicationThreadId}`)
      ?.get(modelId);
    if (!selection) return undefined;
    if (selection.supported.size === 0) return null;
    return currentEffort && selection.supported.has(currentEffort)
      ? currentEffort
      : selection.defaultEffort;
  }

  allows(
    applicationThreadId: string,
    connectionProfileId: string,
    modelId: string,
    effort: string,
  ): boolean {
    return (
      this.#byThreadTarget
        .get(`${connectionProfileId}\0${applicationThreadId}`)
        ?.get(modelId)
        ?.supported.has(effort) === true
    );
  }
}
