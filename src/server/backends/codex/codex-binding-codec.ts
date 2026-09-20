import { z } from "zod";

const MAXIMUM_CODEX_BINDING_DETAIL_BYTES = 4_096;

const codexThreadIdSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => !/[\u0000-\u001f\u007f]/u.test(value),
    "Codex thread IDs cannot contain control characters.",
  );

const codexBindingDetailSchema = z
  .object({
    version: z.literal(2),
    threadId: codexThreadIdSchema,
    sessionId: codexThreadIdSchema.nullable(),
    correlationAncestorThreadIds: z
      .array(codexThreadIdSchema)
      .max(100)
      .refine((values) => new Set(values).size === values.length),
    nativeAncestry: z
      .object({
        forkedFromThreadId: codexThreadIdSchema,
        sourceTurnId: codexThreadIdSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    ({ threadId, correlationAncestorThreadIds }) =>
      !correlationAncestorThreadIds.includes(threadId),
  )
  .refine(
    ({ correlationAncestorThreadIds, nativeAncestry }) =>
      nativeAncestry === null
        ? correlationAncestorThreadIds.length === 0
        : correlationAncestorThreadIds.at(-1) ===
          nativeAncestry.forkedFromThreadId,
  );

export interface CodexBindingDetail {
  readonly version: 2;
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly correlationAncestorThreadIds: readonly string[];
  readonly nativeAncestry: {
    readonly forkedFromThreadId: string;
    readonly sourceTurnId: string | null;
  } | null;
}

export function serializeCodexBindingDetail(
  input: Omit<CodexBindingDetail, "version">,
): string {
  const detail = codexBindingDetailSchema.parse({ version: 2, ...input });
  const serialized = JSON.stringify(detail);
  assertBoundedBindingDetail(serialized);
  return serialized;
}

export function parseCodexBindingDetail(value: string): CodexBindingDetail {
  assertBoundedBindingDetail(value);
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch (error) {
    throw new Error("codex_binding_detail_invalid", { cause: error });
  }
  const parsed = codexBindingDetailSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("codex_binding_detail_invalid", {
      cause: parsed.error,
    });
  }
  return Object.freeze(parsed.data);
}

function assertBoundedBindingDetail(value: string): void {
  if (
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_CODEX_BINDING_DETAIL_BYTES
  ) {
    throw new Error("codex_binding_detail_invalid");
  }
}
