import type { FormField as NativeField, FormInfo, PermissionRequest, SessionFormCancelInput, SessionFormReplyInput } from "@opencode/client";
import { Form } from "@opencode/schema/form";
import { Permission } from "@opencode/schema/permission";
import { createHash } from "node:crypto";
import { z } from "zod";
import { driverInteractionSchema, interactionResponseInputSchema, type DriverInteraction } from "../../../shared/protocol/backend.js";
import { INTERACTION_LIMITS, validateFormAnswers, type FormField } from "../../../shared/protocol/interactions.js";
import { MAXIMUM_BROWSER_ENTITY_BYTES, PAYLOAD_LIMITS, type BoundedDisplayText } from "../../../shared/protocol/payload.js";
import { deterministicJson } from "../../canonical-json.js";
import { boundDisplayText, boundText, boundValue } from "../../conversations/payload-policy.js";
import { snapshotBoundedJson } from "../../provider-protocol/json/bounded-json-snapshot.js";
import { openCodeNativeParser } from "./opencode-native-api.js";
import type { OpenCodeNativePermissionReplyInput } from "./opencode-native-mutations.js";

/** Server-derived identity. generation must fence the runtime and binding. */
export interface OpenCodeInteractionAuthority {
  readonly tenantId: string;
  readonly principalId: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly sessionID: string;
  readonly generation: string;
}
const authoritySchema = z.strictObject({ tenantId: z.string().min(1).max(160), principalId: z.string().min(1).max(160),
  applicationThreadId: z.string().min(1).max(160), backendInstanceId: z.string().min(1).max(160),
  sessionID: z.string().regex(/^ses_[^\x00-\x20/\\]{1,252}$/u), generation: z.string().min(1).max(512) });
const mappingBrand: unique symbol = Symbol("OpenCodeInteractionMapping");
export interface OpenCodeInteractionMapping { readonly [mappingBrand]: true; }
export type OpenCodeInteractionMapResult =
  | { readonly status: "mapped"; readonly interaction: DriverInteraction; readonly mapping: OpenCodeInteractionMapping; readonly requestFingerprint: string }
  | { readonly status: "unsupported"; readonly cancel: SessionFormCancelInput; readonly notice: BoundedDisplayText; readonly requestFingerprint: string }
  | { readonly status: "unowned"; readonly notice: BoundedDisplayText };
export type OpenCodeInteractionNativeResponse =
  | { readonly kind: "permission_reply"; readonly input: OpenCodeNativePermissionReplyInput }
  | { readonly kind: "form_reply"; readonly input: SessionFormReplyInput }
  | { readonly kind: "form_cancel"; readonly input: SessionFormCancelInput };
export class OpenCodeInteractionMappingError extends Error {
  readonly notice?: BoundedDisplayText;
  constructor(readonly code: "invalid_authority" | "invalid_request" | "invalid_response" | "stale" | "permission_cancel_unsupported") {
    super(`opencode_interaction_${code}`); this.name = "OpenCodeInteractionMappingError";
    if (code === "permission_cancel_unsupported") this.notice = boundDisplayText("This OpenCode permission remains pending. Automatic cancellation is unsupported because native rejection also rejects other pending permissions in the session. Reconnect to answer it explicitly.");
  }
}
interface Choice { readonly id: string; readonly value: string; }
interface FieldMapping { readonly id: string; readonly field: NativeField; readonly choices: readonly Choice[]; readonly otherId?: string; }
interface MappingState {
  readonly authorityFingerprint: string;
  readonly requestFingerprint: string;
  readonly interaction: DriverInteraction;
  readonly request: PermissionRequest | FormInfo;
  readonly kind: "permission" | "form";
  readonly fields: readonly FieldMapping[];
}
const mappings = new WeakMap<OpenCodeInteractionMapping, MappingState>();
const parsePermission = openCodeNativeParser<PermissionRequest>(Permission.Request);
const parseForm = openCodeNativeParser<FormInfo>(Form.Info);
const responseLimits = { maximumDepth: 32, maximumObjectProperties: 4_096, maximumArrayItems: 4_096,
  maximumTotalNodes: 20_000, maximumStringBytes: MAXIMUM_BROWSER_ENTITY_BYTES, maximumEncodedBytes: MAXIMUM_BROWSER_ENTITY_BYTES };
