import { boundDisplayText as display } from "../../conversations/payload-policy.js";
import {
  formFieldsSchema,
  validateFormAnswers,
  type FormField,
  type FormAnswer,
} from "../../../shared/protocol/interactions.js";
import type { McpElicitationSchema } from "../../provider-protocol/bindings/codex-app-server/generated/0.153.0/stable/v2/McpElicitationSchema.js";

/** Maps the pinned native form contract; native names and enum values stay here. */
export function normalizeCodexElicitationForm(schema: McpElicitationSchema): {
  fields: FormField[];
  content: (answers: readonly FormAnswer[]) => Record<string, unknown>;
} {
  const entries = Object.entries(schema.properties);
  const required = new Set(schema.required ?? []);
  if (
    required.size !== (schema.required?.length ?? 0) ||
    [...required].some((key) => !Object.hasOwn(schema.properties, key))
  )
    throw new Error("codex_mcp_elicitation_required_invalid");
  const nativeNames = new Map<string, string>();
  const nativeOptions = new Map<string, string>();
  const fields = entries.map(([name, property], index): FormField => {
    if (!property) throw new Error("codex_mcp_elicitation_property_invalid");
    const id = `field:${index}`;
    nativeNames.set(id, name);
    const base = {
      id,
      label: meaningfulLabel(property.title, name),
      required: required.has(name),
      ...(property.description === undefined
        ? {}
        : { description: display(property.description) }),
    };
    const options = (values: readonly { value: string; label: string }[]) => {
      if (new Set(values.map((value) => value.value)).size !== values.length)
        throw new Error("codex_mcp_elicitation_duplicate_enum");
      return values.map((value, optionIndex) => {
        const optionId = `${id}:option:${optionIndex}`;
        nativeOptions.set(optionId, value.value);
        return {
          id: optionId,
          label: meaningfulLabel(value.label, value.value, true),
        };
      });
    };
    if (property.type === "boolean")
      return {
        ...base,
        input: {
          kind: "boolean",
          ...(property.default === undefined
            ? {}
            : { default: property.default }),
        },
      };
    if (property.type === "number" || property.type === "integer")
      return {
        ...base,
        input: {
          kind: "number",
          integer: property.type === "integer",
          ...(property.minimum === undefined
            ? {}
            : { minimum: property.minimum }),
          ...(property.maximum === undefined
            ? {}
            : { maximum: property.maximum }),
          ...(property.default === undefined
            ? {}
            : { default: property.default }),
        },
      };
    if (property.type === "array") {
      const values =
        "enum" in property.items
          ? property.items.enum.map((value) => ({ value, label: value }))
          : property.items.anyOf.map((value) => ({
              value: value.const,
              label: value.title,
            }));
      const mapped = options(values);
      return {
        ...base,
        input: {
          kind: "multiple_choice",
          options: mapped,
          ...(property.minItems === undefined
            ? {}
            : { minItems: checkedCount(property.minItems) }),
          ...(property.maxItems === undefined
            ? {}
            : { maxItems: checkedCount(property.maxItems) }),
          ...(property.default === undefined
            ? {}
            : {
                default: property.default.map((value) => {
                  const index = values.findIndex(
                    (option) => option.value === value,
                  );
                  if (index < 0)
                    throw new Error("codex_mcp_elicitation_default_invalid");
                  return mapped[index]!.id;
                }),
              }),
        },
      };
    }
    if ("enum" in property || "oneOf" in property) {
      if (
        "enumNames" in property &&
        property.enumNames &&
        property.enumNames.length !== property.enum.length
      )
        throw new Error("codex_mcp_elicitation_enum_labels_invalid");
      const values =
        "enum" in property
          ? property.enum.map((value, index) => ({
              value,
              label:
                "enumNames" in property
                  ? (property.enumNames?.[index] ?? value)
                  : value,
            }))
          : property.oneOf.map((option) => ({
              value: option.const,
              label: option.title,
            }));
      const mapped = options(values);
      const defaultIndex =
        property.default === undefined
          ? undefined
          : values.findIndex((option) => option.value === property.default);
      if (defaultIndex === -1)
        throw new Error("codex_mcp_elicitation_default_invalid");
      return {
        ...base,
        input: {
          kind: "single_choice",
          options: mapped,
          ...(defaultIndex === undefined
            ? {}
            : { default: mapped[defaultIndex]!.id }),
        },
      };
    }
    if (property.type !== "string")
      throw new Error("codex_mcp_elicitation_property_invalid");
    return {
      ...base,
      input: {
        kind: "text",
        ...(property.minLength === undefined
          ? {}
          : { minLength: property.minLength }),
        ...(property.maxLength === undefined
          ? {}
          : { maxLength: property.maxLength }),
        ...(property.format === undefined ? {} : { format: property.format }),
        ...(property.default === undefined
          ? {}
          : { default: property.default }),
      },
    };
  });
  if (fields.length) formFieldsSchema.parse(fields);
  return {
    fields,
    content: (answers) => {
      const error = validateFormAnswers(fields, answers);
      if (error) throw new Error("codex_mcp_elicitation_response_invalid");
      return Object.fromEntries(
        answers.map((answer) => {
          const field = fields.find((field) => field.id === answer.fieldId)!;
          const value =
            field.input.kind === "single_choice"
              ? nativeOptions.get(answer.value as string)!
              : field.input.kind === "multiple_choice"
                ? (answer.value as string[]).map((id) => nativeOptions.get(id)!)
                : answer.value;
          return [nativeNames.get(answer.fieldId)!, value];
        }),
      );
    },
  };
}
function checkedCount(value: bigint): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0)
    throw new Error("codex_mcp_elicitation_bound_invalid");
  return count;
}

function meaningfulLabel(
  title: string | undefined,
  fallback: string,
  option = false,
) {
  const titleText = title?.trim();
  if (titleText) return display(titleText);
  const fallbackText = fallback.trim();
  if (fallbackText) return display(fallbackText);
  // Empty enum values are valid data and remain selectable with a named option.
  if (option)
    return display(
      fallback === ""
        ? "Empty value"
        : `Whitespace value: ${JSON.stringify(fallback)}`,
    );
  throw new Error("codex_mcp_elicitation_field_label_invalid");
}
