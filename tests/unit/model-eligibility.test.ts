import { describe, expect, it, vi } from "vitest";
import {
  evaluateModelEligibility,
  type ModelEligibilityEvidence,
} from "../support/model-eligibility.js";

const requiredProvider = "xai";
const requiredModelId = "grok-4.5";
const requiredThinkingLevel = "low";

function evaluate(
  catalog: readonly { provider: string; id: string }[],
  inspect: (
    candidate: { provider: string; id: string },
  ) => ModelEligibilityEvidence,
) {
  return evaluateModelEligibility({
    catalog,
    requiredProvider,
    requiredModelId,
    requiredThinkingLevel,
    inspect,
  });
}

describe("real-Pi model eligibility", () => {
  it("accepts only an exact provider/model pair with verified effective low state", async () => {
    const result = await evaluate(
      [{ provider: requiredProvider, id: requiredModelId }],
      (candidate) => ({
        kind: "effective_state",
        ...candidate,
        thinkingLevel: "low",
        additionalSafetyChecksPassed: true,
      }),
    );

    expect(result.eligible).toEqual([
      { provider: requiredProvider, id: requiredModelId },
    ]);
    expect(result.evaluated).toMatchObject([
      { status: "eligible", evidenceKind: "effective_state" },
    ]);
  });

  it("treats absent effective metadata as indeterminate", async () => {
    const result = await evaluate(
      [{ provider: requiredProvider, id: requiredModelId }],
      (candidate) => ({
        kind: "effective_state",
        provider: candidate.provider,
        id: candidate.id,
      }),
    );

    expect(result.eligible).toEqual([]);
    expect(result.evaluated[0]).toMatchObject({ status: "indeterminate" });
  });

  it("rejects a clamped or different effective thinking level", async () => {
    const result = await evaluate(
      [{ provider: requiredProvider, id: requiredModelId }],
      (candidate) => ({
        kind: "effective_state",
        ...candidate,
        thinkingLevel: "medium",
      }),
    );

    expect(result.eligible).toEqual([]);
    expect(result.evaluated[0]).toMatchObject({ status: "ineligible" });
  });

  it("rejects effective state reported for a different provider/model pair", async () => {
    const result = await evaluate(
      [{ provider: requiredProvider, id: requiredModelId }],
      () => ({
        kind: "effective_state",
        provider: "provider-b",
        id: requiredModelId,
        thinkingLevel: "low",
      }),
    );

    expect(result.eligible).toEqual([]);
    expect(result.evaluated[0]).toMatchObject({ status: "ineligible" });
  });

  it("does not speculate when support evidence is indeterminate", async () => {
    const result = await evaluate(
      [{ provider: requiredProvider, id: requiredModelId }],
      () => ({ kind: "indeterminate" }),
    );

    expect(result.eligible).toEqual([]);
    expect(result.evaluated[0]).toMatchObject({
      status: "indeterminate",
      evidenceKind: "indeterminate",
    });
  });

  it("deduplicates identical catalog pairs before inspecting support", async () => {
    const inspect = vi.fn((candidate: { provider: string; id: string }) => ({
      kind: "effective_state" as const,
      ...candidate,
      thinkingLevel: "low",
    }));
    const result = await evaluate(
      [
        { provider: requiredProvider, id: requiredModelId },
        { provider: requiredProvider, id: requiredModelId },
        { provider: requiredProvider, id: "another-model" },
      ],
      inspect,
    );

    expect(inspect).toHaveBeenCalledOnce();
    expect(result.eligible).toEqual([
      { provider: requiredProvider, id: requiredModelId },
    ]);
  });

  it("reports zero eligible pairs when no exact safe match exists", async () => {
    const result = await evaluate(
      [
        { provider: requiredProvider, id: "another-model" },
        { provider: "provider-b", id: requiredModelId },
      ],
      () => ({
        kind: "explicit_metadata",
        supportedThinkingLevels: ["medium", "high"],
      }),
    );

    expect(result.eligible).toEqual([]);
    expect(result.evaluated).toHaveLength(0);
  });

  it("ignores the same model ID under another provider", async () => {
    const inspect = vi.fn(() => ({
      kind: "explicit_metadata" as const,
      supportedThinkingLevels: ["low"],
    }));
    const result = await evaluate(
      [
        { provider: requiredProvider, id: requiredModelId },
        { provider: "provider-b", id: requiredModelId },
      ],
      inspect,
    );

    expect(result.eligible).toEqual([
      { provider: requiredProvider, id: requiredModelId },
    ]);
    expect(inspect).toHaveBeenCalledOnce();
  });
});