const digest = (value: unknown) => createHash("sha256").update(deterministicJson(value)).digest("base64url");
function authority(value: OpenCodeInteractionAuthority): OpenCodeInteractionAuthority {
  try { return authoritySchema.parse(snapshotBoundedJson(value, responseLimits)); }
  catch { throw new OpenCodeInteractionMappingError("invalid_authority"); }
}
function fingerprint(kind: "permission" | "form", request: PermissionRequest | FormInfo): string { return `ocif_${digest({ kind, request })}`; }
function base(authority: OpenCodeInteractionAuthority, kind: "permission" | "form", requestFingerprint: string, openedAt: string, title: string) {
  if (!z.iso.datetime().safeParse(openedAt).success) throw new OpenCodeInteractionMappingError("invalid_request");
  return { backendInteractionId: `oci_${digest({ authority, kind, requestFingerprint })}`, sourceLabel: boundDisplayText("OpenCode"),
    title: boundDisplayText(title), openedAt, secret: false, destructive: kind === "permission", cancellable: kind === "form" };
}
function mapped(input: { authority: OpenCodeInteractionAuthority; kind: MappingState["kind"]; request: MappingState["request"];
  requestFingerprint: string; interaction: DriverInteraction; fields?: readonly FieldMapping[] }): OpenCodeInteractionMapResult {
  const interaction = snapshotBoundedJson(driverInteractionSchema.parse(input.interaction), responseLimits) as DriverInteraction;
  const mapping: OpenCodeInteractionMapping = Object.freeze({ [mappingBrand]: true as const });
  mappings.set(mapping, Object.freeze({ authorityFingerprint: digest(input.authority), kind: input.kind, request: input.request,
    requestFingerprint: input.requestFingerprint, interaction, fields: input.fields ?? [] }));
  return { status: "mapped", interaction, mapping, requestFingerprint: input.requestFingerprint };
}
const unowned = (): OpenCodeInteractionMapResult => ({ status: "unowned", notice: boundDisplayText("This OpenCode request has no matching session owner. Sedes cannot answer or cancel it.") });
function requestId(value: string, prefix: "per_" | "frm_"): void {
  if (!value.startsWith(prefix) || value.length <= prefix.length || value.length > 256 || /[\x00-\x20/\\]/u.test(value)) {
    throw new OpenCodeInteractionMappingError("invalid_request");
  }
}

export function mapOpenCodePermission(input: { readonly request: PermissionRequest; readonly authority: OpenCodeInteractionAuthority; readonly openedAt: string }): OpenCodeInteractionMapResult {
  const owner = authority(input.authority);
  let request: PermissionRequest;
  try { request = parsePermission(input.request); } catch { throw new OpenCodeInteractionMappingError("invalid_request"); }
  if (request.sessionID !== owner.sessionID) return unowned();
  requestId(request.id, "per_");
  const requestFingerprint = fingerprint("permission", request);
  return mapped({ authority: owner, kind: "permission", request, requestFingerprint,
    interaction: { ...base(owner, "permission", requestFingerprint, input.openedAt, `Permission: ${request.action}`), kind: "decision",
      message: boundText(`Allow once permits this requested action. Deny and stop interrupts the run and rejects every other pending permission in this session.\n\nAction: ${request.action}\nResources:\n${request.resources.join("\n")}${request.message ? `\n\n${request.message}` : ""}`),
      invocation: { arguments: boundValue({ action: request.action, resources: request.resources }) },
      actions: [{ backendActionId: "allow_once", label: boundDisplayText("Allow once"), role: "primary" },
        { backendActionId: "deny_and_stop", label: boundDisplayText("Deny and stop"), role: "reject" }] } });
}

