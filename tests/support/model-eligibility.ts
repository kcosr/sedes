export interface ModelCatalogEntry {
  readonly provider: string;
  readonly id: string;
}

export type ModelEligibilityEvidence =
  | {
      readonly kind: "explicit_metadata";
      readonly supportedThinkingLevels?: readonly string[];
    }
  | {
      readonly kind: "effective_state";
      readonly provider?: string;
      readonly id?: string;
      readonly thinkingLevel?: string;
      readonly additionalSafetyChecksPassed?: boolean;
    }
  | {
      readonly kind: "indeterminate";
    };

export interface EvaluatedModel extends ModelCatalogEntry {
  readonly status: "eligible" | "ineligible" | "indeterminate";
  readonly evidenceKind: ModelEligibilityEvidence["kind"];
}

export interface ModelEligibilityResult {
  readonly evaluated: readonly EvaluatedModel[];
  readonly eligible: readonly ModelCatalogEntry[];
}

export async function evaluateModelEligibility(input: {
  readonly catalog: readonly ModelCatalogEntry[];
  readonly requiredProvider: string;
  readonly requiredModelId: string;
  readonly requiredThinkingLevel: string;
  inspect(
    candidate: ModelCatalogEntry,
  ): Promise<ModelEligibilityEvidence> | ModelEligibilityEvidence;
}): Promise<ModelEligibilityResult> {
  const candidates = [
    ...new Map(
      input.catalog
        .filter(
          ({ provider, id }) =>
            provider === input.requiredProvider && id === input.requiredModelId,
        )
        .map((candidate) => [
          `${candidate.provider}\u0000${candidate.id}`,
          { provider: candidate.provider, id: candidate.id },
        ]),
    ).values(),
  ];
  const evaluated: EvaluatedModel[] = [];

  for (const candidate of candidates) {
    const evidence = await input.inspect(candidate);
    let status: EvaluatedModel["status"];
    if (evidence.kind === "indeterminate") {
      status = "indeterminate";
    } else if (evidence.kind === "explicit_metadata") {
      status =
        evidence.supportedThinkingLevels === undefined
          ? "indeterminate"
          : evidence.supportedThinkingLevels.includes(
                input.requiredThinkingLevel,
              )
            ? "eligible"
            : "ineligible";
    } else if (
      evidence.provider === undefined ||
      evidence.id === undefined ||
      evidence.thinkingLevel === undefined
    ) {
      status = "indeterminate";
    } else {
      status =
        evidence.provider === candidate.provider &&
        evidence.id === candidate.id &&
        evidence.thinkingLevel === input.requiredThinkingLevel &&
        evidence.additionalSafetyChecksPassed !== false
          ? "eligible"
          : "ineligible";
    }
    evaluated.push({
      ...candidate,
      status,
      evidenceKind: evidence.kind,
    });
  }

  return {
    evaluated,
    eligible: evaluated
      .filter(({ status }) => status === "eligible")
      .map(({ provider, id }) => ({ provider, id })),
  };
}
