import { z } from "zod";

export type BackendModelPolicyMatcher = Readonly<{
  providerIds?: readonly string[];
  modelIds?: readonly string[];
  reasoningEfforts?: readonly string[];
}>;

export type BackendModelPolicy =
  | Readonly<{ type: "catalog" }>
  | Readonly<{
      type: "allowlist";
      allowed: readonly BackendModelPolicyMatcher[];
    }>
  | Readonly<{
      type: "denylist";
      denied: readonly BackendModelPolicyMatcher[];
    }>;

const matcherValueSchemas = {
  providerIds: opaqueIdentifierSchema("Provider IDs", 120),
  modelIds: opaqueIdentifierSchema("Model IDs", 240),
  reasoningEfforts: opaqueIdentifierSchema("Reasoning efforts", 120),
} as const;

function opaqueIdentifierSchema(label: string, maximumLength: number) {
  return z
    .string()
    .min(1)
    .max(maximumLength)
    .refine(
      (value) => !/\p{Cc}/u.test(value),
      `${label} cannot contain control characters.`,
    );
}

function uniqueIdentifierList(valueSchema: z.ZodString, label: string) {
  return z
    .array(valueSchema)
    .min(1)
    .max(64)
    .superRefine((values, context) => {
      const seen = new Set<string>();
      for (const [index, value] of values.entries()) {
        if (seen.has(value)) {
          context.addIssue({
            code: "custom",
            message: `${label} contains a duplicate value.`,
            path: [index],
          });
        }
        seen.add(value);
      }
    });
}

export const backendModelPolicyMatcherSchema: z.ZodType<BackendModelPolicyMatcher> =
  z
    .object({
      providerIds: uniqueIdentifierList(
        matcherValueSchemas.providerIds,
        "Provider IDs",
      ).optional(),
      modelIds: uniqueIdentifierList(
        matcherValueSchemas.modelIds,
        "Model IDs",
      ).optional(),
      reasoningEfforts: uniqueIdentifierList(
        matcherValueSchemas.reasoningEfforts,
        "Reasoning efforts",
      ).optional(),
    })
    .strict()
    .refine(
      (matcher) =>
        matcher.providerIds !== undefined ||
        matcher.modelIds !== undefined ||
        matcher.reasoningEfforts !== undefined,
      "A model-policy matcher must contain at least one dimension.",
    );

const matcherListSchema = z
  .array(backendModelPolicyMatcherSchema)
  .min(1)
  .max(64)
  .superRefine((matchers, context) => {
    const seen = new Set<string>();
    for (const [index, matcher] of matchers.entries()) {
      const signature = matcherSignature(matcher);
      if (seen.has(signature)) {
        context.addIssue({
          code: "custom",
          message: "The model policy contains a duplicate matcher.",
          path: [index],
        });
      }
      seen.add(signature);
    }
  });

export const backendModelPolicySchema: z.ZodType<BackendModelPolicy> =
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("catalog") }).strict(),
    z
      .object({
        type: z.literal("allowlist"),
        allowed: matcherListSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("denylist"),
        denied: matcherListSchema,
      })
      .strict(),
  ]);

export type BackendModelPolicyIdentityDisposition =
  "provider_model_effort" | "model_effort";

export interface BackendModelSelection {
  readonly providerId?: string;
  readonly modelId: string;
  readonly reasoningEffort?: string;
}

export interface BackendModelIdentity {
  readonly providerId?: string;
  readonly modelId: string;
}

export interface CompiledBackendModelPolicy {
  readonly policy: BackendModelPolicy;
  isSelectionAllowed(selection: BackendModelSelection): boolean;
  isModelWithoutReasoningEffortAllowed(identity: BackendModelIdentity): boolean;
  filterReasoningEfforts(
    identity: BackendModelIdentity,
    reasoningEfforts: readonly string[],
  ): readonly string[];
}

export class BackendModelPolicyConfigurationError extends Error {
  readonly code = "backend_model_policy_provider_dimension_unsupported";

  constructor() {
    super(
      "This backend does not expose a native provider identity and cannot configure providerIds in modelPolicy.",
    );
    this.name = "BackendModelPolicyConfigurationError";
  }
}

/**
 * Compiles an already operator-owned policy into exact native-selection
 * checks. The policy is parsed again here so direct module callers receive the
 * same closed-shape and bound enforcement as configuration-file callers.
 */
export function compileBackendModelPolicy(
  policy: BackendModelPolicy,
  identityDisposition: BackendModelPolicyIdentityDisposition,
): CompiledBackendModelPolicy {
  const parsed = backendModelPolicySchema.parse(policy);
  const matchers =
    parsed.type === "catalog"
      ? []
      : parsed.type === "allowlist"
        ? parsed.allowed
        : parsed.denied;
  if (
    identityDisposition === "model_effort" &&
    matchers.some(({ providerIds }) => providerIds !== undefined)
  ) {
    throw new BackendModelPolicyConfigurationError();
  }

  const compiledMatchers = matchers.map((matcher) => ({
    providerIds:
      matcher.providerIds === undefined
        ? undefined
        : new Set(matcher.providerIds),
    modelIds:
      matcher.modelIds === undefined ? undefined : new Set(matcher.modelIds),
    reasoningEfforts:
      matcher.reasoningEfforts === undefined
        ? undefined
        : new Set(matcher.reasoningEfforts),
  }));

  const isSelectionAllowed = (selection: BackendModelSelection): boolean => {
    if (parsed.type === "catalog") return true;
    if (
      identityDisposition === "provider_model_effort" &&
      !selection.providerId
    ) {
      return false;
    }
    const matched = compiledMatchers.some((matcher) =>
      selectionMatches(matcher, selection),
    );
    switch (parsed.type) {
      case "allowlist":
        return matched;
      case "denylist":
        return !matched;
    }
  };

  return Object.freeze({
    policy: deepFreeze(parsed),
    isSelectionAllowed,
    isModelWithoutReasoningEffortAllowed(identity: BackendModelIdentity) {
      return isSelectionAllowed(identity);
    },
    filterReasoningEfforts(
      identity: BackendModelIdentity,
      reasoningEfforts: readonly string[],
    ) {
      return reasoningEfforts.filter((reasoningEffort) =>
        isSelectionAllowed({ ...identity, reasoningEffort }),
      );
    },
  });
}

type CompiledMatcher = Readonly<{
  providerIds?: ReadonlySet<string>;
  modelIds?: ReadonlySet<string>;
  reasoningEfforts?: ReadonlySet<string>;
}>;

function selectionMatches(
  matcher: CompiledMatcher,
  selection: BackendModelSelection,
): boolean {
  return (
    (matcher.providerIds === undefined ||
      (selection.providerId !== undefined &&
        matcher.providerIds.has(selection.providerId))) &&
    (matcher.modelIds === undefined ||
      matcher.modelIds.has(selection.modelId)) &&
    (matcher.reasoningEfforts === undefined ||
      (selection.reasoningEffort !== undefined &&
        matcher.reasoningEfforts.has(selection.reasoningEffort)))
  );
}

function matcherSignature(matcher: BackendModelPolicyMatcher): string {
  return JSON.stringify({
    providerIds: matcher.providerIds ? [...matcher.providerIds].sort() : null,
    modelIds: matcher.modelIds ? [...matcher.modelIds].sort() : null,
    reasoningEfforts: matcher.reasoningEfforts
      ? [...matcher.reasoningEfforts].sort()
      : null,
  });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
