import type { ConversationBinding } from "../contracts.js";
import type { ViewedImageCapture } from "../../output-artifacts/viewed-image-capture.js";
import type { CodexViewedImageCandidate } from "./codex-history-projector.js";

/** Handle-owned subscriptions; the application service owns shared reads and byte limits. */
export class CodexViewedImageCaptureCoordinator {
  readonly #controller = new AbortController();
  readonly #attempted = new Set<string>();

  constructor(readonly input: {
    readonly binding: ConversationBinding;
    readonly capture: ViewedImageCapture;
    readonly onCaptured: () => void;
  }) {}

  schedule(candidates: readonly CodexViewedImageCandidate[], maximumCandidates = 32): void {
    // Retry suppression belongs to the retained projection window, not the
    // lifetime of a busy thread. Failed candidates still in that window stay
    // suppressed; evicted candidates cannot exhaust future live admission.
    const retained = new Set(candidates.map(candidate => candidate.publicationKey));
    for (const key of this.#attempted) if (!retained.has(key)) this.#attempted.delete(key);
    let admitted = 0;
    for (const candidate of [...candidates].reverse()) {
      if (!candidate.completed || candidate.retained || this.#attempted.has(candidate.publicationKey) ||
          this.#controller.signal.aborted) continue;
      this.#attempted.add(candidate.publicationKey);
      if (admitted >= maximumCandidates) continue;
      admitted += 1;
      void this.#capture(candidate, this.#controller.signal).then(captured => {
        if (captured && !this.#controller.signal.aborted) this.input.onCaptured();
      }).catch(() => undefined);
    }
  }

  async capturePage(candidates: readonly CodexViewedImageCandidate[], signal?: AbortSignal): Promise<void> {
    const selected = candidates.filter(candidate => candidate.completed && !candidate.retained).slice(-4);
    if (selected.length === 0 || this.#controller.signal.aborted || signal?.aborted) return;
    const deadline = new AbortController();
    const combined = AbortSignal.any([this.#controller.signal, deadline.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => deadline.abort(), 2000);
    try {
      const captured = await Promise.all(selected.map(candidate => this.#capture(candidate, combined)));
      // A page may overlap the live window, whose subscribers need the child as an event.
      if (captured.some(Boolean) && !this.#controller.signal.aborted) this.input.onCaptured();
    } finally {
      clearTimeout(timer);
      deadline.abort();
    }
  }

  close(): void {
    this.#controller.abort();
    this.#attempted.clear();
  }

  async #capture(candidate: CodexViewedImageCandidate, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return false;
    let cancel: (() => void) | undefined;
    try {
      const binding = this.input.binding;
      return await Promise.race([
        this.input.capture.capture({
          scope: { tenantId: binding.tenantId, principalId: binding.ownerPrincipalId },
          binding,
          publicationKey: candidate.publicationKey,
          absolutePath: candidate.absolutePath,
          signal,
        }).then(value => value !== undefined),
        new Promise<boolean>(resolve => {
          cancel = () => resolve(false);
          signal.addEventListener("abort", cancel, { once: true });
          if (signal.aborted) cancel();
        }),
      ]);
    } catch {
      return false;
    } finally {
      if (cancel) signal.removeEventListener("abort", cancel);
    }
  }
}
