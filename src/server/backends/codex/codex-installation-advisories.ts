import { boundDisplayText } from "../../conversations/payload-policy.js";
import type {
  BackendInstallationAdvisoryContribution,
  BackendInstallationAdvisorySource,
} from "../module.js";
import {
  CODEX_RUNTIME_TESTED_THROUGH_RELEASE,
  type VerifiedCodexRuntimeVersion,
} from "./codex-release-guard.js";

export class CodexInstallationAdvisorySource implements BackendInstallationAdvisorySource {
  readonly #listeners = new Set<() => void>();
  #assessment: VerifiedCodexRuntimeVersion | undefined;

  active(): readonly BackendInstallationAdvisoryContribution[] {
    const assessment = this.#assessment;
    if (!assessment?.newerThanTested) return [];
    return [
      Object.freeze({
        id: "runtime-newer-than-tested",
        tone: "warning" as const,
        title: boundDisplayText("Codex is newer than tested"),
        message: boundDisplayText(
          `Running ${assessment.version}; Sedes is tested through ${CODEX_RUNTIME_TESTED_THROUGH_RELEASE}.`,
        ),
      }),
    ];
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

  observe(assessment: VerifiedCodexRuntimeVersion): void {
    if (
      this.#assessment?.version === assessment.version &&
      this.#assessment.newerThanTested === assessment.newerThanTested
    ) {
      return;
    }
    const previouslyActive = this.#assessment?.newerThanTested === true;
    this.#assessment = assessment;
    if (!previouslyActive && !assessment.newerThanTested) return;
    this.#publish();
  }

  clear(): void {
    if (!this.#assessment) return;
    const previouslyActive = this.#assessment.newerThanTested;
    this.#assessment = undefined;
    if (!previouslyActive) return;
    this.#publish();
  }

  #publish(): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener();
      } catch {
        // Advisory observers must never influence provider lifecycle.
      }
    }
  }
}
