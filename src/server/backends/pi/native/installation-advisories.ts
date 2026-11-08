import { boundDisplayText } from "../../../conversations/payload-policy.js";
import type { BackendInstallationAdvisoryContribution, BackendInstallationAdvisorySource } from "../../module.js";
import { PI_RUNTIME_TESTED_THROUGH_RELEASE, type VerifiedPiRuntimeVersion } from "./runtime-release.js";

export class PiInstallationAdvisorySource implements BackendInstallationAdvisorySource {
  readonly #listeners = new Set<() => void>();
  #disposed = false;
  #assessment?: VerifiedPiRuntimeVersion;

  active(): readonly BackendInstallationAdvisoryContribution[] {
    const assessment = this.#assessment;
    return assessment?.newerThanTested ? [Object.freeze({
      id: "runtime-newer-than-tested", tone: "warning" as const,
      title: boundDisplayText("Pi is newer than tested"),
      message: boundDisplayText(`Running ${assessment.version}; Sedes is tested through ${PI_RUNTIME_TESTED_THROUGH_RELEASE}.`),
    })] : [];
  }
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  observe(assessment: VerifiedPiRuntimeVersion): void {
    if (this.#disposed) return;
    if (this.#assessment?.version === assessment.version && this.#assessment.newerThanTested === assessment.newerThanTested) return;
    const previouslyActive = this.#assessment?.newerThanTested === true;
    this.#assessment = assessment;
    if (previouslyActive || assessment.newerThanTested) this.#publish();
  }
  dispose(): void { this.#disposed = true; this.clear(); }
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
