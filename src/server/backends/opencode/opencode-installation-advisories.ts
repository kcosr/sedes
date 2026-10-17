import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { BackendInstallationAdvisoryContribution, BackendInstallationAdvisorySource } from "../module.js";
import { OPENCODE_RUNTIME_TESTED_THROUGH_RELEASE, type VerifiedOpenCodeRuntimeVersion } from "./opencode-release.js";

export class OpenCodeInstallationAdvisorySource implements BackendInstallationAdvisorySource {
  readonly #listeners = new Set<() => void>();
  #assessment?: VerifiedOpenCodeRuntimeVersion;

  active(): readonly BackendInstallationAdvisoryContribution[] {
    const assessment = this.#assessment;
    return assessment?.newerThanTested ? [Object.freeze({
      id: "runtime-newer-than-tested", tone: "warning" as const,
      title: boundDisplayText("OpenCode is newer than tested"),
      message: boundDisplayText(`Running ${assessment.version}; Sedes is tested through ${OPENCODE_RUNTIME_TESTED_THROUGH_RELEASE}.`),
    })] : [];
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  observe(assessment: VerifiedOpenCodeRuntimeVersion): void {
    if (this.#assessment?.version === assessment.version && this.#assessment.newerThanTested === assessment.newerThanTested) return;
    const previouslyActive = this.#assessment?.newerThanTested === true;
    this.#assessment = assessment;
    if (previouslyActive || assessment.newerThanTested) this.#publish();
  }
  clear(): void {
    const previouslyActive = this.#assessment?.newerThanTested;
    this.#assessment = undefined;
    if (previouslyActive) this.#publish();
  }
  #publish(): void {
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* Advisory observers cannot affect provider lifecycle. */ }
    }
  }
}
