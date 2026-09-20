import type { BackendModelDescriptor } from "../contracts.js";

const MAXIMUM_CACHED_THREAD_CATALOGS = 1_024;

export class GrokModelEffortCatalog {
  readonly #byThreadTarget = new Map<
    string,
    ReadonlyMap<string, ReadonlySet<string>>
  >();

  replace(
    applicationThreadId: string,
    connectionProfileId: string,
    models: readonly BackendModelDescriptor[],
  ): void {
    const selections = new Map<string, ReadonlySet<string>>();
    for (const model of models.slice(0, 512)) {
      if (model.provider !== connectionProfileId) continue;
      const efforts = model.supportedReasoningEfforts ?? [];
      if (efforts.length > 0) selections.set(model.id, new Set(efforts));
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
        ?.has(effort) === true
    );
  }
}
