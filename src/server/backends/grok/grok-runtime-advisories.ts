import type {
  BackendInstallationAdvisoryContribution,
  BackendInstallationAdvisorySource,
} from "../module.js";
import type { GrokRuntimeCompatibilityAssessment } from "./grok-release-guard.js";

export interface GrokRuntimeAssessmentObservation {
  admitted(assessment: GrokRuntimeCompatibilityAssessment): void;
  failed(): void;
}

/** Process-local advisory projection for one configured Grok backend instance. */
export class GrokRuntimeAdvisorySource implements BackendInstallationAdvisorySource {
  readonly #listeners = new Set<() => void>();
  #assessment: GrokRuntimeCompatibilityAssessment | undefined;
  #nextObservationId = 0;
  #closed = false;

  active(): readonly BackendInstallationAdvisoryContribution[] {
    const assessment = this.#assessment;
    if (this.#closed || !assessment?.newerThanTested) return [];
    return [
      Object.freeze({
        id: "runtime-newer-than-tested",
        tone: "warning",
        title: Object.freeze({ text: "Grok is newer than tested" }),
        message: Object.freeze({
          text: `Running ${assessment.observedVersion}; Sedes is tested through ${assessment.testedThroughVersion}.`,
        }),
      }),
    ];
  }

  subscribe(listener: () => void): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  beginObservation(): GrokRuntimeAssessmentObservation {
    const observationId = ++this.#nextObservationId;
    let settled = false;
    return Object.freeze({
      admitted: (assessment: GrokRuntimeCompatibilityAssessment) => {
        if (settled) return;
        settled = true;
        this.#settleObservation(observationId, assessment);
      },
      failed: () => {
        if (settled) return;
        settled = true;
        this.#settleObservation(observationId, undefined);
      },
    });
  }

  #settleObservation(
    observationId: number,
    assessment: GrokRuntimeCompatibilityAssessment | undefined,
  ): void {
    if (this.#closed || observationId !== this.#nextObservationId) {
      return;
    }
    if (sameAssessment(this.#assessment, assessment)) return;
    const hadActiveAdvisory = this.#assessment?.newerThanTested === true;
    this.#assessment = assessment;
    if (!hadActiveAdvisory && !assessment?.newerThanTested) return;
    this.#notifyListeners();
  }

  close(): void {
    if (this.#closed) return;
    const hadActiveAdvisory = this.#assessment?.newerThanTested === true;
    this.#closed = true;
    this.#assessment = undefined;
    if (hadActiveAdvisory) this.#notifyListeners();
    this.#listeners.clear();
  }

  #notifyListeners(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // Advisory publication must never break provider runtime admission.
      }
    }
  }
}

function sameAssessment(
  left: GrokRuntimeCompatibilityAssessment | undefined,
  right: GrokRuntimeCompatibilityAssessment | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.observedVersion === right.observedVersion &&
    left.minimumVersion === right.minimumVersion &&
    left.testedThroughVersion === right.testedThroughVersion &&
    left.newerThanTested === right.newerThanTested
  );
}
