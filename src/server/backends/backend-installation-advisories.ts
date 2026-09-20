import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { boundedDisplayTextSchema } from "../../shared/protocol/payload.js";
import { MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES } from "../../shared/protocol/application.js";
import type {
  BackendInstallationAdvisoryContribution,
  BackendInstallationAdvisorySource,
} from "./module.js";

const backendInstallationAdvisoryContributionSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u),
  tone: z.enum(["info", "warning", "error"]),
  title: boundedDisplayTextSchema,
  message: boundedDisplayTextSchema,
});

/**
 * Reusable process-local source for release probes and other changing backend
 * assessments. Replacement is atomic, bounded, deduplicated, and only emits
 * when the normalized active set changes semantically.
 */
export class MutableBackendInstallationAdvisorySource implements BackendInstallationAdvisorySource {
  #active: readonly BackendInstallationAdvisoryContribution[] = Object.freeze(
    [],
  );
  readonly #listeners = new Set<() => void>();

  constructor(
    readonly onListenerError: (error: unknown) => void = () => undefined,
  ) {}

  active(): readonly BackendInstallationAdvisoryContribution[] {
    return this.#active;
  }

  replace(
    contributions: readonly BackendInstallationAdvisoryContribution[],
  ): void {
    if (
      contributions.length > MAXIMUM_BACKEND_INSTANCE_INSTALLATION_ADVISORIES
    ) {
      throw new Error("too_many_backend_installation_advisories");
    }
    const seen = new Set<string>();
    const next = contributions
      .map((contribution) => {
        const parsed =
          backendInstallationAdvisoryContributionSchema.parse(contribution);
        if (seen.has(parsed.id)) {
          throw new Error("duplicate_backend_installation_advisory_id");
        }
        seen.add(parsed.id);
        return Object.freeze({
          ...parsed,
          title: Object.freeze({ ...parsed.title }),
          message: Object.freeze({ ...parsed.message }),
        });
      })
      .sort((left, right) => left.id.localeCompare(right.id));
    if (isDeepStrictEqual(next, this.#active)) return;
    this.#active = Object.freeze(next);
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch (error) {
        try {
          this.onListenerError(error);
        } catch {
          // Advisory publication is diagnostic and must not affect the runtime
          // operation that produced the assessment.
        }
      }
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }
}
