import { createHash } from "node:crypto";
import type { ConversationBinding } from "../contracts.js";
import { NO_USAGE_SINK, usageTokens, type UsageSink, type UsageCapture, type UsageObservation } from "../../usage/contracts.js";
import type { AntigravityNativeHistory } from "./native-schema.js";
import type { AntigravityProjection } from "./history.js";

export class AntigravityUsage {
  readonly capture: UsageCapture;
  readonly #committed = new Map<string, string>();
  constructor(sink: UsageSink | undefined, binding: ConversationBinding, namespace: string) {
    this.capture = (sink ?? NO_USAGE_SINK).open({ binding, nativeNamespace: namespace, nativeSession: binding.backendConversationId,
      epoch: "native_steps", normalizationVersion: "antigravity-1.5/usage-v1", initialBaseline: "unknown" });
  }
  update(history: AntigravityNativeHistory, projection: AntigravityProjection, provenance: "history" | "live"): boolean {
    this.capture.registerTurns(Object.values(projection.snapshot.turnsById));
    // Imported child baselines are not independent additive usage until their
    // native ancestry/copy boundary has been qualified.
    if (history.parentSessionId) { this.capture.gap("inherited_baseline_unknown"); return true; }
    const observations: UsageObservation[] = history.steps.flatMap(step => {
      if (!step.usage || step.status !== 3) return [];
      const id = `step:${step.index}:usage`;
      const turn = projection.stepTurns.get(step.index);
      const usage = step.usage;
      const fact = { id, kind: "operation" as const, sessionContribution: "additive" as const, coverageDomain: "antigravity_native_steps",
        tokens: usageTokens({ input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens,
          cacheWrite: usage.cacheWriteTokens, reasoning: usage.thinkingTokens, requests: 1 }), costs: [], models: [],
        basis: ["provider_reported" as const], providerPresence: "reported" as const, quality: "partial" as const,
        reasons: ["unknown_attribution" as const], activity: "model" as const,
        turn: turn ? { backendTurnId: turn, scope: "main_loop" as const, contribution: "additive" as const } : null };
      const revision = createHash("sha256").update(JSON.stringify(fact)).digest("hex");
      if (this.#committed.get(id) === revision) return [];
      return [{ id, revision, order: String(step.index), provenance, occurredAt: step.completedAt ?? null,
        replaceCheckpoint: false, facts: [fact] }];
    });
    for (let index = 0; index < observations.length; index += 64) {
      const batch = observations.slice(index, index + 64);
      if (!this.capture.capture(batch)) return false;
      for (const observation of batch) this.#committed.set(observation.id, observation.revision);
    }
    return this.capture.reconcile();
  }
  close(): void { this.capture.seal("detached"); }
}