class UnsupportedForm extends Error {}
const unsupported = (): never => { throw new UnsupportedForm(); };
function choices(field: Extract<NativeField, { type: "string" | "multiselect" }>, index: number): Choice[] {
  const options = field.options;
  if (!options || options.length < 1 || options.length > 64 || new Set(options.map(option => option.value)).size !== options.length) return unsupported();
  return options.map((option, optionIndex) => ({ id: `option_${index}_${optionIndex}`, value: option.value }));
}
function optionId(options: readonly Choice[], value: string): string {
  const choice = options.find(option => option.value === value); if (!choice) return unsupported(); return choice.id;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function fieldMapping(field: NativeField, index: number): { field: FormField; mapping: FieldMapping } {
  if (field.type === "external" || field.hidden || field.when !== undefined) return unsupported();
  const id = `field_${index}`;
  const result = { id, label: boundDisplayText(field.title || field.key), ...(field.description === undefined ? {} : { description: boundDisplayText(field.description) }), required: field.required === true };
  let options: readonly Choice[] = [];
  let presentation: FormField["input"];
  if (field.type === "string") {
    if (field.pattern !== undefined || field.custom === true && field.options !== undefined) return unsupported();
    if (field.options !== undefined) {
      options = choices(field, index);
      // Choice fields cannot express additional string constraints. They are
      // redundant only if every offered native value already satisfies them.
      if (options.some(option => !nativeFieldAnswerValid(field, option.value))) return unsupported();
      presentation = { kind: "single_choice", options: options.map((option, optionIndex) => ({ id: option.id,
        label: boundDisplayText(field.options![optionIndex]!.description
          ? `${field.options![optionIndex]!.label} — ${field.options![optionIndex]!.description}` : field.options![optionIndex]!.label) })),
        ...(field.default === undefined ? {} : { default: optionId(options, field.default) }) };
    } else {
      presentation = { kind: "text", ...(field.default === undefined ? {} : { default: field.default }),
        ...(field.minLength === undefined && !field.required ? {} : { minLength: Math.max(field.minLength ?? 0, field.required ? 1 : 0) }),
        ...(field.maxLength === undefined ? {} : { maxLength: field.maxLength }), ...(field.format === undefined ? {} : { format: field.format }) };
    }
  } else if (field.type === "number" || field.type === "integer") {
    if ([field.minimum, field.maximum, field.default].some(value => value !== undefined && !finite(value))) return unsupported();
    presentation = { kind: "number", integer: field.type === "integer", ...(field.minimum === undefined ? {} : { minimum: field.minimum as number }),
      ...(field.maximum === undefined ? {} : { maximum: field.maximum as number }), ...(field.default === undefined ? {} : { default: field.default as number }) };
  } else if (field.type === "boolean") {
    presentation = { kind: "boolean", ...(field.default === undefined ? {} : { default: field.default }) };
  } else {
    if (field.custom) return unsupported();
    options = choices(field, index);
    presentation = { kind: "multiple_choice", options: options.map((option, optionIndex) => ({ id: option.id,
      label: boundDisplayText(field.options[optionIndex]!.description ? `${field.options[optionIndex]!.label} — ${field.options[optionIndex]!.description}` : field.options[optionIndex]!.label) })),
      ...(field.default === undefined ? {} : { default: field.default.map(value => optionId(options, value)) }),
      ...(field.minItems === undefined && !field.required ? {} : { minItems: Math.max(field.minItems ?? 0, field.required ? 1 : 0) }),
      ...(field.maxItems === undefined ? {} : { maxItems: field.maxItems }) };
  }
  if (field.default !== undefined && !nativeFieldAnswerValid(field, field.default)) return unsupported();
  return { field: { ...result, input: presentation }, mapping: { id, field, choices: options } };
}

function questionnaire(request: FormInfo): { questions: Extract<DriverInteraction, { kind: "questionnaire" }>["questions"]; fields: FieldMapping[] } {
  if (request.fields.length > INTERACTION_LIMITS.questionnaireQuestions) return unsupported();
  const fields: FieldMapping[] = [];
  const questions = request.fields.map((field, index) => {
    if (field.type !== "string" || field.custom !== true || field.required || field.hidden || field.when !== undefined || field.default !== undefined ||
        field.minLength !== undefined || field.maxLength !== undefined || field.pattern !== undefined || field.format !== undefined || field.placeholder !== undefined ||
        !field.options || field.options.length > INTERACTION_LIMITS.questionnaireOptionsPerQuestion) return unsupported();
    const options = choices(field, index), id = `question_${index}`, otherId = `other_${index}`;
    fields.push({ id, field, choices: options, otherId });
    return { backendQuestionId: id, header: boundDisplayText(field.title || `Question ${index + 1}`),
      prompt: boundDisplayText(field.description || field.title || field.key), secret: false,
      input: { kind: "single_choice" as const, allowNote: true,
        options: options.map((option, optionIndex) => ({ backendOptionId: option.id, label: boundDisplayText(field.options![optionIndex]!.label),
          description: boundDisplayText(field.options![optionIndex]!.description ?? "") })),
        other: { backendOptionId: otherId, label: boundDisplayText("Other"), description: boundDisplayText("Enter your own answer.") } } };
  });
  return { questions, fields };
}

export function mapOpenCodeForm(input: { readonly request: FormInfo; readonly authority: OpenCodeInteractionAuthority; readonly openedAt: string }): OpenCodeInteractionMapResult {
  const owner = authority(input.authority);
  let request: FormInfo;
  try { request = parseForm(input.request); } catch { throw new OpenCodeInteractionMappingError("invalid_request"); }
  if (request.sessionID !== owner.sessionID) return unowned();
  requestId(request.id, "frm_");
  const requestFingerprint = fingerprint("form", request);
  const common = base(owner, "form", requestFingerprint, input.openedAt, request.title);
  try {
    if (request.fields.length > 32 || new Set(request.fields.map(field => field.key)).size !== request.fields.length) return unsupported();
    if (request.fields.some(field => field.type === "string" && field.custom === true && field.options !== undefined)) {
      const result = questionnaire(request);
      return mapped({ authority: owner, kind: "form", request, requestFingerprint, fields: result.fields,
        interaction: { ...common, kind: "questionnaire", questions: result.questions } });
    }
    const result = request.fields.map(fieldMapping);
    return mapped({ authority: owner, kind: "form", request, requestFingerprint, fields: result.map(value => value.mapping),
      interaction: { ...common, kind: "form", fields: result.map(value => value.field) } });
  } catch (error) {
    if (!(error instanceof UnsupportedForm) && !(error instanceof z.ZodError)) throw error;
    return { status: "unsupported", cancel: Object.freeze({ sessionID: owner.sessionID, formID: request.id }), requestFingerprint,
      notice: boundDisplayText("Sedes cannot represent this OpenCode form's fields. The exact session-owned form must be cancelled; other requests remain unchanged.") };
  }
}

/** Pinned native form constraints, applied again after normalized response validation. */
function nativeFieldAnswerValid(field: NativeField, value: unknown): boolean {
  if (field.type === "external") return false;
  if (field.type === "string") {
    if (typeof value !== "string" || field.required && value.length === 0 || value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? Infinity)) return false;
    if (field.options && !field.custom && !field.options.some(option => option.value === value)) return false;
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return false;
    if (field.format === "uri" && !URL.canParse(value)) return false;
    if (field.format === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
      const date = new Date(`${value}T00:00:00.000Z`);
      if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return false;
    }
    if (field.format === "date-time" && Number.isNaN(new Date(value).getTime())) return false;
    return true;
  }
  if (field.type === "number" || field.type === "integer") return finite(value) && (field.type !== "integer" || Number.isInteger(value)) &&
    (field.minimum === undefined || finite(field.minimum) && value >= field.minimum) && (field.maximum === undefined || finite(field.maximum) && value <= field.maximum);
  if (field.type === "boolean") return typeof value === "boolean";
  return Array.isArray(value) && value.every(item => typeof item === "string") && (!field.required || value.length > 0) &&
    value.length >= (field.minItems ?? 0) && value.length <= (field.maxItems ?? Infinity) &&
    (field.custom === true || value.every(item => field.options.some(option => option.value === item)));
}
function invalidResponse(): never { throw new OpenCodeInteractionMappingError("invalid_response"); }
function nativeResponse(value: OpenCodeInteractionNativeResponse): OpenCodeInteractionNativeResponse {
  try { return snapshotBoundedJson(value, responseLimits) as OpenCodeInteractionNativeResponse; }
  catch { return invalidResponse(); }
}

