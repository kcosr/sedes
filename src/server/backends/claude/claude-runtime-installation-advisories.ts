import { MutableBackendInstallationAdvisorySource } from "../backend-installation-advisories.js";
import type { BackendInstallationAdvisorySource } from "../module.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import {
  CLAUDE_CODE_TESTED_THROUGH_VERSION,
  emitClaudeRuntimeNewerVersionWarning,
  type ClaudeRuntimeVersionAssessment,
} from "./claude-release-guard.js";

export type ClaudeRuntimeVersionObservationSource =
  "health_probe" | "conversation_session";

export interface ClaudeRuntimeVersionObservation {
  readonly source: ClaudeRuntimeVersionObservationSource;
  readonly generation: number;
  readonly observeVersionAssessment: (
    assessment: ClaudeRuntimeVersionAssessment,
  ) => void;
  readonly failed: () => void;
}

/** Process-local assessments learned from this backend instance's CLI probes. */
export class ClaudeRuntimeInstallationAdvisories implements BackendInstallationAdvisorySource {
  readonly #source = new MutableBackendInstallationAdvisorySource();
  #latestGeneration = 0;

  beginObservation(
    source: ClaudeRuntimeVersionObservationSource,
  ): ClaudeRuntimeVersionObservation {
    const generation = ++this.#latestGeneration;
    return Object.freeze({
      source,
      generation,
      observeVersionAssessment: (assessment: ClaudeRuntimeVersionAssessment) =>
        this.#observe(generation, assessment),
      failed: () => this.#observe(generation, undefined),
    });
  }

  #observe(
    generation: number,
    assessment: ClaudeRuntimeVersionAssessment,
  ): void {
    if (generation !== this.#latestGeneration) return;
    if (!assessment?.newerThanTested) {
      this.#source.replace([]);
      return;
    }
    emitClaudeRuntimeNewerVersionWarning({
      testedThroughVersion: CLAUDE_CODE_TESTED_THROUGH_VERSION,
      observedVersion: assessment.version,
    });
    this.#source.replace([
      {
        id: "runtime-newer-than-tested",
        tone: "warning",
        title: boundDisplayText("Claude Code is newer than tested"),
        message: boundDisplayText(
          `Running ${assessment.version}; Sedes is tested through ${CLAUDE_CODE_TESTED_THROUGH_VERSION}.`,
        ),
      },
    ]);
  }

  active() {
    return this.#source.active();
  }

  clear(): void {
    this.#latestGeneration += 1;
    this.#source.replace([]);
  }

  subscribe(listener: () => void): () => void {
    return this.#source.subscribe(listener);
  }
}