export function resolveOpenCodeInteractionResponse(input: { readonly mapping: OpenCodeInteractionMapping; readonly authority: OpenCodeInteractionAuthority;
  readonly requestFingerprint: string; readonly response: unknown }): OpenCodeInteractionNativeResponse {
  const owner = authority(input.authority), state = mappings.get(input.mapping);
  if (!state || state.authorityFingerprint !== digest(owner) || state.requestFingerprint !== input.requestFingerprint) throw new OpenCodeInteractionMappingError("stale");
  let response: z.infer<typeof interactionResponseInputSchema>;
  try { response = interactionResponseInputSchema.parse(snapshotBoundedJson(input.response, responseLimits)); } catch { return invalidResponse(); }
  if (response.interactionId !== state.interaction.backendInteractionId) throw new OpenCodeInteractionMappingError("stale");
  if (state.kind === "permission") {
    if (response.kind === "cancel") throw new OpenCodeInteractionMappingError("permission_cancel_unsupported");
    if (response.kind !== "decision" || !["allow_once", "deny_and_stop"].includes(response.selectedActionId)) return invalidResponse();
    return nativeResponse({ kind: "permission_reply", input: { sessionID: owner.sessionID, requestID: state.request.id,
      decision: response.selectedActionId === "allow_once" ? "once" : "reject" } });
  }
  if (response.kind === "cancel") return nativeResponse({ kind: "form_cancel", input: { sessionID: owner.sessionID, formID: state.request.id } });
  const answer: Record<string, string | number | boolean | readonly string[]> = Object.create(null);
  if (state.interaction.kind === "form") {
    if (response.kind !== "form" || validateFormAnswers(state.interaction.fields, response.answers)) return invalidResponse();
    for (const submitted of response.answers) {
      const field = state.fields.find(field => field.id === submitted.fieldId); if (!field) return invalidResponse();
      let value = submitted.value;
      if (field.choices.length) {
        const resolve = (id: string) => field.choices.find(option => option.id === id)?.value ?? invalidResponse();
        value = Array.isArray(value) ? value.map(resolve) : typeof value === "string" ? resolve(value) : invalidResponse();
      }
      if (!nativeFieldAnswerValid(field.field, value)) return invalidResponse();
      answer[field.field.key] = value;
    }
  } else if (state.interaction.kind === "questionnaire") {
    if (response.kind !== "questionnaire" || response.answers.length !== state.fields.length) return invalidResponse();
    for (const submitted of response.answers) {
      const field = state.fields.find(field => field.id === submitted.questionId); if (!field) return invalidResponse();
      if (submitted.answer.kind === "unanswered") continue;
      if (submitted.answer.kind !== "single_choice") return invalidResponse();
      const selected = submitted.answer;
      const value = selected.selectedOptionId === field.otherId
        ? selected.note && selected.note.trim() ? selected.note : invalidResponse()
        : (() => {
          const option = field.choices.find(option => option.id === selected.selectedOptionId); if (!option) return invalidResponse();
          return selected.note ? `${option.value}: ${selected.note}` : option.value;
        })();
      if (value.length > PAYLOAD_LIMITS.textCharacters || !nativeFieldAnswerValid(field.field, value)) return invalidResponse();
      answer[field.field.key] = value;
    }
  } else return invalidResponse();
  for (const field of state.fields) if (field.field.type !== "external" && field.field.required && !Object.hasOwn(answer, field.field.key)) return invalidResponse();
  return nativeResponse({ kind: "form_reply", input: { sessionID: owner.sessionID, formID: state.request.id,
    answer } });
}
